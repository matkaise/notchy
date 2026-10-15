import {Emitter, Lifetime} from '../lifecycle.js';

// Agent live activities published through notchyctl or the MCP bridge.
// Each one expires after an hour without updates.
export class Productivity extends Emitter {
    constructor() {
        super(); this.life = new Lifetime(); this.activities = new Map();
        this.life.every(10000, () => {
            const now = Date.now(); let changed = false;
            for (const [name, item] of this.activities) if (item.expires < now) { this.activities.delete(name); changed = true; }
            if (changed) this.changed();
        });
    }
    setActivity(name, status, progress) {
        if (!name.trim()) return;
        if (this.activities.size >= 20 && !this.activities.has(name)) this.activities.delete(this.activities.keys().next().value);
        this.activities.set(name.slice(0, 80), {name: name.slice(0, 80), status: status.slice(0, 200), progress: Math.max(0, Math.min(1, progress)), updated: Date.now(), expires: Date.now() + 3600000}); this.changed();
    }
    clearActivity(name) { this.activities.delete(name); this.changed(); }
    dispose() { this.life.dispose(); this.listeners.clear(); }
}
