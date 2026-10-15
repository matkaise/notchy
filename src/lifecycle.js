import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

export class Lifetime {
    constructor() { this.closed = false; this.signals = []; this.destroyHooks = new Map(); this.sources = new Set(); this.cleanups = []; this.cancellable = new Gio.Cancellable(); }
    connect(object, signal, fn) {
        const id = object.connect(signal, (...args) => { if (!this.closed) return fn(...args); }); this.signals.push([object, id]);
        const type = object.constructor.$gtype;
        const endSignal = type && (GObject.signal_lookup('destroy', type) ? 'destroy' : GObject.signal_lookup('unmanaged', type) ? 'unmanaged' : null);
        if (endSignal && !this.destroyHooks.has(object)) {
            const hook = object.connect(endSignal, () => {
                const remaining = [];
                for (const [obj, handler] of this.signals) { if (obj === object) obj.disconnect(handler); else remaining.push([obj, handler]); }
                this.signals = remaining; this.destroyHooks.delete(object); object.disconnect(hook);
            });
            this.destroyHooks.set(object, hook);
        }
        return id;
    }
    later(ms, fn) { if (this.closed) return 0; const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        this.sources.delete(id); if (!this.closed) fn(); return GLib.SOURCE_REMOVE;
    }); this.sources.add(id); return id; }
    every(ms, fn) { if (this.closed) return 0; const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        if (this.closed) { this.sources.delete(id); return GLib.SOURCE_REMOVE; }
        fn(); return GLib.SOURCE_CONTINUE;
    }); this.sources.add(id); return id; }
    cancel(id) { if (this.sources.delete(id)) GLib.source_remove(id); }
    dispose() {
        this.closed = true; this.cancellable.cancel();
        for (const id of this.sources) GLib.source_remove(id); this.sources.clear();
        for (const [obj, id] of this.destroyHooks) { try { obj.disconnect(id); } catch { /* Already ended. */ } } this.destroyHooks.clear();
        for (const [obj, id] of this.signals.splice(0)) { try { obj.disconnect(id); } catch { /* Actor already destroyed. */ } }
        for (const fn of this.cleanups.splice(0).reverse()) { try { fn(); } catch (e) { console.error(e); } }
    }
}

export class Emitter {
    constructor() { this.listeners = new Set(); }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    changed() { for (const fn of [...this.listeners]) fn(); }
}
