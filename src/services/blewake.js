import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The Bluetooth LE advert that wakes an iPhone's AirDrop radio (AWDL) before a
// send: Apple's Continuity frame (company 0x004C) with the AirDrop subtype and
// empty contact hashes, which is all "Everyone" mode needs. It is registered
// through bluetoothd's LEAdvertisingManager1, which any session user may use;
// airdrop-mt7921's own `btmgmt` route hangs with BlueZ 5.85 (Ubuntu 26.04).
// Payload as in airdrop-mt7921's tools/blewake-dbus.py.
const PAYLOAD = [0x05, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
const PATH = '/org/gnome/Shell/Extensions/Notchy/airdrop_wake';
const XML = `<node><interface name="org.bluez.LEAdvertisement1">
 <method name="Release"/>
 <property name="Type" type="s" access="read"/>
 <property name="ManufacturerData" type="a{qv}" access="read"/>
 <property name="IncludeTxPower" type="b" access="read"/>
</interface></node>`;

export class BleWake {
    constructor(adapter = '/org/bluez/hci0') { this.adapter = adapter; this.registration = 0; this.up = false; this.bus = null; }
    start() {
        if (this.registration) return;
        try {
            this.bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            const info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0];
            this.registration = this.bus.register_object(PATH, info,
                (_connection, _sender, _path, _iface, method, _params, invocation) => {
                    if (method === 'Release') this.up = false;
                    invocation.return_value(null);
                },
                (_connection, _sender, _path, _iface, property) => ({
                    Type: new GLib.Variant('s', 'broadcast'),
                    ManufacturerData: new GLib.Variant('a{qv}', {[0x004C]: new GLib.Variant('ay', PAYLOAD)}),
                    IncludeTxPower: new GLib.Variant('b', false),
                })[property] ?? null,
                null);
            this.bus.call('org.bluez', this.adapter, 'org.bluez.LEAdvertisingManager1', 'RegisterAdvertisement',
                new GLib.Variant('(oa{sv})', [PATH, {}]), null, Gio.DBusCallFlags.NONE, 5000, null, (bus, result) => {
                    try { bus.call_finish(result); this.up = true; } catch (e) { console.warn(`Notchy AirDrop: Bluetooth wake failed (${e.message})`); }
                });
        } catch (e) { console.warn(`Notchy AirDrop: Bluetooth wake unavailable (${e.message})`); this.stop(); }
    }
    stop() {
        if (this.bus && this.up) {
            this.bus.call('org.bluez', this.adapter, 'org.bluez.LEAdvertisingManager1', 'UnregisterAdvertisement',
                new GLib.Variant('(o)', [PATH]), null, Gio.DBusCallFlags.NONE, 3000, null, (bus, result) => { try { bus.call_finish(result); } catch { /* Already gone. */ } });
        }
        if (this.registration) { try { this.bus.unregister_object(this.registration); } catch { /* Gone. */ } }
        this.registration = 0; this.up = false;
    }
}
