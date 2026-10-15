import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';

export class Cover extends Emitter {
    constructor(extension, media, settings) {
        super(); this.extension = extension; this.media = media; this.settings = settings; this.life = new Lifetime(); this.uri = ''; this.file = null; this.generation = 0; this.proc = null;
        this.life.cleanups.push(media.subscribe(() => this.sync()));
        this.life.connect(settings, 'changed::media-enabled', () => this.sync()); this.sync();
    }
    stop() { if (this.proc?.get_identifier()) this.proc.force_exit(); this.proc = null; }
    sync() {
        const uri = this.settings.get_boolean('media-enabled') ? this.media.state?.art ?? '' : '';
        if (uri === this.uri) return;
        this.uri = uri; const generation = ++this.generation; this.stop(); this.file = null;
        if (uri.startsWith('file://')) this.file = Gio.File.new_for_uri(uri);
        this.changed();
        if (!/^https?:\/\//i.test(uri) || this.life.closed) return;
        try {
            const directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchy', 'covers']);
            const proc = Gio.Subprocess.new(['/usr/bin/python3', `${this.extension.path}/helper/cover.py`, uri, directory], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this.proc = proc;
            proc.communicate_utf8_async(null, this.life.cancellable, (p, result) => {
                try {
                    const [ok, stdout] = p.communicate_utf8_finish(result);
                    if (!this.life.closed && generation === this.generation && ok && p.get_successful() && stdout.trim().startsWith(directory + '/')) {
                        this.file = Gio.File.new_for_path(stdout.trim()); this.changed();
                    }
                } catch { /* Keep the music icon when fetch is cancelled or unavailable. */ }
                if (this.proc === proc) this.proc = null;
            });
        } catch { /* Optional network artwork never prevents playback controls. */ }
    }
    dispose() { this.life.dispose(); this.stop(); this.file = null; this.listeners.clear(); }
}
