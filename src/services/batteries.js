// AirPods batteries per device and part (left, right, case, single), shared
// by both backends (airpods-helper over D-Bus, Notchy's own AAP reader).
// Pure logic without GNOME imports, so the Node test suite covers it.
//
// What the AirPods actually tell: a bud's level whenever it is connected, and
// the case's level only while the case is connected to the buds — that is,
// while at least one bud sits in it (lid open, or a moment after closing).
// With both buds in the ears, or the case out of reach, the AirPods report the
// case as disconnected (AAP status 0x04) and airpods-helper as BatteryCase -1.
// That is no failure and no zero: it is unknown right now. Notchy keeps the
// last valid reading of each part and shows it as such, never as live.
//
// Each part has:
//   status   'live' (a reading in the current connection, still reported),
//            'stale' (a valid reading from earlier, the part no longer reports),
//            'unknown' (never read, or the last reading expired),
//            'unsupported' (the model or backend has no such part);
//   level    the live level or null;
//   last     the last valid level (live or stale) or null, with `at` and `source`;
//   charging true only for a live reading that says so.

export const PARTS = ['left', 'right', 'case', 'single'];
// A remembered level is shown for this long after it was read: a case drains
// slowly, but after half a day its old number would mislead.
export const STALE_MAX = 12 * 3600 * 1000;
// Devices not seen for this long are dropped from the persisted cache.
export const FORGET_AFTER = 30 * 86400 * 1000;
const MAX_DEVICES = 16;

const valid = level => Number.isInteger(level) && level >= 0 && level <= 100;

export class BatteryCache {
    constructor(saved = {}, now = Date.now()) {
        this.devices = {};
        // Persisted readings come back as stale ones: nothing is live before
        // the AirPods report again.
        for (const [key, device] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
            if (!key || !device || typeof device !== 'object' || !(now - (device.seen ?? 0) < FORGET_AFTER)) continue;
            const parts = {};
            for (const part of PARTS) {
                const entry = device.parts?.[part];
                if (entry && valid(entry.level) && Number.isFinite(entry.at) && entry.at <= now) parts[part] = {level: entry.level, at: entry.at, source: String(entry.source ?? ''), live: false, charging: false};
            }
            this.devices[key] = {seen: device.seen, parts};
        }
    }
    // A report from a backend for one device: levels per part (null or -1 =
    // unknown now), charging per part, and which parts this model/backend has.
    // Returns true when anything that is shown changed.
    observe(key, source, battery, charging = {}, {parts = PARTS, now = Date.now()} = {}) {
        if (!key) return false;
        const device = this.devices[key] ??= {seen: now, parts: {}};
        const before = JSON.stringify(device.parts);
        device.seen = now; device.supported = [...parts];
        for (const part of PARTS) {
            const entry = device.parts[part], level = battery?.[part];
            if (!parts.includes(part)) { if (entry) entry.live = false; continue; }
            // A valid reading replaces the last one; an unknown one keeps it, only no longer live.
            if (valid(level)) device.parts[part] = {level, at: now, source, live: true, charging: Boolean(charging?.[part])};
            else if (entry) { entry.live = false; entry.charging = false; }
        }
        this.prune(now);
        return JSON.stringify(device.parts) !== before;
    }
    // The device left (disconnected, backend gone): its readings become stale.
    disconnect(key) {
        const device = this.devices[key]; if (!device) return false;
        let changed = false;
        for (const entry of Object.values(device.parts)) if (entry.live || entry.charging) { entry.live = false; entry.charging = false; changed = true; }
        return changed;
    }
    // The state of one part for display.
    part(key, part, now = Date.now()) {
        const device = this.devices[key];
        if (device?.supported && !device.supported.includes(part)) return {status: 'unsupported', level: null, last: null, at: null, source: '', charging: false};
        const entry = device?.parts[part];
        if (!entry) return {status: 'unknown', level: null, last: null, at: null, source: '', charging: false};
        if (entry.live) return {status: 'live', level: entry.level, last: entry.level, at: entry.at, source: entry.source, charging: entry.charging};
        if (now - entry.at > STALE_MAX) return {status: 'unknown', level: null, last: null, at: entry.at, source: entry.source, charging: false};
        return {status: 'stale', level: null, last: entry.level, at: entry.at, source: entry.source, charging: false};
    }
    view(key, now = Date.now()) { return Object.fromEntries(PARTS.map(part => [part, this.part(key, part, now)])); }
    prune(now = Date.now()) {
        for (const [key, device] of Object.entries(this.devices)) if (now - device.seen > FORGET_AFTER) delete this.devices[key];
        const keys = Object.keys(this.devices);
        if (keys.length > MAX_DEVICES) for (const key of keys.sort((a, b) => this.devices[a].seen - this.devices[b].seen).slice(0, keys.length - MAX_DEVICES)) delete this.devices[key];
    }
    // What is written to disk: valid readings and when they were made.
    toJSON() {
        return Object.fromEntries(Object.entries(this.devices).map(([key, device]) => [key, {seen: device.seen,
            parts: Object.fromEntries(Object.entries(device.parts).map(([part, e]) => [part, {level: e.level, at: e.at, source: e.source}]))}]));
    }
}

// "65 %", "Zuletzt 65 %" and "vor 5 Min." for a part as the UI shows it.
export function ageText(at, now = Date.now()) {
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 1) return 'gerade eben';
    if (minutes < 60) return `vor ${minutes} Min.`;
    const hours = Math.round(minutes / 60);
    return `vor ${hours} Std.`;
}
export function partText(info, now = Date.now()) {
    if (info.status === 'live') return `${info.charging ? '⚡ ' : ''}${info.level} %`;
    if (info.status === 'stale') return `${info.last} %`;
    return '–';
}
