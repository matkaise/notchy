import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';
import {_} from '../i18n/core.js';
import {eventsForDay} from '../model.js';

const BUS = 'org.gnome.Shell.CalendarServer';
const XML = `<node><interface name="${BUS}">
<method name="SetTimeRange"><arg type="x" direction="in"/><arg type="x" direction="in"/><arg type="b" direction="in"/></method>
<signal name="EventsAddedOrUpdated"><arg type="a(ssxxa{sv})"/></signal>
<signal name="EventsRemoved"><arg type="as"/></signal>
<signal name="ClientDisappeared"><arg type="s"/></signal>
<property name="HasCalendars" type="b" access="read"/></interface></node>`;

// Read-only access to calendars already configured in GNOME / Evolution.
// Loading is lazy: disabled/unopened Calendar never starts a calendar client.
export class Calendar extends Emitter {
    constructor(bus = BUS) { super(); this.bus = bus; this.life = new Lifetime(); this.events = new Map(); this.proxy = null; this.loading = false; this.error = ''; this.range = null; }
    get hasCalendars() { return this.proxy?.get_cached_property('HasCalendars')?.deep_unpack() ?? false; }
    requestMonth(year, month) { this.requestRange(new Date(year, month, 1), new Date(year, month + 1, 1)); }
    // Any span of days, e.g. the calendar tab's week strip across a month's end.
    requestRange(begin, end) {
        const range = [Math.floor(begin.getTime() / 1000), Math.floor(end.getTime() / 1000)];
        // The same span again (a redraw) keeps what is loaded and never re-emits.
        // A service that was missing is tried again.
        if (this.range?.[0] === range[0] && this.range?.[1] === range[1]) { if (!this.proxy && !this.starting) this.start(); return; }
        this.range = range;
        this.events.clear(); this.error = ''; this.loading = true; this.changed();
        if (this.proxy) this.load();
        else if (!this.starting) this.start();
    }
    start() {
        this.starting = true;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
            Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], this.bus, '/org/gnome/Shell/CalendarServer', BUS,
            this.life.cancellable, (_o, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (this.life.closed) { proxy.run_dispose(); return; }
                    this.proxy = proxy;
                    this.life.connect(proxy, 'g-signal', (_p, _sender, name, params) => this.signal(name, params.deep_unpack()));
                    this.life.connect(proxy, 'g-properties-changed', () => this.changed());
                    this.life.connect(proxy, 'notify::g-name-owner', () => {
                        this.events.clear();
                        if (proxy.g_name_owner) this.load();
                        else { this.loading = false; this.error = _('The calendar service is not available.'); this.changed(); }
                    });
                    this.load();
                } catch (e) { if (!this.life.closed) { this.loading = false; this.error = e.message; this.changed(); } }
                this.starting = false;
            });
    }
    load() {
        if (!this.range || !this.proxy || this.life.closed) return;
        const range = this.range;
        this.proxy.call('SetTimeRange', new GLib.Variant('(xxb)', [...range, true]), Gio.DBusCallFlags.NONE,
            10000, this.life.cancellable, (proxy, result) => {
                try { proxy.call_finish(result); if (!this.life.closed && this.range === range) { this.loading = false; this.error = ''; this.changed(); } }
                catch (e) { if (!this.life.closed && this.range === range) { this.loading = false; this.error = _('Events could not be loaded.'); console.warn(`Notchy calendar: ${e.message}`); this.changed(); } }
            });
    }
    removePrefix(prefix) { for (const id of this.events.keys()) if (id.startsWith(prefix)) this.events.delete(id); }
    signal(name, args) {
        if (name === 'EventsAddedOrUpdated') {
            const removed = new Set();
            for (const [id, title, begin, end] of args[0]) {
                if (!id.endsWith('\n')) {
                    const parent = id.slice(0, id.lastIndexOf('\n') + 1);
                    if (parent && !removed.has(parent)) { this.removePrefix(parent); removed.add(parent); }
                }
                this.events.set(id, {id, title, begin: begin * 1000, end: end * 1000});
            }
        } else if (name === 'EventsRemoved') for (const id of args[0]) this.removePrefix(id);
        else if (name === 'ClientDisappeared') this.removePrefix(`${args[0]}\n`);
        else return;
        this.changed();
    }
    day(date) { return eventsForDay([...this.events.values()], date); }
    dispose() { this.life.dispose(); this.proxy?.run_dispose(); this.proxy = null; this.events.clear(); this.listeners.clear(); }
}
