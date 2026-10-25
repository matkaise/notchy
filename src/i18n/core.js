// Notchy's translations and locale-aware formatting, without GNOME imports:
// the Shell, the preferences and the Node test suite share this module.
//
// Source strings are English (the msgids); src/i18n/gnome.js installs the
// backend that translates them — GNOME's gettext for the system language, or
// a catalog read from Notchy's own .mo file when the user picked a language in
// the preferences (that override never touches the process locale). Without a
// backend everything stays English. Technical identifiers (kinds, command and
// action ids, states, persisted data) are never translated; only what is
// shown passes through here.

export const DOMAIN = 'notchy';
export const LANGUAGES = ['de', 'en'];

let backend = null;
const listeners = new Set();

// Marks a string for extraction without translating it here (tables of msgids).
export const N_ = text => text;
export function _(msgid) { return backend ? backend.gettext(msgid) : msgid; }
export function ngettext(singular, plural, n) { return backend ? backend.ngettext(singular, plural, n) : n === 1 ? singular : plural; }
export function pgettext(context, msgid) { return backend ? backend.pgettext(context, msgid) : msgid; }

// printf-style placeholders as gettext tools understand them: %s, %d and,
// for translations that reorder, %1$s, %2$d. %% is a percent sign.
export function fmt(text, ...args) {
    let next = 0;
    return String(text).replace(/%(?:(\d+)\$)?([sd%])/g, (_m, position, type) => {
        if (type === '%') return '%';
        const value = args[position ? Number(position) - 1 : next++];
        return type === 'd' ? String(Math.trunc(Number(value))) : String(value ?? '');
    });
}

// The active backend: {gettext, ngettext, pgettext, language, locale}.
export function setBackend(next) {
    backend = next;
    for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } }
}
export function onLanguageChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// 'de' or 'en': the language the interface speaks now.
export function language() { return backend?.language ?? 'en'; }
// A BCP 47 tag for dates and times ('de-CH', 'en-GB'): the language with the
// system's region when it matches.
export function locale() { return backend?.locale ?? 'en-US'; }

// The supported language a list of POSIX locale names asks for (as
// GLib.get_language_names() or $LANGUAGE/$LANG give them): the first German or
// English entry wins, other languages are skipped, English is the fallback.
export function languageFromNames(names = []) {
    for (const name of names) {
        const lower = String(name).toLowerCase();
        if (lower.startsWith('de')) return 'de';
        if (lower.startsWith('en') || lower === 'c' || lower === 'posix' || lower.startsWith('c.')) return 'en';
    }
    return 'en';
}
// The region for `lang` from the same names: de_CH → de-CH; else the language's usual one.
export function localeFor(lang, names = []) {
    for (const name of names) {
        const match = /^([a-z]{2,3})_([A-Z]{2})/.exec(String(name));
        if (match && match[1] === lang) return `${lang}-${match[2]}`;
    }
    return lang === 'de' ? 'de-DE' : 'en-US';
}
// override: 'auto', 'de' or 'en'; detected: the language gettext chose ('de', or null).
export function resolveLanguage({override = 'auto', names = [], detected = null} = {}) {
    const lang = LANGUAGES.includes(override) ? override : LANGUAGES.includes(detected) ? detected : languageFromNames(names);
    return {language: lang, locale: localeFor(lang, names)};
}

// A compiled gettext catalog (.mo) → Map: msgid (or "context\u0004msgid") to a
// string, or for plural entries to an array of forms. Plus the header fields.
export function parseMo(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = view.getUint32(0, true);
    const little = magic === 0x950412de;
    if (!little && magic !== 0xde120495) throw new Error('Not a gettext catalog');
    const word = at => view.getUint32(at, little);
    const count = word(8), originals = word(12), translations = word(16);
    const decoder = new TextDecoder('utf-8');
    const text = (table, i) => { const length = word(table + i * 8), offset = word(table + i * 8 + 4); return decoder.decode(data.subarray(offset, offset + length)); };
    const messages = new Map();
    let header = {};
    for (let i = 0; i < count; i++) {
        const original = text(originals, i), translated = text(translations, i);
        if (original === '') { header = Object.fromEntries(translated.split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])); continue; }
        const [msgid, plural] = original.split('\0');
        messages.set(msgid, plural === undefined ? translated : translated.split('\0'));
    }
    return {messages, header};
}
// German and English both use nplurals=2; plural=(n != 1). Other rules are not needed.
const pluralIndex = n => (n === 1 ? 0 : 1);
// A backend over a parsed catalog (the language override, the Node tests).
export function catalogBackend(catalog, {language: lang, locale: tag}) {
    const messages = catalog?.messages ?? new Map();
    const one = key => { const value = messages.get(key); return typeof value === 'string' && value ? value : null; };
    return {
        language: lang, locale: tag,
        gettext: msgid => one(msgid) ?? msgid,
        pgettext: (context, msgid) => one(`${context}\u0004${msgid}`) ?? msgid,
        ngettext: (singular, plural, n) => {
            const forms = messages.get(singular);
            const form = Array.isArray(forms) ? forms[pluralIndex(n)] : null;
            return form || (n === 1 ? singular : plural);
        },
    };
}

// --- Formatting -----------------------------------------------------------
// Numbers follow the language (German: decimal comma, also for de-CH, as
// the calculator accepts it); dates and times follow the full locale.
const spaces = text => text.replace(/[  ]/g, ' ');
export function formatNumber(value, digits = 10, lang = language()) {
    if (!Number.isFinite(value)) return '';
    if (value === 0) return '0';
    const abs = Math.abs(value), comma = lang === 'de';
    if (abs >= 1e15 || abs < 1e-6) {
        const text = value.toExponential(4).replace('e+', 'e');
        return comma ? text.replace('.', ',') : text;
    }
    return spaces(new Intl.NumberFormat(lang, {maximumSignificantDigits: Math.min(21, Math.max(1, digits)), useGrouping: false}).format(value));
}
// "65 %" in German, "65%" in English.
export function formatPercent(level, lang = language()) {
    return spaces(new Intl.NumberFormat(lang, {style: 'percent', maximumFractionDigits: 0}).format(level / 100));
}
export function formatDate(date, options = {dateStyle: 'medium'}, tag = locale()) {
    return spaces(new Intl.DateTimeFormat(tag, options).format(date));
}
export function formatTime(date, tag = locale()) { return formatDate(date, {timeStyle: 'short'}, tag); }

// "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago".
export function relativeTime(then, now = Date.now()) {
    const minutes = Math.floor(Math.max(0, now - then) / 60000);
    if (minutes < 1) return _('just now');
    if (minutes < 60) return fmt(ngettext('%d min ago', '%d min ago', minutes), minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return fmt(ngettext('%d h ago', '%d h ago', hours), hours);
    if (hours < 48) return _('yesterday');
    const days = Math.floor(hours / 24);
    return fmt(ngettext('%d day ago', '%d days ago', days), days);
}
// A size in bytes as files show it: "312 MB", "1,2 GB" (decimal units, as GNOME's Files).
export function formatBytes(bytes, lang = language()) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1000) return `${Math.round(value)} B`;
    const units = ['kB', 'MB', 'GB', 'TB'];
    let scaled = value / 1000, unit = 0;
    while (scaled >= 1000 && unit < units.length - 1) { scaled /= 1000; unit++; }
    const digits = scaled < 10 ? 2 : 3;
    return `${formatNumber(Number(scaled.toPrecision(digits)), digits, lang)} ${units[unit]}`;
}
// A running time: "12 s", "4 min", "1 h 5 min".
export function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return fmt(_('%d s'), seconds);
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return fmt(_('%d min'), minutes);
    return fmt(_('%1$d h %2$d min'), Math.floor(minutes / 60), minutes % 60);
}
