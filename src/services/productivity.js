import {Emitter, Lifetime} from '../lifecycle.js';

// Simple named live activities published through `notchyctl activity` or the
// MCP bridge's set_activity (kept for existing integrations; structured agent
// sessions live in agents.js). One activity per name; each update renews it,
// and it expires an hour after its last update, so a reporter that vanished
// leaves no text behind. A task that runs longer reports again meanwhile.
export const MAX_ACTIVITIES = 20, EXPIRES_MS = 3600000;
const key = name => String(name ?? '').trim().slice(0, 80);
// Progress between 0 and 1; anything else (NaN, ±Infinity, a string) counts as 0.
export const progressValue = value => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

export class Productivity extends Emitter {
    constructor() {
        super(); this.life = new Lifetime(); this.activities = new Map(); this.timer = 0;
    }
    setActivity(name, status, progress, now = Date.now()) {
        const id = key(name); if (!id) return;
        const text = String(status ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), value = progressValue(progress);
        const previous = this.activities.get(id);
        // The same report again changes nothing but its lifetime.
        if (previous && previous.status === text && previous.progress === value) { previous.updated = now; previous.expires = now + EXPIRES_MS; return; }
        // Updated ones move to the end, so the oldest-updated is the one dropped.
        this.activities.delete(id);
        if (this.activities.size >= MAX_ACTIVITIES) this.activities.delete(this.activities.keys().next().value);
        this.activities.set(id, {name: id, status: text, progress: value, updated: now, expires: now + EXPIRES_MS});
        this.schedule(); this.changed();
    }
    clearActivity(name) { if (this.activities.delete(key(name))) { this.schedule(); this.changed(); } }
    expire(now = Date.now()) {
        let changed = false;
        for (const [id, item] of this.activities) if (item.expires <= now) { this.activities.delete(id); changed = true; }
        if (changed) this.changed();
        this.schedule();
    }
    // The expiry check runs only while there are activities.
    schedule() {
        if (this.activities.size && !this.timer) this.timer = this.life.every(10000, () => this.expire());
        else if (!this.activities.size && this.timer) { this.life.cancel(this.timer); this.timer = 0; }
    }
    dispose() { this.life.dispose(); this.listeners.clear(); }
}
