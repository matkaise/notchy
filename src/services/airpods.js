import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Emitter, Lifetime} from '../lifecycle.js';
import {helperLauncher} from '../i18n/gnome.js';
import {_} from '../i18n/core.js';
import {BatteryCache} from './batteries.js';

// AirPods through airpods-helper (github.com/superninjv/airpods-helper): its
// daemon owns the AirPods' control session (AAP) and publishes everything on
// the session bus as org.costa.AirPods, with PropertiesChanged on every change.
// Notchy only reads those properties and calls its methods; it installs,
// starts and configures nothing system-wide. Ear detection pauses media in
// the daemon itself (PauseOnRemoval); Notchy has no second ear logic.
// Without the daemon, Notchy finds connected Apple headphones through BlueZ
// and reads them itself over AAP (helper/aap.py, as the user, no root):
// batteries, charging, ear state, noise control. Then, and only then, the
// optional ear pause is Notchy's own, because no daemon controls media.
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
// Model features by product id (Modalias pXXXX): noise control, adaptive
// mode and conversation awareness, over-ear headphones.
const PRODUCT_ANC = [0x200e, 0x2014, 0x2024, 0x2027, 0x200a, 0x201f, 0x201b];
const PRODUCT_ADAPTIVE = [0x2014, 0x2024, 0x2027, 0x201b];
const PRODUCT_HEADPHONES = [0x200a, 0x201f];
// The AAP reader starts this long after BlueZ reports the connection, and
// retries a failed channel after these delays while the AirPods stay connected.
const AAP_SETTLE = 1500, AAP_BACKOFF = [2000, 4000, 8000, 15000, 30000, 60000];
// The headless test never touches the machine's real Bluetooth.
const NO_SYSTEM_BLUETOOTH = Boolean(GLib.getenv('NOTCHY_NO_SYSTEM_BLUETOOTH'));

// A battery value as Notchy shows it: a whole percentage, or null when the
// AirPods do not report one (-1, e.g. a bud in the closed case). Never 0 for unknown.
export const battery = value => Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
// One cache entry per device, whichever backend reads it.
export const deviceKey = state => (state?.address ? state.address.toUpperCase() : state?.name ? `name:${state.name}` : '');
// The battery parts a model and backend report: one battery for over-ear
// models and for BlueZ (which only knows one number), buds and case otherwise.
export const batteryParts = state => (state.headphones || state.backend === 'bluez' ? ['single'] : ['left', 'right', 'case']);

export class AirPods extends Emitter {
    constructor(extension, settings) {
        super(); this.extension = extension; this.settings = settings; this.life = new Lifetime();
        this.proxy = null; this.watch = 0; this.helperRunning = false; this.helperInstalled = false;
        this.bluez = null; this.events = new Set(); this.wasConnected = false; this.warned = {};
        this.life.connect(settings, 'changed::airpods-enabled', () => this.sync());
        this.life.connect(settings, 'changed::airpods-bluez-fallback', () => this.syncBluez());
        this.life.connect(settings, 'changed::airpods-builtin', () => this.syncAap());
        this.aap = null; this.aapRetries = 0; this.aapWanted = null; this.aapTimer = 0;
        // Each helper appearance gets a generation: a proxy that finishes after
        // the daemon vanished (or appeared again) is dropped, never installed.
        this.helperGeneration = 0;
        this.store = extension.store;
        this.batteries = new BatteryCache(this.store?.read('airpods-batteries', {}) ?? {});
        this.saveTimer = 0; this.lastKey = '';
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
                // "Installed" means D-Bus can start it; a daemon that was started by hand and quit is not.
                try { const [names] = connection.call_finish(result).deep_unpack(); this.helperInstalled = names.includes(HELPER_NAME); if (!this.life.closed) this.update(); } catch { /* Bus gone or cancelled. */ }
            });
    }
    helperAppeared() {
        if (this.life.closed) return;
        const generation = ++this.helperGeneration;
        this.helperRunning = true; this.dropProxy();
        // The daemon owns the AirPods' control channel from now on: Notchy's own
        // reader closes its channel at once, before the proxy is even ready.
        this.syncBluez();
        Gio.DBusProxy.new(Gio.DBus.session, Gio.DBusProxyFlags.DO_NOT_AUTO_START, INFO, HELPER_NAME, PATH, IFACE, this.cancellable, (_o, result) => {
            let proxy;
            try { proxy = Gio.DBusProxy.new_finish(result); } catch (e) { if (!this.life.closed && generation === this.helperGeneration) console.warn(`Notchy AirPods: ${e.message}`); return; }
            if (this.life.closed || !this.helperRunning || generation !== this.helperGeneration) return;
            this.proxy = proxy;
            this.proxySignals = [proxy.connect('g-properties-changed', () => this.update()),
                proxy.connect('g-signal', (_p, _sender, name) => { if (['DeviceConnected', 'DeviceDisconnected'].includes(name)) this.update(); })];
            this.stopBluez(); this.update();
        });
    }
    helperVanished() {
        this.helperGeneration++;
        this.helperRunning = false; this.dropProxy();
        if (!this.life.closed && this.watch) this.checkInstalled();
        if (!this.life.closed) { this.syncBluez(); this.update(); }
    }
    dropProxy() {
        if (this.proxy) for (const id of this.proxySignals ?? []) this.proxy.disconnect(id);
        this.proxy = null; this.proxySignals = [];
    }
    prop(name, fallback = null) { return this.proxy?.get_cached_property(name)?.deep_unpack() ?? fallback; }
    get backend() { return this.proxy ? 'airpods-helper' : this.aap?.state?.connected ? 'aap' : this.bluez?.device ? 'bluez' : null; }
    // Everything the island shows, normalised. Unknown values are null.
    // `battery` holds the live levels only; `batteries` adds per part the last
    // valid reading, its age and whether it is live, stale, unknown or
    // unsupported (see batteries.js).
    get state() {
        const state = this.rawState; if (!state) return null;
        const key = deviceKey(state);
        return {...state, key, batteries: this.batteries.view(key)};
    }
    get rawState() {
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
            const aap = this.aap?.address === device.address && this.aap.state?.connected ? this.aap.state : null;
            const headphones = PRODUCT_HEADPHONES.includes(device.product);
            if (aap) {
                // Read over AAP by Notchy itself.
                const features = [...(aap.ancSupported || PRODUCT_ANC.includes(device.product) ? ['anc'] : []), ...(PRODUCT_ADAPTIVE.includes(device.product) ? ['adaptive'] : []),
                    ...(aap.conversation !== null ? ['ca'] : []), ...(headphones ? ['headphones'] : [])];
                const single = headphones ? battery(aap.battery.single ?? aap.battery.left) : battery(aap.battery.single);
                return {backend: 'aap', connected: device.connected, name: device.name || aap.name || 'AirPods', model: aap.model, address: device.address, product: device.product, features, headphones,
                    battery: {left: single === null ? battery(aap.battery.left) : null, right: single === null ? battery(aap.battery.right) : null, case: single === null ? battery(aap.battery.case) : null, single},
                    charging: {left: Boolean(aap.charging.left || aap.charging.single), right: Boolean(aap.charging.right), case: Boolean(aap.charging.case)},
                    ear: headphones || !aap.ear ? null : {left: Boolean(aap.ear.left), right: Boolean(aap.ear.right)},
                    anc: ANC_MODES.includes(aap.anc) ? aap.anc : null, conversation: aap.conversation, pauseOnRemoval: null, version: ''};
            }
            return {backend: 'bluez', connected: device.connected, name: device.name || 'AirPods', model: '', address: device.address, product: device.product, features: [], headphones,
                battery: {left: null, right: null, case: null, single: battery(device.battery)}, charging: {left: false, right: false, case: false},
                ear: null, anc: null, conversation: null, pauseOnRemoval: null, version: ''};
        }
        return null;
    }
    get connected() { return Boolean(this.state?.connected); }
    // Which ANC modes this model has (none without the helper).
    get modes() {
        const state = this.state; if (!state?.connected || !['airpods-helper', 'aap'].includes(state.backend)) return [];
        const features = state.features;
        return ANC_MODES.filter(mode => mode === 'adaptive' ? features.includes('adaptive') : features.includes('anc') || features.includes('adaptive'));
    }
    update() {
        if (this.life.closed) return;
        // Readings go into the cache first: an unknown value never erases a valid one.
        const raw = this.rawState, key = raw ? deviceKey(raw) : '';
        let stored = false;
        if (raw?.connected) stored = this.batteries.observe(key, raw.backend, raw.battery, raw.charging, {parts: batteryParts(raw)});
        if (this.lastKey && (this.lastKey !== key || !raw?.connected)) stored = this.batteries.disconnect(this.lastKey) || stored;
        this.lastKey = raw?.connected ? key : '';
        if (stored) this.saveBatteries();
        const state = this.state, connected = Boolean(state?.connected);
        if (connected !== this.wasConnected) {
            this.wasConnected = connected; this.warned = {}; this.bothInEar = undefined; this.pausedByEar = false;
            this.emit({type: connected ? 'connected' : 'disconnected', state});
        }
        if (connected) { this.checkBattery(state); this.earPause(state); }
        // Only a change Notchy shows wakes the island (the daemon also reports
        // things like who is speaking, many times a minute).
        const signature = JSON.stringify([this.status, state]);
        if (signature !== this.signature) { this.signature = signature; this.changed(); }
    }
    // Ear pause with Notchy's own AAP reader only (the daemon pauses by itself):
    // a bud taken out pauses the music, putting it back resumes what was paused.
    earPause(state) {
        const ear = state.backend === 'aap' ? state.ear : null, both = ear ? ear.left && ear.right : null;
        const previous = this.bothInEar; this.bothInEar = both;
        if (both === null || previous === undefined || previous === null || both === previous || !this.settings.get_boolean('airpods-ear-pause')) return;
        const media = this.extension.media;
        if (!both && media?.state?.playing) { this.pausedByEar = true; media.call('Pause'); }
        else if (both && this.pausedByEar) { this.pausedByEar = false; media?.call('Play'); }
    }
    // The last valid readings survive a restart, written a moment after they change.
    saveBatteries() {
        if (this.saveTimer || !this.store) return;
        this.saveTimer = this.life.later(3000, () => { this.saveTimer = 0; this.store.write('airpods-batteries', this.batteries.toJSON()); });
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
        if (!this.proxy) return Promise.reject(Error(_('airpods-helper is not running')));
        return new Promise((resolve, reject) => this.proxy.call(method, params, Gio.DBusCallFlags.NONE, 8000, this.cancellable, (proxy, result) => {
            try { resolve(proxy.call_finish(result)); } catch (e) { reject(e); }
        }));
    }
    setAnc(mode) {
        if (!ANC_MODES.includes(mode) || !this.modes.includes(mode)) return Promise.reject(Error(_('Mode not supported')));
        return this.proxy ? this.call('SetAncMode', new GLib.Variant('(s)', [mode])) : this.aapCommand({anc: mode});
    }
    setConversationAwareness(on) { return this.proxy ? this.call('SetConversationalAwareness', new GLib.Variant('(b)', [on])) : this.aapCommand({conversation: Boolean(on)}); }
    // The daemon's own setting; Notchy just switches it.
    setPauseOnRemoval(on) {
        if (!this.proxy) return Promise.reject(Error(_('airpods-helper is not running')));
        return new Promise((resolve, reject) => Gio.DBus.session.call(HELPER_NAME, PATH, 'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', [IFACE, 'PauseOnRemoval', new GLib.Variant('b', on)]),
            null, Gio.DBusCallFlags.NONE, 5000, this.cancellable, (connection, result) => { try { resolve(connection.call_finish(result)); } catch (e) { reject(e); } }));
    }
    async connect() {
        if (this.proxy) {
            const address = this.prop('Address', '');
            if (address) return this.call('ConnectTo', new GLib.Variant('(s)', [address]));
            try { return await this.call('Reconnect'); } catch {
                const [paired] = (await this.call('ListPaired')).deep_unpack();
                if (!paired.length) throw Error(_('No paired AirPods'));
                return this.call('ConnectTo', new GLib.Variant('(s)', [paired[0][0]]));
            }
        }
        return this.bluezCall('Connect');
    }
    disconnect() { return this.proxy ? this.call('Disconnect') : this.bluezCall('Disconnect'); }

    // BlueZ fallback: connection and battery of Apple headphones only.
    syncBluez() {
        const wanted = this.enabled && !this.helperRunning && (this.settings.get_boolean('airpods-bluez-fallback') || this.settings.get_boolean('airpods-builtin')) && !this.life.closed;
        if (wanted && !this.bluez) this.startBluez();
        else if (!wanted && this.bluez) this.stopBluez();
    }
    startBluez() {
        let bus;
        if (NO_SYSTEM_BLUETOOTH) return;
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
                    bluez.devices.set(path, {path, name, address: get('org.bluez.Device1', 'Address') ?? '', connected: Boolean(get('org.bluez.Device1', 'Connected')), battery: get('org.bluez.Battery1', 'Percentage') ?? -1,
                        product: parseInt(/p([0-9a-f]{4})/i.exec(modalias)?.[1] ?? '0', 16)});
                }
                const devices = [...bluez.devices.values()];
                bluez.device = devices.find(d => d.connected) ?? devices[0] ?? null;
                this.syncAap(); this.update();
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
        for (const id of bluez.subscriptions) bluez.bus?.signal_unsubscribe(id);
        this.syncAap();
    }
    // The headless test stands in for BlueZ with one device ({address, name, product, connected}).
    testDevice(device) {
        this.stopBluez();
        if (device) { this.bluez = {bus: null, subscriptions: [], devices: new Map([['test', {path: 'test', battery: -1, ...device}]]), device: {path: 'test', battery: -1, ...device}}; }
        this.syncAap(); this.update();
    }

    // Notchy's own AAP reader for a connected device, when no daemon owns it.
    syncAap() {
        const device = this.bluez?.device;
        const wanted = device?.connected && !this.helperRunning && this.enabled && this.settings.get_boolean('airpods-builtin') && !this.life.closed ? device.address : null;
        if (wanted !== this.aapWanted) {
            // A fresh connection starts over: the AirPods need a moment for their
            // audio profiles before they answer on the AAP channel.
            this.aapWanted = wanted; this.aapRetries = 0;
            this.life.cancel(this.aapTimer); this.aapTimer = 0;
            if (this.aap) this.stopAap();
            if (wanted) this.aapTimer = this.life.later(AAP_SETTLE, () => { this.aapTimer = 0; this.syncAap(); });
            return;
        }
        if (wanted && !this.aap && !this.aapTimer) this.startAap(wanted);
    }
    startAap(address) {
        try {
            const launcher = helperLauncher(this.settings, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            for (const name of ['NOTCHY_AAP_REPLAY', 'NOTCHY_AAP_LOG']) { const value = GLib.getenv(name); if (value) launcher.setenv(name, value, true); }
            const proc = launcher.spawnv(['/usr/bin/python3', `${this.extension.path}/helper/aap.py`, address]);
            const aap = this.aap = {address, proc, state: null, stdin: proc.get_stdin_pipe(), stdout: new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true})};
            const read = () => aap.stdout.read_line_async(GLib.PRIORITY_DEFAULT, this.cancellable, (stream, result) => {
                let line = null;
                try { [line] = stream.read_line_finish_utf8(result); } catch { return; }
                if (line === null || this.aap !== aap) return;
                try {
                    aap.state = JSON.parse(line);
                    if (Object.values(aap.state.battery ?? {}).some(level => level !== null) || aap.state.anc) this.aapRetries = 0;
                } catch { /* Not a state line. */ }
                this.update(); read();
            });
            read();
            proc.wait_async(null, () => {
                if (this.aap !== aap) return;
                this.aap = null; this.update();
                // While the AirPods stay connected, keep trying, ever more patiently.
                if (this.life.closed || !this.aapWanted) return;
                const wait = AAP_BACKOFF[Math.min(this.aapRetries++, AAP_BACKOFF.length - 1)];
                this.aapTimer = this.life.later(wait, () => { this.aapTimer = 0; this.syncAap(); });
            });
        } catch (e) { console.warn(`Notchy AirPods: ${e.message}`); this.aap = null; }
    }
    stopAap() {
        const aap = this.aap; if (!aap) return;
        this.aap = null;
        try { aap.proc.force_exit(); } catch { /* Gone. */ }
    }
    aapCommand(command) {
        const aap = this.aap;
        if (!aap?.state?.connected) return Promise.reject(Error(_('AirPods are not connected')));
        return new Promise((resolve, reject) => aap.stdin.write_bytes_async(new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(command)}\n`)), GLib.PRIORITY_DEFAULT, this.cancellable,
            (stream, result) => { try { stream.write_bytes_finish(result); resolve(); } catch (e) { reject(e); } }));
    }
    bluezCall(method) {
        const device = this.bluez?.device; if (!device) return Promise.reject(Error(_('No AirPods found')));
        return new Promise((resolve, reject) => this.bluez.bus.call('org.bluez', device.path, 'org.bluez.Device1', method, null, null, Gio.DBusCallFlags.NONE, 20000, this.cancellable,
            (connection, result) => { try { resolve(connection.call_finish(result)); } catch (e) { reject(e); } }));
    }
    // The settings page reads this.
    get status() {
        if (!this.enabled) return 'disabled';
        if (this.helperRunning) return 'helper';
        if (this.helperInstalled) return 'installed';
        return this.aap?.state?.connected ? 'aap' : this.bluez?.device ? 'bluez' : 'missing';
    }
    dispose() {
        if (this.saveTimer) { this.life.cancel(this.saveTimer); this.saveTimer = 0; this.store?.write('airpods-batteries', this.batteries.toJSON()); }
        this.helperGeneration++;
        if (this.watch) Gio.bus_unwatch_name(this.watch); this.watch = 0;
        this.cancellable?.cancel(); this.dropProxy(); this.stopAap(); this.stopBluez(); this.stopAap(); this.life.dispose(); this.events.clear(); this.listeners.clear();
    }
}
