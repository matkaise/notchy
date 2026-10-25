import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {box, label, gicon} from './widgets.js';
import {Lifetime} from '../lifecycle.js';
import {PROVIDERS, stateText, viewState, statusText} from '../services/agentModel.js';
import {fmt, ngettext, duration} from '../i18n/core.js';

// Ring colours per state (RGBA).
const COLOR = {working: [0.42, 0.71, 1, 1], waiting: [1, 0.62, 0.04, 1], error: [1, 0.27, 0.23, 1], completed: [0.2, 0.78, 0.35, 1], idle: [1, 1, 1, 0.22], disconnected: [1, 1, 1, 0.12]};

// A running time ("12 s", "4 min", "1 h 5 min"), in the interface language.
export {duration};

// The agents beside the notch: one indicator per agent (Claude Code, Codex,
// Antigravity, or whatever reports over notchyctl/MCP), its sessions in its
// card (src/ui/agentCard.js), which a click opens out of the notch.
// Indicators come and go with their sessions; their side is the island's
// SideIndicators' choice.
export class AgentIndicators {
    constructor(island) {
        this.island = island; this.agents = island.agents; this.life = new Lifetime(); this.bubbles = new Map();
        this.life.cleanups.push(this.agents.subscribe(() => this.sync()));
        this.life.cleanups.push(this.agents.onEvent(event => this.bubbles.get(event.session?.provider)?.transition(event)));
        this.sync();
    }
    sync() {
        if (this.life.closed) return;
        const groups = new Map(this.agents.providers().map(group => [group.provider, group]));
        for (const [provider, group] of groups) {
            let bubble = this.bubbles.get(provider);
            if (!bubble || bubble.leaving) { bubble?.destroyNow(); bubble = new AgentBubble(this.island, provider); this.bubbles.set(provider, bubble); }
            bubble.update(group);
        }
        // An agent without sessions fades out, then leaves its place.
        for (const [provider, bubble] of this.bubbles) {
            if (groups.has(provider) || bubble.leaving) continue;
            bubble.leave(() => { if (this.bubbles.get(provider) === bubble) this.bubbles.delete(provider); });
        }
    }
    dispose() { this.life.dispose(); for (const bubble of this.bubbles.values()) bubble.destroyNow(); this.bubbles.clear(); }
}

export class AgentBubble {
    constructor(island, provider) {
        this.island = island; this.provider = provider; this.agents = island.agents; this.settings = island.settings; this.life = new Lifetime();
        this.group = null; this.leaving = false; this.leaveSources = new Set();
        const name = PROVIDERS[provider]?.name ?? provider;
        // No popup menu of its own: a click opens the agent's card from the notch.
        this.button = new PanelMenu.Button(0.5, name, true);
        this.button.add_style_class_name('notchy-side-button');
        this.button.add_style_class_name('notchy-agent-bubble-button');
        this.content = new St.Widget({style_class: 'notchy-agent-bubble', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        // The track and a determinate progress or the state's full ring.
        this.ring = new St.DrawingArea({x_expand: true, y_expand: true});
        this.ring.connect('repaint', () => this.paintRing());
        // Working without a known progress: a short arc turning (a transform, no repaints).
        this.spinner = new St.DrawingArea({x_expand: true, y_expand: true, visible: false, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this.spinner.connect('repaint', () => this.paintSpinner());
        const appIcon = this.agents.appIcon(provider);
        this.icon = new St.Icon({gicon: appIcon ?? gicon(PROVIDERS[provider]?.icon ?? 'notchy-agent-symbolic'), icon_size: 13, style_class: 'notchy-agent-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.badge = label('', 'notchy-agent-badge', {x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, visible: false});
        for (const child of [this.ring, this.spinner, this.icon, this.badge]) this.content.add_child(child);
        this.button.add_child(this.content);
        const open = () => { this.island.showAgentCard(this.provider); return Clutter.EVENT_STOP; };
        this.life.connect(this.button, 'button-press-event', (_a, event) => (event.get_button() === Clutter.BUTTON_PRIMARY ? open() : Clutter.EVENT_PROPAGATE));
        this.life.connect(this.button, 'key-press-event', (_a, event) => ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(event.get_key_symbol()) ? open() : Clutter.EVENT_PROPAGATE));
        this.unplace = island.sides.add({id: `agent:${provider}`, actor: this.button.container, priority: () => this.group?.priority ?? 1,
            preferred: () => this.preferredSide, wanted: () => !this.leaving && Boolean(this.group), summary: () => this.summary()});
        this.life.connect(this.settings, 'changed', (_s, key) => { if (key === 'style' || key.startsWith('agents-')) this.style(); });
        this.life.connect(this.spinner, 'notify::mapped', () => this.spin());
        // Appearing: a short scale and fade once it is on screen in its place.
        this.content.opacity = 0; this.content.scale_x = this.content.scale_y = 0.6;
        this.whenMapped(() => this.settle(this.content, {opacity: 255, scale_x: 1, scale_y: 1}, 260, Clutter.AnimationMode.EASE_OUT_BACK));
        this.style();
    }
    get preferredSide() {
        let sides = {};
        try { sides = JSON.parse(this.settings.get_string('agents-side')) ?? {}; } catch { sides = {}; }
        if (['left', 'right'].includes(sides[this.provider])) return sides[this.provider];
        // Settings → Agents: all indicators on one side, or automatic.
        const position = this.settings.get_string('agents-position');
        return position === 'left' || position === 'right' ? position : null;
    }
    // An animation that always ends in its final state: should Clutter stop it
    // half-way (the actor moved, unmapped, lost its frame clock), the values are
    // set directly once it should have finished. An indicator never stays
    // invisible or half-sized because of an animation.
    settle(actor, values, duration, mode, onDone = null) {
        let done = false;
        const finish = () => {
            if (done || this.life.closed) return;
            done = true; this.life.cancel(guard);
            if (this.leaving) return;
            for (const key of Object.keys(values)) actor.remove_transition(key.replace(/_/g, '-'));
            actor.set(values); onDone?.();
        };
        const guard = this.life.later(duration + 250, finish);
        actor.ease({...values, duration, mode, onComplete: finish});
    }
    whenMapped(fn) {
        if (this.content.mapped) { fn(); return; }
        let id = this.content.connect('notify::mapped', () => { if (!this.content.mapped) return; this.content.disconnect(id); id = 0; fn(); });
        this.life.cleanups.push(() => { if (id) this.content.disconnect(id); id = 0; });
    }
    style() {
        if (this.life.closed) return;
        const state = this.group?.state ?? 'idle';
        this.content.set_style_class_name(`notchy-agent-bubble notchy-${this.settings.get_string('style')} notchy-agent-${state}`);
        const size = Math.max(22, Main.panel.height - (this.settings.get_string('style') === 'liquid' ? 6 : 4));
        this.content.set_size(size, size);
    }
    update(group) {
        const previous = this.group?.state;
        this.group = group;
        const {state, count, progress, name} = group;
        this.style();
        this.button.accessible_name = count > 1 ? fmt(ngettext('%1$s: %2$s, %3$d session', '%1$s: %2$s, %3$d sessions', count), name, stateText(state), count) : `${name}: ${stateText(state)}`;
        // The spinner turns only while the agent works and no real progress is known.
        const spin = state === 'working' && progress === null;
        if (spin !== this.spinning) {
            this.spinning = spin; this.spinner.visible = spin; this.spinner.remove_all_transitions(); this.spinner.rotation_angle_z = 0;
            this.spin();
        }
        // Waiting: a few gentle pulses, then a steady highlight.
        if (state === 'waiting' && previous !== 'waiting') {
            this.ring.remove_all_transitions(); this.ring.opacity = 255;
            this.ring.ease({opacity: 110, duration: 650, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: 7, autoReverse: true, onStopped: () => { this.ring.opacity = 255; }});
        } else if (state !== 'waiting' && previous === 'waiting') { this.ring.remove_all_transitions(); this.ring.opacity = 255; }
        // The badge: how many sessions, or the check/alert of a finished or failed task.
        // Done but not seen yet: ✓, or how many of its sessions finished.
        const badge = state === 'completed' ? (group.unseen > 1 ? String(group.unseen) : '✓') : state === 'error' ? '!' : state === 'waiting' && count <= 1 ? '?' : count > 1 ? String(count) : '';
        this.badge.text = badge; this.badge.visible = Boolean(badge);
        this.badge.set_style_class_name(`notchy-agent-badge${['waiting', 'error', 'completed'].includes(state) ? ` ${state}` : ''}`);
        this.ring.queue_repaint(); this.spinner.queue_repaint();
        if (previous !== state) this.island.sides.queue();
    }
    // The turning arc. Moving the indicator between rows can stop Clutter's
    // transition, so it is started again whenever it is back on screen.
    spin() {
        if (!this.spinning || !this.spinner.mapped || this.spinner.get_transition('rotation-angle-z')) return;
        this.spinner.rotation_angle_z = 0;
        this.spinner.ease({rotation_angle_z: 360, duration: 1400, mode: Clutter.AnimationMode.LINEAR, repeatCount: -1});
    }
    // A finished task: a short bounce (when enabled), then it turns idle by itself.
    transition(event) {
        if (event.type !== 'completed' || !this.settings.get_boolean('agents-completion-animation')) return;
        this.content.remove_transition('scale-x'); this.content.remove_transition('scale-y');
        this.content.scale_x = this.content.scale_y = 1.22;
        this.settle(this.content, {scale_x: 1, scale_y: 1}, 420, Clutter.AnimationMode.EASE_OUT_BACK);
    }
    paintRing() {
        const cr = this.ring.get_context(), [w, h] = this.ring.get_surface_size(), r = Math.min(w, h) / 2 - 2.2, state = this.group?.state ?? 'idle';
        try {
            cr.setLineWidth(2.2); cr.setSourceRGBA(1, 1, 1, 0.14); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke();
            const [red, green, blue, alpha] = COLOR[state];
            cr.setSourceRGBA(red, green, blue, alpha); cr.setLineCap(Cairo.LineCap.ROUND);
            if (state === 'working' && this.group?.progress !== null && this.group?.progress !== undefined) {
                cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.02, this.group.progress)); cr.stroke();
            } else if (state !== 'working') { cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke(); }
        } finally { cr.$dispose(); }
    }
    paintSpinner() {
        const cr = this.spinner.get_context(), [w, h] = this.spinner.get_surface_size(), r = Math.min(w, h) / 2 - 2.2;
        try {
            cr.setLineWidth(2.2); cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setSourceRGBA(...COLOR.working);
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 0.6); cr.stroke();
        } finally { cr.$dispose(); }
    }
    // Rows for the "+N" group when room runs out: each opens the agent's card.
    summary() {
        const group = this.group; if (!group) return [];
        return group.sessions.filter(s => s.connected).map(session => ({title: `${group.name}${session.project ? ` · ${session.project}` : ''}`, subtitle: [stateText(viewState(session)), statusText(session)].filter(Boolean).join(' · '),
            icon: this.icon.gicon, activate: () => this.island.showAgentCard(this.provider)}));
    }
    // Leaving: the indicator fades and shrinks, then gives up its place.
    leave(done) {
        if (this.leaving) return;
        this.leaving = true;
        // Destroyed only after the transition has finished with the actor. The
        // sources are this bubble's own, so disabling Notchy mid-fade removes them.
        const finish = () => {
            const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.leaveSources.delete(id); this.destroyNow(); done(); return GLib.SOURCE_REMOVE; });
            this.leaveSources.add(id);
        };
        if (!this.content.mapped) { finish(); return; }
        let left = false;
        const once = () => { if (!left) { left = true; finish(); } };
        this.content.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: 220, mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: once});
        // Should Clutter never report the end, it leaves anyway.
        const guard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => { this.leaveSources.delete(guard); once(); return GLib.SOURCE_REMOVE; });
        this.leaveSources.add(guard);
    }
    destroyNow() {
        for (const id of this.leaveSources) GLib.source_remove(id);
        this.leaveSources.clear();
        if (this.life.closed) return;
        this.life.dispose(); this.unplace?.(); this.unplace = null;
        this.spinner.remove_all_transitions(); this.ring.remove_all_transitions();
        this.button.destroy();
    }
}
