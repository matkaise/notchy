import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// A module-wide serialized queue survives quick disable/enable cycles.
// Writes finish without touching disposed UI objects.
const queue = new Map();
const latest = new Map();
let writing = false;
function flush() {
    if (writing || queue.size === 0) return;
    const [path, text] = queue.entries().next().value; queue.delete(path); writing = true;
    Gio.File.new_for_path(path).replace_contents_async(new TextEncoder().encode(text), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null,
        (file, result) => {
            try { file.replace_contents_finish(result); } catch (e) { console.error(`Notchy storage: ${e.message}`); }
            writing = false; flush();
        });
}

export class Store {
    constructor() {
        this.disposed = false; this.dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchy']);
        GLib.mkdir_with_parents(this.dir, 0o700);
    }
    read(name, fallback) {
        const path = `${this.dir}/${name}.json`;
        try {
            if (latest.has(path)) return JSON.parse(latest.get(path));
            const file = Gio.File.new_for_path(path); const [ok, bytes] = file.load_contents(null);
            if (ok) return JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) { if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) console.warn(`Notchy ${name}: ${e.message}`); }
        return fallback;
    }
    write(name, data) {
        if (this.disposed) return;
        const path = `${this.dir}/${name}.json`, text = JSON.stringify(data);
        latest.set(path, text); queue.set(path, text); flush();
    }
    dispose() { this.disposed = true; flush(); }
}
