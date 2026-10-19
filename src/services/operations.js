import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Emitter, Lifetime} from '../lifecycle.js';
import {helperLauncher} from '../i18n/gnome.js';
import {_} from '../i18n/core.js';

export class Operations extends Emitter {
    constructor(extension, shelf) {
        super(); this.extension = extension; this.shelf = shelf; this.life = new Lifetime(); this.processes = new Set(); this.busy = 0; this.message = '';
    }
    available(command) { return Boolean(GLib.find_program_in_path(command)); }
    async run(action, uri, extra = '') {
        if (this.life.closed) return;
        // The helper's messages (shown as notifications) speak Notchy's language.
        const proc = helperLauncher(this.extension.settings, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
            .spawnv(['/usr/bin/python3', `${this.extension.path}/helper/operations.py`, action, uri, extra]);
        this.processes.add(proc); this.busy++; this.message = _('Processing the file…'); this.changed();
        try {
            const [out, err] = await new Promise((resolve, reject) => proc.communicate_utf8_async(null, this.life.cancellable, (p, result) => {
                try { const [_ok, stdout, stderr] = p.communicate_utf8_finish(result); resolve([stdout, stderr]); } catch (e) { reject(e); }
            }));
            if (this.life.closed) return;
            if (!proc.get_successful()) throw Error(err.trim().slice(-500) || _('Processing failed'));
            const result = JSON.parse(out);
            if (result.uri) this.shelf.add(result.uri);
            if (result.text) {
                const St = (await import('gi://St')).default;
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, result.text);
            }
            this.message = result.message ?? _('Done'); Main.notify('Notchy', this.message);
        } catch (e) { if (!this.life.closed) { this.message = e.message; Main.notify('Notchy', e.message); } }
        finally { this.processes.delete(proc); this.busy--; if (!this.life.closed) this.changed(); }
    }
    dispose() { this.life.dispose(); for (const proc of this.processes) { try { proc.send_signal(15); } catch { /* already exited */ } } this.processes.clear(); this.listeners.clear(); }
}
