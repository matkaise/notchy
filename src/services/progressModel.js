// Progress apps publish through the LauncherEntry interface
// (src/services/launcherEntry.js), as pure logic for the Node tests.
//
// An app sends Update(app_uri, properties) whenever something changes;
// properties are partial (only what changed), so the last known value of each
// is kept. Only `progress` (0..1) together with `progress-visible` is used.
// When the app hides its progress, Notchy cannot know why: it counts as
// finished only if the last reported value was complete, else it leaves
// quietly (a cancelled download is not a success).

// An entry that has not been updated for this long is no longer believed.
export const STALE_MS = 30 * 60 * 1000;
// A finished entry is reported this long (the activity lingers less).
export const FINISHED_MS = 30000;
const APP_RE = /^[A-Za-z0-9][\w.-]{0,120}\.desktop$/;

// application://firefox.desktop → firefox.desktop; anything else → null.
export function launcherEntryUpdate(uri, properties = {}) {
    const match = /^application:\/\/(.+)$/.exec(String(uri ?? ''));
    if (!match || !APP_RE.test(match[1]) || !properties || typeof properties !== 'object') return null;
    const update = {app: match[1]};
    if ('progress' in properties) {
        const value = Number(properties.progress);
        if (typeof properties.progress !== 'boolean' && Number.isFinite(value)) update.progress = Math.max(0, Math.min(1, value));
    }
    if ('progress-visible' in properties) update.visible = Boolean(properties['progress-visible']);
    return 'progress' in update || 'visible' in update ? update : null;
}

export class LauncherEntries {
    constructor() { this.entries = new Map(); }
    // Returns whether what is shown changed.
    update({app, progress, visible}, sender = '', now = Date.now()) {
        const old = this.entries.get(app);
        const entry = {app, sender, progress: progress ?? old?.progress ?? null, visible: visible ?? old?.visible ?? false, updated: now, state: 'running', finishedAt: 0, started: old?.started ?? now};
        if (!entry.visible) {
            // Nothing shown yet, or already finished: a hidden progress changes nothing
            // (a finished entry stays its time).
            if (!old || old.state !== 'running') return false;
            // Hidden after a complete value: finished; else it just leaves.
            if (old.visible && (entry.progress ?? 0) >= 0.999) this.entries.set(app, {...old, progress: 1, state: 'completed', finishedAt: now, updated: now});
            else this.entries.delete(app);
            return true;
        }
        // A complete value is finished at once (Files keeps 100 % shown for seconds);
        // a lower value after it is the next operation.
        if (entry.progress !== null && entry.progress >= 0.999) {
            if (old?.state === 'completed') return false;
            if (!old || !old.visible) return false;
            this.entries.set(app, {...entry, progress: 1, state: 'completed', finishedAt: now, started: old.started});
            return true;
        }
        if (old?.state === 'completed') entry.started = now;
        this.entries.set(app, entry);
        return !old || old.progress !== entry.progress || old.visible !== entry.visible || old.state !== entry.state;
    }
    vanished(sender) {
        let changed = false;
        for (const [app, entry] of this.entries) if (entry.sender === sender) { this.entries.delete(app); changed = true; }
        return changed;
    }
    // Visible progress and recently finished entries; stale ones are dropped.
    list(now = Date.now()) {
        for (const [app, entry] of this.entries) {
            if ((entry.state === 'running' && now - entry.updated > STALE_MS) || (entry.state === 'completed' && now - entry.finishedAt > FINISHED_MS)) this.entries.delete(app);
        }
        return [...this.entries.values()].filter(entry => entry.state === 'completed' || (entry.visible && entry.progress !== null));
    }
}

// Browser downloads, seen in the Downloads folder (src/services/downloads.js).
// Chrome, Chromium, Edge, Brave and Vivaldi write `name.crdownload` (first
// `Unconfirmed 123456.crdownload` until the name is known), Firefox
// `name.part` beside an empty `name`, Opera `name.opdownload`; each is
// renamed to its final name when it is complete. None of them publishes the
// total size, so a download shows what it measurably has — its bytes so far —
// and never a percentage. Renamed to its final name: finished; deleted:
// cancelled, it leaves quietly; not growing for a while (paused, stalled, a
// leftover from before): not shown, until it grows again.
export const DOWNLOAD_SUFFIXES = ['.crdownload', '.part', '.opdownload'];
export const DOWNLOAD_STALE_MS = 2 * 60 * 1000;
export const DOWNLOAD_DONE_MS = 30000;
// A file name in the Downloads folder → {temp, name}: whether it is a
// download in progress and the name it will have (null while unknown).
export function downloadName(file) {
    const base = String(file ?? '');
    const suffix = DOWNLOAD_SUFFIXES.find(s => base.toLowerCase().endsWith(s) && base.length > s.length);
    if (!suffix) return {temp: false, name: base};
    const name = base.slice(0, -suffix.length);
    return {temp: true, name: /^Unconfirmed \d+$/.test(name) ? null : name};
}
export class Downloads {
    constructor() { this.entries = new Map(); this.seq = 0; }
    // A temporary file's size as seen now. `initial`: found when watching
    // began — remembered, but shown only once it grows. Returns whether
    // what is shown changed.
    seen(file, size, now = Date.now(), {initial = false} = {}) {
        const {temp, name} = downloadName(file);
        if (!temp) return false;
        const old = this.entries.get(file);
        if (!old) {
            this.entries.set(file, {id: `dl${++this.seq}`, file, name, bytes: size, started: now, updated: initial ? -Infinity : now, state: 'running', finishedAt: 0, grown: !initial});
            return !initial;
        }
        if (old.state !== 'running' || old.bytes === size) return false;
        Object.assign(old, {bytes: size, updated: now, grown: true});
        return true;
    }
    // Renamed: to another temporary name (the name became known) it goes on;
    // to a final name it is finished.
    renamed(from, to, now = Date.now()) {
        const entry = this.entries.get(from);
        if (!entry) return false;
        this.entries.delete(from);
        const next = downloadName(to);
        if (next.temp) { this.entries.set(to, {...entry, file: to, name: next.name ?? entry.name}); return this.shown(entry, now); }
        if (!entry.grown) return false;
        this.entries.set(to, {...entry, file: to, name: next.name, state: 'completed', finishedAt: now, updated: now});
        return true;
    }
    // Deleted: cancelled (or moved away) — never claimed as finished.
    deleted(file, now = Date.now()) {
        const entry = this.entries.get(file);
        if (!entry || entry.state !== 'running') return false;
        this.entries.delete(file);
        return this.shown(entry, now);
    }
    shown(entry, now) {
        return entry.state === 'completed' ? now - entry.finishedAt < DOWNLOAD_DONE_MS : entry.grown && now - entry.updated < DOWNLOAD_STALE_MS;
    }
    // What is shown now; finished ones are forgotten after a while.
    list(now = Date.now()) {
        for (const [file, entry] of this.entries) if (entry.state === 'completed' && now - entry.finishedAt >= DOWNLOAD_DONE_MS) this.entries.delete(file);
        return [...this.entries.values()].filter(entry => this.shown(entry, now));
    }
    // When list() next changes by itself (a download going quiet, a finished one leaving), or null.
    nextWake(now = Date.now()) {
        let next = Infinity;
        for (const entry of this.entries.values()) {
            if (!this.shown(entry, now)) continue;
            next = Math.min(next, entry.state === 'completed' ? entry.finishedAt + DOWNLOAD_DONE_MS - now : entry.updated + DOWNLOAD_STALE_MS - now);
        }
        return Number.isFinite(next) ? Math.max(0, next) : null;
    }
}
