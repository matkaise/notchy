import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {box, label, gicon} from './widgets.js';
import {ANC_ICON, ancName, airpodsParts, productCell, partReading} from './views.js';
import {settingsPanel} from '../launcher/providers.js';
import {_, fmt, formatPercent} from '../i18n/core.js';
import {Lifetime} from '../lifecycle.js';

// AirPods keep their place right of the notch and stay visible before agents.
const PRIORITY = 6;

// The AirPods as a small round companion beside the notch, as Droppy and
// Apple show a connected accessory: their symbol inside a battery ring. A
// click opens their controls — batteries, noise control, conversation
// awareness, the ear pause, disconnect. It shows only while AirPods are
// connected and the island is closed (an opened island covers that place).
// Its place comes from the island's SideIndicators, like the agents'.
export class AirPodsBubble {
    constructor(island) {
        this.island = island; this.airpods = island.airpods; this.settings = island.settings; this.life = new Lifetime();
        this.button = new PanelMenu.Button(0.5, 'AirPods', false);
        this.button.add_style_class_name('notchy-airpods-bubble-button');
        this.button.accessible_name = 'AirPods';
        const content = new St.Widget({style_class: 'notchy-airpods-bubble', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this.ring = new St.DrawingArea({style_class: 'notchy-airpods-bubble-ring', x_expand: true, y_expand: true});
        this.ring.connect('repaint', () => this.paint());
        content.add_child(this.ring);
        content.add_child(new St.Icon({gicon: gicon('notchy-airpods-symbolic'), icon_size: 13, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        this.content = content;
        this.button.add_child(content);
        this.button.menu.box.add_style_class_name('notchy-airpods-menu');
        Main.panel.menuManager.addMenu(this.button.menu);
        this.unplace = island.sides.add({id: 'airpods', actor: this.button.container, priority: () => PRIORITY, preferred: () => 'right',
            wanted: () => this.wanted, summary: () => this.summary()});
        // A PopupMenu never opens while empty, so its items are kept current, not built on open.
        this.life.cleanups.push(this.airpods.subscribe(() => { this.sync(); this.fill(); }));
        this.life.connect(this.settings, 'changed', (_s, key) => { if (key.startsWith('airpods-') || key === 'style') { this.sync(); this.fill(); } });
        // The age of a remembered battery reading ticks on while the controls are open.
        this.life.connect(this.button.menu, 'open-state-changed', (_m, open) => {
            this.life.cancel(this.ageTimer); this.ageTimer = 0;
            if (open) this.ageTimer = this.life.every(30000, () => this.fill());
        });
        this.sync(); this.fill();
    }
    get wanted() { return Boolean(this.airpods.state?.connected) && this.settings.get_boolean('airpods-bubble'); }
    get level() {
        const state = this.airpods.state; if (!state) return null;
        const {left, right, single} = state.battery;
        return single ?? (left === null ? right : right === null ? left : Math.min(left, right));
    }
    summary() {
        const state = this.airpods.state; if (!state) return [];
        const level = this.level;
        return [{title: state.name, subtitle: level === null ? _('Connected') : fmt(_('Connected · %s'), formatPercent(level)), icon: gicon('notchy-airpods-symbolic'), activate: () => this.button.menu.open()}];
    }
    sync() {
        if (this.life.closed) return;
        if (!this.wanted && this.button.menu.isOpen) this.button.menu.close();
        this.content.set_style_class_name(`notchy-airpods-bubble notchy-${this.settings.get_string('style')}`);
        const size = Math.max(22, Main.panel.height - (this.settings.get_string('style') === 'liquid' ? 6 : 4));
        this.content.set_size(size, size);
        const level = this.level;
        this.button.accessible_name = level === null ? _('AirPods connected') : fmt(_('AirPods: %s'), formatPercent(level));
        this.ring.queue_repaint();
        this.island.sides.queue();
    }
    // Kept for the island's syncVisibility: the side rows follow it themselves.
    get visible() { return this.button.container.visible && this.button.container.get_parent()?.get_parent()?.visible; }
    paint() {
        const cr = this.ring.get_context(), [w, h] = this.ring.get_surface_size(), r = Math.min(w, h) / 2 - 2.5;
        const level = this.level, state = this.airpods.state, threshold = this.settings.get_int('airpods-battery-threshold');
        cr.setLineWidth(2.5); cr.setSourceRGBA(1, 1, 1, 0.16); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke();
        if (level !== null) {
            const charging = state?.charging.left || state?.charging.right;
            if (level < threshold && !charging) cr.setSourceRGBA(1, 0.62, 0.04, 1); else cr.setSourceRGBA(0.2, 0.78, 0.35, 1);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.02, level / 100)); cr.stroke();
        }
        cr.$dispose();
    }
    // The controls. Built once per layout (the parts the model reports, its
    // modes, which switches it has) and updated in place otherwise: a battery
    // update while the menu is open keeps focus, hover and a click in progress.
    fill() {
        if (this.life.closed) return;
        const menu = this.button.menu, airpods = this.airpods, state = airpods.state;
        if (!state) { if (this.layout) { menu.removeAll(); this.layout = ''; this.parts = null; } return; }
        const modes = airpods.modes, pause = state.backend === 'airpods-helper' && state.pauseOnRemoval !== null ? 'helper' : state.backend === 'aap' ? 'aap' : '';
        const layout = JSON.stringify([airpodsParts(state).map(p => p.key), modes, state.conversation !== null, pause]);
        if (layout !== this.layout) this.build(state, modes, pause, layout);
        this.update(state);
    }
    build(state, modes, pause, layout) {
        const menu = this.button.menu, airpods = this.airpods, failed = e => this.island.toast('dialog-warning-symbolic', e.message);
        const focused = global.stage.get_key_focus(), hadFocus = menu.isOpen && focused && menu.box.contains(focused);
        menu.removeAll(); this.layout = layout;
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'notchy-airpods-menu-head'});
        const column = box(true, {x_expand: true});
        this.title = label('', 'notchy-airpods-menu-title'); this.subtitle = label('', 'notchy-airpods-menu-sub');
        column.add_child(this.title); column.add_child(this.subtitle);
        head.add_child(column); menu.addMenuItem(head);
        // The batteries as on the card, already filled.
        const rings = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'notchy-airpods-menu-rings'});
        const row = box(false, {style_class: 'notchy-airpods-products', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this.parts = airpodsParts(state).map(part => {
            const kind = part.key === 'single' ? (state.headphones ? 'headphones' : 'buds') : part.key;
            const cell = productCell(kind, part.key === 'single' ? _('Battery') : part.name);
            cell.instant = true; cell.progress = 1; cell.picture.opacity = 255; cell.picture.scale_x = cell.picture.scale_y = 1; cell.picture.rotation_angle_z = 0;
            row.add_child(cell.actor);
            return {part, cell};
        });
        rings.add_child(row); menu.addMenuItem(rings);
        // Noise control: one button per mode the model has.
        this.modeButtons = new Map();
        if (modes.length) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'notchy-airpods-menu-modes'});
            const segment = box(false, {style_class: 'notchy-airpods-modes', x_expand: true});
            for (const mode of modes) {
                const inner = box(true, {x_align: Clutter.ActorAlign.CENTER});
                inner.add_child(new St.Icon({gicon: gicon(ANC_ICON[mode]), icon_size: 18, x_align: Clutter.ActorAlign.CENTER}));
                // Translators: short labels of the AirPods noise control buttons.
                inner.add_child(label({noise: _('ANC'), transparency: _('Transparency'), adaptive: _('Adaptive'), off: _('Off')}[mode], 'notchy-airpods-mode-label', {x_align: Clutter.ActorAlign.CENTER}));
                const b = new St.Button({style_class: 'notchy-airpods-mode', child: inner, can_focus: true, x_expand: true, accessible_name: ancName(mode)});
                b.connect('clicked', () => airpods.setAnc(mode).catch(failed));
                segment.add_child(b); this.modeButtons.set(mode, b);
            }
            item.add_child(segment); menu.addMenuItem(item);
        }
        this.talk = null;
        if (state.conversation !== null) {
            this.talk = new PopupMenu.PopupSwitchMenuItem(_('Conversation Awareness'), Boolean(state.conversation));
            this.talk.connect('toggled', (_i, on) => airpods.setConversationAwareness(on).catch(failed));
            menu.addMenuItem(this.talk);
        }
        // The ear pause: the daemon's setting with airpods-helper, Notchy's own otherwise.
        this.pause = null;
        if (pause === 'helper') {
            this.pause = new PopupMenu.PopupSwitchMenuItem(_('Pause When Taken Out'), Boolean(state.pauseOnRemoval));
            this.pause.connect('toggled', (_i, on) => airpods.setPauseOnRemoval(on).catch(failed));
            menu.addMenuItem(this.pause);
        } else if (pause === 'aap') {
            this.pause = new PopupMenu.PopupSwitchMenuItem(_('Pause When Taken Out'), this.settings.get_boolean('airpods-ear-pause'));
            this.pause.connect('toggled', (_i, on) => this.settings.set_boolean('airpods-ear-pause', on));
            menu.addMenuItem(this.pause);
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Disconnect'), () => airpods.disconnect().catch(failed));
        menu.addAction(_('Bluetooth Settings…'), () => settingsPanel('bluetooth'));
        // A rebuilt menu keeps the keyboard inside it.
        if (hadFocus) menu.box.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }
    update(state) {
        this.title.text = state.name;
        this.subtitle.text = state.connected ? (state.anc ? fmt(_('Connected · %s'), ancName(state.anc)) : _('Connected')) : _('Disconnected');
        const threshold = this.settings.get_int('airpods-battery-threshold');
        for (const {part, cell} of this.parts ?? []) {
            // A bud out of the ear says so.
            const out = state.ear && ['left', 'right'].includes(part.key) && !state.ear[part.key];
            cell.setCaption(out ? fmt(_('%s · not in ear'), part.name) : part.key === 'single' ? _('Battery') : part.name);
            const {level, charging, stale} = partReading(state, part.key);
            cell.set(level, charging, level !== null && level < threshold && !charging, stale);
        }
        for (const [mode, b] of this.modeButtons ?? []) state.anc === mode ? b.add_style_class_name('active') : b.remove_style_class_name('active');
        // Switches follow the device without emitting their own 'toggled'.
        if (this.talk && this.talk.state !== Boolean(state.conversation)) this.talk.setToggleState(Boolean(state.conversation));
        if (this.pause) {
            const on = state.backend === 'airpods-helper' ? Boolean(state.pauseOnRemoval) : this.settings.get_boolean('airpods-ear-pause');
            if (this.pause.state !== on) this.pause.setToggleState(on);
        }
    }
    dispose() { this.life.dispose(); this.unplace?.(); this.button.destroy(); }
}
