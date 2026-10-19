import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Emitter, Lifetime} from '../lifecycle.js';
import {launcherEntryUpdate, LauncherEntries} from './progressModel.js';

const IFACE = 'com.canonical.Unity.LauncherEntry';

// Progress other apps publish themselves: the LauncherEntry interface docks
// (Ubuntu Dock, Dash to Dock, Plank) listen to. Chrome and Chromium report
// downloads there, Nautilus its file operations, Transmission its torrents.
// Notchy only listens to the broadcast signal on the session bus — no
// polling, nothing read from the apps. What the app says is all Notchy knows:
// the fraction it reports, never a name of a file or a speed. An app that
// stops reporting (it quit: its bus name vanished) takes its progress along.
export class LauncherEntry extends Emitter {
    constructor() {
        super(); this.life = new Lifetime(); this.entries = new LauncherEntries(); this.watches = new Map();
        const bus = Gio.DBus.session;
        const id = bus.signal_subscribe(null, IFACE, 'Update', null, null, Gio.DBusSignalFlags.NONE, (_c, sender, _path, _iface, _signal, parameters) => {
            if (this.life.closed) return;
            const [uri, properties] = parameters.deep_unpack();
            const update = launcherEntryUpdate(uri, Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value?.deep_unpack?.() ?? value])));
            if (!update) return;
            // Watching the sender adds a subscription: not while GDBus hands out this signal.
            if (!this.watches.has(sender)) this.life.later(0, () => this.watch(sender));
            if (this.entries.update(update, sender)) this.changed();
        });
        this.life.cleanups.push(() => bus.signal_unsubscribe(id));
        this.life.cleanups.push(() => { for (const watch of this.watches.values()) Gio.bus_unwatch_name(watch); this.watches.clear(); });
    }
    // The sender's unique name: once it leaves the bus, its entries go.
    watch(sender) {
        if (!sender || this.watches.has(sender)) return;
        const watch = Gio.bus_watch_name_on_connection(Gio.DBus.session, sender, Gio.BusNameWatcherFlags.NONE, null, () => {
            if (this.life.closed) return;
            Gio.bus_unwatch_name(this.watches.get(sender)); this.watches.delete(sender);
            if (this.entries.vanished(sender)) this.changed();
        });
        this.watches.set(sender, watch);
    }
    // The app's name and icon for an entry (its desktop id), when installed.
    app(id) { return Shell.AppSystem.get_default().lookup_app(id); }
    list(now = Date.now()) { return this.entries.list(now); }
    dispose() { this.life.dispose(); this.listeners.clear(); }
}
