import test from 'node:test';
import assert from 'node:assert/strict';
import {fold, matchScore, bestScore, rank, rankScore, matchTier, fileQuery, frecency, recordUse, recentUses, formatNumber, convert, parseConversion, unitSymbol,
    expandTemplate, quicklinkTarget, matchQuicklink, parseList, expandSnippet} from '../src/launcher/logic.js';

test('folding ignores case and diacritics', () => {
    assert.equal(fold('Müller Straße'), 'muller strasse');
    assert.equal(fold('ÉCOLE'), 'ecole');
});
test('match weighting: exact > prefix > word start > substring > initials > fuzzy > none', () => {
    const exact = matchScore('firefox', 'Firefox'), prefix = matchScore('fire', 'Firefox'), word = matchScore('code', 'Visual Studio Code'),
        sub = matchScore('efo', 'Firefox'), initials = matchScore('gc', 'GNOME Calendar'), fuzzy = matchScore('ffx', 'Firefox');
    assert.equal(exact, 1000);
    assert.ok(exact > prefix && prefix > word && word > sub && sub > initials && initials > fuzzy && fuzzy > 0, [exact, prefix, word, sub, initials, fuzzy].join());
    assert.equal(matchScore('xyz', 'Firefox'), 0);
    assert.equal(matchScore('', 'Firefox'), 0);
    assert.ok(matchScore('muller', 'Müller.pdf') >= 800, 'diacritics do not block a prefix match');
    assert.ok(matchScore('vs code', 'Visual Studio Code') === 0 || matchScore('studio code', 'Visual Studio Code') > 600);
    assert.ok(bestScore('term', ['Konsole', 'terminal emulator']) > 0 && bestScore('term', ['Terminal', 'x']) > bestScore('term', ['Konsole', 'terminal emulator']));
});
test('ranking merges providers, caps per kind and in total, drops duplicates; frecency orders within a band', () => {
    const results = [
        {id: 'app:a', kind: 'App', score: 500}, {id: 'app:b', kind: 'App', score: 600}, {id: 'app:c', kind: 'App', score: 400},
        {id: 'file:x', kind: 'Datei', score: 550}, {id: 'file:x', kind: 'Datei', score: 550}, {id: 'cmd:lock', kind: 'Befehl', score: 450}, {id: 'cmd:dark', kind: 'Befehl', score: 460},
    ];
    const now = Date.UTC(2026, 9, 17);
    const history = {'cmd:lock': {count: 20, last: now - 3600000}};
    const out = rank(results, {history, limit: 5, perKind: {App: 2}, now});
    // The often used command passes an app of the same match quality, not a better one.
    assert.deepEqual(out.map(r => r.id), ['app:b', 'cmd:lock', 'app:a', 'cmd:dark', 'file:x']);
    assert.ok(frecency(history['cmd:lock'], now) > frecency({count: 20, last: now - 40 * 86400000}, now), 'recent use counts more than old use');
    assert.equal(frecency(undefined, now), 0);
});

// A launcher with Google Chrome installed and 30 files named after it.
const now = Date.UTC(2026, 9, 18);
const app = (name, query) => ({id: `app:${name}`, kind: 'App', title: name, score: Math.min(1000, bestScore(query, [name]))});
const files = (query, count = 30) => Array.from({length: count}, (_, i) => {
    const name = i === 0 ? 'chrome' : i % 3 ? `chrome-export-${i}.json` : `Chrome Lesezeichen ${i}.html`;
    return {id: `file:${i}`, kind: i % 7 ? 'Datei' : 'Ordner', title: name, score: matchScore(query, name), bonus: i % 4 ? 40 : 100};
});
test('a matching app leads over many files that contain its name', () => {
    for (const query of ['chrome', 'Chrome', 'chro', 'google chrome', 'goo']) {
        const out = rank([...files(query), app('Google Chrome', query)], {limit: 24, perKind: {Datei: 4, Ordner: 3, App: 4}, now});
        assert.equal(out[0].title, 'Google Chrome', `${query}: ${out.slice(0, 3).map(r => r.title)}`);
        assert.ok(out.some(r => r.kind === 'Datei'), 'files stay reachable');
    }
    const firefox = rank([app('Firefox', 'firefox'), {id: 'file:f', kind: 'Datei', title: 'firefox', score: 1000, bonus: 100}], {now});
    assert.equal(firefox[0].title, 'Firefox');
});
test('an exactly matching app beats a frequently opened file; a fuzzy app yields to an exact file', () => {
    const history = {'file:0': {count: 400, last: now - 60000}};
    const out = rank([...files('chrome'), app('Google Chrome', 'chrome')], {history, now, limit: 24});
    assert.equal(out[0].title, 'Google Chrome');
    assert.equal(out[1].title, 'chrome', 'the frequently used, exactly named file comes right after the app');
    const fuzzy = app('Character Map', 'chrmap');
    assert.equal(matchTier(fuzzy.score), 'weak');
    const weak = rank([fuzzy, {id: 'file:x', kind: 'Datei', title: 'chrmap', score: 1000}], {now});
    assert.equal(weak[0].id, 'file:x');
});
test('exact commands and quicklinks come after strong apps and before exact files', () => {
    const cmd = {id: 'cmd:lock', kind: 'Befehl', score: 1000}, link = {id: 'link:yt', kind: 'Link', score: 1000};
    const strongApp = {id: 'app:x', kind: 'App', score: 700}, exactFile = {id: 'file:x', kind: 'Datei', score: 1000, bonus: 500};
    const history = {'cmd:lock': {count: 999, last: now}, 'file:x': {count: 999, last: now}};
    const out = rank([exactFile, link, cmd, strongApp], {history, now});
    assert.deepEqual(out.map(r => r.id), ['app:x', 'cmd:lock', 'link:yt', 'file:x']);
    assert.ok(rankScore({kind: 'Rechner', score: 2000}) > rankScore({kind: 'App', score: 1000}, {history: {}}), 'explicit intents (calculator, prefixes) still lead');
    assert.ok(rankScore({kind: 'Web', score: 1}) < rankScore({kind: 'Datei', score: 1}), 'the web search stays last');
});
test('the explicit file mode puts files and folders first', () => {
    assert.equal(fileQuery('datei bericht'), 'bericht');
    assert.equal(fileQuery('File  Bericht 2026'), 'Bericht 2026');
    assert.equal(fileQuery('/bericht'), 'bericht');
    for (const text of ['bericht', 'dateien', '2/3', '/ bericht', '//x']) assert.equal(fileQuery(text), null, text);
    const out = rank([app('Bericht-Generator', 'bericht'), {id: 'file:b', kind: 'Datei', title: 'Bericht Q3.pdf', score: matchScore('bericht', 'Bericht Q3.pdf')}], {mode: 'files', now});
    assert.equal(out[0].id, 'file:b');
});
test('late file results keep the ranking of what was already shown', () => {
    const early = [app('Google Chrome', 'chrome'), {id: 'cmd:x', kind: 'Befehl', score: 700}];
    const before = rank(early, {now}).map(r => r.id);
    const after = rank([...early, ...files('chrome')], {now, limit: 24, perKind: {Datei: 4, Ordner: 3}}).map(r => r.id);
    assert.deepEqual(after.filter(id => before.includes(id)), before);
    assert.equal(after[0], before[0]);
});

test('usage history records counts, keeps the newest entries and lists recent ones', () => {
    let history = {};
    history = recordUse(history, 'a', {title: 'A'}, 1); history = recordUse(history, 'b', {title: 'B'}, 2); history = recordUse(history, 'a', {title: 'A'}, 3);
    assert.deepEqual([history.a.count, history.a.last, history.b.count], [2, 3, 1]);
    assert.deepEqual(recentUses(history).map(e => e.id), ['a', 'b']);
    history = recordUse(history, 'c', {}, 4, 2);
    assert.deepEqual(Object.keys(history).sort(), ['a', 'c']);
});
test('numbers use a decimal comma without grouping', () => {
    assert.equal(formatNumber(6.213711922373339), '6,213711922');
    assert.equal(formatNumber(14), '14');
    assert.equal(formatNumber(1e20), '1,0000e20');
    assert.equal(formatNumber(NaN), '');
});
test('unit conversion: length, area, mass, volume, temperature, time and data', () => {
    const close = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
    assert.ok(close(convert(10, 'km', 'mi'), 6.2137119223733395));
    assert.ok(close(convert(1, 'ha', 'm2'), 10000));
    assert.ok(close(convert(1, 'lb', 'g'), 453.59237));
    assert.ok(close(convert(1, 'gal', 'l'), 3.785411784));
    assert.ok(close(convert(100, 'c', 'f'), 212) && close(convert(32, 'f', 'c'), 0) && close(convert(0, 'k', 'c'), -273.15));
    assert.ok(close(convert(1.5, 'h', 'min'), 90));
    assert.ok(close(convert(1, 'gib', 'mb'), 1073.741824));
    assert.equal(convert(1, 'km', 'kg'), null, 'no conversion across categories');
});
test('conversion queries in German and English, with and without a target', () => {
    const a = parseConversion('10 km in mi');
    assert.equal(a.from, 'km'); assert.equal(a.conversions[0].to, 'mi'); assert.equal(formatNumber(a.conversions[0].value, 6), '6,21371');
    assert.equal(parseConversion('3,5 Liter nach ml').conversions[0].value, 3500);
    assert.equal(Math.round(parseConversion('72°F').conversions[0].value * 100) / 100, 22.22);
    assert.equal(parseConversion('5 ft to cm').conversions[0].value, 152.4);
    assert.equal(parseConversion('2 Stunden in Minuten').conversions[0].value, 120);
    assert.equal(parseConversion('20 qm in ft²').conversions[0].to, 'ft2');
    assert.equal(parseConversion('1 kg in Pfund').conversions[0].value, 2);
    assert.deepEqual(parseConversion('0 °C').conversions.map(c => c.to), ['f', 'k']);
    assert.equal(parseConversion('10 km in kg'), null);
    assert.equal(parseConversion('firefox'), null);
    assert.equal(parseConversion('1password'), null);
    assert.equal(parseConversion('10 xyz'), null);
    assert.equal(unitSymbol('c'), '°C');
});
test('quicklinks insert their argument URL-encoded and only open safe targets', () => {
    assert.equal(expandTemplate('https://www.youtube.com/results?search_query={query}', 'lo-fi & chill?'), 'https://www.youtube.com/results?search_query=lo-fi%20%26%20chill%3F');
    assert.deepEqual(quicklinkTarget({url: 'https://de.wikipedia.org/w/index.php?search={query}'}, 'Zürich'), {kind: 'url', url: 'https://de.wikipedia.org/w/index.php?search=Z%C3%BCrich'});
    const gh = {url: 'https://github.com/search?q={query}&type=repositories', alt: {pattern: '^[\\w.-]+/[\\w.-]+$', url: 'https://github.com/{path}'}};
    assert.equal(quicklinkTarget(gh, 'matkaise/notchy').url, 'https://github.com/matkaise/notchy');
    assert.equal(quicklinkTarget(gh, 'gnome shell').url, 'https://github.com/search?q=gnome%20shell&type=repositories');
    assert.equal(quicklinkTarget({url: 'javascript:alert(1)'}, ''), null);
    assert.equal(quicklinkTarget({url: 'https://x.org/{query}'}, '@evil.com').url, 'https://x.org/%40evil.com');
    assert.equal(quicklinkTarget({url: 'file:///etc/passwd'}), null);
    assert.deepEqual(quicklinkTarget({url: 'app:org.gnome.Nautilus.desktop'}), {kind: 'app', id: 'org.gnome.Nautilus.desktop'});
    assert.equal(quicklinkTarget({url: 'app:$(rm -rf).desktop'}), null);
    assert.deepEqual(quicklinkTarget({url: 'xdg:DOWNLOAD'}), {kind: 'folder', xdg: 'DOWNLOAD'});
    assert.deepEqual(quicklinkTarget({url: '~/Projekte'}), {kind: 'folder', path: '~/Projekte'});
    const links = [{keyword: 'yt', url: 'https://youtube.com/{query}'}];
    assert.deepEqual(matchQuicklink('yt lofi beats', links), {link: links[0], argument: 'lofi beats', complete: true});
    assert.equal(matchQuicklink('ytx', links), null);
    assert.equal(matchQuicklink('yt', links).complete, false);
});
test('saved lists drop malformed entries; snippets fill in date and time', () => {
    assert.deepEqual(parseList('[{"keyword":"a","url":"https://a"},{"keyword":1},null,"x"]', ['keyword', 'url']), [{keyword: 'a', url: 'https://a'}]);
    assert.deepEqual(parseList('not json', ['keyword']), []);
    assert.equal(expandSnippet('Stand {date}, {time}', new Date(2026, 9, 7, 9, 5)), 'Stand 07.10.2026, 09:05');
});
