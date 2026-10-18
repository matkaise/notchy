import GLib from 'gi://GLib';
import {rank, recordUse, recentUses, fileQuery} from './logic.js';
import {CalculatorProvider, UnitsProvider, QuicklinkProvider, WebSearchProvider, AppsProvider, SystemProvider, WindowProvider,
    ClipboardProvider, SnippetProvider, EmojiProvider, ShelfProvider, FileProvider, launchUri} from './providers.js';

// The providers the explicit file mode asks (the file index and the Regal).
const FILE_PROVIDERS = ['shelf', 'file'];
// How long typing must pause before the file index is asked.
export const FILE_DEBOUNCE = 140;
// At most this many results in the list (it scrolls beyond the visible rows).
const TOTAL = 24;
// At most this many of one kind in a mixed list.
const PER_KIND = {App: 4, Datei: 4, Ordner: 3, Befehl: 4, Fenster: 3, Emoji: 3, Zeichen: 2, Ablage: 3, Snippet: 3, Link: 3, Regal: 2, Umrechnung: 3, Rechner: 1, Web: 1};

// Thunderstorm's engine: the providers, the usage history (frecency, recent
// results) and one Session per opened search field.
export class Launcher {
    constructor(extension, files) {
        this.extension = extension; this.settings = extension.settings; this.store = extension.store; this.files = files;
        const saved = this.store.read('launcher-history', {});
        this.history = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        // Provider order breaks ties between equal scores.
        this.providers = {
            calc: new CalculatorProvider(), units: new UnitsProvider(), link: new QuicklinkProvider(this.settings), app: new AppsProvider(),
            cmd: new SystemProvider(extension), win: new WindowProvider(extension), clip: new ClipboardProvider(extension),
            snippet: new SnippetProvider(this.settings), emoji: new EmojiProvider(), shelf: new ShelfProvider(extension),
            file: new FileProvider(extension, files), web: new WebSearchProvider(this.settings),
        };
    }
    record(result) {
        if (!result?.revive) return;
        this.history = recordUse(this.history, result.id, {title: result.title, kind: result.kind, ...result.revive});
        this.store.write('launcher-history', this.history);
    }
    forget(id) { const next = {...this.history}; delete next[id]; this.history = next; this.store.write('launcher-history', next); }
    session(ctx, life, onUpdate) { return new Session(this, ctx, life, onUpdate); }
}

export class Session {
    constructor(launcher, ctx, life, onUpdate) {
        this.launcher = launcher; this.ctx = ctx; this.life = life; this.onUpdate = onUpdate;
        this.generation = 0; this.timer = 0; this.syncResults = []; this.fileResults = []; this.pending = false;
    }
    get limit() { return TOTAL; }
    perKind(query) {
        // An explicit prefix ("emoji herz", ":herz", "ablage …") lists more of that kind.
        if (/^(emoji|zeichen|symbol)\s|^:/i.test(query)) return {...PER_KIND, Emoji: TOTAL, Zeichen: TOTAL};
        if (/^(ablage|clip|clipboard|zwischenablage)\s/i.test(query)) return {...PER_KIND, Ablage: 10};
        if (/^(snippet|snip|text)\s/i.test(query)) return {...PER_KIND, Snippet: 10};
        return PER_KIND;
    }
    merged(query, mode = 'all') {
        const perKind = mode === 'files' ? {} : this.perKind(query);
        return rank([...this.syncResults, ...this.fileResults], {history: this.launcher.history, limit: TOTAL, perKind, mode});
    }
    // Drop every answer still on its way (a drill-down took over the list).
    cancel() { this.generation++; this.life.cancel(this.timer); this.timer = 0; this.pending = false; }
    query(text) {
        const generation = ++this.generation;
        // "datei …", "file …" or "/…" searches files and folders only.
        const only = fileQuery(text), mode = only === null ? 'all' : 'files', query = only ?? text.trim();
        this.life.cancel(this.timer); this.timer = 0; this.fileResults = [];
        if (!text.trim()) { this.empty(generation); return; }
        this.syncResults = [];
        for (const [name, provider] of Object.entries(this.launcher.providers)) {
            if (!provider.search || (mode === 'files' && !FILE_PROVIDERS.includes(name))) continue;
            try { this.syncResults.push(...provider.search(mode === 'files' ? query : text, this.ctx)); } catch (e) { console.warn(`Notchy launcher ${name}: ${e.message}`); }
        }
        const files = this.launcher.providers.file;
        this.pending = files.files.enabled && query.length >= 2;
        this.mode = mode;
        this.onUpdate(this.merged(query, mode), {pending: this.pending, mode});
        if (!this.pending) return;
        // Debounced; an answer for an older query is dropped by its generation.
        this.timer = this.life.later(FILE_DEBOUNCE, async () => {
            this.timer = 0;
            let results = null;
            try { results = await files.searchAsync(query, this.ctx); } catch (e) { console.warn(`Notchy file search: ${e.message}`); }
            if (generation !== this.generation || this.life.closed) return;
            this.pending = false; this.fileResults = results ?? [];
            this.onUpdate(this.merged(query, mode), {pending: false, mode});
        });
    }
    // The empty field: recently used results, the dock's favourites, recent files.
    empty(generation) {
        const providers = this.launcher.providers, revivers = {app: providers.app, cmd: providers.cmd, link: providers.link, snippet: providers.snippet, emoji: providers.emoji, file: providers.file};
        const recent = [];
        for (const entry of recentUses(this.launcher.history, 8)) {
            if (recent.length >= 4) break;
            const result = revivers[entry.provider]?.revive?.(entry, this.ctx);
            if (result) recent.push({...result, section: 'Zuletzt verwendet'});
        }
        const ids = new Set(recent.map(r => r.id));
        const favorites = providers.app.empty().filter(r => !ids.has(r.id)).map(r => ({...r, section: 'Favoriten'}));
        this.syncResults = [...recent, ...favorites];
        this.onUpdate(this.syncResults, {pending: false, empty: true});
        if (!providers.file.files.enabled) return;
        providers.file.recent(this.ctx).then(files => {
            if (generation !== this.generation || this.life.closed) return;
            const shown = new Set(this.syncResults.map(r => r.id));
            const extra = files.filter(r => !shown.has(r.id)).slice(0, 2).map(r => ({...r, section: 'Zuletzt geöffnet'}));
            if (extra.length) this.onUpdate([...this.syncResults, ...extra], {pending: false, empty: true});
        }).catch(() => { /* No recent files. */ });
    }
    // Indexed folders, as a list of their own (from „Indizierte Ordner anzeigen“).
    async indexed() {
        const status = await this.launcher.files.status();
        const local = status.backend === 'localsearch';
        const folders = local ? [...(status.indexed ?? []), ...(status.single ?? [])] : status.fallback ?? [];
        const home = GLib.get_home_dir();
        const rows = folders.map((path, i) => ({id: `indexed:${path}`, kind: local ? 'Indiziert' : 'Einfache Suche', title: path === home ? 'Persönlicher Ordner' : GLib.path_get_basename(path),
            subtitle: path, icon: 'folder-symbolic', score: 100 - i, section: local ? 'Von GNOME LocalSearch indiziert' : 'LocalSearch läuft nicht · einfache Suche in',
            actions: [{title: 'Ordner öffnen', icon: 'folder-open-symbolic', run: () => launchUri(GLib.filename_to_uri(path, null))}]}));
        rows.push({id: 'indexed:settings', kind: 'Befehl', title: 'Suchordner bearbeiten …', subtitle: 'In den Notchy-Einstellungen (Thunderstorm)', icon: 'emblem-system-symbolic', score: 0, section: 'Einstellungen',
            actions: [{title: 'Einstellungen öffnen', icon: 'emblem-system-symbolic', run: () => this.launcher.extension.openPreferences()}]});
        return rows;
    }
}
