import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';

// The helper stays up between searches and ends after this much quiet.
const IDLE_EXIT = 5 * 60 * 1000;

// Thunderstorm's file search. The work happens in helper/filesearch.py, a
// small long-lived process: it queries GNOME LocalSearch's index over D-Bus
// (or crawls the personal folders, bounded, when no indexer runs) and checks
// the candidates on disk. The Shell only writes one JSON line per request and
// reads the answers asynchronously, so no file access ever blocks it.
export class FileSearch extends Emitter {
    constructor(extension, settings) {
        super(); this.extension = extension; this.settings = settings; this.life = new Lifetime();
        this.proc = null; this.pending = new Map(); this.nextId = 1; this.idle = 0; this.backend = null;
    }
    get enabled() { return this.settings.get_boolean('launcher-file-search'); }
    start() {
        if (this.proc || this.life.closed) return true;
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
            // Tests point the helper at a stand-in index and their own folders; it never starts a real indexer.
            for (const name of ['NOTCHY_LOCALSEARCH_NAME', 'NOTCHY_FALLBACK_ROOTS']) { const value = GLib.getenv(name); if (value) launcher.setenv(name, value, true); }
            const proc = launcher.spawnv(['/usr/bin/python3', `${this.extension.path}/helper/filesearch.py`]);
            this.proc = proc; this.stdin = proc.get_stdin_pipe();
            this.stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
            this.read(proc);
            proc.wait_async(null, () => {
                if (this.proc !== proc) return;
                this.proc = null; this.stdin = null; this.stdout = null; this.fail('Dateisuche wurde beendet.');
            });
            return true;
        } catch (e) { console.warn(`Notchy file search: ${e.message}`); this.proc = null; return false; }
    }
    read(proc) {
        const stream = this.stdout; if (!stream) return;
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this.life.cancellable, (s, result) => {
            let line = null;
            try { [line] = s.read_line_finish_utf8(result); } catch { return; }
            if (line === null || this.proc !== proc) return;
            try {
                const reply = JSON.parse(line), pending = this.pending.get(reply.id);
                if (pending) { this.pending.delete(reply.id); pending(reply); }
                if (reply.backend && reply.backend !== 'none' && reply.backend !== this.backend) { this.backend = reply.backend; this.changed(); }
            } catch (e) { console.warn(`Notchy file search: ${e.message}`); }
            this.read(proc);
        });
    }
    fail(error) { for (const resolve of this.pending.values()) resolve({error, results: []}); this.pending.clear(); }
    request(message) {
        if (this.life.closed || !this.start()) return Promise.resolve({error: 'Dateisuche nicht verfügbar', results: []});
        this.life.cancel(this.idle);
        this.idle = this.life.later(IDLE_EXIT, () => { this.idle = 0; this.stop(); });
        const id = this.nextId++;
        return new Promise(resolve => {
            this.pending.set(id, resolve);
            const bytes = new TextEncoder().encode(`${JSON.stringify({id, extra: this.settings.get_strv('launcher-extra-folders'), ...message})}\n`);
            this.stdin.write_bytes_async(new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT, this.life.cancellable, (stream, result) => {
                try { stream.write_bytes_finish(result); } catch (e) { if (this.pending.delete(id)) resolve({error: e.message, results: []}); }
            });
        });
    }
    // Resolves with {backend, results} or {superseded: true} when a newer search overtook it.
    search(query, limit = 30, hidden = false) { return this.request({op: 'search', query, limit, hidden}); }
    status() { return this.request({op: 'status'}); }
    recent(limit = 6) { return this.request({op: 'recent', limit}); }
    stop() {
        const proc = this.proc; this.proc = null; this.stdin = null; this.stdout = null;
        this.fail('Dateisuche beendet.');
        try { proc?.force_exit(); } catch { /* Already gone. */ }
    }
    dispose() { this.life.dispose(); this.stop(); this.listeners.clear(); }
}
