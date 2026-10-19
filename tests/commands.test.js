import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CATEGORIES, COMMANDS, COMMAND_IDS, LEGACY_IDS, canonicalId, commandById, migrateHistory, parseCommandConfig, sanitizeOverride, effective,
    updateCommandConfig, aliasCollisions, commandScore, commandBonus, available, SHORTCUT_SCORE} from '../src/launcher/commands.js';
import {rank, rankScore, fold, matchTier} from '../src/launcher/logic.js';
import {_, parseMo} from '../src/i18n/core.js';
import {useLanguage} from './i18n-helper.js';

const now = Date.UTC(2026, 9, 19);
// Thunderstorm's command search, as SystemProvider runs it: enabled and
// available commands, their score and bonus, then the shared ranking.
function search(query, config = {}, env = {notifications: true, files: true, capture: true}) {
    const results = [];
    for (const def of COMMANDS.filter(c => c.category !== 'windows')) {
        const cfg = effective(def, config);
        if (!cfg.enabled || !available(def, env)) continue;
        const score = commandScore(query, def, cfg, _(def.title));
        if (score >= 450) results.push({id: `cmd:${def.id}`, kind: 'command', title: _(def.title), score, bonus: commandBonus(cfg), confirm: def.requiresConfirmation});
    }
    return rank(results, {now});
}
const ids = results => results.map(r => r.id.slice(4));

test('the catalog: unique stable ids, known categories, dangerous commands always confirm', () => {
    assert.equal(COMMAND_IDS.size, COMMANDS.length);
    const categories = new Set(CATEGORIES.map(c => c.id));
    for (const def of COMMANDS) {
        assert.match(def.id, /^[a-z]+\.[a-zA-Z.]+$/, def.id);
        assert.ok(categories.has(def.category), def.id);
        for (const field of ['title', 'description', 'icon']) assert.ok(def[field], `${def.id}: ${field}`);
        assert.ok(def.keywords.length >= 2, def.id);
        if (def.dangerous) assert.ok(def.requiresConfirmation && def.confirm, `${def.id} asks first`);
    }
    for (const id of ['system.shutdown', 'system.restart', 'system.logout']) assert.equal(commandById(id).requiresConfirmation, true, id);
    for (const [legacy, id] of Object.entries(LEGACY_IDS)) assert.ok(COMMAND_IDS.has(id), `${legacy} → ${id}`);
});

test('every command is found by its English and its German title, whatever the interface speaks', () => {
    const catalog = parseMo(readFileSync(new URL('../locale/de/LC_MESSAGES/notchy.mo', import.meta.url))).messages;
    for (const def of COMMANDS) {
        const german = catalog.get(def.title);
        assert.ok(german, `${def.id} has a German title`);
        // The English title always counts (commandScore); the German one must be a keyword.
        if (!def.numbered) assert.ok(def.keywords.map(fold).includes(fold(german)), `${def.id}: "${german}" is a search term`);
    }
});

test('the weighting does not depend on the interface language', () => {
    const queries = ['ausschalten', 'shutdown', 'shut down', 'neustart', 'restart', 'neu starten', 'bildschirm sperren', 'lock screen', 'sperren', 'bluetooth',
        'wlan', 'wifi', 'nicht stören', 'do not disturb', 'abmelden', 'log out', 'audio', 'einstellungen', 'settings', 'regal', 'shelf', 'airpods'];
    const scores = lang => { useLanguage(lang); return Object.fromEntries(queries.map(q => [q, search(q).map(r => `${r.id}:${r.score}`)])); };
    const german = scores('de'), english = scores('en');
    assert.deepEqual(german, english);
    useLanguage('de');
    assert.equal(ids(search('ausschalten'))[0], 'system.shutdown');
    assert.equal(ids(search('shutdown'))[0], 'system.shutdown');
    assert.equal(ids(search('neustart'))[0], 'system.restart');
    assert.equal(ids(search('restart'))[0], 'system.restart');
    assert.equal(ids(search('bildschirm sperren'))[0], 'system.lock');
    assert.equal(ids(search('lock screen'))[0], 'system.lock');
});

test('after installation every command is on and shown with its defaults', () => {
    for (const config of [parseCommandConfig('{}'), parseCommandConfig(''), parseCommandConfig(undefined)]) {
        for (const def of COMMANDS) assert.deepEqual(effective(def, config), {enabled: true, visible: true, favorite: false, priority: 0, aliases: [], shortcut: '', requiresConfirmation: def.requiresConfirmation});
    }
    useLanguage('en');
    assert.ok(ids(search('lock')).includes('system.lock'));
});

test('a switched-off command is no result, and neither are all optional ones', () => {
    let json = updateCommandConfig('{}', 'system.suspend', {enabled: false});
    assert.ok(!ids(search('suspend', parseCommandConfig(json))).includes('system.suspend'));
    assert.ok(!ids(search('bereitschaft', parseCommandConfig(json))).includes('system.suspend'));
    // Everything that is not about power or the session off.
    json = '{}';
    for (const def of COMMANDS.filter(c => c.category !== 'power')) json = updateCommandConfig(json, def.id, {enabled: false});
    const config = parseCommandConfig(json);
    for (const query of ['settings', 'bluetooth', 'regal', 'airpods', 'notchy', 'screenshot']) {
        assert.ok(search(query, config).every(r => commandById(r.id.slice(4)).category === 'power'), query);
    }
    assert.equal(ids(search('shutdown', config))[0], 'system.shutdown', 'the rest stays');
});

test('hidden commands are reached only by their shortcut, which leads like a quicklink keyword', () => {
    const json = updateCommandConfig('{}', 'system.shutdown', {visible: false, shortcut: 'Off'});
    const config = parseCommandConfig(json);
    assert.equal(config['system.shutdown'].shortcut, 'off', 'shortcuts are stored folded');
    assert.ok(!ids(search('shutdown', config)).includes('system.shutdown'));
    const hit = search('off', config);
    assert.equal(hit[0].id, 'cmd:system.shutdown'); assert.equal(hit[0].score, SHORTCUT_SCORE);
    assert.ok(rankScore(hit[0]) > rankScore({kind: 'app', score: 1000}), 'an exact shortcut is an explicit intent');
    assert.equal(hit[0].confirm, true, 'and still asks first');
});

test('own search terms: added, changed, cleared; collisions with other commands and quicklinks are reported', () => {
    let json = updateCommandConfig('{}', 'settings.bluetooth', {aliases: ['Kopfhörer koppeln', ' BT ', 'bt', '']});
    assert.deepEqual(parseCommandConfig(json)['settings.bluetooth'].aliases, ['kopfhörer koppeln', 'bt']);
    assert.equal(ids(search('bt', parseCommandConfig(json)))[0], 'settings.bluetooth');
    json = updateCommandConfig(json, 'settings.bluetooth', {aliases: ['blau']});
    assert.ok(!ids(search('bt', parseCommandConfig(json))).includes('settings.bluetooth'), 'a changed alias replaces the old one');
    assert.equal(ids(search('blau', parseCommandConfig(json)))[0], 'settings.bluetooth');
    json = updateCommandConfig(json, 'settings.wifi', {aliases: ['blau'], shortcut: 'yt'});
    const clashes = aliasCollisions(parseCommandConfig(json), ['yt', 'gh']);
    assert.deepEqual(clashes.get('blau').sort(), ['settings.bluetooth', 'settings.wifi']);
    assert.deepEqual(clashes.get('yt'), ['settings.wifi', 'quicklink:yt']);
    // Both commands with the same alias stay findable; a priority decides between them.
    json = updateCommandConfig(json, 'settings.wifi', {priority: 1});
    assert.deepEqual(ids(search('blau', parseCommandConfig(json))).slice(0, 2), ['settings.wifi', 'settings.bluetooth']);
    json = updateCommandConfig(json, 'settings.bluetooth', {aliases: []});
    assert.equal(parseCommandConfig(json)['settings.bluetooth'], undefined, 'nothing left: the command is back to its defaults');
});

test('favourites and priorities order equal matches, but never lift a weak match above a strong one', () => {
    const fav = parseCommandConfig(updateCommandConfig('{}', 'settings.sound', {favorite: true}));
    assert.equal(commandBonus(effective('settings.sound', fav)), 60);
    // Two commands that match equally (the same own search term): the favourite leads.
    let json = updateCommandConfig('{}', 'settings.sound', {aliases: ['laut']});
    json = updateCommandConfig(json, 'settings.power', {aliases: ['laut']});
    assert.deepEqual(ids(search('laut', parseCommandConfig(json))).slice(0, 2), ['settings.sound', 'settings.power'], 'equal: catalog order');
    json = updateCommandConfig(json, 'settings.power', {favorite: true});
    assert.deepEqual(ids(search('laut', parseCommandConfig(json))).slice(0, 2), ['settings.power', 'settings.sound'], 'the favourite first');
    json = updateCommandConfig(json, 'settings.sound', {priority: 2});
    assert.deepEqual(ids(search('laut', parseCommandConfig(json))).slice(0, 2), ['settings.sound', 'settings.power'], 'a higher priority beats a favourite');
    // A favourite never passes a better match: an exact title stays above a word-start alias.
    const better = parseCommandConfig(updateCommandConfig(updateCommandConfig('{}', 'settings.wifi', {favorite: true, priority: 2, aliases: ['bluetooth funk']}), 'settings.bluetooth', {}));
    assert.equal(ids(search('bluetooth', better))[0], 'settings.bluetooth');
    // A weak (fuzzy) command, even a favourite with the highest priority, stays below an exactly matching file.
    const weak = {id: 'cmd:x', kind: 'command', score: 410, bonus: commandBonus({favorite: true, priority: 2})};
    assert.equal(matchTier(weak.score), 'weak');
    assert.equal(rank([weak, {id: 'file:x', kind: 'file', score: 1000}], {now})[0].id, 'file:x');
    const low = parseCommandConfig(updateCommandConfig('{}', 'system.lock', {priority: -2}));
    assert.equal(commandBonus(effective('system.lock', low)), -80);
});

test('the usage history: old ids become new ones and keep their count', () => {
    const history = migrateHistory({'cmd:lock': {provider: 'cmd', command: 'lock', count: 3, last: 10, title: 'Bildschirm sperren', kind: 'Befehl'},
        'cmd:system.lock': {provider: 'cmd', command: 'system.lock', count: 2, last: 20}, 'cmd:settings-bluetooth': {provider: 'cmd', command: 'settings-bluetooth', count: 1, last: 5},
        'app:firefox.desktop': {provider: 'app', app: 'firefox.desktop', count: 7, last: 30}, 'cmd:unknown-thing': {provider: 'cmd', command: 'unknown-thing', count: 1, last: 1}});
    assert.deepEqual(Object.keys(history).sort(), ['app:firefox.desktop', 'cmd:settings.bluetooth', 'cmd:system.lock', 'cmd:unknown-thing']);
    assert.equal(history['cmd:system.lock'].count, 5); assert.equal(history['cmd:system.lock'].last, 20); assert.equal(history['cmd:system.lock'].command, 'system.lock');
    assert.equal(history['cmd:settings.bluetooth'].command, 'settings.bluetooth');
    assert.equal(canonicalId('lock'), 'system.lock'); assert.equal(canonicalId('system.lock'), 'system.lock'); assert.equal(canonicalId('nonsense'), null);
    assert.deepEqual(migrateHistory(history), history, 'migrating twice changes nothing');
});

test('commands that cannot work now are not offered', () => {
    const env = {notifications: true, files: true, capture: true, workspaces: 1, window: false, airpods: null};
    const offered = e => COMMANDS.filter(def => available(def, e)).map(def => def.id);
    const none = offered(env);
    for (const id of ['airpods.connect', 'airpods.disconnect', 'airpods.anc.noise', 'window.maximize', 'window.workspaceNext', 'window.workspace']) assert.ok(!none.includes(id), id);
    const paired = offered({...env, airpods: {state: {}, connected: false, modes: []}});
    assert.ok(paired.includes('airpods.connect') && !paired.includes('airpods.disconnect'));
    const connected = offered({...env, airpods: {state: {}, connected: true, modes: ['noise', 'transparency']}});
    assert.ok(connected.includes('airpods.disconnect') && connected.includes('airpods.anc.transparency') && !connected.includes('airpods.anc.adaptive') && !connected.includes('airpods.connect'));
    const window = offered({...env, window: true, workspaces: 3});
    assert.ok(window.includes('window.maximize') && window.includes('window.moveNext') && window.includes('window.workspace'));
    assert.ok(!offered({...env, window: true, workspaces: 1}).includes('window.moveNext'));
    assert.ok(!offered({...env, notifications: false}).includes('system.dnd'));
    assert.ok(!offered({...env, capture: false}).includes('system.screenshot'));
});

test('invalid settings: anything malformed is dropped, a confirmation cannot be switched off', () => {
    for (const json of ['not json', '[]', '"x"', '42', 'null', '{"system.lock": "yes"}', '{"system.lock": []}']) {
        assert.deepEqual(effective('system.lock', parseCommandConfig(json)).enabled, true, json);
    }
    const config = parseCommandConfig(JSON.stringify({
        'system.shutdown': {enabled: 'false', visible: 0, requiresConfirmation: false, confirm: '', priority: 99, aliases: ['ok', 7, null, 'x'.repeat(41)], shortcut: 'rm -rf', favorite: true},
        'BAD ID': {enabled: false}, 'future.command': {enabled: false}, '__proto__': {enabled: false},
    }));
    assert.deepEqual(config['system.shutdown'], {favorite: true, priority: 2, aliases: ['ok']});
    assert.equal(effective('system.shutdown', config).requiresConfirmation, true);
    assert.equal(config['BAD ID'], undefined);
    assert.deepEqual(config['future.command'], {enabled: false}, 'a newer version’s command is kept, not used');
    assert.equal(effective('future.command', config), null);
    assert.equal(sanitizeOverride({shortcut: 'a b'}), null, 'shortcuts are single words');
    assert.deepEqual(sanitizeOverride({aliases: Array.from({length: 30}, (_v, i) => `a${i}`)}).aliases.length, 12);
});

test('reset: one command or all; a restart of the extension reads the same settings', () => {
    let json = updateCommandConfig('{}', 'system.lock', {enabled: false, favorite: true});
    json = updateCommandConfig(json, 'system.dnd', {aliases: ['ruhe']});
    // Stored as JSON text in GSettings: what a re-enabled extension parses again.
    const restarted = parseCommandConfig(JSON.parse(JSON.stringify(json)));
    assert.deepEqual(restarted, parseCommandConfig(json));
    json = updateCommandConfig(json, 'system.lock', null);
    assert.equal(parseCommandConfig(json)['system.lock'], undefined);
    assert.deepEqual(parseCommandConfig(json)['system.dnd'], {aliases: ['ruhe']});
    // Values equal to the default are not stored.
    assert.equal(updateCommandConfig('{}', 'system.lock', {enabled: true, visible: true, favorite: false, priority: 0}), '{}');
    assert.equal(updateCommandConfig('{}', 'no.such.command', {enabled: false}), '{}');
});

test('several changes in a row, each from the stored state, keep every change', () => {
    // The preferences read the setting before each write, as quick successive toggles do.
    let stored = '{}';
    const write = (id, patch) => { stored = updateCommandConfig(stored, id, patch); };
    write('system.lock', {favorite: true}); write('system.dnd', {enabled: false}); write('system.lock', {priority: 1}); write('settings.wifi', {shortcut: 'w'});
    const config = parseCommandConfig(stored);
    assert.deepEqual(config['system.lock'], {favorite: true, priority: 1});
    assert.deepEqual(config['system.dnd'], {enabled: false});
    assert.deepEqual(config['settings.wifi'], {shortcut: 'w'});
});

test('a language change keeps every setting; only titles change', () => {
    const json = updateCommandConfig('{}', 'system.shutdown', {aliases: ['feierabend'], shortcut: 'off'});
    useLanguage('de'); const german = search('feierabend', parseCommandConfig(json));
    useLanguage('en'); const english = search('feierabend', parseCommandConfig(json));
    assert.deepEqual(german.map(r => [r.id, r.score]), english.map(r => [r.id, r.score]));
    assert.equal(german[0].title, 'Ausschalten'); assert.equal(english[0].title, 'Shut Down');
    assert.equal(parseCommandConfig(json)['system.shutdown'].shortcut, 'off');
});
