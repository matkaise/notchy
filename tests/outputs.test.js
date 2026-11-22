import test from 'node:test';
import assert from 'node:assert/strict';
import {OutputGuard, homeOutput, SETTLE_MS} from '../src/services/outputModel.js';

const hdmi = {name: 'alsa_output.pci-0000_01_00.1.hdmi-stereo', airplay: false, local: true};
const headset = {name: 'bluez_output.12_34_56_78_9A_BC.1', airplay: false, local: true};
const sunshine = {name: 'sink-sunshine-stereo', airplay: false, local: false};
const bedroom = {name: 'raop_sink.Sonos-0A1B2C3D4E5F.local.192.0.2.11.7000', airplay: true, local: false};
const kitchen = {name: 'raop_sink.Kitchen.local.192.0.2.12.7000', airplay: true, local: false};

// A guard whose outputs are all present, with the receivers found at login and this computer's output settled.
function settled(present = [hdmi, sunshine, bedroom, kitchen]) {
    const guard = new OutputGuard(), names = new Set(present.map(output => output.name));
    const exists = name => names.has(name);
    guard.appear(bedroom, 0); guard.appear(kitchen, 0);
    assert.equal(guard.check(hdmi, 0, exists), false);
    return {guard, exists, names};
}

test('a Sunshine stream ending on a receiver nobody chose goes back to this computer', () => {
    const {guard, exists} = settled();
    assert.equal(guard.check(sunshine, 10_000, exists), false, 'the stream takes the sound');
    assert.equal(guard.check(bedroom, 70_000, exists), true, 'Sunshine restoring the bedroom is undone');
    assert.equal(guard.check(bedroom, 70_400, exists), true, 'and stays undone until the output changes');
    assert.equal(homeOutput([bedroom, sunshine, hdmi], guard.home)?.name, hdmi.name);
    assert.equal(guard.check(hdmi, 70_500, exists), false);
    // The loop is broken: the next stream starts and ends on this computer.
    assert.equal(guard.check(sunshine, 80_000, exists), false);
    assert.equal(guard.check(hdmi, 90_000, exists), false);
});

test('a remembered receiver showing up after login does not take the sound', () => {
    const guard = new OutputGuard(), exists = () => true;
    assert.equal(guard.check(hdmi, 0, exists), false);
    guard.appear(bedroom, 8_000);
    assert.equal(guard.check(bedroom, 8_100, exists), true);
    assert.equal(homeOutput([hdmi, bedroom], guard.home)?.name, hdmi.name);
});

test('a receiver already the output when Notchy starts was not chosen in Notchy', () => {
    const guard = new OutputGuard();
    assert.equal(guard.check(bedroom, 50_000, () => true), true);
    assert.equal(homeOutput([bedroom, hdmi], guard.home)?.name, hdmi.name, 'any output of this computer when none was seen yet');
});

test('a receiver picked in Notchy keeps the sound, also across a game stream', () => {
    const {guard, exists} = settled();
    guard.pick(bedroom);
    assert.equal(guard.check(bedroom, 1_000, exists), false);
    assert.equal(guard.check(sunshine, 10_000, exists), false);
    assert.equal(guard.check(bedroom, 70_000, exists), false, 'Sunshine restoring the chosen receiver is fine');
});

test('a receiver chosen in GNOME\'s menu from a settled output counts as chosen', () => {
    const {guard, exists} = settled();
    assert.equal(guard.check(bedroom, 30_000, exists), false);
    assert.equal(guard.chosen, bedroom.name);
    assert.equal(guard.check(kitchen, 60_000, exists), false, 'moving on to another receiver from a chosen one');
    assert.equal(guard.chosen, kitchen.name);
});

test('going back to this computer ends the choice', () => {
    const {guard, exists} = settled();
    guard.pick(bedroom); guard.check(bedroom, 1_000, exists);
    guard.pick(hdmi); assert.equal(guard.check(hdmi, 20_000, exists), false);
    assert.equal(guard.chosen, null);
    guard.check(sunshine, 30_000, exists);
    assert.equal(guard.check(bedroom, 40_000, exists), true);
});

test('a chosen receiver that drops off the network for a moment keeps its choice', () => {
    const {guard, exists, names} = settled();
    guard.pick(bedroom); guard.check(bedroom, 1_000, exists);
    names.delete(bedroom.name);
    assert.equal(guard.check(hdmi, 20_000, exists), false, 'WirePlumber falls back while it is gone');
    assert.equal(guard.chosen, bedroom.name);
    names.add(bedroom.name); guard.appear(bedroom, 25_000);
    assert.equal(guard.check(bedroom, 25_100, exists), false, 'and returns to it');
});

test('switches in quick succession are not the person\'s choice', () => {
    const {guard, exists} = settled();
    guard.check(sunshine, 10_000, exists);
    assert.equal(guard.check(hdmi, 70_000, exists), false, 'a fallback for a moment');
    assert.equal(guard.check(bedroom, 70_000 + SETTLE_MS - 1, exists), true);
});

test('without an output of this computer the receiver stays until one returns', () => {
    const {guard, exists, names} = settled();
    names.delete(hdmi.name);
    assert.equal(guard.check(bedroom, 20_000, exists), true, 'the monitor went to sleep');
    assert.equal(homeOutput([bedroom, kitchen], guard.home), null);
    names.add(hdmi.name);
    assert.equal(guard.check(bedroom, 30_000, exists), true, 'still undone when the monitor is back');
    assert.equal(homeOutput([bedroom, hdmi], guard.home)?.name, hdmi.name);
});

test('the sound goes back to the last output of this computer', () => {
    const {guard, exists} = settled([hdmi, headset, sunshine, bedroom]);
    guard.check(headset, 10_000, exists); guard.check(sunshine, 20_000, exists);
    assert.equal(guard.check(bedroom, 30_000, exists), true);
    assert.equal(homeOutput([hdmi, headset, bedroom], guard.home)?.name, headset.name);
    assert.equal(homeOutput([hdmi, bedroom], guard.home)?.name, hdmi.name, 'or another when it is gone');
});
