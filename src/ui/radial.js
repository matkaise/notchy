import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {box, label, icon} from './widgets.js';
import {Lifetime} from '../lifecycle.js';
import {_, N_} from '../i18n/core.js';

// Translators: the radial capture menu: a selected area, a window, the whole screen, a recording, text recognition.
export const CAPTURES = [['area', N_('Area'), 'screenshot-ui-area-symbolic'], ['window', N_('Window'), 'screenshot-ui-window-symbolic'],
    ['screen', N_('Screen'), 'screenshot-ui-display-symbolic'], ['record', N_('Record'), 'media-record-symbolic'], ['text', N_('Text (OCR)'), 'scanner-symbolic']];
const RADIUS = 120, SIZE = 64;

// Glass ring of capture actions that springs out below the island (right
// click on the island, or the ring shortcut). Keys 1–5 choose, Esc closes.
export class RadialMenu {
    constructor(extension) { this.extension = extension; this.actor = null; }
    toggle() { this.actor ? this.close() : this.open(); }
    open() {
        if (this.actor) return;
        const island = this.extension.activeIsland(); if (!island) return;
        // Measure before closing: the bar slot keeps the capsule's centre, while
        // a just-returned capsule has no fresh allocation yet.
        const monitor = island.monitor, cx = island.centeredX(0) - monitor.x, cy = Main.panel.height + 26;
        island.close(true); this.life = new Lifetime();
        this.actor = new St.Widget({name: 'notchy-radial', style_class: 'notchy-radial-backdrop', reactive: true, x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, opacity: 0});
        this.buttons = CAPTURES.map(([kind, title, iconName], i) => {
            const content = box(true, {style_class: 'notchy-radial-content', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            content.add_child(icon(iconName, 22)); content.add_child(label(_(title), 'notchy-radial-label', {x_align: Clutter.ActorAlign.CENTER}));
            const b = new St.Button({style_class: 'notchy-radial-button', child: content, width: SIZE, height: SIZE, can_focus: true, accessible_name: `${i + 1} · ${_(title)}`, track_hover: true});
            b.connect('clicked', () => this.run(kind));
            const angle = (160 - i * 35) * Math.PI / 180, x = cx + RADIUS * Math.cos(angle), y = cy + RADIUS * Math.sin(angle);
            b.set_position(Math.round(x - SIZE / 2), Math.round(y - SIZE / 2)); b.set_pivot_point(0.5, 0.5);
            // Spring out of the island, staggered like a fan.
            b.translation_x = cx - x; b.translation_y = Main.panel.height / 2 - y; b.scale_x = b.scale_y = 0.3;
            b.ease({translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1, delay: i * 35, duration: 480, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            this.actor.add_child(b); return b;
        });
        this.actor.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        Main.layoutManager.addTopChrome(this.actor); this.actor.grab_key_focus();
        this.life.connect(this.actor, 'button-press-event', (_a, event) => {
            if (global.stage.get_event_actor(event) === this.actor) { this.close(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
        this.life.connect(this.actor, 'key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
            const capture = CAPTURES[key - Clutter.KEY_1];
            if (capture) { this.run(capture[0]); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
    }
    run(kind) {
        this.close();
        // Let the dimmed backdrop leave the screen before a full-screen shot.
        const life = this.extension.life;
        life?.later(kind === 'screen' ? 220 : 60, () => this.extension.capture?.run(kind));
    }
    close() { if (!this.actor) return; this.life.dispose(); Main.layoutManager.removeChrome(this.actor); this.actor.destroy(); this.actor = null; this.buttons = null; }
    dispose() { this.close(); }
}
