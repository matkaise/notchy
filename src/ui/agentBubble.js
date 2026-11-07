import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {box, label, gicon} from './widgets.js';
import {Lifetime} from '../lifecycle.js';
import {PROVIDERS, stateText, viewState, statusText, toolKind} from '../services/agentModel.js';
import {fmt, ngettext, duration, formatPercent} from '../i18n/core.js';

// Agents whose symbol is a spark that turns while a tool runs (as Nosy Notch's
// does); the others breathe instead, a turning terminal or triangle reads oddly.
const SPINS = new Set(['claude']);
// The agent's own symbol, coloured by CSS (.notchy-agent-glyph.<provider> / .<state>).
export const agentGlyph = provider => gicon(PROVIDERS[provider]?.icon ?? 'notchy-agent-symbolic');
// The symbol of what a tool does (src/icons/notchy-tool-*-symbolic.svg).
export const toolGlyph = tool => gicon(`notchy-tool-${toolKind(tool) || 'tool'}-symbolic`);
// A running clock: "0:41", "12:05", "1:02:09".
export function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// A running time ("12 s", "4 min", "1 h 5 min"), in the interface language.
export {duration};

// The agents beside the notch: one indicator per agent (Claude Code, Codex,
// Antigravity, or whatever reports over notchyctl/MCP). Quiet, it is a round
// symbol in the agent's colour; working, it grows a wing — the symbol turning
// or breathing, beside it what the tool does and how long the task runs (or
// three bouncing dots while it thinks); waiting, it glows amber with a waving
// hand. A click opens the list of all sessions (src/ui/agentCard.js).
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
        this.group = null; this.leaving = false; this.leaveSources = new Set(); this.motion = ''; this.ticking = 0; this.waving = 0;
        const name = PROVIDERS[provider]?.name ?? provider;
        // No popup menu of its own: a click opens the agent list from the notch.
        this.button = new PanelMenu.Button(0.5, name, true);
        this.button.add_style_class_name('notchy-side-button');
        this.button.add_style_class_name('notchy-agent-bubble-button');
        this.content = new St.Widget({style_class: 'notchy-agent-bubble', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this.pill = box(false, {style_class: 'notchy-agent-pill', x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.glyph = new St.Icon({gicon: agentGlyph(provider), icon_size: 14, style_class: 'notchy-agent-glyph', y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this.icon = this.glyph;
        // The wing: what the tool does and the task's time, three dots, or a hand.
        this.wing = box(false, {style_class: 'notchy-agent-wing', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this.tool = new St.Icon({icon_size: 12, style_class: 'notchy-agent-tool', y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 1})});
        this.time = label('', 'notchy-agent-time', {y_align: Clutter.ActorAlign.CENTER});
        this.dots = box(false, {style_class: 'notchy-agent-dots', y_align: Clutter.ActorAlign.CENTER, visible: false});
        for (let i = 0; i < 3; i++) this.dots.add_child(new St.Widget({style_class: 'notchy-agent-dot', y_align: Clutter.ActorAlign.CENTER}));
        for (const child of [this.tool, this.time, this.dots]) this.wing.add_child(child);
        // How many sessions (or ! for a failure) sits in the pill, at its end: laid over
        // a wide pill it covered the dots.
        this.badge = label('', 'notchy-agent-badge', {y_align: Clutter.ActorAlign.CENTER, visible: false});
        this.pill.add_child(this.glyph); this.pill.add_child(this.wing); this.pill.add_child(this.badge);
        // Done but not seen yet: a green dot that breathes.
        this.unseen = new St.Widget({style_class: 'notchy-agent-unseen', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, visible: false});
        for (const child of [this.pill, this.unseen]) this.content.add_child(child);
        this.button.add_child(this.content);
        const open = () => { this.island.showAgentCard(this.provider); return Clutter.EVENT_STOP; };
        this.life.connect(this.button, 'button-press-event', (_a, event) => (event.get_button() === Clutter.BUTTON_PRIMARY ? open() : Clutter.EVENT_PROPAGATE));
        this.life.connect(this.button, 'key-press-event', (_a, event) => ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(event.get_key_symbol()) ? open() : Clutter.EVENT_PROPAGATE));
        this.unplace = island.sides.add({id: `agent:${provider}`, actor: this.button.container, priority: () => this.group?.priority ?? 1,
            preferred: () => this.preferredSide, wanted: () => !this.leaving && Boolean(this.group), summary: () => this.summary()});
        this.life.connect(this.settings, 'changed', (_s, key) => { if (key === 'style' || key.startsWith('agents-')) this.style(); });
        // The wing grows and shrinks (dots, a tool and its time, a longer time): the sides plan
        // again. Its own wish counts, not its allocation — a side too narrow would just clip it.
        this.wished = 0;
        this.life.connect(this.content, 'notify::mapped', () => this.remeasure());
        this.life.connect(this.content, 'notify::width', () => { this.island.sides.queue(); this.remeasure(); });
        // Clutter skips animations of actors not on screen: the motion starts once mapped.
        this.life.connect(this.content, 'notify::mapped', () => { if (this.content.mapped) this.animate(true); });
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
        const state = this.group?.state ?? 'idle', winged = this.winged;
        this.content.set_style_class_name(`notchy-agent-bubble notchy-${this.settings.get_string('style')} notchy-agent-${state}${winged ? ' winged' : ''}`);
        this.glyph.set_style_class_name(`notchy-agent-glyph ${this.provider} ${state}`);
        const size = Math.max(22, Main.panel.height - (this.settings.get_string('style') === 'liquid' ? 6 : 4));
        this.content.height = size; this.content.width = winged ? -1 : size;
        this.pill.style = winged ? `padding: 0 ${Math.round(size * 0.32)}px 0 ${Math.round(size * 0.24)}px;` : null;
    }
    // The primary session: the most urgent live one (the registry sorts them).
    get primary() { return this.group?.sessions.find(s => s.connected) ?? null; }
    // Working or waiting (its wing), or a count or ! beside the symbol: a pill; else the round symbol.
    get winged() { return ['working', 'waiting'].includes(this.group?.state) || Boolean(this.badge?.visible); }
    update(group) {
        const previous = this.group?.state, wasWinged = this.winged;
        this.group = group;
        const {state, count, progress, name} = group, session = this.primary;
        this.button.accessible_name = count > 1 ? fmt(ngettext('%1$s: %2$s, %3$d session', '%1$s: %2$s, %3$d sessions', count), name, stateText(state), count) : `${name}: ${stateText(state)}`;
        // The wing: a tool's symbol and the task's time, a real progress, three dots while thinking, a hand while waiting.
        const tool = state === 'working' && session?.tool ? session.tool : '';
        this.wing.visible = ['working', 'waiting'].includes(state);
        this.dots.visible = state === 'working' && !tool && (progress === null || progress === undefined);
        this.tool.visible = state === 'waiting' || Boolean(tool);
        if (state === 'waiting') { this.tool.gicon = gicon('notchy-hand-symbolic'); this.tool.set_style_class_name('notchy-agent-tool hand'); }
        else if (tool) { this.tool.gicon = toolGlyph(tool); this.tool.set_style_class_name('notchy-agent-tool'); }
        this.time.visible = state === 'working' && !this.dots.visible;
        this.tick();
        // A count of sessions, or ! for a failed task; done and not seen: the green dot.
        const badge = state === 'error' ? '!' : count > 1 && state !== 'completed' ? String(count) : '';
        this.badge.text = badge; this.badge.visible = Boolean(badge);
        this.badge.set_style_class_name(`notchy-agent-badge${state === 'error' ? ' error' : ''}`);
        this.unseen.visible = state === 'completed' && group.unseen > 0;
        this.style();
        this.animate(previous !== state);
        if (previous !== state || wasWinged !== this.winged) this.island.sides.queue();
        this.remeasure();
    }
    remeasure() {
        if (this.life.closed || !this.content.get_stage()) return;
        const wished = this.content.get_preferred_width(-1)[1];
        if (Math.abs(wished - this.wished) < 0.5) return;
        this.wished = wished; this.island.sides.queue();
    }
    // The running time (or a real progress) beside the tool, every second while it works.
    tick() {
        const session = this.primary, working = this.group?.state === 'working';
        const progress = this.group?.progress;
        if (working && progress !== null && progress !== undefined) this.time.text = formatPercent(Math.round(progress * 100));
        else if (working && session) this.time.text = clock(Date.now() - (session.turnStarted || session.lastActivity || session.started));
        if (this.ticking) this.remeasure();
        const wanted = working && this.time.visible;
        if (wanted && !this.ticking) this.ticking = this.life.every(1000, () => this.tick());
        else if (!wanted && this.ticking) { this.life.cancel(this.ticking); this.ticking = 0; }
    }
    // The symbol's motion: turning (a spark with a tool), breathing (thinking,
    // or an agent whose symbol does not turn), dots bouncing, the hand waving.
    animate(restart = false) {
        if (this.life.closed) return;
        const state = this.group?.state, tool = this.primary?.tool;
        const motion = state === 'working' ? (SPINS.has(this.provider) && tool ? 'spin' : 'breathe') : state === 'waiting' ? 'wave' : '';
        // (Dots appearing or going while it keeps thinking restart the motion too.)
        const key = `${motion}:${this.dots.visible}`;
        if (!restart && key === this.motion && (this.content.mapped ? this.moving : true)) return;
        this.motion = key; this.moving = false;
        this.glyph.remove_all_transitions(); this.glyph.rotation_angle_z = 0; this.glyph.scale_x = this.glyph.scale_y = 1; this.glyph.opacity = 255;
        this.tool.remove_all_transitions(); this.tool.rotation_angle_z = 0;
        for (const dot of this.dots.get_children()) { dot.remove_all_transitions(); dot.translation_y = 0; }
        this.life.cancel(this.waving); this.waving = 0;
        if (!motion || !this.content.mapped) return;
        this.moving = true;
        if (motion === 'spin') this.glyph.ease({rotation_angle_z: 360, duration: 1100, mode: Clutter.AnimationMode.LINEAR, repeatCount: -1});
        if (motion === 'breathe') {
            this.glyph.scale_x = this.glyph.scale_y = 0.82; this.glyph.opacity = 190;
            this.glyph.ease({scale_x: 1.06, scale_y: 1.06, opacity: 255, duration: 700, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
        }
        if (motion === 'breathe' && this.dots.visible)
            this.dots.get_children().forEach((dot, i) => dot.ease({translation_y: -3, duration: 280, delay: i * 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD, repeatCount: -1, autoReverse: true}));
        if (motion === 'wave') {
            // A quick wiggle every few seconds, as a hand waves.
            const wave = () => { this.tool.remove_all_transitions(); this.tool.rotation_angle_z = -14; this.tool.ease({rotation_angle_z: 14, duration: 110, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: 5, autoReverse: true, onStopped: () => { this.tool.rotation_angle_z = 0; }}); };
            wave(); this.waving = this.life.every(2600, wave);
        }
    }
    // A finished task: a short bounce (when enabled), then it turns idle by itself.
    transition(event) {
        if (event.type !== 'completed' || !this.settings.get_boolean('agents-completion-animation')) return;
        this.content.remove_transition('scale-x'); this.content.remove_transition('scale-y');
        this.content.scale_x = this.content.scale_y = 1.22;
        this.settle(this.content, {scale_x: 1, scale_y: 1}, 420, Clutter.AnimationMode.EASE_OUT_BACK);
        // The green dot breathes while nobody looked.
        this.unseen.remove_all_transitions(); this.unseen.opacity = 255;
        this.unseen.ease({opacity: 120, duration: 1400, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
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
        for (const actor of [this.glyph, this.tool, this.unseen, ...this.dots.get_children()]) actor.remove_all_transitions();
        this.button.destroy();
    }
}
