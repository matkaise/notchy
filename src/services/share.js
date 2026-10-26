import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';
import {helperLauncher} from '../i18n/gnome.js';
import {_, fmt, ngettext, formatBytes, formatPercent} from '../i18n/core.js';

// How long a phone's upload question waits for an answer (the helper gives up after 60 s).
const ASK_MS = 55000;
// Receiving by QR code ends by itself after this long without a transfer.
const RECEIVE_SECONDS = 600;
export const SENDING = ['starting', 'ready', 'sending'];

// Sharing with any phone in the same network by QR code, beside AirDrop
// (airdrop.js) and in the same banners: helper/share.py runs a small web
// server for one session, the phone scans the code, opens the page in its
// browser and downloads — or picks files and sends them, after an explicit
// „Annehmen“ in the notch. No app, no account, no internet; the link carries a
// random key, only private-network addresses are served, and the session
// ends with its banner. The helper is its own process, so nothing of it can
// stall the Shell.
//
// send     {files, paths, phase: starting | ready | sending | done | failed | cancelled, url, peer, done, total, error}
// incoming {phase: starting | ready | receiving | expired | failed, url, peer, done, total, count (received so far), error}
// question {sender, what, timeout, asked, via: 'qr', answer(accepted)} — the AirDrop question's shape
export class Share extends Emitter {
    constructor(extension, shelf, settings) {
        super(); this.extension = extension; this.shelf = shelf; this.settings = settings; this.life = new Lifetime();
        this.send = null; this.incoming = null; this.question = null; this.sendProc = null; this.receiveProc = null; this.lastPaths = [];
        this.life.connect(settings, 'changed::share-qr-enabled', () => { if (!this.enabled) { this.cancelSend(); this.stopReceive(); } this.changed(); });
    }
    get enabled() { return this.settings.get_boolean('share-qr-enabled'); }
    get sending() { return Boolean(this.send && SENDING.includes(this.send.phase)); }
    get receiving() { return Boolean(this.incoming && ['starting', 'ready', 'receiving'].includes(this.incoming.phase)); }
    // Received files go where AirDrop puts them (Settings → AirDrop folder).
    get folder() { return this.extension.airdrop?.folder ?? GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.get_home_dir(), 'AirDrop']); }

    // Files to a phone: AirDrop when its backend is there (the banner offers the
    // QR code too), else the QR code. Returns whether a send started.
    sendToPhone(paths, way = null) {
        paths = paths.filter(path => path && GLib.file_test(path, GLib.FileTest.IS_REGULAR));
        if (!paths.length) return false;
        this.lastPaths = paths;
        const airdrop = this.extension.airdrop;
        const chosen = way ?? (airdrop?.available ? 'airdrop' : 'qr');
        if (chosen === 'airdrop' && airdrop?.available) return airdrop.sendFiles(paths);
        return this.sendFiles(paths);
    }
    // The banner's pill: the same files the other way.
    switchSend(way) {
        const paths = this.lastPaths, airdrop = this.extension.airdrop;
        if (!paths.length) return false;
        if (way === 'qr') { if (airdrop?.sendProc) airdrop.cancelSend(); return this.sendFiles(paths); }
        this.cancelSend(true);
        return Boolean(airdrop?.available) && airdrop.sendFiles(paths);
    }
    switchReceive(way) {
        const airdrop = this.extension.airdrop;
        if (way === 'qr') { if (airdrop?.receiving) airdrop.receive(false); return this.receive(); }
        this.stopReceive();
        return Boolean(airdrop?.available) && airdrop.receive(true);
    }

    spawn(args) {
        const proc = helperLauncher(this.settings, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
            .spawnv(['/usr/bin/python3', `${this.extension.path}/helper/share.py`, ...args]);
        const stdin = proc.get_stdin_pipe();
        proc.notchyWrite = line => { try { stdin.write_all(new TextEncoder().encode(`${line}\n`), null); } catch { /* Ended. */ } };
        return proc;
    }
    lines(proc, onEvent) {
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        const read = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, this.life.cancellable, (s, result) => {
            let line = null;
            try { [line] = s.read_line_finish_utf8(result); } catch { return; }
            if (line === null || this.life.closed) return;
            try { onEvent(JSON.parse(line)); } catch (e) { console.warn(`Notchy share: ${e.message}`); }
            read();
        });
        read();
    }

    sendFiles(paths) {
        if (!this.enabled || this.life.closed) return false;
        this.cancelSend(true);
        this.lastPaths = paths;
        const send = {files: paths.map(path => GLib.path_get_basename(path)), paths, phase: 'starting', url: '', peer: '', done: 0, total: 0, error: ''};
        let proc;
        try { proc = this.spawn(['send', ...paths]); } catch (e) { this.send = {...send, phase: 'failed', error: e.message}; this.changed(); return false; }
        this.send = send; this.sendProc = proc;
        this.lines(proc, event => {
            if (this.send !== send) return;
            if (event.event === 'waiting') send.waiting = true;
            else if (event.event === 'ready') { send.phase = 'ready'; send.url = String(event.url ?? ''); send.waiting = false; }
            else if (event.event === 'progress') { send.phase = 'sending'; send.peer = String(event.peer ?? ''); send.done = Number(event.done) || 0; send.total = Number(event.total) || 0; }
            else if (event.event === 'sent') { send.phase = 'done'; send.peer = String(event.peer ?? send.peer); }
            else if (event.event === 'error') { send.phase = 'failed'; send.error = String(event.message ?? ''); }
            else return;
            this.changed();
        });
        proc.wait_async(null, (p, result) => {
            try { p.wait_finish(result); } catch { /* Ended. */ }
            if (this.sendProc !== p) return;
            this.sendProc = null;
            if (SENDING.includes(send.phase)) { send.phase = 'failed'; send.error ||= _('Sharing ended unexpectedly'); }
            if (!this.life.closed) this.changed();
        });
        this.changed();
        return true;
    }
    // `quiet`: switching to AirDrop, nothing to report.
    cancelSend(quiet = false) {
        const proc = this.sendProc;
        if (!proc) { if (quiet && this.send && !SENDING.includes(this.send.phase)) this.send = null; return; }
        this.sendProc = null;
        if (this.send) this.send.phase = 'cancelled';
        proc.notchyWrite('stop'); try { proc.force_exit(); } catch { /* Gone. */ }
        if (quiet) this.send = null;
        this.changed();
    }

    receive() {
        if (!this.enabled || this.life.closed) return false;
        if (this.receiving) return true;
        const incoming = {phase: 'starting', url: '', peer: '', done: 0, total: 0, error: ''};
        let proc;
        try { proc = this.spawn(['receive', '--folder', this.folder, '--timeout', String(RECEIVE_SECONDS)]); } catch (e) { this.incoming = {...incoming, phase: 'failed', error: e.message}; this.changed(); return false; }
        this.incoming = incoming; this.receiveProc = proc;
        this.lines(proc, event => {
            if (this.incoming !== incoming) return;
            switch (event.event) {
            case 'waiting': incoming.waiting = true; break;
            case 'ready': incoming.phase = 'ready'; incoming.url = String(event.url ?? ''); incoming.waiting = false; break;
            case 'ask': this.ask(proc, event); break;
            case 'declined': incoming.phase = 'ready'; break;
            case 'progress': incoming.phase = 'receiving'; incoming.peer = String(event.peer ?? ''); incoming.done = Number(event.done) || 0; incoming.total = Number(event.total) || 0; break;
            case 'received': this.received(incoming, event); break;
            case 'expired': incoming.phase = 'expired'; break;
            case 'error': incoming.phase = 'failed'; incoming.error = String(event.message ?? ''); break;
            default: return;
            }
            this.changed();
        });
        proc.wait_async(null, (p, result) => {
            try { p.wait_finish(result); } catch { /* Ended. */ }
            if (this.receiveProc !== p) return;
            this.receiveProc = null; this.question?.answer(false);
            if (['starting', 'ready', 'receiving'].includes(incoming.phase)) incoming.phase = 'expired';
            if (!this.life.closed) this.changed();
        });
        this.changed();
        return true;
    }
    // A phone wants to send: the notch asks with the AirDrop question; no answer is a no.
    ask(proc, event) {
        this.question?.answer(false);
        const count = Number(event.count) || 0, names = Array.isArray(event.files) ? event.files.map(String) : [];
        const what = count === 1 ? fmt(_('wants to send “%s”'), names[0] ?? '') : fmt(ngettext('wants to send %1$d file (%2$s)', 'wants to send %1$d files (%2$s)', count), count, formatBytes(Number(event.size) || 0));
        const question = {sender: String(event.peer || _('Phone')), what, files: names.join(', '), timeout: ASK_MS, asked: GLib.get_monotonic_time(), via: 'qr', answer: accepted => {
            if (this.question !== question) return;
            this.question = null; this.life.cancel(question.timer);
            proc.notchyWrite(`${accepted ? 'accept' : 'decline'} ${event.id}`);
            this.changed();
        }};
        question.timer = this.life.later(ASK_MS, () => question.answer(false));
        this.question = question;
    }
    // Files arrived: into the Regal; the session stays open for more („Weitere senden“ on the phone).
    received(incoming, event) {
        incoming.phase = 'ready'; incoming.peer = String(event.peer ?? incoming.peer); incoming.done = 0; incoming.total = 0;
        const paths = (Array.isArray(event.paths) ? event.paths : []).map(String).filter(path => GLib.file_test(path, GLib.FileTest.IS_REGULAR));
        for (const path of paths) this.shelf.add(Gio.File.new_for_path(path).get_uri());
        incoming.count = (incoming.count ?? 0) + paths.length;
    }
    stopReceive() {
        const proc = this.receiveProc;
        this.question?.answer(false);
        if (!proc) return;
        this.receiveProc = null;
        if (this.incoming && ['starting', 'ready', 'receiving'].includes(this.incoming.phase)) this.incoming.phase = 'expired';
        proc.notchyWrite('stop'); try { proc.force_exit(); } catch { /* Gone. */ }
        this.changed();
    }
    // What the closed notch shows while a QR session runs: {icon, text, progress}.
    get activity() {
        const send = this.send, incoming = this.incoming;
        if (send && SENDING.includes(send.phase)) {
            if (send.phase === 'sending' && send.total > 0) return {icon: 'notchy-qr-symbolic', progress: Math.round(send.done / send.total * 100)};
            return {icon: 'notchy-qr-symbolic', text: send.phase === 'starting' ? _('Starting…') : _('Ready'), progress: null};
        }
        if (this.receiving) {
            if (incoming.phase === 'receiving' && incoming.total > 0) return {icon: 'notchy-qr-symbolic', progress: Math.round(incoming.done / incoming.total * 100)};
            return {icon: 'notchy-qr-symbolic', text: _('Receiving'), progress: null};
        }
        return null;
    }
    // A share's progress line: "Pixel 8 is downloading · 45 %".
    static percent(state) { return state.total > 0 ? formatPercent(Math.round(state.done / state.total * 100)) : ''; }
    dispose() {
        this.question?.answer(false);
        for (const proc of [this.sendProc, this.receiveProc]) if (proc) { proc.notchyWrite('stop'); try { proc.force_exit(); } catch { /* Gone. */ } }
        this.sendProc = this.receiveProc = null;
        this.life.dispose(); this.listeners.clear();
    }
}
