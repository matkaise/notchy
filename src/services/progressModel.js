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

