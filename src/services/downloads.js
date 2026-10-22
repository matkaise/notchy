import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';
import {Downloads as DownloadModel, downloadName} from './progressModel.js';

// Browser downloads as live activities. Chrome and Firefox publish their
// progress nowhere Notchy could read it (Chrome's LauncherEntry progress only
// runs under Unity), but both write a temporary file into the Downloads
// folder while they download and rename it when it is complete. Notchy
// watches that one folder (inotify through Gio, no polling, not recursive)
// and reads only the names and sizes of those temporary files — never their
// contents, never other folders. The rules are in progressModel.js.
export class DownloadWatch extends Emitter {
    constructor(settings) {
        super(); this.settings = settings; this.life = new Lifetime(); this.model = new DownloadModel(); this.monitor = null; this.wake = 0;
        this.life.connect(settings, 'changed::activities-downloads', () => this.sync());
        this.sync();
    }
    get folder() {
        const path = GLib.getenv('NOTCHY_DOWNLOADS_DIR') || GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        return path ? Gio.File.new_for_path(path) : null;
    }
    // Watching only while the setting is on.
    sync() {
        const on = this.settings.get_boolean('activities-downloads');
        if (on && !this.monitor) this.start();
        else if (!on && this.monitor) { this.stop(); this.changed(); }
    }
    start() {
        const folder = this.folder;
        if (!folder) return;
        try { this.monitor = folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this.life.cancellable); } catch (e) { console.warn(`Notchy downloads: ${e.message}`); return; }
        this.monitorId = this.monitor.connect('changed', (_m, file, other, type) => this.event(file, other, type));
        // What is already there is remembered, and shown only once it grows.
        folder.enumerate_children_async('standard::name,standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, this.life.cancellable, (f, result) => {
            let children;
            try { children = f.enumerate_children_finish(result); } catch { return; }
            const next = () => children.next_files_async(64, GLib.PRIORITY_LOW, this.life.cancellable, (c, r) => {
                let infos = [];
                try { infos = c.next_files_finish(r); } catch { return; }
                if (!infos.length || this.life.closed) { children.close_async(GLib.PRIORITY_LOW, null, null); return; }
                for (const info of infos) if (downloadName(info.get_name()).temp) this.model.seen(info.get_name(), info.get_size(), Date.now(), {initial: true});
                next();
            });
            next();
        });
    }
    stop() {
        if (this.monitorId) this.monitor.disconnect(this.monitorId);
        this.monitor?.cancel(); this.monitor = null; this.monitorId = 0;
        this.model = new DownloadModel(); this.life.cancel(this.wake); this.wake = 0;
    }
    event(file, other, type) {
        if (this.life.closed) return;
        const name = file.get_basename(), now = Date.now();
        let changed = false;
        switch (type) {
        case Gio.FileMonitorEvent.CREATED: case Gio.FileMonitorEvent.CHANGED: case Gio.FileMonitorEvent.CHANGES_DONE_HINT: case Gio.FileMonitorEvent.MOVED_IN:
            if (downloadName(name).temp) changed = this.model.seen(name, sizeOf(file), now);
            break;
        case Gio.FileMonitorEvent.RENAMED: {
            // A known download renamed on, or one that appears under a temporary name by a rename.
            const to = other?.get_basename() ?? '';
            if (this.model.entries.has(name)) changed = this.model.renamed(name, to, now);
            else if (downloadName(to).temp) changed = this.model.seen(to, sizeOf(other), now);
            break;
        }
        case Gio.FileMonitorEvent.DELETED: case Gio.FileMonitorEvent.MOVED_OUT:
            changed = this.model.deleted(name, now);
            break;
        default: return;
        }
        if (changed) { this.schedule(); this.changed(); }
    }
    // One timeout: when a download goes quiet or a finished one leaves.
    schedule() {
        this.life.cancel(this.wake); this.wake = 0;
        const next = this.model.nextWake(Date.now());
        if (next !== null) this.wake = this.life.later(Math.ceil(next) + 50, () => { this.wake = 0; this.schedule(); this.changed(); });
    }
    list(now = Date.now()) { return this.model.list(now); }
    file(entry) { const folder = this.folder; return folder ? folder.get_child(entry.file) : null; }
    dispose() { this.stop(); this.life.dispose(); this.listeners.clear(); }
}

function sizeOf(file) {
    try { return file.query_info('standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_size(); } catch { return 0; }
}
