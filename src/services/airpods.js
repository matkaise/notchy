import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';

// AirPods through airpods-helper (github.com/superninjv/airpods-helper): its
// daemon owns the AirPods' control session (AAP) and publishes everything on
// the session bus as org.costa.AirPods, with PropertiesChanged on every change.
// Notchy only reads those properties and calls its methods; it installs,
// starts and configures nothing system-wide. Ear detection pauses media in
// the daemon itself (PauseOnRemoval); Notchy has no second ear logic.
// Without the daemon, BlueZ still tells connection and one battery level of
// Apple headphones (optional, read-only apart from Connect/Disconnect).
export const HELPER_NAME = GLib.getenv('NOTCHY_AIRPODS_NAME') || 'org.costa.AirPods';
const PATH = '/org/costa/AirPods', IFACE = 'org.costa.AirPods';
const XML = `<node><interface name="${IFACE}">
 <property name="Connected" type="b" access="read"/><property name="Address" type="s" access="read"/>
 <property name="Model" type="s" access="read"/><property name="ModelName" type="s" access="read"/>
 <property name="Features" type="as" access="read"/>
 <property name="BatteryLeft" type="i" access="read"/><property name="BatteryRight" type="i" access="read"/><property name="BatteryCase" type="i" access="read"/>
 <property name="ChargingLeft" type="b" access="read"/><property name="ChargingRight" type="b" access="read"/><property name="ChargingCase" type="b" access="read"/>
 <property name="EarLeft" type="b" access="read"/><property name="EarRight" type="b" access="read"/>
 <property name="AncMode" type="s" access="read"/><property name="ConversationalAwareness" type="b" access="read"/>
 <property name="PauseOnRemoval" type="b" access="readwrite"/><property name="Version" type="s" access="read"/>
 <method name="SetAncMode"><arg type="s" direction="in"/></method>
 <method name="SetConversationalAwareness"><arg type="b" direction="in"/></method>
 <method name="ListPaired"><arg type="a(ss)" direction="out"/></method>
 <method name="ConnectTo"><arg type="s" direction="in"/></method>
 <method name="Disconnect"/><method name="Reconnect"/>
 <signal name="DeviceConnected"><arg type="s"/></signal><signal name="DeviceDisconnected"/>
 <signal name="EarDetectionChanged"><arg type="b"/><arg type="b"/></signal>
</interface></node>`;
const INFO = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0];
export const ANC_MODES = ['noise', 'transparency', 'adaptive', 'off'];
// Apple's Bluetooth (0x004C) and USB (0x05AC) vendor ids in BlueZ's Modalias.
const APPLE = /^(bluetooth:v004C|usb:v05AC)/i;

// A battery value as Notchy shows it: a whole percentage, or null when the
// AirPods do not report one (-1, e.g. a bud in the closed case). Never 0 for unknown.
export const battery = value => Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;

export class AirPods extends Emitter {
    constructor(extension, settings) {
        super(); this.extension = extension; this.settings = settings; this.life = new Lifetime();
        this.proxy = null; this.watch = 0; this.helperRunning = false; this.helperInstalled = false;
        this.bluez = null; this.events = new Set(); this.wasConnected = false; this.warned = {};
        this.life.connect(settings, 'changed::airpods-enabled', () => this.sync());
        this.life.connect(settings, 'changed::airpods-bluez-fallback', () => this.syncBluez());
        this.sync();
    }
    get enabled() { return this.settings.get_boolean('airpods-enabled'); }
    // Connection events and low battery: {type: 'connected' | 'disconnected' | 'low', ...}.
    onEvent(fn) { this.events.add(fn); return () => this.events.delete(fn); }
    emit(event) { for (const fn of [...this.events]) { try { fn(event); } catch (e) { console.error(e); } } }
    sync() {
        if (this.enabled && !this.watch && !this.life.closed) {
            this.cancellable = new Gio.Cancellable();
            this.watch = Gio.bus_watch_name(Gio.BusType.SESSION, HELPER_NAME, Gio.BusNameWatcherFlags.NONE,
                () => this.helperAppeared(), () => this.helperVanished());
            this.checkInstalled();
        } else if (!this.enabled && this.watch) {
            Gio.bus_unwatch_name(this.watch); this.watch = 0;
            this.cancellable?.cancel(); this.dropProxy(); this.stopBluez();
            this.helperRunning = false; this.wasConnected = false; this.update();
        }
        this.syncBluez();
    }
    // Installed but not running: D-Bus can start it (offered in the settings, never done unasked).
    checkInstalled() {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListActivatableNames', null, null,
            Gio.DBusCallFlags.NONE, 3000, this.cancellable, (connection, result) => {
                try { const [names] = connection.call_finish(result).deep_unpack(); this.helperInstalled = this.helperInstalled || names.includes(HELPER_NAME); if (!this.life.closed) this.update(); } catch { /* Bus gone or cancelled. */ }
            });
    }
    helperAppeared() {
        if (this.life.closed) return;
        this.helperRunning = true; this.helperInstalled = true; this.dropProxy();
        Gio.DBusProxy.new(Gio.DBus.session, Gio.DBusProxyFlags.DO_NOT_AUTO_START, INFO, HELPER_NAME, PATH, IFACE, this.cancellable, (_o, result) => {
            let proxy;
            try { proxy = Gio.DBusProxy.new_finish(result); } catch (e) { if (!this.life.closed) console.warn(`Notchy AirPods: ${e.message}`); return; }
            if (this.life.closed || !this.helperRunning) return;
            this.proxy = proxy;
            this.proxySignals = [proxy.connect('g-properties-changed', () => this.update()),
                proxy.connect('g-signal', (_p, _sender, name) => { if (['DeviceConnected', 'DeviceDisconnected'].includes(name)) this.update(); })];
            this.stopBluez(); this.update();
        });
    }
    helperVanished() {
        this.helperRunning = false; this.dropProxy();
        if (!this.life.closed) { this.syncBluez(); this.update(); }
    }
    dropProxy() {
        if (this.proxy) for (const id of this.proxySignals ?? []) this.proxy.disconnect(id);
        this.proxy = null; this.proxySignals = [];
    }
    prop(name, fallback = null) { return this.proxy?.get_cached_property(name)?.deep_unpack() ?? fallback; }
    get backend() { return this.proxy ? 'airpods-helper' : this.bluez?.device ? 'bluez' : null; }
    // Everything the island shows, normalised. Unknown values are null.
    get state() {
        if (this.proxy) {
            const features = this.prop('Features', []), headphones = features.includes('headphones');
            return {backend: 'airpods-helper', connected: Boolean(this.prop('Connected', false)), name: this.prop('ModelName', '') || 'AirPods', model: this.prop('Model', ''), address: this.prop('Address', ''),
                features, headphones,
                battery: {left: battery(this.prop('BatteryLeft', -1)), right: headphones ? null : battery(this.prop('BatteryRight', -1)), case: headphones ? null : battery(this.prop('BatteryCase', -1)), single: headphones ? battery(this.prop('BatteryLeft', -1)) : null},
                charging: {left: Boolean(this.prop('ChargingLeft', false)), right: Boolean(this.prop('ChargingRight', false)), case: Boolean(this.prop('ChargingCase', false))},
                ear: headphones ? null : {left: Boolean(this.prop('EarLeft', false)), right: Boolean(this.prop('EarRight', false))},
                anc: ANC_MODES.includes(this.prop('AncMode', '')) ? this.prop('AncMode') : null,
                conversation: features.includes('ca') ? Boolean(this.prop('ConversationalAwareness', false)) : null,
                pauseOnRemoval: this.proxy.get_cached_property('PauseOnRemoval') ? Boolean(this.prop('PauseOnRemoval')) : null,
                version: this.prop('Version', '')};
        }
        const device = this.bluez?.device;
        if (device) {
            return {backend: 'bluez', connected: device.connected, name: device.name || 'AirPods', model: '', address: device.address, features: [], headphones: false,
                battery: {left: null, right: null, case: null, single: battery(device.battery)}, charging: {left: false, right: false, case: false},
                ear: null, anc: null, conversation: null, pauseOnRemoval: null, version: ''};
        }
        return null;
    }
    get connected() { return Boolean(this.state?.connected); }
    // Which ANC modes this model has (none without the helper).
    get modes() {
        const state = this.state; if (!state?.connected || state.backend !== 'airpods-helper') return [];
        const features = state.features;
        return ANC_MODES.filter(mode => mode === 'adaptive' ? features.includes('adaptive') : features.includes('anc') || features.includes('adaptive'));
    }
    update() {
        if (this.life.closed) return;
        const state = this.state, connected = Boolean(state?.connected);
        if (connected !== this.wasConnected) {
            this.wasConnected = connected; this.warned = {};
            this.emit({type: connected ? 'connected' : 'disconnected', state});
        }
        if (connected) this.checkBattery(state);
        // Only a change Notchy shows wakes the island (the daemon also reports
        // things like who is speaking, many times a minute).
        const signature = JSON.stringify([this.status, state]);
        if (signature !== this.signature) { this.signature = signature; this.changed(); }
    }
    // Low battery: once per part when it drops below the threshold without charging.
    checkBattery(state) {
        if (!this.settings.get_boolean('airpods-battery-warning')) return;
        const threshold = this.settings.get_int('airpods-battery-threshold');
        const parts = state.battery.single !== null ? [['single', state.battery.single, state.charging.left]] :
            [['left', state.battery.left, state.charging.left], ['right', state.battery.right, state.charging.right], ['case', state.battery.case, state.charging.case]];
        for (const [part, level, charging] of parts) {
            if (level === null) continue;
            if (charging || level >= threshold + 5) { delete this.warned[part]; continue; }
            if (level < threshold && !this.warned[part]) { this.warned[part] = true; this.emit({type: 'low', part, level, state}); }
        }
    }
    call(method, params = null) {
        if (!this.proxy) return Promise.reject(Error('airpods-helper läuft nicht'));
        return new Promise((resolve, reject) => this.proxy.call(method, params, Gio.DBusCallFlags.NONE, 8000, this.cancellable, (proxy, result) => {
            try { resolve(proxy.call_finish(result)); } catch (e) { reject(e); }
        }));
    }
    setAnc(mode) { return ANC_MODES.includes(mode) && this.modes.includes(mode) ? this.call('SetAncMode', new GLib.Variant('(s)', [mode])) : Promise.reject(Error('Modus nicht unterstützt')); }
    setConversationAwareness(on) { return this.call('SetConversationalAwareness', new GLib.Variant('(b)', [on])); }
    // The daemon's own setting; Notchy just switches it.
    setPauseOnRemoval(on) {
        if (!this.proxy) return Promise.reject(Error('airpods-helper läuft nicht'));
        return new Promise((resolve, reject) => Gio.DBus.session.call(HELPER_NAME, PATH, 'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', [IFACE, 'PauseOnRemoval', new GLib.Variant('b', on)]),
            null, Gio.DBusCallFlags.NONE, 5000, this.cancellable, (connection, result) => { try { resolve(connection.call_finish(result)); } catch (e) { reject(e); } }));
    }
    async connect() {
        if (this.proxy) {
            const address = this.prop('Address', '');
            if (address) return this.call('ConnectTo', new GLib.Variant('(s)', [address]));
            try { return await this.call('Reconnect'); } catch {
                const [paired] = (await this.call('ListPaired')).deep_unpack();
                if (!paired.length) throw Error('Keine gekoppelten AirPods');
                return this.call('ConnectTo', new GLib.Variant('(s)', [paired[0][0]]));
            }
        }
        return this.bluezCall('Connect');
    }
    disconnect() { return this.proxy ? this.call('Disconnect') : this.bluezCall('Disconnect'); }

    // BlueZ fallback: connection and battery of Apple headphones only.
    syncBluez() {
        const wanted = this.enabled && !this.helperRunning && this.settings.get_boolean('airpods-bluez-fallback') && !this.life.closed;
        if (wanted && !this.bluez) this.startBluez();
        else if (!wanted && this.bluez) this.stopBluez();
    }
    startBluez() {
        let bus;
        try { bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null); } catch { return; }
        const bluez = this.bluez = {bus, devices: new Map(), device: null, subscriptions: []};
        const refresh = () => {
            bus.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null, null, Gio.DBusCallFlags.NO_AUTO_START, 5000, this.cancellable, (connection, result) => {
                if (this.bluez !== bluez) return;
                let objects = {};
                try { [objects] = connection.call_finish(result).deep_unpack(); } catch { objects = {}; }
                bluez.devices.clear();
                for (const [path, interfaces] of Object.entries(objects)) {
                    const device = interfaces['org.bluez.Device1']; if (!device) continue;
                    const get = (iface, name) => interfaces[iface]?.[name]?.deep_unpack?.();
                    const modalias = get('org.bluez.Device1', 'Modalias') ?? '', name = get('org.bluez.Device1', 'Alias') ?? get('org.bluez.Device1', 'Name') ?? '', icon = get('org.bluez.Device1', 'Icon') ?? '';
                    // Only Apple headphones; every other device is left alone.
                    if (!APPLE.test(modalias) || !(/audio-head(set|phones)/.test(icon) || /airpods|beats/i.test(name))) continue;
                    bluez.devices.set(path, {path, name, address: get('org.bluez.Device1', 'Address') ?? '', connected: Boolean(get('org.bluez.Device1', 'Connected')), battery: get('org.bluez.Battery1', 'Percentage') ?? -1});
                }
                const devices = [...bluez.devices.values()];
                bluez.device = devices.find(d => d.connected) ?? devices[0] ?? null;
                this.update();
            });
        };
        for (const [iface, member] of [['org.freedesktop.DBus.ObjectManager', 'InterfacesAdded'], ['org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved'], ['org.freedesktop.DBus.Properties', 'PropertiesChanged']]) {
            bluez.subscriptions.push(bus.signal_subscribe('org.bluez', iface, member, null, null, Gio.DBusSignalFlags.NONE, () => refresh()));
        }
        refresh();
    }
    stopBluez() {
        const bluez = this.bluez; if (!bluez) return;
        this.bluez = null;
        for (const id of bluez.subscriptions) bluez.bus.signal_unsubscribe(id);
    }
    bluezCall(method) {
        const device = this.bluez?.device; if (!device) return Promise.reject(Error('Keine AirPods gefunden'));
        return new Promise((resolve, reject) => this.bluez.bus.call('org.bluez', device.path, 'org.bluez.Device1', method, null, null, Gio.DBusCallFlags.NONE, 20000, this.cancellable,
            (connection, result) => { try { resolve(connection.call_finish(result)); } catch (e) { reject(e); } }));
    }
    // The settings page reads this.
    get status() {
        if (!this.enabled) return 'disabled';
        if (this.helperRunning) return 'helper';
        if (this.helperInstalled) return 'installed';
        return this.bluez?.device ? 'bluez' : 'missing';
    }
    dispose() {
        if (this.watch) Gio.bus_unwatch_name(this.watch); this.watch = 0;
        this.cancellable?.cancel(); this.dropProxy(); this.stopBluez(); this.life.dispose(); this.events.clear(); this.listeners.clear();
    }
}
