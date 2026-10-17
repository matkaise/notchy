import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Emitter, Lifetime} from '../lifecycle.js';

export const BUS_NAME = 'org.gnome.Shell.Extensions.Notchy';
export const BUS_PATH = '/org/gnome/Shell/Extensions/Notchy';
const XML = `<node><interface name="${BUS_NAME}">
 <method name="GetItems"><arg type="s" direction="out"/></method>
 <method name="AddUris"><arg type="s" direction="in"/><arg type="u" direction="out"/></method>
 <method name="AddDroppedUris"><arg type="s" direction="in"/><arg type="u" direction="out"/></method>
 <method name="DropReady"><arg type="s" direction="in"/></method>
 <method name="DropHover"><arg type="s" direction="in"/><arg type="b" direction="in"/></method>
 <method name="ShelfHold"><arg type="b" direction="in"/></method>
 <method name="ShelfSelected"><arg type="u" direction="in"/></method>
 <method name="CloseShelf"/>
 <method name="GetShelfConfig"><arg type="s" direction="out"/></method>
 <method name="RemoveUri"><arg type="s" direction="in"/></method>
 <method name="Clear"/>
 <method name="Action"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
 <method name="SetActivity"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="d" direction="in"/></method>
 <method name="ClearActivity"><arg type="s" direction="in"/></method>
 <method name="GetActivities"><arg type="s" direction="out"/></method>
 <method name="AirDropAsk"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="b" direction="out"/></method>
 <method name="AirDropSend"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
 <method name="AirDropDropped"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
 <method name="AirDropReceive"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
 <signal name="AirDrop"><arg type="s"/></signal>
 <signal name="Changed"/>
 <signal name="DropTarget"><arg type="s"/></signal>
 <signal name="ShelfConfig"><arg type="s"/></signal>
</interface></node>`;

export class Companion extends Emitter {
    constructor(extension, shelf, operations, productivity) {
        super(); this.extension = extension; this.shelf = shelf; this.operations = operations; this.life = new Lifetime(); this.proc = null; this.position = null;
        this.dbus = Gio.DBusExportedObject.wrapJSObject(XML, {
            SetActivity: (name, status, progress) => productivity.setActivity(name, status, progress),
            ClearActivity: name => productivity.clearActivity(name),
            GetActivities: () => JSON.stringify([...productivity.activities.values()]),
            GetItems: () => JSON.stringify(shelf.items), AddUris: text => shelf.add(text),
            AddDroppedUris: text => extension.drops?.accepted(text) ?? 0,
            DropReady: backend => extension.drops?.receiverReady(backend),
            DropHover: (backend, active) => { if (extension.drops?.backend === backend) extension.drops.hovering = active; },
            ShelfHold: held => { this.shelfHeld = held; if (held) this.shelfIsland?.cancelCollapse(); else this.shelfIsland?.scheduleCollapse(); },
            CloseShelf: () => this.shelfIsland?.close(),
            // How many files are selected in the native Regal.
            ShelfSelected: count => { this.shelfSelected = count; },
            GetShelfConfig: () => JSON.stringify(this.shelfConfig()),
            RemoveUri: uri => shelf.remove(uri), Clear: () => shelf.clear(),
            Action: (action, uri, extra) => operations.run(action, uri, extra),
            // helper/airdrop-confirm waits on this until the notch is answered.
            AirDropAskAsync: ([sender, files, timeout], invocation) => {
                const airdrop = extension.airdrop;
                if (!airdrop) { invocation.return_value(new GLib.Variant('(b)', [false])); return; }
                airdrop.ask(sender, files, Math.min(Math.max(timeout, 3000), 60000)).then(accepted => invocation.return_value(new GLib.Variant('(b)', [accepted])));
            },
            AirDropSend: text => extension.airdrop?.sendFiles(text.split(/\r?\n/).filter(Boolean).map(uri => Gio.File.new_for_uri(uri).get_path()).filter(Boolean)) ?? false,
            AirDropDropped: text => extension.drops?.airdropped(text) ?? false,
            AirDropReceive: on => extension.airdrop?.receive(on) ?? false,
        });
        this.dbus.export(Gio.DBus.session, BUS_PATH);
        this.owner = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
        this.unsub = shelf.subscribe(() => this.dbus.emit_signal('Changed', null));
        // The native panes show AirDrop's switch and state.
        this.unsubAirDrop = extension.airdrop?.subscribe(() => this.dbus.emit_signal('AirDrop', new GLib.Variant('(s)', [JSON.stringify(this.airdropConfig())])));
        this.life.connect(global.display, 'window-created', (_d, window) => {
            // Set title before mapping is asynchronous on Wayland.
            this.life.connect(window, 'notify::title', () => this._positionWindow(window));
            const actor = window.get_compositor_private();
            if (actor) this.life.connect(actor, 'first-frame', () => this._positionWindow(window));
            this._positionWindow(window);
            this.life.later(100, () => { try { this._positionWindow(window); } catch { /* Window already closed. */ } });
        });
    }
    _positionWindow(window) {
        if (!this.life.closed && this.shelfProc && window.get_title() === 'Notchy Files' && window.get_gtk_application_id() === 'org.notchy.FileTray') {
            const actor = window.get_compositor_private();
            if (!this.shelfIsland || !this.position) return;
            if (actor) actor.opacity = this.shelfIsland.morphing ? 0 : 255;
            if (!actor?.mapped) return;
            const {x, y, width, height} = this.position;
            window.make_above(); window.stick(); window.move_resize_frame(false, Math.round(x), Math.round(y), width, height);
            if (!this.shelfMapped) {
                this.shelfMapped = true; this.shelfWindow = window;
                this.life.connect(window, 'unmanaged', () => { if (this.shelfWindow === window) { this.shelfWindow = null; this.shelfMapped = false; } });
                this.shelfIsland.syncVisibility();
            }
            this.shelfIsland?.syncShade(); return;
        }
        const drops = this.extension.drops;
        const dropTitle = drops?.backend === 'x11' ? 'Notchy Drop Target X11' : 'Notchy Drop Target';
        if (!this.life.closed && window.get_title() === dropTitle && window.get_gtk_application_id() === 'org.notchy.DropTarget' && drops?.position) {
            const actor = window.get_compositor_private();
            if (actor) actor.opacity = drops.island?.morphing ? 0 : 255;
            if (!actor?.mapped) return;
            const {x, y, width, height} = this.extension.drops.position;
            window.make_above(); window.stick(); window.move_resize_frame(false, Math.round(x), Math.round(y), width, height);
            this.dropWindow = window; this.extension.drops?.island?.syncShade(); return;
        }
        if (this.life.closed || window.get_title() !== 'Notchy File Tray' || (window.get_gtk_application_id() !== 'org.notchy.FileTray' && window.get_wm_class() !== 'org.notchy.FileTray') || !this.trayPosition) return;
        const {x, y, width, height} = this.trayPosition;
        window.unmaximize(); window.make_above(); window.stick();
        window.move_resize_frame(false, Math.round(x), Math.round(y), width, height);
    }
    dropTarget(config) {
        if (!this.life.closed) this.dbus.emit_signal('DropTarget', new GLib.Variant('(s)', [JSON.stringify(config)]));
        if (config.visible) for (const actor of global.get_window_actors()) this._positionWindow(actor.meta_window);
    }
    containsShelfPoint(x, y) { const p = this.shelfIsland && this.position; return Boolean(p && x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height); }
    positionShelf() {
        const island = this.shelfIsland; if (!island || this.life.closed) return;
        // Exactly where the island settles, so pane and glass share one edge.
        this.position = {x: island.targetX ?? island.centeredX(island.expandedWidth), y: island.contentY, width: island.expandedWidth, height: island.shelfWindowHeight};
        this.syncShelfVisibility();
        for (const actor of global.get_window_actors()) this._positionWindow(actor.meta_window);
        island.animateSize(island.shelfHeight);
    }
    syncShelfVisibility() {
        if (this.life.closed || !this.shelfProc) return;
        const config = this.shelfConfig();
        if (!config.visible) this.shelfMapped = false;
        this.dbus.emit_signal('ShelfConfig', new GLib.Variant('(s)', [JSON.stringify(config)]));
    }
    shelfConfig() {
        // The pane sits between the clock header and the tab bar; Dynamic Glass
        // continues its black-to-glass shade across it.
        const island = this.shelfIsland ?? this.extension.activeIsland?.();
        return {visible: Boolean(this.shelfIsland?.actor.visible && !this.shelfIsland.dropActive), joined: true,
            style: this.extension.settings.get_string('style'), shade: island?.shelfShade ?? {black: 0, fade: 70}, airdrop: this.airdropConfig(),
            ...(this.position ?? {width: this.extension.settings.get_int('width'), height: 250})};
    }
    // The shelf is one long-lived GTK process. Switching to the Regal tab only
    // maps its window, so the files appear without a process start.
    startShelf() {
        if (this.shelfProc || this.life.closed) return;
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.setenv('GDK_BACKEND', 'wayland', true);
            const proc = launcher.spawnv(['/usr/bin/python3', `${this.extension.path}/helper/tray.py`, 'shelf', String(this.extension.settings.get_int('width')), this.extension.settings.get_string('style'), 'hidden']);
            this.shelfProc = proc;
            proc.wait_async(this.life.cancellable, (p, res) => {
                try { p.wait_finish(res); } catch (e) { if (!this.life.closed) console.warn(e.message); }
                if (this.shelfProc !== proc || this.life.closed) return;
                this.shelfProc = null; this.shelfMapped = false; this.shelfWindow = null;
                const island = this.shelfIsland; this.closeShelf(); island?.close(); this.changed();
            });
        } catch (e) { Main.notify('Notchy', `Dateiablage konnte nicht geöffnet werden: ${e.message}`); }
    }
    openShelf(island) {
        if (this.shelfIsland === island) { this.positionShelf(); return; }
        if (this.proc) { this.proc.force_exit(); this.proc = null; this.kind = null; }
        this.shelfIsland?.close();
        this.startShelf(); if (!this.shelfProc) return;
        this.shelfIsland = island; this.shelfHeld = false; this.shelfMapped = false;
        this.positionShelf(); island.syncVisibility(); this.changed();
        this.shelfHover = true;
        this.shelfPoll = this.life.every(100, () => {
            const hovered = island.hovered;
            if (hovered !== this.shelfHover) { this.shelfHover = hovered; island.hoverChanged(); }
        });
    }
    closeShelf() {
        if (!this.shelfIsland) return;
        const island = this.shelfIsland; this.shelfIsland = null; this.shelfHeld = false; this.shelfMapped = false;
        this.life.cancel(this.shelfPoll); this.shelfPoll = 0; this.position = null;
        this.syncShelfVisibility(); island.syncVisibility(); this.changed();
    }
    // The floating Korb: a small glass basket at the pointer that collects
    // files during a drag and hands them to the Regal in one go.
    open(kind = 'basket', monitor = Main.layoutManager.primaryMonitor) {
        if (this.proc || this.life.closed) return;
        const width = 240, height = 230;
        const [px, py] = global.get_pointer();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const x = Math.min(Math.max(px - width / 2, area.x), area.x + area.width - width);
        const y = Math.min(Math.max(py - 90, area.y), area.y + area.height - height);
        this.trayPosition = {x, y, width, height};
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
            launcher.setenv('GDK_BACKEND', 'wayland', true);
            const proc = launcher.spawnv(['/usr/bin/python3', `${this.extension.path}/helper/tray.py`, 'basket', String(width), this.extension.settings.get_string('style')]);
            this.proc = proc; this.kind = 'basket'; this.changed();
            proc.wait_async(this.life.cancellable, (p, res) => {
                try { p.wait_finish(res); } catch (e) { if (!this.life.closed) console.warn(e.message); }
                if (this.proc === proc) { this.proc = null; this.kind = null; this.trayPosition = null; this.changed(); }
            });
        } catch (e) { Main.notify('Notchy', `Korb konnte nicht geöffnet werden: ${e.message}`); }
    }
    airdropConfig() {
        const airdrop = this.extension.airdrop;
        return {available: Boolean(airdrop?.available), receiving: Boolean(airdrop?.receiving), state: airdrop?.state ?? 'off', sending: Boolean(airdrop?.sendProc)};
    }
    dispose() { this.closeShelf(); this.life.dispose(); this.unsub(); this.unsubAirDrop?.(); this.dbus.unexport(); Gio.bus_unown_name(this.owner);
        this.proc?.force_exit(); this.proc = null; this.shelfProc?.force_exit(); this.shelfProc = null; }
}
