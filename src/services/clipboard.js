import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import {History, parseUris, normalizeTags, combineCopies} from '../model.js';
import {Emitter, Lifetime} from '../lifecycle.js';

const TYPE = Meta.SelectionType.SELECTION_CLIPBOARD;
export class Clipboard extends Emitter {
    constructor(settings, store) {
        super(); this.settings = settings; this.store = store; this.life = new Lifetime(); this.generation = 0;
        this.assets = `${store.dir}/clipboard-assets`; this.pendingAssets = new Set(); GLib.mkdir_with_parents(this.assets, 0o700);
        const saved = settings.get_boolean('clipboard-persist') ? store.read('clipboard', []) : [];
        this.history = new History(Array.isArray(saved) ? saved : [], settings.get_int('clipboard-limit'));
        this.history.items = this.history.items.filter(x => !x.asset || x.asset.startsWith(`${this.assets}/`));
        // Pictures saved by older versions were keyed by a German word.
        for (const item of this.history.items) if (item.kind === 'image' && /^Bild [0-9a-f]{12}$/.test(item.text)) item.text = `image:${item.text.slice(5)}`;
        this.life.connect(settings, 'changed', (_s, key) => {
            if (!key.startsWith('clipboard-')) return;
            this.history.limit = settings.get_int('clipboard-limit'); this.prune();
            if (!settings.get_boolean('clipboard-persist')) store.write('clipboard', []);
            this.changed();
        });
        this.life.connect(global.display.get_selection(), 'owner-changed', (_s, type, owner) => {
            if (type === TYPE) { this.generation++; if (owner) this._capture(owner); }
        });
        this.prune(); this.life.every(60000, () => this.prune());
    }
    prune() { const previous = this.history.items.length; this.history.prune(this.settings.get_int('clipboard-retention-days')); this.save(); this._cleanAssets(); if (previous !== this.history.items.length) this.changed(); }
    async _capture(owner) {
        const token = this.generation;
        if (!this.settings.get_boolean('clipboard-enabled')) return;
        const focusApp = global.display.focus_window ? Shell.WindowTracker.get_default().get_window_app(global.display.focus_window) : null;
        if (focusApp && this.settings.get_strv('exclude-apps').includes(focusApp.get_id())) return;
        const mimes = owner.get_mimetypes();
        if (mimes.some(x => /password|concealed|sensitive|x-kde-passwordManagerHint|x-notchy-secret/i.test(x))) return;
        const mime = ['text/uri-list','image/png','text/plain;charset=utf-8','UTF8_STRING','text/plain'].find(x => mimes.includes(x));
        if (!mime) return;
        const source = focusApp?.get_name() ?? '';
        const sizeLimit = mime === 'image/png' ? 20 * 1024 * 1024 : 1024 * 1024;
        const out = Gio.MemoryOutputStream.new_resizable();
        try {
            await new Promise((resolve, reject) => global.display.get_selection().transfer_async(TYPE, mime,
                sizeLimit, out, this.life.cancellable, (sel, result) => {
                    try { sel.transfer_finish(result); resolve(); } catch (e) { reject(e); }
                }));
            out.close(null); const bytes = out.steal_as_bytes().get_data();
            if (this.life.closed || token !== this.generation || !this.settings.get_boolean('clipboard-enabled') || !bytes.length || bytes.length >= sizeLimit) return;
            let item;
            if (mime === 'image/png') {
                const digest = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
                const file = Gio.File.new_for_path(`${this.assets}/${digest}.png`);
                this.pendingAssets.add(file.get_path());
                try { await new Promise((resolve, reject) => file.replace_contents_async(bytes, null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, this.life.cancellable, (f, res) => {
                        try { f.replace_contents_finish(res); resolve(); } catch (e) { reject(e); }
                    })); } finally { this.pendingAssets.delete(file.get_path()); }
                if (this.life.closed || token !== this.generation || !this.settings.get_boolean('clipboard-enabled')) { this._cleanAssets(null); return; }
                // The text is the picture's identity for deduplication, never shown (see clipTitle).
                item = this.history.add(`image:${digest.slice(0, 12)}`, source); if (item) { item.kind = 'image'; item.asset = file.get_path(); item.title = ''; }
            } else {
                const text = new TextDecoder().decode(bytes);
                item = this.history.add(text, source);
                if (item && mime === 'text/uri-list') { item.kind = 'files'; item.uris = parseUris(text); item.title = ''; }
            }
            if (item) { this.save(); this._cleanAssets(); this.changed(); }
        } catch (e) { if (!this.life.closed) console.warn(`Notchy clipboard: ${e.message}`); }
    }
    copy(item) {
        if (item.kind === 'files') St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', new TextEncoder().encode(item.uris.join('\r\n') + '\r\n'));
        else if (item.kind === 'image' && item.asset?.startsWith(`${this.assets}/`)) {
            Gio.File.new_for_path(item.asset).load_contents_async(this.life.cancellable, (file, result) => {
                try { const [ok, bytes] = file.load_contents_finish(result); if (ok && !this.life.closed) St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes); }
                catch (e) { if (!this.life.closed) console.warn(e.message); }
            });
        } else St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.text);
    }
    rename(id, title) { const item = this.history.items.find(x => x.id === id); if (item) item.title = title.slice(0, 200); this.save(); this.changed(); }
    edit(id, title, tags) { const item = this.history.items.find(x => x.id === id); if (!item) return;
        item.title = title.slice(0, 200); item.tags = normalizeTags(tags); this.save(); this.changed(); }
    copyMany(ids) {
        const items = ids.map(id => this.history.items.find(x => x.id === id)).filter(Boolean);
        if (items.length === 1) { this.copy(items[0]); return true; }
        const copy = combineCopies(items); if (!copy) return false;
        if (copy.mime === 'text/plain') St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, copy.text);
        else St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, copy.mime, new TextEncoder().encode(copy.text));
        return true;
    }
    removeMany(ids) { const selected = new Set(ids); this.history.items = this.history.items.filter(x => !selected.has(x.id)); this.save(); this._cleanAssets(); this.changed(); }
    favorite(id) { const item = this.history.items.find(x => x.id === id); if (item) item.favorite = !item.favorite; this.save(); this.changed(); }
    remove(id) { this.history.remove(id); this.save(); this._cleanAssets(); this.changed(); }
    clear(keep = true) { this.history.clear(keep); this.save(); this._cleanAssets(); this.changed(); }
    save() { if (this.settings.get_boolean('clipboard-persist')) this.store.write('clipboard', this.history.items); }
    _cleanAssets(cancellable = this.life.cancellable) {
        const keep = new Set(this.history.items.filter(x => x.asset).map(x => x.asset));
        Gio.File.new_for_path(this.assets).enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (dir, result) => {
            try { const list = dir.enumerate_children_finish(result);
                list.next_files_async(2000, GLib.PRIORITY_DEFAULT, cancellable, (enumerator, res) => {
                    try { for (const info of enumerator.next_files_finish(res)) { const file = dir.get_child(info.get_name());
                        if (/^[a-f0-9]{64}\.png$/.test(info.get_name()) && !keep.has(file.get_path()) && !this.history.items.some(x => x.asset === file.get_path()))
                            if (!this.pendingAssets.has(file.get_path())) file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, r) => { try { f.delete_finish(r); } catch { /* Already removed. */ } });
                    } } catch { /* Cancellation. */ } enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
                });
            } catch { /* Cancellation. */ }
        });
    }
    dispose() { if (!this.settings.get_boolean('clipboard-persist')) { this.history.clear(false); this._cleanAssets(null); } this.life.dispose(); this.listeners.clear(); }
}
