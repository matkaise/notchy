import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {_, ngettext, pgettext, fmt, language, locale, resolveLanguage, languageFromNames, localeFor, parseMo, catalogBackend, setBackend, onLanguageChanged,
    formatNumber, formatPercent, formatDate, formatTime, relativeTime, duration} from '../src/i18n/core.js';
import {kindLabel, sectionLabel, FAMILY, rank, unitSymbol, parseConversion, expandSnippet, defaultQuicklinks, defaultSnippets, savedOrDefault} from '../src/launcher/logic.js';
import {clipTitle, History} from '../src/model.js';
import {ageText, partText} from '../src/services/batteries.js';
import {stateText} from '../src/services/agentModel.js';
import {useLanguage} from './i18n-helper.js';

// GLib.get_language_names() for a session started with LANG=… (and LANGUAGE=…).
const names = (lang, list = '') => {
    const out = [];
    for (const entry of [...list.split(':').filter(Boolean), lang]) {
        const [base, codeset] = entry.split('.'), short = base.split('_')[0];
        out.push(...(codeset ? [entry] : []), base, ...(codeset ? [`${short}.${codeset}`] : []), short);
    }
    return [...new Set([...out, 'C'])];
};

test('the language follows the system: German and English variants, English for everything else', () => {
    for (const [lang, expected, tag] of [['de_DE.UTF-8', 'de', 'de-DE'], ['de_CH.UTF-8', 'de', 'de-CH'], ['de_AT.UTF-8', 'de', 'de-AT'], ['en_US.UTF-8', 'en', 'en-US'],
        ['en_GB.UTF-8', 'en', 'en-GB'], ['fr_FR.UTF-8', 'en', 'en-US'], ['ja_JP.UTF-8', 'en', 'en-US'], ['C.UTF-8', 'en', 'en-US'], ['de', 'de', 'de-DE'], ['en', 'en', 'en-US']]) {
        assert.deepEqual(resolveLanguage({names: names(lang)}), {language: expected, locale: tag}, lang);
    }
    assert.equal(languageFromNames(names('en_US.UTF-8', 'fr:de')), 'de', 'LANGUAGE=fr:de: French has no catalog, German follows');
    assert.equal(resolveLanguage({names: names('de_DE.UTF-8'), detected: null}).language, 'de');
    assert.equal(resolveLanguage({names: names('fr_FR.UTF-8'), detected: 'de'}).language, 'de', 'the catalog gettext picked decides');
    assert.equal(localeFor('de', names('en_GB.UTF-8')), 'de-DE', 'an override keeps no foreign region');
});
test('a language chosen in the preferences wins over the system and keeps a matching region', () => {
    assert.deepEqual(resolveLanguage({override: 'en', names: names('de_CH.UTF-8')}), {language: 'en', locale: 'en-US'});
    assert.deepEqual(resolveLanguage({override: 'de', names: names('de_CH.UTF-8')}), {language: 'de', locale: 'de-CH'});
    assert.deepEqual(resolveLanguage({override: 'de', names: names('en_US.UTF-8')}), {language: 'de', locale: 'de-DE'});
    assert.equal(resolveLanguage({override: 'xx', names: names('de_DE.UTF-8')}).language, 'de', 'an unknown value means automatic');
});

test('the compiled catalog: messages, plurals and contexts; missing entries fall back to English', () => {
    const catalog = parseMo(readFileSync(new URL('../locale/de/LC_MESSAGES/notchy.mo', import.meta.url)));
    assert.equal(catalog.header.Language, 'de');
    assert.match(catalog.header['Plural-Forms'], /nplurals=2/);
    const de = catalogBackend(catalog, {language: 'de', locale: 'de-DE'});
    assert.equal(de.gettext('Lock Screen'), 'Bildschirm sperren');
    assert.equal(de.ngettext('%d file', '%d files', 1), '%d Datei');
    assert.equal(de.ngettext('%d file', '%d files', 3), '%d Dateien');
    assert.equal(de.ngettext('%d file', '%d files', 0), '%d Dateien');
    assert.equal(de.pgettext('snippet keyword', 'kr'), 'mfg');
    assert.equal(de.gettext('Not in the catalog'), 'Not in the catalog');
    assert.equal(de.ngettext('one thing', 'things', 2), 'things');
    const en = catalogBackend(null, {language: 'en', locale: 'en-US'});
    assert.equal(en.gettext('Lock Screen'), 'Lock Screen');
    assert.throws(() => parseMo(new Uint8Array(32)));
});
test('placeholders: in order, reordered by position, numbers truncated', () => {
    assert.equal(fmt('%s copied', 'x'), 'x copied');
    assert.equal(fmt('%1$s: %2$d sessions', 'Claude', 2.7), 'Claude: 2 sessions');
    assert.equal(fmt('%2$s before %1$s', 'a', 'b'), 'b before a');
    assert.equal(fmt('100 %% sure'), '100 % sure');
});
test('switching the language notifies listeners, and the module follows', () => {
    let calls = 0;
    const stop = onLanguageChanged(() => calls++);
    useLanguage('de'); assert.equal(language(), 'de'); assert.equal(_('Open'), 'Öffnen');
    useLanguage('en'); assert.equal(language(), 'en'); assert.equal(_('Open'), 'Open');
    stop(); useLanguage('de');
    assert.equal(calls, 2);
    setBackend(null);
    assert.equal(_('Open'), 'Open', 'without a backend: English'); assert.equal(locale(), 'en-US');
});

test('numbers, percentages, dates and times in the interface’s format', () => {
    useLanguage('de', 'de-DE');
    assert.equal(formatNumber(1.5), '1,5'); assert.equal(formatNumber(1234567.25), '1234567,25'); assert.equal(formatNumber(1e20), '1,0000e20');
    assert.equal(formatPercent(65), '65 %');
    assert.equal(formatDate(new Date(2026, 9, 19)), '19.10.2026');
    assert.equal(formatTime(new Date(2026, 9, 19, 14, 5)), '14:05');
    assert.equal(`${formatNumber(1.5)} km`, '1,5 km');
    useLanguage('de', 'de-CH');
    assert.equal(formatNumber(1.5), '1,5', 'German numbers keep the decimal comma the calculator takes');
    assert.equal(formatDate(new Date(2026, 9, 19)), '19.10.2026');
    useLanguage('en', 'en-US');
    assert.equal(formatNumber(1.5), '1.5'); assert.equal(formatNumber(1e20), '1.0000e20');
    assert.equal(formatPercent(65), '65%');
    assert.equal(formatDate(new Date(2026, 9, 19)), 'Oct 19, 2026');
    assert.equal(formatTime(new Date(2026, 9, 19, 14, 5)), '2:05 PM');
    useLanguage('en', 'en-GB');
    assert.equal(formatDate(new Date(2026, 9, 19)), '19 Oct 2026');
    assert.equal(formatTime(new Date(2026, 9, 19, 14, 5)), '14:05');
});
test('relative times, durations, ages and plurals', () => {
    const now = Date.UTC(2026, 9, 19, 12);
    useLanguage('de');
    assert.deepEqual([relativeTime(now - 5 * 60000, now), relativeTime(now - 26 * 3600000, now), relativeTime(now - 86400000 * 3, now)], ['vor 5 Min.', 'gestern', 'vor 3 Tagen']);
    assert.equal(fmt(ngettext('%d file', '%d files', 3), 3), '3 Dateien');
    assert.equal(fmt(ngettext('%d file', '%d files', 1), 1), '1 Datei');
    assert.deepEqual([duration(12000), duration(4 * 60000), duration(65 * 60000)], ['12 s', '4 Min.', '1 Std. 5 Min.']);
    assert.equal(ageText(now - 5 * 60000, now), 'vor 5 Min.');
    assert.equal(partText({status: 'live', level: 40, charging: true}), '⚡ 40 %');
    useLanguage('en');
    assert.deepEqual([relativeTime(now - 20000, now), relativeTime(now - 5 * 60000, now), relativeTime(now - 3 * 3600000, now), relativeTime(now - 26 * 3600000, now), relativeTime(now - 86400000 * 3, now)],
        ['just now', '5 min ago', '3 h ago', 'yesterday', '3 days ago']);
    assert.equal(fmt(ngettext('%d file', '%d files', 3), 3), '3 files');
    assert.deepEqual([duration(12000), duration(4 * 60000), duration(65 * 60000)], ['12 s', '4 min', '1 h 5 min']);
    assert.equal(partText({status: 'stale', last: 65}), '65%');
    assert.equal(stateText('waiting'), 'Waiting for you');
});
test('units: words in the interface language, singular for exactly one; input in either language', () => {
    useLanguage('de');
    assert.equal(unitSymbol('wk', 2), 'Wochen'); assert.equal(unitSymbol('wk', 1), 'Woche'); assert.equal(unitSymbol('tl', 2), 'TL'); assert.equal(unitSymbol('km', 2), 'km');
    useLanguage('en');
    assert.equal(unitSymbol('wk', 2), 'weeks'); assert.equal(unitSymbol('d', 1), 'day'); assert.equal(unitSymbol('tl', 2), 'tsp');
    for (const query of ['3,5 Liter nach ml', '3.5 liters to ml', '3,5 l in ml']) assert.equal(parseConversion(query).conversions[0].value, 3500, query);
});
test('snippet placeholders in the interface’s date and time format', () => {
    const at = new Date(2026, 9, 19, 14, 5);
    useLanguage('de'); assert.equal(expandSnippet('{date} {time}', at), '19.10.2026 14:05');
    useLanguage('en'); assert.equal(expandSnippet('{datetime}', at), 'Oct 19, 2026 2:05 PM');
});

test('labels are translated for display only; kinds, sections and the ranking stay ids', () => {
    for (const kind of [...Object.keys(FAMILY), 'emoji', 'char', 'clipboard', 'snippet', 'unit', 'calc', 'web', 'indexed', 'basic']) {
        useLanguage('en'); const english = kindLabel(kind);
        useLanguage('de'); const german = kindLabel(kind);
        assert.ok(english && german && english !== kind, kind);
    }
    useLanguage('de');
    assert.deepEqual([kindLabel('file'), kindLabel('command'), kindLabel('clipboard'), sectionLabel('recent')], ['Datei', 'Befehl', 'Ablage', 'Zuletzt verwendet']);
    useLanguage('en');
    assert.deepEqual([kindLabel('file'), kindLabel('command'), kindLabel('clipboard'), sectionLabel('recent')], ['File', 'Command', 'Clipboard', 'Recently Used']);
    const results = [{id: 'app:a', kind: 'app', score: 700}, {id: 'file:b', kind: 'file', score: 1000}, {id: 'cmd:system.lock', kind: 'command', score: 1000}, {id: 'web', kind: 'web', score: 1}];
    useLanguage('de'); const german = rank(results).map(r => r.id);
    useLanguage('en'); const english = rank(results).map(r => r.id);
    assert.deepEqual(german, english);
});
test('clipboard entries: titles shown in the current language, older German ones recognised', () => {
    useLanguage('en');
    assert.equal(clipTitle({kind: 'files', title: '', uris: ['a', 'b']}), '2 files');
    assert.equal(clipTitle({kind: 'files', title: '2 Dateien', uris: ['a', 'b']}), '2 files', 'a German title saved by an older version');
    assert.equal(clipTitle({kind: 'image', title: 'Bild'}), 'Picture');
    assert.equal(clipTitle({kind: 'text', title: 'My own title'}), 'My own title');
    useLanguage('de');
    assert.equal(clipTitle({kind: 'files', title: '', uris: ['a']}), '1 Datei');
    const history = new History([{id: '1', text: 'image:abc', kind: 'image', title: '', created: 1}]);
    assert.equal(history.search('bild').length, 1, 'found by its title in the interface language');
});
test('defaults per language; saved lists stay exactly as the user saved them', () => {
    useLanguage('de');
    const german = defaultQuicklinks();
    assert.equal(german.find(l => l.keyword === 'wiki').url, 'https://de.wikipedia.org/w/index.php?search={query}');
    assert.equal(german.find(l => l.keyword === 'docs').name, 'Dokumente');
    assert.deepEqual(defaultSnippets().map(s => [s.name, s.keyword]), [['Freundliche Grüsse', 'mfg'], ['Datum heute', 'heute']]);
    useLanguage('en');
    const english = defaultQuicklinks();
    assert.equal(english.find(l => l.keyword === 'wiki').url, 'https://en.wikipedia.org/w/index.php?search={query}');
    assert.equal(english.find(l => l.keyword === 'docs').name, 'Documents');
    assert.deepEqual(english.map(l => l.keyword), german.map(l => l.keyword), 'keywords are the same in both languages');
    const saved = JSON.stringify([{keyword: 'wiki', name: 'Wikipedia', url: 'https://de.wikipedia.org/w/index.php?search={query}'}]);
    for (const lang of ['de', 'en']) {
        useLanguage(lang);
        assert.deepEqual(savedOrDefault(saved, ['keyword', 'name', 'url'], () => defaultQuicklinks()), JSON.parse(saved), lang);
        assert.equal(savedOrDefault('', ['keyword', 'name', 'url'], () => defaultQuicklinks()).length, 7, `${lang}: empty means defaults`);
    }
});
test('long English labels stay within a sensible length for the island', () => {
    // Labels shown in fixed places (kind column, AirPods buttons, tab names) must not need much more room than the German ones.
    const fixed = ['App', 'Command', 'Link', 'Window', 'File', 'Folder', 'Shelf', 'Recent', 'Emoji', 'Character', 'Clipboard', 'Snippet', 'Conversion', 'Calculator', 'Web', 'Indexed', 'Basic search',
        'ANC', 'Transparency', 'Adaptive', 'Off', 'Area', 'Window', 'Screen', 'Record', 'Text (OCR)'];
    for (const label of fixed) assert.ok(label.length <= 14, label);
    useLanguage('de');
    for (const label of fixed) assert.ok(_(label).length <= 16, `${label} → ${_(label)}`);
});
