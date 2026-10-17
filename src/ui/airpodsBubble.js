import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {box, label, gicon} from './widgets.js';
import {ANC_ICON, ANC_NAME, airpodsParts, productCell} from './views.js';
import {Lifetime} from '../lifecycle.js';

// The AirPods as a small round companion beside the notch, as Droppy and
// Apple show a connected accessory: their symbol inside a battery ring. A
// click opens their controls — batteries, noise control, conversation
// awareness, the ear pause, disconnect. It shows only while AirPods are
// connected and the island is closed (an opened island covers that place).
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
        // A PopupMenu never opens while empty, so its items are kept current, not built on open.
        // Right beside Notchy's capsule in the bar's middle.
        const center = Main.panel._centerBox, notchy = island.panelButton.container;
        Main.panel.addToStatusArea('notchy-airpods', this.button, center.get_children().indexOf(notchy) + 1, 'center');
        this.life.cleanups.push(this.airpods.subscribe(() => { this.sync(); this.fill(); }));
        this.life.connect(this.settings, 'changed', (_s, key) => { if (key.startsWith('airpods-') || key === 'style') this.sync(); });
        this.sync(); this.fill();
    }
    // The bud level the ring shows: the lower bud, or the one battery of over-ear models.
    get level() {
        const state = this.airpods.state; if (!state) return null;
        const {left, right, single} = state.battery;
        return single ?? (left === null ? right : right === null ? left : Math.min(left, right));
    }
    sync() {
        if (this.life.closed) return;
        const state = this.airpods.state;
        const shown = Boolean(state?.connected) && this.settings.get_boolean('airpods-bubble') && !this.island.actor.visible;
        this.button.visible = shown;
        if (!shown && this.button.menu.isOpen) this.button.menu.close();
        this.content.set_style_class_name(`notchy-airpods-bubble notchy-${this.settings.get_string('style')}`);
        const size = Math.max(22, Main.panel.height - (this.settings.get_string('style') === 'liquid' ? 6 : 4));
        this.content.set_size(size, size);
        const level = this.level;
        this.button.accessible_name = level === null ? 'AirPods verbunden' : `AirPods: ${level} %`;
        this.ring.queue_repaint();
    }
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
    // The controls, rebuilt whenever the AirPods change.
    fill() {
        const menu = this.button.menu, airpods = this.airpods, state = airpods.state;
        menu.removeAll();
        if (!state) return;
        const failed = e => this.island.toast('dialog-warning-symbolic', e.message);
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'notchy-airpods-menu-head'});
        const column = box(true, {x_expand: true});
        column.add_child(label(state.name, 'notchy-airpods-menu-title'));
        column.add_child(label(state.connected ? (state.anc ? `Verbunden · ${ANC_NAME[state.anc]}` : 'Verbunden') : 'Getrennt', 'notchy-airpods-menu-sub'));
        head.add_child(column); menu.addMenuItem(head);
        // The batteries as on the card, already filled.
        const rings = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'notchy-airpods-menu-rings'});
        const row = box(false, {style_class: 'notchy-airpods-products', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        const threshold = this.settings.get_int('airpods-battery-threshold');
        for (const part of airpodsParts(state)) {
            const kind = part.key === 'single' ? (state.headphones ? 'headphones' : 'buds') : part.key;
            // A bud out of the ear says so, as the media tab used to show it.
            const out = state.ear && ['left', 'right'].includes(part.key) && !state.ear[part.key];
            const cell = productCell(kind, `${part.key === 'single' ? 'Akku' : part.name}${out ? ' · nicht im Ohr' : ''}`);
            const level = state.battery[part.key], charging = part.key !== 'single' && state.charging[part.key];
            cell.instant = true; cell.progress = 1; cell.picture.opacity = 255; cell.picture.scale_x = cell.picture.scale_y = 1; cell.picture.rotation_angle_z = 0;
            cell.set(level, Boolean(charging), level !== null && level < threshold && !charging);
            row.add_child(cell.actor);
        }
        rings.add_child(row); menu.addMenuItem(rings);
        // Noise control: one button per mode the model has.
        const modes = airpods.modes;
        if (modes.length) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'notchy-airpods-menu-modes'});
            const segment = box(false, {style_class: 'notchy-airpods-modes', x_expand: true});
            for (const mode of modes) {
                const inner = box(true, {x_align: Clutter.ActorAlign.CENTER});
                inner.add_child(new St.Icon({gicon: gicon(ANC_ICON[mode]), icon_size: 18, x_align: Clutter.ActorAlign.CENTER}));
                inner.add_child(label({noise: 'ANC', transparency: 'Transparenz', adaptive: 'Adaptiv', off: 'Aus'}[mode], 'notchy-airpods-mode-label', {x_align: Clutter.ActorAlign.CENTER}));
                const b = new St.Button({style_class: `notchy-airpods-mode${state.anc === mode ? ' active' : ''}`, child: inner, can_focus: true, x_expand: true, accessible_name: ANC_NAME[mode]});
                b.connect('clicked', () => airpods.setAnc(mode).catch(failed));
                segment.add_child(b);
            }
            item.add_child(segment); menu.addMenuItem(item);
        }
        if (state.conversation !== null) {
            const talk = new PopupMenu.PopupSwitchMenuItem('Gesprächserkennung', state.conversation);
            talk.connect('toggled', (_i, on) => airpods.setConversationAwareness(on).catch(failed));
            menu.addMenuItem(talk);
        }
        // The ear pause: the daemon's setting with airpods-helper, Notchy's own otherwise.
        if (state.backend === 'airpods-helper' && state.pauseOnRemoval !== null) {
            const pause = new PopupMenu.PopupSwitchMenuItem('Pause beim Herausnehmen', state.pauseOnRemoval);
            pause.connect('toggled', (_i, on) => airpods.setPauseOnRemoval(on).catch(failed));
            menu.addMenuItem(pause);
        } else if (state.backend === 'aap') {
            const pause = new PopupMenu.PopupSwitchMenuItem('Pause beim Herausnehmen', this.settings.get_boolean('airpods-ear-pause'));
            pause.connect('toggled', (_i, on) => this.settings.set_boolean('airpods-ear-pause', on));
            menu.addMenuItem(pause);
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Trennen', () => airpods.disconnect().catch(failed));
        menu.addAction('Bluetooth-Einstellungen …', () => this.island.extension.launcher?.providers.cmd.commands.find(c => c.id === 'settings-bluetooth')?.run());
    }
    dispose() { this.life.dispose(); this.button.destroy(); }
}
