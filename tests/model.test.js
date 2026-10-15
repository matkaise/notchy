import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUris, classify, History, calculate, normalizeTags, combineCopies, eventsForDay, relativeTime, mprisActive, isoWeek, weekDays, groupBy, SNAP_LAYOUTS, zoneRect} from '../src/model.js';

test('file drops parse URI lists, deduplicate and reject unsafe/nonlocal data', () => {
    assert.deepEqual(parseUris('# Comment\r\nfile:///tmp/a%20b\r\nfile:///tmp/a%20b\nhttps://example.com\nfile:///tmp/%ZZ\nfile:///tmp/%00'), ['file:///tmp/a%20b']);
});
test('history updates duplicates, retains favorites beyond limits, searches source and titles', () => {
    const h = new History([], 2); const a = h.add('first', 'Editor', 1); a.favorite = true; a.title = 'Project';
    h.add('second', '', 2); h.add('third', '', 3); h.add('fourth', '', 4);
    assert.equal(h.items.length, 3); assert.equal(h.search('project')[0], a); assert.equal(h.search('editor')[0], a);
    h.add('first', 'Editor', 5); assert.equal(h.items[0].id, a.id); assert.equal(h.items[0].favorite, true);
    h.clear(); assert.deepEqual(h.items, [a]); h.clear(false); assert.equal(h.items.length, 0);
});
test('history honors retention, tolerates malformed persisted entries and caps text size', () => {
    const h = new History([{}, null, {id:'a',text:'valid',created:0}], 10); h.prune(1, 86400001); assert.deepEqual(h.items, []);
    assert.equal(h.add('x'.repeat(1048577)), null);
});
test('classifies links and colors without classifying multiline text as links', () => {
    assert.equal(classify('https://example.com'), 'link'); assert.equal(classify('#AaB'), 'color'); assert.equal(classify('https://example.com\nmore'), 'text');
});
test('calculator handles precedence, unary signs, parentheses and invalid input without eval', () => {
    for (const [expr,result] of [['2+3*4',14],['(2+3)*4',20],['-2 * -3',6],['.5+1.5',2],['10%3',1],['1/0',null],['1 +',null],['1 2',null],['1..2',null],['(2+3',null],['process.exit()',null],['$(touch /tmp/a)',null]]) assert.equal(calculate(expr),result,expr);
});
test('tags migrate old history, normalize edits and participate in combined filters', () => {
    assert.deepEqual(normalizeTags(' #Arbeit, Arbeit, , Projekt '), ['Arbeit', 'Projekt']);
    assert.deepEqual(normalizeTags([null, 1, 'Tag']), ['Tag']);
    const h = new History([{id:'old', text:'old copy', created:10}]);
    assert.deepEqual(h.items[0].tags, []);
    const item = h.add('https://example.com', 'Browser', 20); item.tags = normalizeTags('Arbeit, Projekt');
    assert.equal(h.search('projekt')[0], item);
    assert.equal(h.search('', 'link', false, 'Arbeit')[0], item);
    assert.equal(h.search('', 'text', false, 'Arbeit').length, 0);
    assert.equal(h.search('', 'all', true, 'Arbeit').length, 0);
    item.favorite = true; assert.equal(h.search('', 'all', true, 'Arbeit')[0], item);
});
test('batch copy joins texts, preserves native file lists and rejects lossy mixed selections', () => {
    assert.deepEqual(combineCopies([{kind:'text', text:'first'}, {kind:'link', text:'https://example.com'}]), {mime:'text/plain', text:'first\nhttps://example.com'});
    assert.deepEqual(combineCopies([{kind:'files', uris:['file:///tmp/a']}, {kind:'files', uris:['file:///tmp/a', 'file:///tmp/b']}]), {mime:'text/uri-list', text:'file:///tmp/a\r\nfile:///tmp/b\r\n'});
    assert.equal(combineCopies([{kind:'image', text:'digest'}, {kind:'text', text:'text'}]), null);
    assert.equal(combineCopies([{kind:'files', uris:['file:///tmp/a']}, {kind:'text', text:'text'}]), null);
    assert.equal(combineCopies([]), null);
});

test('calendar handles all-day, overnight and zero-duration events with exclusive day boundaries', () => {
    const day = new Date(2026, 9, 11), begin = day.getTime(), end = new Date(2026, 9, 12).getTime();
    const events = [{id:'ends-at-midnight', begin:begin-10000, end:begin}, {id:'all-day',begin,end}, {id:'starts-next-day',begin:end,end:end+10000}, {id:'overnight',begin:begin-1000,end:begin+1000}, {id:'instant',begin:begin+1000,end:begin+1000}];
    assert.deepEqual(eventsForDay(events, day).map(x=>x.id), ['overnight','all-day','instant']);
});

test('MPRIS metadata tolerates absent optional values and both artist representations', async () => {
    const {mprisMetadata} = await import('../src/model.js');
    assert.equal(mprisMetadata({'xesam:artist':['A','B']}).artist,'A, B');
    assert.equal(mprisMetadata({'xesam:artist':'Artist'}).artist,'Artist');
    assert.equal(mprisMetadata({'mpris:trackid':{deep_unpack:()=>'/track/1'}}).trackId,'/track/1');
});
test('relative times read naturally for list metadata', () => {
    const now = Date.UTC(2026, 9, 14, 12);
    assert.equal(relativeTime(now - 20000, now), 'gerade eben');
    assert.equal(relativeTime(now - 5 * 60000, now), 'vor 5 Min.');
    assert.equal(relativeTime(now - 3 * 3600000, now), 'vor 3 Std.');
    assert.equal(relativeTime(now - 30 * 3600000, now), 'gestern');
    assert.equal(relativeTime(now - 4 * 86400000, now), 'vor 4 Tagen');
    assert.equal(relativeTime(now + 60000, now), 'gerade eben');
});
test('a stopped player without a track leaves the island', () => {
    const variant = value => ({deep_unpack: () => value});
    assert.equal(mprisActive('Playing', {'xesam:title': variant('Song')}), true);
    assert.equal(mprisActive('Paused', {'xesam:url': 'https://youtube.com/watch'}), true);
    assert.equal(mprisActive('Stopped', {'xesam:title': variant('Song')}), false);
    assert.equal(mprisActive('Paused', {'mpris:trackid': variant('/org/chromium/MediaPlayer2/TrackList/NoTrack'), 'xesam:title': variant('')}), false);
    assert.equal(mprisActive('Playing', {}), false);
});
test('calendar weeks: ISO week numbers and Monday-first week strips across month and year ends', () => {
    for (const [date, week] of [[new Date(2026, 9, 15), 42], [new Date(2021, 0, 3), 53], [new Date(2021, 0, 4), 1], [new Date(2024, 11, 30), 1], [new Date(2026, 0, 1), 1]]) assert.equal(isoWeek(date), week, date.toDateString());
    const days = weekDays(new Date(2026, 9, 15));
    assert.deepEqual(days.map(d => [d.getMonth(), d.getDate(), d.getDay()]), [[9,12,1],[9,13,2],[9,14,3],[9,15,4],[9,16,5],[9,17,6],[9,18,0]]);
    const next = weekDays(new Date(2026, 9, 31), 1); assert.deepEqual([next[0].getMonth(), next[0].getDate(), next[6].getMonth(), next[6].getDate()], [10, 2, 10, 8]);
    assert.equal(weekDays(new Date(2026, 9, 18))[0].getDate(), 12, 'Sunday belongs to the week before');
});
test('notifications group per app in order of their newest entry', () => {
    const groups = groupBy([{app: 'Chat', id: 1}, {app: 'Mail', id: 2}, {app: 'Chat', id: 3}], x => x.app);
    assert.deepEqual(groups.map(g => [g.name, g.items.map(x => x.id)]), [['Chat', [1, 3]], ['Mail', [2]]]);
});
test('snap layouts tile the whole work area without gaps or overlaps', () => {
    const area = {x: 0, y: 32, width: 3440, height: 1408};
    for (const layout of SNAP_LAYOUTS) {
        const rects = layout.zones.map(zone => zoneRect(area, zone));
        assert.equal(rects.reduce((sum, r) => sum + r.width * r.height, 0), area.width * area.height, layout.name);
        for (const r of rects) assert.ok(r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height, layout.name);
    }
    assert.deepEqual(zoneRect({x: 10, y: 20, width: 1001, height: 600}, [1 / 3, 0, 1 / 3, 1]), {x: 344, y: 20, width: 333, height: 600});
});
