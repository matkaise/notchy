// Thunderstorm's platform-independent logic, shared by GJS and the Node test
// suite: matching and ranking, unit conversion, quicklink templates, frecency.
// Nothing here evaluates code or runs commands.
//
// Results carry a stable `kind` ('app', 'file', 'command', …); kindLabel()
// translates it only for display. Ranking, caps and the usage history work on
// the ids, so the interface language never changes an order or a saved entry.
import {_, N_, pgettext, ngettext, language, formatNumber as localeNumber, formatDate, formatTime} from '../i18n/core.js';

const KIND_LABELS = {
    app: N_('App'), command: N_('Command'), link: N_('Link'), window: N_('Window'), file: N_('File'), folder: N_('Folder'), shelf: N_('Shelf'),
    recent: N_('Recent'), emoji: N_('Emoji'), char: N_('Character'), clipboard: N_('Clipboard'), snippet: N_('Snippet'), unit: N_('Conversion'),
    calc: N_('Calculator'), timer: N_('Timer'), web: N_('Web'), indexed: N_('Indexed'), basic: N_('Basic search'),
};
// The kind of a result as its row shows it.
export const kindLabel = kind => (KIND_LABELS[kind] ? _(KIND_LABELS[kind]) : String(kind ?? ''));
const SECTION_LABELS = {
    recent: N_('Recently Used'), favorites: N_('Favorites'), 'recent-files': N_('Recently Opened'), indexed: N_('Indexed by GNOME LocalSearch'),
    basic: N_('LocalSearch is not running · basic search in'), settings: N_('Settings'),
};
export const sectionLabel = section => (SECTION_LABELS[section] ? _(SECTION_LABELS[section]) : String(section ?? ''));

// Lower case without diacritics, so "muller" finds "Müller" and "strasse" "Straße".
export function fold(text) {
    return String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss');
}

// How well `query` matches `text`, 0 (not at all) to 1000 (exactly).
// Exact, then prefix, then the start of a word, then a substring, then a
// subsequence whose letters lie close together (fuzzy).
export function matchScore(query, text) {
    const q = fold(query).trim(), t = fold(text);
    if (!q || !t) return 0;
    if (t === q) return 1000;
    if (t.startsWith(q)) return 900 - Math.min(100, t.length - q.length);
    const words = q.split(/\s+/);
    // Every query word starts a word of the text ("vs code" → "Visual Studio Code" partly).
    const starts = (word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(t);
    if (words.every(starts)) return 760 - Math.min(80, t.length - q.length);
    const at = t.indexOf(q);
    if (at >= 0) return 600 - Math.min(150, at * 4);
    // Initials: "gc" → "GNOME Calendar".
    const initials = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(word => word[0]).join('');
    if (q.length >= 2 && !q.includes(' ') && initials.startsWith(q)) return 520;
    // Fuzzy: all letters in order; tighter is better.
    let position = -1, gaps = 0, first = -1;
    for (const ch of q.replace(/\s+/g, '')) {
        const next = t.indexOf(ch, position + 1);
        if (next < 0) return 0;
        if (first < 0) first = next; else gaps += next - position - 1;
        position = next;
    }
    if (q.length < 3) return 0;
    return Math.max(1, 400 - gaps * 12 - first * 3);
}

// The best score over several fields; later fields count a little less.
export function bestScore(query, fields) {
    let best = 0;
    fields.filter(Boolean).forEach((field, i) => { best = Math.max(best, matchScore(query, field) - (i ? 40 : 0)); });
    return best;
}

// Frecency: how often and how recently a result was used, as a ranking boost (0–300).
export function frecency(entry, now = Date.now()) {
    if (!entry?.count) return 0;
    const days = Math.max(0, (now - (entry.last ?? 0)) / 86400000);
    const recency = days < 1 ? 1 : days < 7 ? 0.7 : days < 30 ? 0.4 : 0.15;
    return Math.round(Math.min(300, Math.log2(1 + entry.count) * 70 * recency));
}

// The usage history: id → {count, last, ...data needed to bring the result back}.
export function recordUse(history, id, data, now = Date.now(), limit = 200) {
    const previous = history[id];
    const next = {...history, [id]: {...data, count: (previous?.count ?? 0) + 1, last: now}};
    const ids = Object.keys(next);
    if (ids.length > limit) for (const old of ids.sort((a, b) => next[a].last - next[b].last).slice(0, ids.length - limit)) delete next[old];
    return next;
}
export function recentUses(history, limit = 5) {
    return Object.entries(history).sort(([, a], [, b]) => b.last - a.last).slice(0, limit).map(([id, entry]) => ({id, ...entry}));
}

// Thunderstorm's ranking is type-aware. A provider's `score` is how well the
// query matches (matchScore, 0–1000); above 1000 it is an explicit intent
// (the calculator, a unit conversion, a quicklink keyword, a prefixed search
// such as "emoji …") that always leads. Ordinary results are placed in bands
// by their family and match quality, so for a normal search
//   exact apps > strong apps > exact commands and quicklinks > exact files
//   > the remaining apps, commands and files > weak (fuzzy) matches,
// while a weak app still yields to an exactly matching file. Within a band the
// match quality, a provider's own small `bonus` (files: recently changed,
// shallow, recently opened) and frecency — capped per family, so a frequently
// opened file never pushes an exactly matching app down — order the results.
// In the explicit file mode ("datei …", "file …", "/…") files lead instead.
export const FAMILY = {app: 'app', command: 'command', link: 'command', window: 'command', file: 'file', folder: 'file', shelf: 'file', recent: 'file'};
export function matchTier(score) { return score >= 1000 ? 'exact' : score >= 680 ? 'strong' : score >= 450 ? 'medium' : 'weak'; }
const TIER_FLOOR = {exact: 1000, strong: 680, medium: 450, weak: 0};
const BANDS = {
    app: {exact: 3200, strong: 2600, medium: 1700, weak: 700},
    command: {exact: 2300, strong: 1900, medium: 1500, weak: 600},
    file: {exact: 2000, strong: 1800, medium: 1300, weak: 500},
    other: {exact: 2000, strong: 1600, medium: 1200, weak: 400},
};
const FILE_MODE_BANDS = {exact: 3400, strong: 3000, medium: 2500, weak: 1200};
const FRECENCY_CAP = {app: 300, command: 250, file: 150, other: 200};
const BONUS_LIMIT = [-200, 100];
export function rankScore(result, {history = {}, now = Date.now(), mode = 'all'} = {}) {
    if (result.score > 1000) return 5000 + result.score;
    // The web search is the way out, always the last row.
    if (result.kind === 'web') return Math.min(100, result.score);
    const family = FAMILY[result.kind] ?? 'other', match = Math.max(0, Math.min(1000, result.score)), tier = matchTier(match);
    const band = mode === 'files' && family === 'file' ? FILE_MODE_BANDS[tier] : BANDS[family][tier];
    const within = tier === 'exact' ? 0 : Math.min(160, (match - TIER_FLOOR[tier]) / (tier === 'weak' ? 3 : 2));
    const bonus = Math.max(BONUS_LIMIT[0], Math.min(BONUS_LIMIT[1], result.bonus ?? 0));
    return band + within + bonus + Math.min(FRECENCY_CAP[family], frecency(history[result.id], now));
}

// Prefixes that ask for one kind, in German and English whatever the interface speaks.
export const EMOJI_PREFIX = /^(emoji|zeichen|symbol|symbole|char|chars|character|characters)\s+|^:/i;
export const CLIPBOARD_PREFIX = /^(ablage|clip|clipboard|zwischenablage)\s/i;
export const SNIPPET_PREFIX = /^(snippet|snip|text|textbaustein)\s/i;

// The file mode: "datei bericht", "file bericht", "/bericht". Returns the
// search text without its prefix, or null for a normal query.
export function fileQuery(text) {
    const match = /^\s*(?:(?:datei|dateien|file|files)\s+|\/(?=[^\s/]))(.*)$/is.exec(String(text));
    return match ? match[1].trim() : null;
}

// Results from all providers in one list, by rankScore, at most `perKind` of
// one kind and `limit` in all; equal scores keep provider order.
export function rank(results, {history = {}, limit = 8, perKind = {}, now = Date.now(), mode = 'all'} = {}) {
    const scored = results.map((result, order) => ({result, order, total: rankScore(result, {history, now, mode})}));
    scored.sort((a, b) => b.total - a.total || a.order - b.order);
    const counts = {}, out = [], seen = new Set();
    for (const {result} of scored) {
        if (seen.has(result.id)) continue;
        const max = perKind[result.kind] ?? Infinity;
        if ((counts[result.kind] ?? 0) >= max) continue;
        counts[result.kind] = (counts[result.kind] ?? 0) + 1; seen.add(result.id); out.push(result);
        if (out.length >= limit) break;
    }
    return out;
}

// A number for display and copying in the interface language (German:
// decimal comma), no grouping, at most `digits` significant digits, an
// exponent only for extreme values.
export function formatNumber(value, digits = 10, lang = language()) { return localeNumber(value, digits, lang); }

// Unit conversion. Each unit: factor to its category's base unit (temperature
// has its own formulas). Aliases are lower case, German and English.
const UNITS = {
    length: {mm: [0.001, ['millimeter', 'millimetre']], cm: [0.01, ['zentimeter', 'centimeter', 'centimetre']], dm: [0.1, ['dezimeter']],
        m: [1, ['meter', 'metre', 'meters', 'metres']], km: [1000, ['kilometer', 'kilometre', 'kilometers']],
        in: [0.0254, ['zoll', 'inch', 'inches', '"']], ft: [0.3048, ['fuß', 'fuss', 'foot', 'feet', "'"]], yd: [0.9144, ['yard', 'yards']],
        mi: [1609.344, ['meile', 'meilen', 'mile', 'miles']], nmi: [1852, ['seemeile', 'seemeilen', 'nautical mile', 'sm']]},
    area: {mm2: [1e-6, ['quadratmillimeter']], cm2: [1e-4, ['quadratzentimeter']], m2: [1, ['qm', 'quadratmeter', 'square meter']],
        a: [100, ['ar']], ha: [10000, ['hektar', 'hectare', 'hectares']], km2: [1e6, ['quadratkilometer']],
        in2: [0.00064516, ['sq in', 'square inch']], ft2: [0.09290304, ['sq ft', 'square foot', 'square feet']], yd2: [0.83612736, ['sq yd']],
        ac: [4046.8564224, ['acre', 'acres', 'morgen']], mi2: [2589988.110336, ['sq mi', 'square mile']]},
    mass: {mg: [1e-6, ['milligramm', 'milligram']], g: [0.001, ['gramm', 'gram', 'grams']], kg: [1, ['kilogramm', 'kilogram', 'kilo', 'kilos']],
        t: [1000, ['tonne', 'tonnen', 'ton', 'tons']], oz: [0.028349523125, ['unze', 'unzen', 'ounce', 'ounces']],
        lb: [0.45359237, ['lbs', 'pound', 'pounds']], st: [6.35029318, ['stone']], pfund: [0.5, ['pfd']]},
    volume: {ml: [0.001, ['milliliter', 'millilitre']], cl: [0.01, ['zentiliter', 'centiliter']], dl: [0.1, ['deziliter']],
        l: [1, ['liter', 'litre', 'liters', 'litres', 'ltr']], m3: [1000, ['kubikmeter', 'cubic meter']], cm3: [0.001, ['ccm', 'kubikzentimeter']],
        gal: [3.785411784, ['gallone', 'gallonen', 'gallon', 'gallons']], qt: [0.946352946, ['quart', 'quarts']], pt: [0.473176473, ['pint', 'pints']],
        cup: [0.2365882365, ['cups', 'tasse', 'tassen']], floz: [0.0295735295625, ['fl oz', 'fluid ounce', 'fluid ounces']],
        tl: [0.005, ['teelöffel', 'tsp', 'teaspoon']], el: [0.015, ['esslöffel', 'tbsp', 'tablespoon']]},
    temperature: {c: [null, ['celsius', 'grad', 'grad celsius']], f: [null, ['fahrenheit']], k: [null, ['kelvin']]},
    time: {ms: [0.001, ['millisekunde', 'millisekunden', 'millisecond', 'milliseconds']], s: [1, ['sek', 'sekunde', 'sekunden', 'sec', 'second', 'seconds']],
        min: [60, ['minute', 'minuten', 'minutes', 'mins']], h: [3600, ['std', 'stunde', 'stunden', 'hour', 'hours', 'hr', 'hrs']],
        d: [86400, ['tag', 'tage', 'tagen', 'day', 'days']], wk: [604800, ['woche', 'wochen', 'week', 'weeks', 'w']],
        mo: [2629746, ['monat', 'monate', 'month', 'months']], yr: [31556952, ['jahr', 'jahre', 'year', 'years', 'j']]},
    data: {b: [1, ['byte', 'bytes']], kb: [1e3, ['kilobyte', 'kilobytes']], mb: [1e6, ['megabyte', 'megabytes']], gb: [1e9, ['gigabyte', 'gigabytes']],
        tb: [1e12, ['terabyte', 'terabytes']], kib: [1024, ['kibibyte']], mib: [1048576, ['mebibyte']], gib: [1073741824, ['gibibyte']], tib: [1099511627776, ['tebibyte']]},
};
// The symbol each unit is shown with; words are translated, with the plural
// for every value but exactly one.
const SYMBOL = {m2: 'm²', mm2: 'mm²', cm2: 'cm²', km2: 'km²', in2: 'in²', ft2: 'ft²', yd2: 'yd²', mi2: 'mi²', m3: 'm³', cm3: 'cm³',
    c: '°C', f: '°F', k: 'K', floz: 'fl oz', kib: 'KiB', mib: 'MiB', gib: 'GiB', tib: 'TiB', kb: 'kB', mb: 'MB', gb: 'GB', tb: 'TB', b: 'B'};
const WORDS = {
    ac: n => ngettext('acre', 'acres', n), wk: n => ngettext('week', 'weeks', n), mo: n => ngettext('month', 'months', n),
    yr: n => ngettext('year', 'years', n), d: n => ngettext('day', 'days', n),
    // Translators: abbreviations of teaspoon and tablespoon.
    tl: () => _('tsp'), el: () => _('tbsp'),
    // Translators: the German pound of 500 g.
    pfund: () => _('Pfund'),
};
// Without a target, a unit converts to these.
const DEFAULT_TARGETS = {mm: ['in'], cm: ['in'], m: ['ft'], km: ['mi'], in: ['cm'], ft: ['m'], yd: ['m'], mi: ['km'], nmi: ['km'],
    m2: ['ft2'], ha: ['ac', 'km2'], km2: ['mi2'], ft2: ['m2'], ac: ['ha'], mi2: ['km2'],
    g: ['oz'], kg: ['lb'], t: ['lb'], oz: ['g'], lb: ['kg'], st: ['kg'], pfund: ['kg'],
    ml: ['floz'], l: ['gal'], gal: ['l'], qt: ['l'], pt: ['ml'], cup: ['ml'], floz: ['ml'], m3: ['l'],
    c: ['f', 'k'], f: ['c'], k: ['c'],
    s: ['min'], min: ['h', 's'], h: ['min'], d: ['h'], wk: ['d'], mo: ['d'], yr: ['d'], ms: ['s'],
    b: ['kb'], kb: ['kib'], mb: ['mib'], gb: ['gib'], tb: ['tib'], kib: ['kb'], mib: ['mb'], gib: ['gb'], tib: ['tb']};
const LOOKUP = new Map();
for (const [category, units] of Object.entries(UNITS)) {
    for (const [unit, [, aliases]] of Object.entries(units)) for (const name of [unit, ...aliases]) LOOKUP.set(name, {category, unit});
}
function unitOf(text) {
    const name = String(text).trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/^°\s*/, '').replace(/\.$/, '').replace(/\s+/g, ' ');
    return LOOKUP.get(name) ?? null;
}
export const unitSymbol = (unit, value = 2) => WORDS[unit]?.(Math.abs(value) === 1 ? 1 : 2) ?? SYMBOL[unit] ?? unit;

export function convert(value, from, to) {
    const a = LOOKUP.get(from) ?? {unit: from}, b = LOOKUP.get(to) ?? {unit: to};
    const category = Object.keys(UNITS).find(c => a.unit in UNITS[c] && b.unit in UNITS[c]);
    if (!category) return null;
    if (category === 'temperature') {
        const celsius = a.unit === 'c' ? value : a.unit === 'f' ? (value - 32) * 5 / 9 : value - 273.15;
        return b.unit === 'c' ? celsius : b.unit === 'f' ? celsius * 9 / 5 + 32 : celsius + 273.15;
    }
    return value * UNITS[category][a.unit][0] / UNITS[category][b.unit][0];
}

// "10 km in mi", "72°F", "3,5 l nach ml", "5 ft to cm", "1,5h in min".
// Returns {value, from, conversions: [{to, value}]} or null.
export function parseConversion(input) {
    const text = String(input).trim();
    if (text.length > 80) return null;
    const match = text.match(/^(-?\d+(?:[.,]\d+)?)\s*([^\d\s=→][^=→]*?)(?:\s*(?:\s(?:in|to|nach|zu|als)\s|=|->|→)\s*(.+))?$/i);
    if (!match) return null;
    const value = Number(match[1].replace(',', '.'));
    const from = unitOf(match[2]);
    if (!from || !Number.isFinite(value)) return null;
    const targets = match[3] ? [unitOf(match[3])] : (DEFAULT_TARGETS[from.unit] ?? []).map(unit => ({category: from.category, unit}));
    if (targets.some(target => !target || target.category !== from.category)) return null;
    const conversions = targets.filter(target => target.unit !== from.unit).map(target => ({to: target.unit, value: convert(value, from.unit, target.unit)}));
    return conversions.length ? {value, from: from.unit, category: from.category, conversions} : null;
}

// Quicklinks: "keyword argument". The argument is inserted URL-encoded
// ({query}) or as an encoded path that keeps its slashes ({path}). Only
// web addresses (http/https), folders and installed apps are allowed targets.
export function expandTemplate(template, argument = '') {
    const path = String(argument).split('/').map(encodeURIComponent).join('/');
    return String(template).replace(/\{query\}/g, encodeURIComponent(argument)).replace(/\{path\}/g, path);
}
export function quicklinkTarget(link, argument = '') {
    if (!link || typeof link.url !== 'string') return null;
    const raw = link.url.trim();
    if (/^https?:\/\//i.test(raw)) {
        const alt = link.alt && typeof link.alt.pattern === 'string' && link.alt.pattern.length < 120 && typeof link.alt.url === 'string' ? link.alt : null;
        let template = raw;
        try { if (alt && argument && new RegExp(alt.pattern).test(argument)) template = alt.url; } catch { /* Invalid pattern: the plain URL. */ }
        const url = expandTemplate(template, argument);
        // GJS has no URL class: a strict check instead. A scheme, a host of
        // plain characters, no whitespace or control characters anywhere.
        return /^https?:\/\/[\w.-]+(:\d+)?([/?#][^\s\x00-\x1f\x7f]*)?$/i.test(url) ? {kind: 'url', url} : null;
    }
    if (/^app:[\w.-]+\.desktop$/.test(raw)) return {kind: 'app', id: raw.slice(4)};
    if (/^xdg:[A-Z_]+$/.test(raw)) return {kind: 'folder', xdg: raw.slice(4)};
    if (/^(~\/|\/)/.test(raw) && !raw.includes('\0')) return {kind: 'folder', path: raw};
    return null;
}
// The quicklink a query invokes: its keyword followed by a space (and the argument).
export function matchQuicklink(query, links) {
    const text = String(query).replace(/^\s+/, '');
    const space = text.indexOf(' ');
    const keyword = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const link = links.find(l => typeof l?.keyword === 'string' && l.keyword.toLowerCase() === keyword);
    if (!link) return null;
    return {link, argument: space < 0 ? '' : text.slice(space + 1).trim(), complete: space >= 0};
}
// Saved quicklinks or snippets from settings JSON; anything malformed is dropped.
export function parseList(json, fields) {
    try {
        const list = JSON.parse(json);
        return Array.isArray(list) ? list.filter(x => x && fields.every(f => typeof x[f] === 'string' && x[f].length <= 4000)).slice(0, 200) : [];
    } catch { return []; }
}
// Snippet placeholders: {date}, {time}, {datetime} in the interface's locale
// ("19.10.2026" in German, "Oct 19, 2026" in English).
export function expandSnippet(text, now = new Date()) {
    const date = formatDate(now, {dateStyle: 'medium'}), time = formatTime(now);
    return String(text).replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{datetime\}/g, `${date} ${time}`);
}

// Quicklinks and snippets a new installation starts with, in the interface
// language. They apply while the user has not edited the lists; an edited
// list is the user's and stays exactly as saved, whatever the language.
export function defaultQuicklinks(lang = language()) {
    return [
        {keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query={query}'},
        {keyword: 'gh', name: 'GitHub', url: 'https://github.com/search?q={query}&type=repositories', alt: {pattern: '^[\\w.-]+/[\\w.-]+$', url: 'https://github.com/{path}'}},
        {keyword: 'wiki', name: 'Wikipedia', url: `https://${lang === 'de' ? 'de' : 'en'}.wikipedia.org/w/index.php?search={query}`},
        {keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}'},
        {keyword: 'maps', name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/search?query={query}'},
        {keyword: 'dl', name: _('Downloads'), url: 'xdg:DOWNLOAD'},
        {keyword: 'docs', name: _('Documents'), url: 'xdg:DOCUMENTS'},
    ];
}
export function defaultSnippets() {
    return [
        // Translators: a snippet that copies a closing greeting for letters and mails.
        {name: _('Kind regards'), keyword: pgettext('snippet keyword', 'kr'), text: `${_('Kind regards')}\n`},
        {name: _('Today’s date'), keyword: pgettext('snippet keyword', 'today'), text: '{date}'},
    ];
}
// A saved list, or the defaults while the setting is empty (never edited).
export function savedOrDefault(json, fields, defaults) {
    return String(json ?? '').trim() ? parseList(json, fields) : defaults();
}
