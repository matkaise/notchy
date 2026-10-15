import Gio from 'gi://Gio';
import {Emitter} from '../lifecycle.js';
import {parseUris} from '../model.js';

export class Shelf extends Emitter {
    constructor(store) {
        super(); this.store = store;
        const saved = store.read('shelf', []);
        this.items = Array.isArray(saved) ? saved.filter(x => x && parseUris(x.uri).length && typeof x.name === 'string') : [];
    }
    add(text) {
        let count = 0;
        for (const uri of parseUris(text)) {
            if (this.items.some(x => x.uri === uri) || this.items.length >= 200) continue;
            const file = Gio.File.new_for_uri(uri);
            if (!file.get_path()) continue;
            const name = file.get_basename();
            this.items.push({uri: file.get_uri(), name, added: Date.now()}); count++;
        }
        if (count) this.save();
        return count;
    }
    remove(uri) { this.items = this.items.filter(x => x.uri !== uri); this.save(); }
    clear() { this.items = []; this.save(); }
    save() { this.store.write('shelf', this.items); this.changed(); }
    dispose() { this.listeners.clear(); }
}
