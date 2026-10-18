import test from 'node:test';
import assert from 'node:assert/strict';
import {BatteryCache, STALE_MAX, FORGET_AFTER, partText, ageText} from '../src/services/batteries.js';

const BUDS = {parts: ['left', 'right', 'case']};
const at = minutes => Date.UTC(2026, 9, 18, 9) + minutes * 60000;
const read = (left, right, kase) => ({left, right, case: kase, single: null});

test('the case: present, unknown (-1 or null), present again', () => {
    const cache = new BatteryCache();
    cache.observe('AA', 'aap', read(90, 88, 65), {case: true}, {...BUDS, now: at(0)});
    assert.deepEqual(cache.part('AA', 'case', at(0)), {status: 'live', level: 65, last: 65, at: at(0), source: 'aap', charging: true});
    // Both buds in the ears: the case is reported as disconnected.
    for (const unknown of [null, -1, 101, undefined]) cache.observe('AA', 'aap', read(89, 88, unknown), {}, {...BUDS, now: at(5)});
    const stale = cache.part('AA', 'case', at(5));
    assert.equal(stale.status, 'stale', 'an unknown value never erases the last valid one');
    assert.equal(stale.level, null, 'a stale value is never shown as live');
    assert.equal(stale.last, 65); assert.equal(stale.charging, false, 'a stale reading does not claim to charge');
    assert.equal(partText(stale), '65 %'); assert.equal(ageText(stale.at, at(5)), 'vor 5 Min.');
    assert.equal(cache.part('AA', 'left', at(5)).level, 89, 'the buds stay live meanwhile');
    cache.observe('AA', 'aap', read(89, 88, 64), {}, {...BUDS, now: at(9)});
    assert.equal(cache.part('AA', 'case', at(9)).status, 'live');
    assert.equal(cache.part('AA', 'case', at(9)).level, 64);
});
test('a first connection without any case reading shows „–“; a late case value arrives live', () => {
    const cache = new BatteryCache();
    cache.observe('AA', 'airpods-helper', read(-1, -1, -1), {}, {...BUDS, now: at(0)});
    assert.equal(cache.part('AA', 'case', at(0)).status, 'unknown');
    assert.equal(partText(cache.part('AA', 'case', at(0))), '–');
    cache.observe('AA', 'airpods-helper', read(80, 80, -1), {}, {...BUDS, now: at(0.1)});
    assert.equal(cache.part('AA', 'case', at(0.1)).status, 'unknown');
    assert.ok(cache.observe('AA', 'airpods-helper', read(80, 80, 55), {}, {...BUDS, now: at(0.5)}), 'a late case value counts as a change');
    assert.equal(partText(cache.part('AA', 'case', at(0.5))), '55 %');
});
test('charging follows live readings only', () => {
    const cache = new BatteryCache();
    cache.observe('AA', 'aap', read(50, 50, 40), {case: true, left: true}, {...BUDS, now: at(0)});
    assert.equal(partText(cache.part('AA', 'case', at(0))), '⚡ 40 %');
    cache.observe('AA', 'aap', read(50, 50, 41), {case: false}, {...BUDS, now: at(1)});
    assert.equal(cache.part('AA', 'case', at(1)).charging, false);
    assert.equal(cache.part('AA', 'left', at(1)).charging, false);
});
test('disconnecting and reconnecting: readings become stale, then live again', () => {
    const cache = new BatteryCache();
    cache.observe('AA', 'aap', read(70, 71, 60), {}, {...BUDS, now: at(0)});
    assert.ok(cache.disconnect('AA'));
    for (const part of ['left', 'right', 'case']) assert.equal(cache.part('AA', part, at(3)).status, 'stale');
    assert.ok(!cache.disconnect('AA'), 'a second disconnect changes nothing');
    cache.observe('AA', 'aap', read(68, -1, -1), {}, {...BUDS, now: at(30)});
    assert.equal(cache.part('AA', 'left', at(30)).status, 'live');
    assert.equal(cache.part('AA', 'right', at(30)).status, 'stale');
    assert.equal(cache.part('AA', 'case', at(30)).last, 60);
    // A stale value expires: then it is unknown again.
    assert.equal(cache.part('AA', 'case', at(0) + STALE_MAX + 60000).status, 'unknown');
});
test('two devices keep their own cases', () => {
    const cache = new BatteryCache();
    cache.observe('AA', 'aap', read(90, 90, 30), {}, {...BUDS, now: at(0)});
    cache.observe('BB', 'aap', read(40, 40, -1), {}, {...BUDS, now: at(1)});
    assert.equal(cache.part('BB', 'case', at(1)).status, 'unknown', 'no value is taken from another device\'s case');
    assert.equal(cache.part('AA', 'case', at(1)).last, 30);
});
test('switching backend (AAP → airpods-helper) keeps the device and records the source', () => {
    const cache = new BatteryCache();
    cache.observe('AA', 'aap', read(90, 90, 70), {}, {...BUDS, now: at(0)});
    cache.disconnect('AA');
    cache.observe('AA', 'airpods-helper', read(90, 89, -1), {}, {...BUDS, now: at(1)});
    assert.deepEqual([cache.part('AA', 'case', at(1)).status, cache.part('AA', 'case', at(1)).source], ['stale', 'aap']);
    assert.equal(cache.part('AA', 'left', at(1)).source, 'airpods-helper');
});
test('a temporary D-Bus interruption: the daemon gone and back keeps the last values', () => {
    const cache = new BatteryCache();
    cache.observe('AA', 'airpods-helper', read(80, 80, 50), {}, {...BUDS, now: at(0)});
    cache.disconnect('AA');
    const saved = JSON.parse(JSON.stringify(cache.toJSON()));
    const restarted = new BatteryCache(saved, at(2));
    assert.equal(restarted.part('AA', 'case', at(2)).status, 'stale', 'persisted readings return as stale, never live');
    restarted.observe('AA', 'airpods-helper', read(80, 80, -1), {}, {...BUDS, now: at(3)});
    assert.equal(restarted.part('AA', 'case', at(3)).last, 50);
});
test('unsupported parts and the persisted cache are bounded and validated', () => {
    const cache = new BatteryCache();
    cache.observe('MAX', 'aap', {single: 70}, {}, {parts: ['single'], now: at(0)});
    assert.equal(cache.part('MAX', 'case', at(0)).status, 'unsupported');
    assert.equal(cache.part('MAX', 'single', at(0)).level, 70);
    const loaded = new BatteryCache({'': {}, AA: {seen: at(0), parts: {case: {level: 300, at: at(0)}, left: {level: 50, at: at(0), source: 'aap'}}}, OLD: {seen: at(0) - FORGET_AFTER - 1, parts: {}}, BAD: null}, at(1));
    assert.deepEqual(Object.keys(loaded.devices), ['AA']);
    assert.equal(loaded.part('AA', 'case', at(1)).status, 'unknown');
    assert.equal(loaded.part('AA', 'left', at(1)).status, 'stale');
    for (let i = 0; i < 40; i++) cache.observe(`D${i}`, 'aap', read(1, 1, 1), {}, {...BUDS, now: at(i)});
    assert.ok(Object.keys(cache.devices).length <= 16);
});
