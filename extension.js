import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {Lifetime} from './src/lifecycle.js';
import {normalizeAccelerator} from './src/model.js';
import {Store} from './src/services/store.js';
import {Shelf} from './src/services/shelf.js';
import {Clipboard} from './src/services/clipboard.js';
import {Media} from './src/services/media.js';
import {System} from './src/services/system.js';
import {Operations} from './src/services/operations.js';
import {Companion} from './src/services/companion.js';
import {Productivity} from './src/services/productivity.js';
import {Calendar} from './src/services/calendar.js';
import {Notifications} from './src/services/notifications.js';
import {Spectrum} from './src/services/spectrum.js';
import {Outputs} from './src/services/outputs.js';
import {Snap} from './src/services/snap.js';
import {AirDrop} from './src/services/airdrop.js';
import {Cover} from './src/services/cover.js';
import {Capture} from './src/services/capture.js';
import {RadialMenu} from './src/ui/radial.js';
import {Island} from './src/ui/island.js';
import {Drops} from './src/services/drops.js';
import {FileSearch} from './src/services/filesearch.js';
import {Launcher} from './src/launcher/launcher.js';
import {AirPods} from './src/services/airpods.js';
import {Agents} from './src/services/agents.js';

export default class Notchy extends Extension {
    openPreferences() {
        // GNOME rejects a second OpenExtensionPrefs call while a dialog is
        // showing. Reuse that window and always consume the D-Bus result.
        const existing = global.get_window_actors().map(actor => actor.meta_window)
            .find(window => window.get_gtk_application_id() === 'org.gnome.Shell.Extensions' || window.get_wm_class() === 'org.gnome.Shell.Extensions');
        if (existing) { Main.activateWindow(existing); return; }
        if (this.prefsPending) return;
        this.prefsPending = true;
        Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions', 'OpenExtensionPrefs', new GLib.Variant('(ssa{sv})', [this.uuid, '', {}]),
            null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                this.prefsPending = false;
                try { connection.call_finish(result); }
                catch (error) {
                    console.warn(`Notchy preferences: ${error.message}`);
                    if (this.life && !this.life.closed) Main.notify('Notchy', `Einstellungen konnten nicht geöffnet werden: ${error.message}`);
                }
            });
    }
    enable() {
        this.settings = this.getSettings(); this.life = new Lifetime(); this.islands = [];
        try {
            this.store = new Store(); this.shelf = new Shelf(this.store); this.clipboard = new Clipboard(this.settings, this.store);
            this.media = new Media(this.settings); this.system = new System();
            this.cover = new Cover(this, this.media, this.settings);
            this.spectrum = new Spectrum(this, this.media, this.system, this.settings);
            this.outputs = new Outputs(this, this.system, this.settings);
            this.productivity = new Productivity(); this.agents = new Agents(this, this.settings); this.calendar = new Calendar(); this.notifications = new Notifications();
            this.capture = new Capture(this); this.radial = new RadialMenu(this);
            this.airdrop = new AirDrop(this, this.shelf, this.settings);
            this.operations = new Operations(this, this.shelf); this.companion = new Companion(this, this.shelf, this.operations, this.productivity);
            this.drops = new Drops(this); this.snap = new Snap(this);
            this.files = new FileSearch(this, this.settings); this.launcher = new Launcher(this, this.files);
            this.airpods = new AirPods(this, this.settings);
            this._rebuild();
            this.life.connect(Main.layoutManager, 'monitors-changed', () => this._rebuild());
            const binds = {
                'toggle-search': () => this.activeIsland()?.toggle('search'),
                'toggle-ring': () => this.radial.toggle(),
                'toggle-island': () => this.activeIsland()?.toggle(),
                'toggle-clipboard': () => this.activeIsland()?.toggle('clipboard'),
                'toggle-basket': () => this.companion.open('basket', this.activeIsland()?.monitor),
            };
            for (const [name, action] of Object.entries(binds)) { Main.wm.addKeybinding(name, this.settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, action); this.life.cleanups.push(() => Main.wm.removeKeybinding(name)); }
            this._hookHud(); this._hookDrag(); this._hookNotifications(); this._hookInputSourceKeys();
        } catch (e) { this.disable(); throw e; }
    }
    _rebuild() {
        this.drops?.hide();
        this.radial?.close();
        for (const island of this.islands) island.dispose(); this.islands = [];
        // Notchy lives in the top bar, which GNOME shows on the primary monitor.
        const services = {cover: this.cover, spectrum: this.spectrum, calendar: this.calendar, notifications: this.notifications, productivity: this.productivity, settings: this.settings, store: this.store, shelf: this.shelf, clipboard: this.clipboard,
            media: this.media, system: this.system, outputs: this.outputs, airdrop: this.airdrop, operations: this.operations, companion: this.companion, launcher: this.launcher, airpods: this.airpods, agents: this.agents};
        this.services = services;
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) this.islands.push(new Island(this, monitor, services));
    }
    activeIsland() { return this.islands[0]; }
    _hookHud() {
        this.injections = new InjectionManager(); const extension = this;
        this.injections.overrideMethod(Main.osdWindowManager, '_showOsdWindow', original => function (index, icon, text, level, maxLevel) {
            // Shown as a Notchy live activity; GNOME's OSD only when Notchy cannot show it.
            const island = extension.islands.find(i => i.monitor.index === index);
            const name = icon?.get_names?.()[0] ?? 'audio-volume-high-symbolic';
            const caption = text || (name.includes('brightness') ? 'Helligkeit' : name.includes('mic') ? 'Mikrofon' : 'Lautstärke');
            if (!extension.settings.get_boolean('hud-enabled') || level === null || level === undefined || !island?.hud(icon ?? name, caption, level, maxLevel ?? 1))
                return original.call(this, index, icon, text, level, maxLevel);
        });
        const keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        // 'state-changed' also fires for Num Lock, layout switches and modifiers;
        // only an actual Caps Lock change becomes a live activity in the capsule.
        let capsLock = keymap.get_caps_lock_state();
        this.life.connect(keymap, 'state-changed', () => {
            const state = keymap.get_caps_lock_state(); if (state === capsLock) return; capsLock = state;
            if (!this.settings.get_boolean('hud-enabled')) return;
            const island = this.activeIsland(), text = state ? 'Feststelltaste an' : 'Feststelltaste aus';
            if (!island?.hud('input-keyboard-symbolic', text, null)) island?.toast('input-keyboard-symbolic', text);
        });
    }
    _hookDrag() {
        this.dragging = false; this.dragPoll = 0; this.dragPoints = [];
        this.life.connect(Main.xdndHandler, 'drag-begin', () => {
            this.dragging = true; this.dragPoints = []; this.life.cancel(this.dragPoll);
            this.dragPoll = this.life.every(60, () => {
                const [x, y] = global.get_pointer();
                if (this.companion.proc || this.companion.shelfIsland) return;
                this.drops?.motion(x, y);
                if (this.drops?.island) return;
                if (!this.settings.get_boolean('jiggle-enabled')) return;
                this.dragPoints.push([x, y]); if (this.dragPoints.length > 12) this.dragPoints.shift();
                if (this.dragPoints.length < 8) return;
                let travel = 0, reversals = 0;
                for (let i = 1; i < this.dragPoints.length; i++) { const dx = this.dragPoints[i][0] - this.dragPoints[i - 1][0]; travel += Math.abs(dx);
                    if (i > 1 && dx * (this.dragPoints[i - 1][0] - this.dragPoints[i - 2][0]) < 0) reversals++; }
                if (travel > 350 && reversals >= 3) this.companion.open('basket', this.activeIsland()?.monitor);
            });
        });
        this.life.connect(Main.xdndHandler, 'drag-end', () => { this.dragging = false; this.life.cancel(this.dragPoll); this.dragPoll = 0; });
    }
    // GNOME binds Super+Space (and Shift+Super+Space) to switching keyboard
    // layouts. Two bindings on one key make Mutter pick either at random, so
    // Notchy's search opened only sometimes. With a single layout GNOME's
    // switch does nothing at all; then Notchy borrows the keys while it runs
    // (no setting is changed). With several layouts GNOME keeps them.
    _hookInputSourceKeys() {
        const GNOME_KEYS = [['switch-input-source', Meta.KeyBindingFlags.NONE, '_keybindingAction'], ['switch-input-source-backward', Meta.KeyBindingFlags.IS_REVERSED, '_keybindingActionBackward']];
        const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'}), sources = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
        this.borrowedKeys = new Set();
        const restore = name => {
            const [, flags, field] = GNOME_KEYS.find(([key]) => key === name), manager = getInputSourceManager();
            manager[field] = Main.wm.addKeybinding(name, wm, flags, Shell.ActionMode.ALL, manager._switchInputSource.bind(manager));
            this.borrowedKeys.delete(name);
        };
        const sync = () => {
            const ours = new Set(['toggle-search', 'toggle-island', 'toggle-clipboard', 'toggle-basket', 'toggle-ring'].flatMap(key => this.settings.get_strv(key)).map(normalizeAccelerator).filter(Boolean));
            const single = sources.get_value('sources').n_children() < 2;
            for (const [name] of GNOME_KEYS) {
                const clash = single && wm.get_strv(name).some(accel => ours.has(normalizeAccelerator(accel)));
                if (clash && !this.borrowedKeys.has(name)) { Main.wm.removeKeybinding(name); this.borrowedKeys.add(name); }
                else if (!clash && this.borrowedKeys.has(name)) restore(name);
            }
        };
        for (const [object, signal] of [[sources, 'changed::sources'], [wm, 'changed::switch-input-source'], [wm, 'changed::switch-input-source-backward'], [this.settings, 'changed']]) this.life.connect(object, signal, sync);
        this.life.cleanups.push(() => { for (const name of [...this.borrowedKeys]) restore(name); });
        sync();
    }
    _hookNotifications() {
        this.notificationSources = new Set();
        const watch = source => {
            if (this.notificationSources.has(source)) return; this.notificationSources.add(source);
            this.life.connect(source, 'destroy', () => this.notificationSources?.delete(source));
            // 'notification-added' runs before GNOME queues its banner. Mirroring
            // GNOME's banner rules and acknowledging a shown notification makes
            // GNOME skip its own banner, exactly as after showing one itself.
            this.life.connect(source, 'notification-added', (_source, notification) => {
                if (!this.settings.get_boolean('notifications-enabled') || notification.acknowledged || notification.urgency === MessageTray.Urgency.LOW) return;
                const critical = notification.urgency === MessageTray.Urgency.CRITICAL;
                if ((!source.policy.showBanners || this.notifications?.doNotDisturb) && !critical && !notification.forFeedback) return;
                if (this.activeIsland()?.notify(notification)) notification.acknowledged = true;
            });
        };
        for (const source of Main.messageTray.getSources()) watch(source);
        this.life.connect(Main.messageTray, 'source-added', (_tray, source) => watch(source));
    }
    disable() {
        this.drops?.dispose(); this.drops = null;
        this.radial?.dispose(); this.capture?.dispose();
        this.injections?.clear(); this.injections = null; this.life?.dispose();
        for (const island of this.islands ?? []) island.dispose(); this.islands = [];
        this.files?.dispose(); this.files = this.launcher = null; this.airpods?.dispose(); this.airpods = null;
        this.companion?.dispose(); this.operations?.dispose(); this.clipboard?.dispose(); this.cover?.dispose(); this.cover = null; this.spectrum?.dispose(); this.spectrum = null; this.outputs?.dispose(); this.outputs = null; this.snap?.dispose(); this.snap = null; this.airdrop?.dispose(); this.airdrop = null; this.media?.dispose(); this.system?.dispose(); this.productivity?.dispose(); this.agents?.dispose(); this.agents = null; this.calendar?.dispose(); this.calendar = null; this.notifications?.dispose(); this.notifications = null; this.shelf?.dispose(); this.store?.dispose();
        this.companion = this.operations = this.clipboard = this.media = this.system = this.shelf = this.store = this.life = this.settings = null;
        this.notificationSources?.clear(); this.productivity = this.radial = this.capture = this.services = null;
    }
}
