import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Emitter, Lifetime} from '../lifecycle.js';
import {helperLauncher} from '../i18n/gnome.js';
import {_} from '../i18n/core.js';

// A finished job stays in the list this long (the live activity lingers less, see activityModel.js).
const KEEP_MS = 30000;
// What each action does, for its live activity.
const ACTION_TEXT = {copy: () => _('Copying'), zip: () => _('Compressing'), 'zip-many': () => _('Compressing'), image: () => _('Converting'), 'pdf-compress': () => _('Compressing the PDF'),
    'document-pdf': () => _('Converting to PDF'), ocr: () => _('Recognizing text'), background: () => _('Removing the background'), video: () => _('Compressing the video')};
export const actionText = action => ACTION_TEXT[action]?.() ?? _('Processing the file…');

// File work Notchy runs (helper/operations.py): one job per run, with the
// progress the helper measured (bytes for copy and ZIP, FFmpeg's position for
// videos; nothing for the others), its result and a way to cancel it. The
// jobs are a source of live activities (src/services/activities.js).
export class Operations extends Emitter {
    constructor(extension, shelf) {
        super(); this.extension = extension; this.shelf = shelf; this.life = new Lifetime(); this.processes = new Set(); this.busy = 0; this.message = '';
        this.jobs = new Map(); this.seq = 0;
    }
    available(command) { return Boolean(GLib.find_program_in_path(command)); }
    async run(action, uri, extra = '') {
        if (this.life.closed) return;
        // The helper's messages (shown as notifications) speak Notchy's language.
        const proc = helperLauncher(this.extension.settings, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
            .spawnv(['/usr/bin/python3', `${this.extension.path}/helper/operations.py`, action, uri, extra]);
        const name = action === 'zip-many' ? '' : GLib.path_get_basename(Gio.File.new_for_uri(uri).get_path() ?? uri);
        const job = {id: `op${++this.seq}`, action, name, started: Date.now(), progress: null, state: 'running', message: '', proc, cancelled: false};
        this.jobs.set(job.id, job);
        this.processes.add(proc); this.busy++; this.message = _('Processing the file…'); this.changed();
        try {
            const errors = readAll(proc.get_stderr_pipe(), this.life.cancellable);
            let result = null;
            await readLines(proc.get_stdout_pipe(), this.life.cancellable, line => {
                const match = /^progress (\d+(?:\.\d+)?)$/.exec(line);
                if (match) {
                    const value = Math.max(0, Math.min(1, Number(match[1])));
                    if (value !== job.progress && !this.life.closed) { job.progress = value; this.changed(); }
                } else if (line.startsWith('{')) result = line;
            });
            const err = await errors;
            await new Promise(resolve => proc.wait_async(this.life.cancellable, (p, r) => { try { p.wait_finish(r); } catch { /* Cancelled. */ } resolve(); }));
            if (this.life.closed) return;
            if (job.cancelled) { this.jobs.delete(job.id); return; }
            if (!proc.get_successful()) throw Error(err.trim().slice(-500) || _('Processing failed'));
            const output = JSON.parse(result ?? '{}');
            if (output.uri) this.shelf.add(output.uri);
            if (output.text) {
                const St = (await import('gi://St')).default;
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, output.text);
            }
            this.message = output.message ?? _('Done'); job.state = 'completed'; job.message = this.message; Main.notify('Notchy', this.message);
        } catch (e) {
            if (!this.life.closed && !job.cancelled) { this.message = e.message; job.state = 'error'; job.message = e.message; Main.notify('Notchy', e.message); }
            else this.jobs.delete(job.id);
        } finally {
            this.processes.delete(proc); this.busy--; job.proc = null;
            if (!this.life.closed) {
                if (this.jobs.has(job.id)) this.life.later(KEEP_MS, () => { if (this.jobs.delete(job.id)) this.changed(); });
                this.changed();
            }
        }
    }
    // Stops a running job (the helper ends its own child processes); it leaves without a result.
    cancel(id) {
        const job = this.jobs.get(id);
        if (!job?.proc || job.state !== 'running') return false;
        job.cancelled = true;
        try { job.proc.send_signal(15); } catch { /* Already exited. */ }
        return true;
    }
    dispose() { this.life.dispose(); for (const proc of this.processes) { try { proc.send_signal(15); } catch { /* already exited */ } } this.processes.clear(); this.jobs.clear(); this.listeners.clear(); }
}

// A pipe's lines, one callback each, until it ends.
function readLines(stream, cancellable, onLine) {
    const data = new Gio.DataInputStream({base_stream: stream, close_base_stream: true});
    return new Promise(resolve => {
        const next = () => data.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
            let line = null;
            try { [line] = s.read_line_finish_utf8(result); } catch { resolve(); return; }
            if (line === null) { resolve(); return; }
            try { onLine(line); } catch (e) { console.error(e); }
            next();
        });
        next();
    });
}
// A pipe's whole text.
async function readAll(stream, cancellable) {
    const lines = [];
    await readLines(stream, cancellable, line => { if (lines.length < 400) lines.push(line); });
    return lines.join('\n');
}
