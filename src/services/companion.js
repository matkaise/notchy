import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Emitter, Lifetime} from '../lifecycle.js';
import {AGENT_DBUS} from './agents.js';
import {helperLauncher} from '../i18n/gnome.js';
import {_, fmt} from '../i18n/core.js';

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
 <method name="ReportActivity"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
 <method name="EndActivity"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
 <method name="GetLiveActivities"><arg type="s" direction="out"/></method>
 <method name="InvokeActivity"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
 <method name="Timer"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
 <signal name="LiveActivitiesChanged"><arg type="s"/></signal>
 <signal name="ActivityAction"><arg type="s"/><arg type="s"/></signal>
${AGENT_DBUS}
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
        // The Regal's popups (its context menu, tooltips): window -> {clone, life}.
        this.popups = new Map();
        this.dbus = Gio.DBusExportedObject.wrapJSObject(XML, {
            SetActivity: (name, status, progress) => productivity.setActivity(name, status, progress),
            ClearActivity: name => productivity.clearActivity(name),
            GetActivities: () => JSON.stringify([...productivity.activities.values()]),
            // Smart Live Activities (src/services/activities.js): reports from other apps,
            // the whole list, an action, timers. Unavailable parts answer with a message.
            ReportActivity: json => extension.activities?.report(json) ?? _('Live activities are not available'),
            EndActivity: id => extension.activities?.end(id) ?? false,
            GetLiveActivities: () => JSON.stringify(extension.activities?.toJSON() ?? {enabled: false, focus: null, activities: []}),
            InvokeActivity: (id, action) => {
                const activities = extension.activities; if (!activities) return _('Live activities are not available');
                activities.flush();
                return activities.invoke(activities.store.get(`ext:${id}`) ? `ext:${id}` : id, action);
            },
            Timer: json => JSON.stringify(this.timerCommand(json)),
            // Structured agent sessions (notchyctl agent …, the MCP bridge, hook adapters).
            AgentEvent: json => extension.agents?.report(json) ?? _('Agent indicators are not available'),
            AgentHook: (provider, json) => extension.agents?.hook(provider, json) ?? _('Agent indicators are not available'),
            GetAgents: () => JSON.stringify(extension.agents?.toJSON() ?? []),
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
        this.unsubAgents = extension.agents?.subscribe(() => this.dbus.emit_signal('AgentsChanged', new GLib.Variant('(s)', [JSON.stringify(extension.agents.toJSON())])));
        // The native panes show AirDrop's switch and state.
        this.unsubAirDrop = extension.airdrop?.subscribe(() => this.dbus.emit_signal('AirDrop', new GLib.Variant('(s)', [JSON.stringify(this.airdropConfig())])));
        this.life.connect(global.display, 'window-created', (_d, window) => {
            // Set title before mapping is asynchronous on Wayland.
            this.life.connect(window, 'notify::title', () => this._positionWindow(window));
            const actor = window.get_compositor_private();
            if (actor) this.life.connect(actor, 'first-frame', () => { this._positionWindow(window); this.trackPopup(window); });
            this._positionWindow(window); this.trackPopup(window);
            this.life.later(100, () => { try { this._positionWindow(window); } catch { /* Window already closed. */ } });
        });
    }
    // The manager's changes and the actions external reporters declared, as signals.
    watchActivities(activities) {
        if (!activities) return;
        this.unsubActivities = activities.subscribe(() => { if (!this.life.closed) this.dbus.emit_signal('LiveActivitiesChanged', new GLib.Variant('(s)', [JSON.stringify(activities.toJSON())])); });
        this.unsubActions = activities.onAction((id, action) => { if (!this.life.closed) this.dbus.emit_signal('ActivityAction', new GLib.Variant('(ss)', [id, action])); });
    }
    // Timer(json): {action: start, duration ("25m"), name} | {action: start, pomodoro: true} | {action: pause|resume|cancel, id} | {action: list}.
    timerCommand(json) {
        const timers = this.extension.timers;
        if (!timers) return {ok: false, error: _('Timers are not available')};
        let command;
        try { command = JSON.parse(json); } catch { return {ok: false, error: _('Not valid JSON')}; }
        if (!command || typeof command !== 'object') return {ok: false, error: _('Not valid JSON')};
        const shown = timer => ({id: timer.id, name: timer.name, kind: timer.kind, phase: timer.phase, cycle: timer.cycle, state: timer.state, remaining: Math.round(timers.set.remaining(timer) / 1000)});
        switch (command.action) {
        case 'start': {
            const timer = timers.start({duration: command.duration === undefined ? undefined : String(command.duration), name: command.name === undefined ? '' : String(command.name), pomodoro: command.pomodoro === true});
            return typeof timer === 'string' ? {ok: false, error: timer} : {ok: true, timer: shown(timer)};
        }
        case 'pause': case 'resume': case 'cancel': {
            const id = String(command.id ?? '') || timers.list().find(t => t.state !== 'completed')?.id;
            return timers[command.action](id) ? {ok: true} : {ok: false, error: _('No such timer')};
        }
        case 'list': return {ok: true, timers: timers.list().map(shown)};
        default: return {ok: false, error: _('Unknown timer action')};
        }
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
    // A popup of the native Regal (its context menu, a tooltip) is its own
    // Wayland surface. Mutter stacks it with the windows, below the Shell's
    // chrome, so the island would cover it. It is shown as a clone on top of
    // everything instead, exactly over the real popup, which keeps the input:
    // the clone is not reactive, and while a menu is open the island's tab
    // bar lets clicks through (Island.syncVisibility), so a click there only
    // dismisses the menu, as a click anywhere outside does.
    trackPopup(window) {
        if (this.life.closed || this.popups.has(window) || !this.shelfProc) return;
        const types = [Meta.WindowType.POPUP_MENU, Meta.WindowType.DROPDOWN_MENU, Meta.WindowType.MENU, Meta.WindowType.COMBO, Meta.WindowType.TOOLTIP];
        if (!types.includes(window.get_window_type()) || window.get_pid() !== Number(this.shelfProc.get_identifier())) return;
        const actor = window.get_compositor_private(); if (!actor) return;
        const life = new Lifetime(), clone = new Clutter.Clone({name: 'notchy-popup', source: actor, reactive: false});
        Main.layoutManager.uiGroup.add_child(clone);
        const place = () => { clone.set_position(Math.round(actor.x), Math.round(actor.y)); clone.set_size(actor.width, actor.height); clone.visible = actor.visible; };
        for (const signal of ['notify::x', 'notify::y', 'notify::width', 'notify::height', 'notify::visible']) life.connect(actor, signal, place);
        const menu = window.get_window_type() !== Meta.WindowType.TOOLTIP;
        this.popups.set(window, {clone, life, menu});
        life.connect(window, 'unmanaged', () => this.untrackPopup(window));
        life.connect(actor, 'destroy', () => this.untrackPopup(window));
        place(); this.changed();
    }
    untrackPopup(window) {
        const popup = this.popups.get(window); if (!popup) return;
        this.popups.delete(window); popup.life.dispose(); popup.clone.destroy();
        if (!this.life.closed) this.changed();
    }
    // A context menu of the Regal is open (tooltips do not count).
    get menuOpen() { return [...this.popups.values()].some(popup => popup.menu); }
    containsPopupPoint(x, y) {
        return [...this.popups.entries()].some(([window, popup]) => {
            if (!popup.menu) return false;
            const r = window.get_frame_rect();
            return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
        });
    }
    dropTarget(config) {
        if (!this.life.closed) this.dbus.emit_signal('DropTarget', new GLib.Variant('(s)', [JSON.stringify(config)]));
        if (config.visible) for (const actor of global.get_window_actors()) this._positionWindow(actor.meta_window);
    }
    // The pane, and its open context menu, count as the island for hover and clicks.
    containsShelfPoint(x, y) {
        const p = this.shelfIsland && this.position;
        return Boolean(p && ((x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height) || this.containsPopupPoint(x, y)));
    }
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
            const launcher = helperLauncher(this.extension.settings);
            launcher.setenv('GDK_BACKEND', 'wayland', true);
            const proc = launcher.spawnv(['/usr/bin/python3', `${this.extension.path}/helper/tray.py`, 'shelf', String(this.extension.settings.get_int('width')), this.extension.settings.get_string('style'), 'hidden']);
            this.shelfProc = proc;
            proc.wait_async(this.life.cancellable, (p, res) => {
                try { p.wait_finish(res); } catch (e) { if (!this.life.closed) console.warn(e.message); }
                if (this.shelfProc !== proc || this.life.closed) return;
                this.shelfProc = null; this.shelfMapped = false; this.shelfWindow = null;
                const island = this.shelfIsland; this.closeShelf(); island?.close(); this.changed();
            });
        } catch (e) { Main.notify('Notchy', fmt(_('The shelf could not be opened: %s'), e.message)); }
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
        if (this.restartWanted) { this.restartWanted = false; this.restartHelpers(); }
    }
    // The floating Korb: a small glass basket at the pointer that collects
    // files during a drag and hands them to the Regal in one go.
    open(kind = 'basket', monitor = Main.layoutManager.primaryMonitor) {
        if (this.proc || this.life.closed) return;
        // As large as helper/tray.py's BASKET.
        const width = 280, height = 262;
        const [px, py] = global.get_pointer();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const x = Math.min(Math.max(px - width / 2, area.x), area.x + area.width - width);
        const y = Math.min(Math.max(py - 90, area.y), area.y + area.height - height);
        this.trayPosition = {x, y, width, height};
        try {
            const launcher = helperLauncher(this.extension.settings);
            launcher.setenv('GDK_BACKEND', 'wayland', true);
            const proc = launcher.spawnv(['/usr/bin/python3', `${this.extension.path}/helper/tray.py`, 'basket', String(width), this.extension.settings.get_string('style')]);
            this.proc = proc; this.kind = 'basket'; this.changed();
            proc.wait_async(this.life.cancellable, (p, res) => {
                try { p.wait_finish(res); } catch (e) { if (!this.life.closed) console.warn(e.message); }
                if (this.proc === proc) { this.proc = null; this.kind = null; this.trayPosition = null; this.changed(); }
            });
        } catch (e) { Main.notify('Notchy', fmt(_('The basket could not be opened: %s'), e.message)); }
    }
    // A new interface language: the shelf process starts again in it — at once
    // while it is hidden, else the next time the Regal closes.
    restartHelpers() {
        if (this.life.closed || !this.shelfProc) return;
        if (this.shelfIsland) { this.restartWanted = true; return; }
        const proc = this.shelfProc; this.shelfProc = null; this.shelfMapped = false; this.shelfWindow = null;
        try { proc.force_exit(); } catch { /* Gone. */ }
    }
    airdropConfig() {
        const airdrop = this.extension.airdrop;
        return {available: Boolean(airdrop?.available), receiving: Boolean(airdrop?.receiving), state: airdrop?.state ?? 'off', sending: Boolean(airdrop?.sendProc)};
    }
    dispose() { for (const window of [...this.popups.keys()]) this.untrackPopup(window); this.closeShelf(); this.life.dispose(); this.unsub(); this.unsubAirDrop?.(); this.unsubAgents?.(); this.unsubActivities?.(); this.unsubActions?.(); this.dbus.unexport(); Gio.bus_unown_name(this.owner);
        this.proc?.force_exit(); this.proc = null; this.shelfProc?.force_exit(); this.shelfProc = null; }
}
