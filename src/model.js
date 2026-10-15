// Platform-independent domain logic, shared by GJS and the Node test suite.
export function parseUris(text) {
    return [...new Set(String(text).split(/\r?\n/).map(s => s.trim())
        .filter(s => s && !s.startsWith('#') && /^file:\/\//i.test(s)))]
        .filter(s => { try { return decodeURI(s).indexOf('\0') < 0; } catch { return false; } });
}

export function classify(text) {
    if (/^https?:\/\/\S+$/i.test(text)) return 'link';
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text)) return 'color';
    return 'text';
}

export function normalizeTags(value) {
    const tags = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return [...new Set(tags.filter(x => typeof x === 'string').map(x => x.trim().replace(/^#/, '').slice(0, 32))
        .filter(Boolean))].slice(0, 12);
}

export function eventsForDay(events, day) {
    const begin = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const end = new Date(begin); end.setDate(end.getDate() + 1);
    return events.filter(x => x.begin < end.getTime() && (x.end > begin.getTime() || x.begin === x.end && x.begin >= begin.getTime()))
        .sort((a, b) => a.begin - b.begin || a.end - b.end);
}

export function mprisMetadata(meta) {
    const get = (name, fallback) => meta[name]?.deep_unpack?.() ?? meta[name] ?? fallback;
    const artist = get('xesam:artist', []);
    return {title: String(get('xesam:title', 'Unbekannter Titel')), artist: Array.isArray(artist) ? artist.join(', ') : String(artist),
        album: String(get('xesam:album', '')), art: String(get('mpris:artUrl', '')), url: String(get('xesam:url', '')),
        length: Number(get('mpris:length', 0)), trackId: String(get('mpris:trackid', '/'))};
}

// A player only counts while it holds a track: browsers keep their MPRIS
// service after the last media tab closes, stopped and without metadata.
export function mprisActive(status, meta) {
    const get = name => meta?.[name]?.deep_unpack?.() ?? meta?.[name];
    const title = String(get('xesam:title') ?? '').trim(), url = String(get('xesam:url') ?? '').trim();
    return status !== 'Stopped' && Boolean(title || url);
}

// Multiple file items preserve their native URI MIME; text items form one text copy.
// Images and mixed file/text selections cannot be represented faithfully as one copy.
export function combineCopies(items) {
    if (!items.length) return null;
    if (items.every(x => x.kind === 'files' && Array.isArray(x.uris))) {
        const uris = parseUris(items.flatMap(x => x.uris).join('\r\n'));
        return uris.length ? {mime: 'text/uri-list', text: uris.join('\r\n') + '\r\n'} : null;
    }
    if (items.every(x => ['text', 'link', 'color'].includes(x.kind))) {
        const text = items.map(x => x.text).join('\n');
        return text.length <= 1024 * 1024 ? {mime: 'text/plain', text} : null;
    }
    return null;
}

export class History {
    constructor(items = [], limit = 100) {
        this.limit = limit;
        this.items = items.filter(x => x && typeof x.id === 'string' && typeof x.text === 'string'
            && typeof x.created === 'number').map(x => ({...x, favorite: Boolean(x.favorite), tags: normalizeTags(x.tags)}));
        this.prune();
    }
    add(text, source = '', now = Date.now()) {
        if (!text || typeof text !== 'string' || text.length > 1024 * 1024) return null;
        const previous = this.items.find(x => x.text === text);
        if (previous) {
            this.items = [previous, ...this.items.filter(x => x !== previous)];
            previous.created = now;
            return previous;
        }
        const item = {id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
            text, source, kind: classify(text), title: '', favorite: false, tags: [], created: now};
        this.items.unshift(item);
        this.prune();
        return item;
    }
    prune(maxAgeDays = Infinity, now = Date.now()) {
        let count = 0;
        this.items = this.items.filter(x => x.favorite ||
            (now - x.created <= maxAgeDays * 86400000 && count++ < this.limit));
    }
    search(query = '', kind = 'all', favorites = false, tag = '') {
        query = query.toLocaleLowerCase();
        return this.items.filter(x => (!favorites || x.favorite) && (kind === 'all' || x.kind === kind)
            && (!tag || x.tags.includes(tag))
            && `${x.title}\n${x.text}\n${x.source}\n${x.tags.join(' ')}`.toLocaleLowerCase().includes(query));
    }
    remove(id) { this.items = this.items.filter(x => x.id !== id); }
    clear(keepFavorites = true) { this.items = keepFavorites ? this.items.filter(x => x.favorite) : []; }
}

// Recursive-descent calculator. Never executes JavaScript or shell input.
export function calculate(input) {
    if (input.length > 200 || !/^[\d\s.+*/%()\-]+$/.test(input)) return null;
    const tokens = input.match(/\d+(?:\.\d*)?|\.\d+|[()+*/%\-]/g) ?? [];
    let at = 0;
    const factor = () => {
        if (tokens[at] === '+' || tokens[at] === '-') { const sign = tokens[at++] === '-' ? -1 : 1; return sign * factor(); }
        if (tokens[at] === '(') { at++; const v = expression(); if (tokens[at++] !== ')') throw Error(); return v; }
        const token = tokens[at++]; if (!token || !/^[\d.]+$/.test(token)) throw Error(); return Number(token);
    };
    const term = () => { let v = factor(); while (['*', '/', '%'].includes(tokens[at])) {
        const op = tokens[at++], r = factor(); v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    } return v; };
    const expression = () => { let v = term(); while (['+', '-'].includes(tokens[at])) {
        const op = tokens[at++], r = term(); v = op === '+' ? v + r : v - r;
    } return v; };
    try { const value = expression(); return at === tokens.length && Number.isFinite(value) ? value : null; } catch { return null; }
}

// German relative time for list metadata ("gerade eben", "vor 5 Min.", "gestern").
export function relativeTime(then, now = Date.now()) {
    const minutes = Math.floor(Math.max(0, now - then) / 60000);
    if (minutes < 1) return 'gerade eben';
    if (minutes < 60) return `vor ${minutes} Min.`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `vor ${hours} Std.`;
    return hours < 48 ? 'gestern' : `vor ${Math.floor(hours / 24)} Tagen`;
}

// ISO 8601 calendar week (weeks start on Monday; week 1 holds the year's first Thursday).
export function isoWeek(date) {
    const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    day.setUTCDate(day.getUTCDate() + 3 - (day.getUTCDay() + 6) % 7);
    const firstThursday = new Date(Date.UTC(day.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((day - firstThursday) / 86400000 - 3 + (firstThursday.getUTCDay() + 6) % 7) / 7);
}

// The seven days (Monday first) of the week `offset` weeks away from `today`.
export function weekDays(today, offset = 0) {
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7 + offset * 7);
    return Array.from({length: 7}, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
}

// Notifications grouped per app, newest first, as in the calendar tab.
export function groupBy(items, key) {
    const groups = new Map();
    for (const item of items) { const k = key(item); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(item); }
    return [...groups.entries()].map(([name, list]) => ({name, items: list}));
}

// Window layouts offered when a window is dragged into the notch, as in
// Windows' snap layouts. Zones are fractions [x, y, width, height] of the work area.
export const SNAP_LAYOUTS = [
    {name: 'Hälften', zones: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1]]},
    {name: 'Zwei Drittel und ein Drittel', zones: [[0, 0, 2 / 3, 1], [2 / 3, 0, 1 / 3, 1]]},
    {name: 'Drittel', zones: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]]},
    {name: 'Hälfte und zwei Viertel', zones: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]]},
    {name: 'Viertel', zones: [[0, 0, 1 / 2, 1 / 2], [1 / 2, 0, 1 / 2, 1 / 2], [0, 1 / 2, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]]},
    {name: 'Vollbild', zones: [[0, 0, 1, 1]]},
];

// A zone in pixels; neighbouring zones share their edges exactly.
export function zoneRect(area, [fx, fy, fw, fh]) {
    const x = Math.round(area.x + fx * area.width), y = Math.round(area.y + fy * area.height);
    return {x, y, width: Math.round(area.x + (fx + fw) * area.width) - x, height: Math.round(area.y + (fy + fh) * area.height) - y};
}

// A GTK accelerator in canonical form, so equal shortcuts compare equal:
// modifiers sorted and lower-cased (Primary/Ctrl → control), key lower-cased.
export function normalizeAccelerator(accel) {
    const alias = {primary: 'control', ctrl: 'control', mod4: 'super', mod1: 'alt'};
    const mods = [...String(accel).matchAll(/<([^>]+)>/g)].map(m => alias[m[1].toLowerCase()] ?? m[1].toLowerCase());
    const key = String(accel).replace(/<[^>]+>/g, '').trim().toLowerCase();
    return key ? `${[...new Set(mods)].sort().map(m => `<${m}>`).join('')}${key}` : '';
}
