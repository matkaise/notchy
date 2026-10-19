import GLib from 'gi://GLib';
import {rank, recordUse, recentUses, fileQuery, EMOJI_PREFIX, CLIPBOARD_PREFIX, SNIPPET_PREFIX} from './logic.js';
import {migrateHistory} from './commands.js';
import {_} from '../i18n/core.js';
import {CalculatorProvider, UnitsProvider, QuicklinkProvider, WebSearchProvider, AppsProvider, SystemProvider, WindowProvider,
    ClipboardProvider, SnippetProvider, EmojiProvider, ShelfProvider, FileProvider, TimerProvider, launchUri} from './providers.js';

// The providers the explicit file mode asks (the file index and the Regal).
const FILE_PROVIDERS = ['shelf', 'file'];
// How long typing must pause before the file index is asked.
export const FILE_DEBOUNCE = 140;
// At most this many results in the list (it scrolls beyond the visible rows).
const TOTAL = 24;
// At most this many of one kind in a mixed list (kinds are ids, see logic.js).
const PER_KIND = {app: 4, file: 4, folder: 3, command: 4, window: 3, emoji: 3, char: 2, clipboard: 3, snippet: 3, link: 3, shelf: 2, unit: 3, calc: 1, timer: 1, web: 1};

// Thunderstorm's engine: the providers, the usage history (frecency, recent
// results) and one Session per opened search field.
export class Launcher {
    constructor(extension, files) {
        this.extension = extension; this.settings = extension.settings; this.store = extension.store; this.files = files;
        const saved = this.store.read('launcher-history', {});
        const history = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        // Older versions keyed commands by other ids ('cmd:lock'); they keep their frecency.
        this.history = migrateHistory(history);
        if (JSON.stringify(this.history) !== JSON.stringify(history)) this.store.write('launcher-history', this.history);
        // Provider order breaks ties between equal scores.
        this.providers = {
            calc: new CalculatorProvider(), timer: new TimerProvider(extension), units: new UnitsProvider(), link: new QuicklinkProvider(this.settings), app: new AppsProvider(),
            cmd: new SystemProvider(extension), win: new WindowProvider(extension), clip: new ClipboardProvider(extension),
            snippet: new SnippetProvider(this.settings), emoji: new EmojiProvider(), shelf: new ShelfProvider(extension),
            file: new FileProvider(extension, files), web: new WebSearchProvider(this.settings),
        };
    }
    record(result) {
        if (!result?.revive) return;
        // Only ids and what brings the result back: no titles, which are translated.
        this.history = recordUse(this.history, result.id, {...result.revive});
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
        if (EMOJI_PREFIX.test(query)) return {...PER_KIND, emoji: TOTAL, char: TOTAL};
        if (CLIPBOARD_PREFIX.test(query)) return {...PER_KIND, clipboard: 10};
        if (SNIPPET_PREFIX.test(query)) return {...PER_KIND, snippet: 10};
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
    // The empty field: recently used results, favourite commands and the
    // dock's favourites, recent files.
    empty(generation) {
        const providers = this.launcher.providers, revivers = {app: providers.app, cmd: providers.cmd, link: providers.link, snippet: providers.snippet, emoji: providers.emoji, file: providers.file};
        const recent = [];
        for (const entry of recentUses(this.launcher.history, 8)) {
            if (recent.length >= 4) break;
            let result = null;
            try { result = revivers[entry.provider]?.revive?.(entry, this.ctx); } catch (e) { console.warn(`Notchy launcher history: ${e.message}`); }
            if (result) recent.push({...result, section: 'recent'});
        }
        const ids = new Set(recent.map(r => r.id));
        const favorites = [...providers.cmd.favorites(this.ctx), ...providers.app.empty()].filter(r => !ids.has(r.id)).map(r => ({...r, section: 'favorites'}));
        this.syncResults = [...recent, ...favorites];
        this.onUpdate(this.syncResults, {pending: false, empty: true});
        if (!providers.file.files.enabled) return;
        providers.file.recent(this.ctx).then(files => {
            if (generation !== this.generation || this.life.closed) return;
            const shown = new Set(this.syncResults.map(r => r.id));
            const extra = files.filter(r => !shown.has(r.id)).slice(0, 2).map(r => ({...r, section: 'recent-files'}));
            if (extra.length) this.onUpdate([...this.syncResults, ...extra], {pending: false, empty: true});
        }).catch(() => { /* No recent files. */ });
    }
    // Indexed folders, as a list of their own (from "Show Indexed Folders").
    async indexed() {
        const status = await this.launcher.files.status();
        const local = status.backend === 'localsearch';
        const folders = local ? [...(status.indexed ?? []), ...(status.single ?? [])] : status.fallback ?? [];
        const home = GLib.get_home_dir();
        const rows = folders.map((path, i) => ({id: `indexed:${path}`, kind: local ? 'indexed' : 'basic', title: path === home ? _('Home Folder') : GLib.path_get_basename(path),
            subtitle: path, icon: 'folder-symbolic', score: 100 - i, section: local ? 'indexed' : 'basic',
            actions: [{id: 'folder.open', title: _('Open Folder'), icon: 'folder-open-symbolic', run: () => launchUri(GLib.filename_to_uri(path, null))}]}));
        rows.push({id: 'indexed:settings', kind: 'command', title: _('Edit Search Folders…'), subtitle: _('In Notchy’s settings (Thunderstorm)'), icon: 'emblem-system-symbolic', score: 0, section: 'settings',
            actions: [{id: 'settings.open', title: _('Open Settings'), icon: 'emblem-system-symbolic', run: () => this.launcher.extension.openPreferences()}]});
        return rows;
    }
}
