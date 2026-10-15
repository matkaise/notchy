import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';
import {BleWake} from './blewake.js';

// AirDrop through the airdrop-mt7921 backend (github.com/jedbillyb/airdrop-mt7921):
// OWL speaks AWDL on the MediaTek card and a patched OpenDrop speaks AirDrop.
// Notchy is its front end. It never runs anything as root itself; the
// backend's own narrow sudo helper does that.
//
// Receiving runs `airdropd run` in exclusive mode: the Wi-Fi card is taken
// only while switched on and comes back by itself shortly after the last
// transfer. Every incoming transfer asks through helper/airdrop-confirm, which
// asks Notchy over D-Bus; anything but an explicit „Annehmen“ declines.
// Sending runs `airdropd send`, which wakes the phone over Bluetooth, finds
// the first AirDrop receiver in range and sends to it; the phone accepts.

const HOME = GLib.get_home_dir();
const CANDIDATES = ['airdrop-mt7921', 'src/airdrop-mt7921', 'Projekte/airdrop-mt7921', 'Schreibtisch/airdrop-mt7921', 'Desktop/airdrop-mt7921', 'git/airdrop-mt7921']
    .map(dir => GLib.build_filenamev([HOME, dir, 'daemon', 'airdropd']));

// The backend's states (airdropd status), as Notchy describes them.
export const AIRDROP_STATES = {
    off: 'Aus', idle: 'Bereit', waking: 'Startet …', armed: 'Empfangsbereit', switching: 'Wechselt Kanal …',
    unreachable: 'Kein iPhone in Reichweite', sending: 'Sendet …', receiving: 'Empfängt …', restoring: 'WLAN verbindet …', error: 'Fehler',
};

export class AirDrop extends Emitter {
    constructor(extension, shelf, settings) {
        super(); this.extension = extension; this.shelf = shelf; this.settings = settings; this.life = new Lifetime();
        // The backend's own Bluetooth wake (btmgmt) hangs on BlueZ 5.85; Notchy wakes the phone itself.
        this.ble = new BleWake();
        this.state = 'off'; this.detail = ''; this.runProc = null; this.sendProc = null; this.send = null; this.question = null; this.received = new Set();
        this.life.connect(settings, 'changed::airdrop-daemon', () => this.changed());
        this.life.connect(settings, 'changed::airdrop-enabled', () => { if (!this.enabled) this.stop(); this.changed(); });
        // The backend writes its state here; every change is read back through `airdropd status`.
        // (NOTCHY_AIRDROP_RUNDIR: the headless test's stand-in keeps its state apart.)
        const runDir = Gio.File.new_for_path(GLib.getenv('NOTCHY_AIRDROP_RUNDIR') || GLib.build_filenamev([GLib.get_user_runtime_dir(), 'airdropd']));
        try { runDir.make_directory_with_parents(null); } catch { /* Exists. */ }
        this.monitor = runDir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this.life.connect(this.monitor, 'changed', (_m, file) => { if (file.get_basename() === 'state.json') this.refresh(); });
        // The backend runs the hooks directly; an extension zip need not keep their mode.
        for (const name of ['airdrop-confirm', 'airdrop-url']) {
            const file = Gio.File.new_for_path(`${extension.path}/helper/${name}`);
            try { file.set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null); } catch { /* Read-only install. */ }
        }
        this.refresh();
    }
    get enabled() { return this.settings.get_boolean('airdrop-enabled'); }
    get daemon() {
        const configured = this.settings.get_string('airdrop-daemon');
        // The headless test must never find (and start) a real installation.
        if (configured || GLib.getenv('NOTCHY_AIRDROP_RUNDIR')) return configured;
        // `airdrop-send` is installed as a symlink into the repository, beside airdropd.
        try {
            const target = GLib.file_read_link('/usr/local/bin/airdrop-send');
            const daemon = GLib.build_filenamev([GLib.path_get_dirname(GLib.path_is_absolute(target) ? target : `/usr/local/bin/${target}`), 'airdropd']);
            if (GLib.file_test(daemon, GLib.FileTest.IS_EXECUTABLE)) return daemon;
        } catch { /* Not installed that way. */ }
        return CANDIDATES.find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? '';
    }
    get available() { const daemon = this.daemon; return this.enabled && Boolean(daemon) && GLib.file_test(daemon, GLib.FileTest.IS_EXECUTABLE); }
    get active() { return this.state !== 'off' && this.state !== 'error'; }
    get receiving() { return Boolean(this.runProc); }
    get folder() {
        const configured = this.settings.get_string('airdrop-folder');
        return configured || GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || HOME, 'AirDrop']);
    }
    launcher() {
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE});
        const helper = name => `${this.extension.path}/helper/${name}`;
        // Exclusive: the card is only taken on demand and given back by itself.
        launcher.setenv('AIRDROP_MODE', 'exclusive', true);
        launcher.setenv('AIRDROP_CONFIRM', helper('airdrop-confirm'), true);
        launcher.setenv('AIRDROP_URL_HOOK', helper('airdrop-url'), true);
        launcher.setenv('RECV_DIR', this.folder, true);
        return launcher;
    }
    // Reads one line at a time from a backend process.
    lines(proc, onLine) {
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const read = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, result) => {
            try {
                const [line] = s.read_line_finish_utf8(result);
                if (line === null) return;
                onLine(line); read();
            } catch { /* Process ended. */ }
        });
        read();
    }
    // Receiving: on until switched off, or until the backend gives the Wi-Fi back.
    receive(on = !this.receiving) {
        if (!on) { this.stop(); return true; }
        if (!this.available || this.runProc) return false;
        GLib.mkdir_with_parents(this.folder, 0o755);
        try {
            const proc = this.launcher().spawnv([this.daemon, 'run']); this.runProc = proc; this.output = [];
            this.lines(proc, line => { this.output.push(line); if (this.output.length > 8) this.output.shift(); });
            this.watchFolder();
            this.state = 'waking'; this.detail = ''; this.changed();
            proc.wait_async(null, (p, result) => {
                try { p.wait_finish(result); } catch { /* Already ended. */ }
                if (this.runProc !== p) return;
                this.runProc = null; this.folderLife?.dispose(); this.folderLife = null;
                // A run that ends at once never got the card: say why instead of failing silently.
                if (!p.get_successful() && this.state === 'waking') { this.state = 'error'; this.detail = this.output.slice(-2).join(' ') || 'AirDrop konnte nicht starten.'; }
                this.refresh(); this.changed();
            });
            return true;
        } catch (e) { this.state = 'error'; this.detail = e.message; this.changed(); return false; }
    }
    stop() {
        if (!this.runProc || !this.daemon) return;
        try { Gio.Subprocess.new([this.daemon, 'stop'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE); } catch { /* Gone. */ }
    }
    // Sending: one transfer after another, each accepted on the phone.
    sendFiles(paths) {
        paths = paths.filter(path => GLib.file_test(path, GLib.FileTest.IS_REGULAR));
        if (!this.available || this.sendProc || !paths.length) return false;
        try {
            this.ble.start();
            const proc = this.launcher().spawnv([this.daemon, 'send', ...paths]); this.sendProc = proc;
            this.send = {files: paths.map(path => GLib.path_get_basename(path)), sent: 0, peer: '', phase: 'searching', error: '', started: GLib.get_monotonic_time()};
            const output = [];
            this.lines(proc, line => {
                output.push(line); if (output.length > 8) output.shift();
                if (line.startsWith('sending to ')) { this.send.peer = line.slice(11).trim(); this.send.phase = 'waiting'; }
                else if (line.startsWith('sent: ')) { this.send.sent++; this.send.phase = 'sending'; }
                else return;
                this.changed();
            });
            proc.wait_async(null, (p, result) => {
                try { p.wait_finish(result); } catch { /* Already ended. */ }
                if (this.sendProc !== p) return;
                this.sendProc = null; this.ble.stop(); this.reapBrowse();
                if (this.send.phase === 'cancelled') { /* The user stopped it. */ }
                else if (p.get_successful()) this.send.phase = 'done';
                else { this.send.phase = 'failed'; this.send.error = describeFailure(output); }
                this.changed();
            });
            this.changed(); return true;
        } catch (e) { this.send = {files: paths, sent: 0, peer: '', phase: 'failed', error: e.message}; this.changed(); return false; }
    }
    // airdropd's browse (`opendrop find`) inherits its lock; when a send is cut
    // short it can outlive it and keep holding the lock, and then the backend
    // refuses every later start. End such leftovers once a send is over.
    reapBrowse() {
        const lock = GLib.build_filenamev([GLib.getenv('NOTCHY_AIRDROP_RUNDIR') || GLib.build_filenamev([GLib.get_user_runtime_dir(), 'airdropd']), 'lock']);
        let entries; try { entries = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null); } catch { return; }
        for (let info; (info = entries.next_file(null));) {
            const pid = Number(info.get_name()); if (!Number.isInteger(pid) || pid <= 1) continue;
            try {
                const [, raw] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
                const cmd = new TextDecoder().decode(raw).split('\0');
                if (!cmd.some(arg => arg.endsWith('/opendrop')) || !cmd.includes('find')) continue;
                const fds = Gio.File.new_for_path(`/proc/${pid}/fd`).enumerate_children('standard::name,standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                let holds = false;
                for (let fd; (fd = fds.next_file(null));) if (fd.get_symlink_target() === lock) holds = true;
                // SIGINT: opendrop writes its report and exits cleanly on it.
                if (holds) GLib.spawn_command_line_async(`kill -INT ${pid}`);
            } catch { /* Gone, or not ours. */ }
        }
    }
    cancelSend() {
        if (!this.sendProc) return;
        this.send.phase = 'cancelled';
        // SIGTERM: airdropd's trap tears its stack down and gives the Wi-Fi back.
        this.sendProc.send_signal(15); this.changed();
    }
    // The backend's verdict, read through `airdropd status` (which knows a stale state file).
    refresh() {
        const daemon = this.daemon; if (!daemon || this.life.closed) return;
        try {
            const proc = Gio.Subprocess.new([daemon, 'status'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, this.life.cancellable, (p, result) => {
                try {
                    const [, out] = p.communicate_utf8_finish(result);
                    const status = JSON.parse(out.trim().split('\n').pop() || '{}');
                    // A start Notchy just asked for may not have written its state yet.
                    if (status.state === 'off' && this.runProc && this.state === 'waking') return;
                    if (status.state === this.state && (status.detail ?? '') === this.detail) return;
                    this.state = AIRDROP_STATES[status.state] ? status.state : 'off'; this.detail = String(status.detail ?? '');
                    this.changed();
                } catch { /* Unreadable status: keep the last one. */ }
            });
        } catch { /* Backend gone. */ }
    }
    // Percent of an arriving transfer, when the backend reports one.
    get progress() { return this.state === 'receiving' && /^\d+$/.test(this.detail) ? Math.min(100, Number(this.detail)) : null; }
    // Asked by helper/airdrop-confirm: resolves true only on an explicit „Annehmen“.
    ask(sender, detail, timeout) {
        this.question?.answer(false);
        return new Promise(resolve => {
            const question = {sender, files: detail, timeout, asked: GLib.get_monotonic_time(), answer: accepted => {
                if (this.question !== question) return;
                this.question = null; this.life.cancel(question.timer); resolve(Boolean(accepted)); this.changed();
            }};
            question.timer = this.life.later(timeout, () => question.answer(false));
            this.question = question; this.changed();
        });
    }
    // Received files land in the folder; each finished one joins the Regal.
    watchFolder() {
        this.folderLife?.dispose(); this.folderLife = new Lifetime();
        const life = this.folderLife, folder = Gio.File.new_for_path(this.folder), pending = new Map();
        const monitor = folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null); life.cleanups.push(() => monitor.cancel());
        life.connect(monitor, 'changed', (_m, file, other, event) => {
            const target = event === Gio.FileMonitorEvent.MOVED_IN || event === Gio.FileMonitorEvent.RENAMED ? other ?? file : file;
            if (!target || ![Gio.FileMonitorEvent.CREATED, Gio.FileMonitorEvent.MOVED_IN, Gio.FileMonitorEvent.RENAMED, Gio.FileMonitorEvent.CHANGES_DONE_HINT].includes(event)) return;
            const name = target.get_basename();
            // iOS wraps transfers in NSIRD_AirDrop_* folders with ._ sidecars; the backend flattens them.
            if (!name || name.startsWith('.') || name.startsWith('NSIRD_') || !target.get_parent()?.equal(folder)) return;
            life.cancel(pending.get(name));
            pending.set(name, life.later(1500, () => {
                pending.delete(name);
                if (this.received.has(target.get_uri()) || !GLib.file_test(target.get_path(), GLib.FileTest.IS_REGULAR)) return;
                this.received.add(target.get_uri()); this.shelf.add(target.get_uri());
                this.lastReceived = name; this.changed();
                this.extension.activeIsland()?.toast('notchy-airdrop-symbolic', `${name} im Regal`);
            }));
        });
    }
    dispose() {
        // Never leave the Wi-Fi card taken when Notchy goes away.
        this.stop(); this.cancelSend(); this.ble.stop(); this.question?.answer(false);
        this.folderLife?.dispose(); this.monitor?.cancel(); this.life.dispose(); this.listeners.clear();
    }
}

// The backend's own words for the common failures, as one short German line.
export function describeFailure(lines) {
    const text = lines.join('\n');
    if (/without a password|sudo/.test(text)) return 'AirDrop ist noch nicht eingerichtet (sudo-Regel fehlt).';
    if (/jq is required/.test(text)) return 'Dem AirDrop-Backend fehlt jq.';
    if (/no receiver|not found|No receiver/i.test(text)) return 'Kein iPhone gefunden. AirDrop auf „Für alle“ stellen und das Teilen-Menü schließen.';
    if (/declin/i.test(text)) return 'Auf dem iPhone abgelehnt.';
    if (/could not bring the stack up/.test(text)) return 'Die WLAN-Karte ließ sich nicht für AirDrop umschalten.';
    return lines.filter(Boolean).at(-1)?.slice(0, 120) || 'Senden fehlgeschlagen.';
}
