import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {label} from './widgets.js';
import {Lifetime} from '../lifecycle.js';
import {entryTitle, stateLabel, sidePriority, remainingOf, finished, ticking} from '../services/activityModel.js';
import {iconFor, clockOf} from './activityViews.js';
import {formatPercent} from '../i18n/core.js';

// Ring colours per class (RGBA), as the agents' rings.
const COLOR = {attention: [1, 0.62, 0.04, 1], error: [1, 0.27, 0.23, 1], completed: [0.2, 0.78, 0.35, 1], transfer: [0.42, 0.71, 1, 1], timer: [1, 0.62, 0.04, 1], background: [1, 1, 1, 0.5]};

// Further activities beside the notch while another one has the notch: one
// small round indicator per entry (a group counts its members), its symbol
// inside a ring that fills with the measured progress (a timer's elapsed
// share; a full quiet ring where nothing is measured). A click opens the
// Activities tab. Places come from the island's SideIndicators, like the
// agents' and the AirPods'.
export class ActivityIndicators {
    constructor(island) {
        this.island = island; this.activities = island.activities; this.life = new Lifetime(); this.bubbles = new Map(); this.clock = 0;
        this.life.cleanups.push(this.activities.subscribe(() => this.sync()));
        this.life.connect(island.settings, 'changed::style', () => { for (const bubble of this.bubbles.values()) bubble.style(); });
        this.sync();
    }
    sync() {
        if (this.life.closed) return;
        const entries = new Map(this.activities.sideEntries.map(entry => [entry.key, entry]));
        for (const [key, entry] of entries) {
            let bubble = this.bubbles.get(key);
            if (!bubble) { bubble = new ActivityBubble(this.island, key); this.bubbles.set(key, bubble); }
            bubble.update(entry);
        }
        for (const [key, bubble] of this.bubbles) if (!entries.has(key)) { bubble.destroy(); this.bubbles.delete(key); }
        // A second hand only while an indicator shows a running timer or recording.
        const ticks = [...entries.values()].some(entry => entry.members.some(ticking));
        if (ticks && !this.clock) this.clock = this.life.every(1000, () => { for (const bubble of this.bubbles.values()) bubble.tick(); });
        else if (!ticks && this.clock) { this.life.cancel(this.clock); this.clock = 0; }
    }
    dispose() { this.life.dispose(); for (const bubble of this.bubbles.values()) bubble.destroy(); this.bubbles.clear(); }
}

class ActivityBubble {
    constructor(island, key) {
        this.island = island; this.key = key; this.entry = null; this.life = new Lifetime();
        this.button = new PanelMenu.Button(0.5, 'Notchy', true);
        this.button.add_style_class_name('notchy-side-button');
        this.content = new St.Widget({style_class: 'notchy-agent-bubble notchy-act-bubble', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this.ring = new St.DrawingArea({x_expand: true, y_expand: true});
        this.ring.connect('repaint', () => this.paint());
        this.icon = new St.Icon({icon_size: 13, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.badge = label('', 'notchy-agent-badge', {x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, visible: false});
        for (const child of [this.ring, this.icon, this.badge]) this.content.add_child(child);
        this.button.add_child(this.content);
        const open = () => { this.island.open('activities'); return Clutter.EVENT_STOP; };
        this.life.connect(this.button, 'button-press-event', open);
        this.life.connect(this.button, 'key-press-event', (_a, event) => ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(event.get_key_symbol()) ? open() : Clutter.EVENT_PROPAGATE));
        this.unplace = island.sides.add({id: `activity:${key}`, actor: this.button.container, priority: () => (this.entry ? sidePriority(this.entry, island.activities.order) : 1),
            preferred: () => null, wanted: () => Boolean(this.entry), summary: () => this.summary()});
        this.style();
        if (island.settings.get_boolean('activities-animations')) {
            this.content.opacity = 0; this.content.scale_x = this.content.scale_y = 0.6;
            this.life.connect(this.content, 'notify::mapped', () => {
                if (!this.content.mapped || this.appeared) return;
                this.appeared = true;
                this.content.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 240, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    onStopped: () => { if (this.gone) return; this.content.opacity = 255; this.content.scale_x = this.content.scale_y = 1; }});
            });
        }
    }
    style() {
        const style = this.island.settings.get_string('style'), size = Math.max(22, Main.panel.height - (style === 'liquid' ? 6 : 4));
        this.content.set_style_class_name(`notchy-agent-bubble notchy-act-bubble notchy-${style} ${this.entry?.cls ?? ''}`);
        this.content.set_size(size, size);
    }
    update(entry) {
        this.entry = entry;
        const lead = entry.members[0], gicon = iconFor(lead, this.island.agents), key = gicon.to_string?.() ?? '';
        if (this.iconKey !== key) { this.iconKey = key; this.icon.gicon = gicon; }
        const badge = entry.count > 1 ? String(entry.count) : entry.cls === 'completed' ? '✓' : entry.cls === 'error' ? '!' : '';
        this.badge.text = badge; this.badge.visible = Boolean(badge);
        this.badge.set_style_class_name(`notchy-agent-badge${entry.cls === 'completed' ? ' completed' : entry.cls === 'error' ? ' error' : entry.cls === 'attention' ? ' waiting' : ''}`);
        this.style(); this.tick();
        this.island.sides.queue();
    }
    get progress() {
        const entry = this.entry; if (!entry) return null;
        if (entry.count > 1) return entry.progress;
        const lead = entry.members[0];
        if (lead.progress !== null) return lead.progress;
        if (lead.type === 'timer' && lead.duration > 0 && !finished(lead)) return Math.max(0, Math.min(1, 1 - remainingOf(lead, Date.now()) / lead.duration));
        return null;
    }
    tick() {
        const entry = this.entry; if (!entry) return;
        const lead = entry.members[0], progress = this.progress, clock = entry.count === 1 ? clockOf(lead) : '';
        this.button.accessible_name = [entryTitle(entry), stateLabel(entry.state), progress !== null ? formatPercent(Math.round(progress * 100)) : '', clock].filter(Boolean).join(', ');
        this.ring.queue_repaint();
    }
    paint() {
        const cr = this.ring.get_context(), [w, h] = this.ring.get_surface_size(), r = Math.min(w, h) / 2 - 2.2;
        try {
            const entry = this.entry, progress = this.progress, [red, green, blue, alpha] = COLOR[entry?.cls] ?? COLOR.background;
            cr.setLineWidth(2.2); cr.setSourceRGBA(1, 1, 1, 0.14); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke();
            cr.setSourceRGBA(red, green, blue, alpha); cr.setLineCap(Cairo.LineCap.ROUND);
            // Measured progress fills the ring; without one it stays a quiet, full ring.
            if (progress !== null) cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.02, progress));
            else { cr.setSourceRGBA(red, green, blue, alpha * 0.45); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); }
            cr.stroke();
        } finally { cr.$dispose(); }
    }
    summary() {
        const entry = this.entry; if (!entry) return [];
        return entry.members.map(item => ({title: item.name, subtitle: [stateLabel(item.state), item.progress !== null ? formatPercent(Math.round(item.progress * 100)) : clockOf(item)].filter(Boolean).join(' · '),
            icon: iconFor(item, this.island.agents), activate: () => this.island.open('activities')}));
    }
    // Gone first: a transition stopped by the removal must not set values while Clutter drops it.
    destroy() { this.gone = true; this.life.dispose(); this.unplace?.(); this.unplace = null; this.content.remove_all_transitions(); this.button.destroy(); }
}
