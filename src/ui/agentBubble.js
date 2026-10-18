import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {box, label, gicon} from './widgets.js';
import {Lifetime} from '../lifecycle.js';
import {PROVIDERS, stateText, shownState} from '../services/agentModel.js';

// Ring colours per state (RGBA).
const COLOR = {working: [0.42, 0.71, 1, 1], waiting: [1, 0.62, 0.04, 1], error: [1, 0.27, 0.23, 1], completed: [0.2, 0.78, 0.35, 1], idle: [1, 1, 1, 0.22], disconnected: [1, 1, 1, 0.12]};

// A running time as "12 s", "4 Min.", "1 Std. 5 Min.".
export function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} Min.`;
    return `${Math.floor(minutes / 60)} Std. ${minutes % 60} Min.`;
}

// The agents beside the notch: one indicator per agent (Claude Code, Codex,
// Antigravity, or whatever reports over notchyctl/MCP), its sessions in its
// popup. Indicators come and go with their sessions; their side is the
// island's SideIndicators' choice.
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
        this.group = null; this.rows = new Map(); this.leaving = false;
        const name = PROVIDERS[provider]?.name ?? provider;
        this.button = new PanelMenu.Button(0.5, name, false);
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
        this.button.menu.box.add_style_class_name('notchy-agent-menu');
        Main.panel.menuManager.addMenu(this.button.menu);
        this.buildMenu(name);
        this.unplace = island.sides.add({id: `agent:${provider}`, actor: this.button.container, priority: () => this.group?.priority ?? 1,
            preferred: () => this.preferredSide, wanted: () => !this.leaving && Boolean(this.group), summary: () => this.summary()});
        this.life.connect(this.button.menu, 'open-state-changed', (_m, open) => {
            this.life.cancel(this.clock); this.clock = 0;
            if (open) { this.updateRows(); this.clock = this.life.every(1000, () => this.updateRows()); }
        });
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
        return ['left', 'right'].includes(sides[this.provider]) ? sides[this.provider] : null;
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
        this.button.accessible_name = `${name}: ${stateText(state)}${count > 1 ? `, ${count} Sitzungen` : ''}`;
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
        const badge = state === 'completed' ? '✓' : state === 'error' ? '!' : state === 'waiting' && count <= 1 ? '?' : count > 1 ? String(count) : '';
        this.badge.text = badge; this.badge.visible = Boolean(badge);
        this.badge.set_style_class_name(`notchy-agent-badge${['waiting', 'error', 'completed'].includes(state) ? ` ${state}` : ''}`);
        this.ring.queue_repaint(); this.spinner.queue_repaint();
        this.syncMenu();
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
    // The popup: a head with the agent and its state, then one row per session.
    // Rows are kept per session and updated in place; only a session that
    // comes or goes adds or removes a row.
    buildMenu(name) {
        const menu = this.button.menu;
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const column = box(true, {x_expand: true});
        this.menuTitle = label(name, 'notchy-agent-menu-title'); this.menuSub = label('', 'notchy-agent-menu-sub');
        column.add_child(this.menuTitle); column.add_child(this.menuSub);
        head.add_child(column); menu.addMenuItem(head);
        this.rowSection = new PopupMenu.PopupMenuSection(); menu.addMenuItem(this.rowSection);
    }
    syncMenu() {
        const group = this.group; if (!group) return;
        const live = group.sessions.filter(s => s.connected).length;
        this.menuSub.text = `${stateText(group.state)}${live > 1 ? ` · ${live} Sitzungen` : ''}`;
        const ids = new Set(group.sessions.map(s => s.id));
        for (const [id, row] of this.rows) if (!ids.has(id)) { row.item.destroy(); this.rows.delete(id); }
        group.sessions.forEach((session, index) => {
            let row = this.rows.get(session.id);
            if (!row) { row = this.row(session); this.rows.set(session.id, row); this.rowSection.addMenuItem(row.item, index); }
            else if (this.rowSection.box.get_child_at_index(index) !== row.item) this.rowSection.box.set_child_at_index(row.item, index);
            row.session = session;
        });
        this.updateRows();
    }
    row(session) {
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'notchy-agent-row', can_focus: true});
        const dot = new St.Widget({style_class: 'notchy-agent-dot', y_align: Clutter.ActorAlign.CENTER});
        const column = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label('', 'notchy-agent-row-title'), sub = label('', 'notchy-agent-row-sub');
        const progress = new St.Widget({style_class: 'notchy-agent-progress', x_expand: true, visible: false});
        const fill = new St.Widget({style_class: 'notchy-agent-progress-fill'}); progress.add_child(fill);
        column.add_child(title); column.add_child(sub); column.add_child(progress);
        const time = label('', 'notchy-agent-row-time', {y_align: Clutter.ActorAlign.CENTER});
        const go = new St.Button({style_class: 'notchy-agent-switch', label: 'Wechseln', can_focus: true, y_align: Clutter.ActorAlign.CENTER, visible: false, accessible_name: 'Zum Agenten wechseln'});
        for (const child of [dot, column, time, go]) item.add_child(child);
        const row = {item, dot, title, sub, progress, fill, time, go, session};
        const jump = () => { const window = this.agents.window(row.session); if (window) { Main.activateWindow(window); this.button.menu.close(); } };
        go.connect('clicked', jump);
        item.connect('activate', jump);
        return row;
    }
    updateRows() {
        const now = Date.now();
        for (const row of this.rows.values()) {
            const {session} = row, state = shownState(session);
            row.dot.set_style_class_name(`notchy-agent-dot ${state}`);
            const title = session.project || (session.id.length > 18 ? `Sitzung ${session.id.slice(0, 8)}` : `Sitzung ${session.id}`);
            if (row.title.text !== title) row.title.text = title;
            const sub = [stateText(state), session.status].filter(Boolean).join(' · ');
            if (row.sub.text !== sub) row.sub.text = sub;
            row.time.text = duration(now - session.started);
            // Real progress only; no invented numbers.
            const known = session.progress !== null && session.progress !== undefined && state === 'working';
            row.progress.visible = known;
            if (known) row.fill.width = Math.round(Math.max(0, Math.min(1, session.progress)) * Math.max(1, row.progress.width || 200));
            // „Zum Agenten wechseln“ only when its window is known for sure.
            const window = this.button.menu.isOpen ? this.agents.window(session) : null;
            row.go.visible = Boolean(window);
            row.item.reactive = Boolean(window);
        }
    }
    summary() {
        const group = this.group; if (!group) return [];
        return group.sessions.filter(s => s.connected).map(session => ({title: `${group.name}${session.project ? ` · ${session.project}` : ''}`, subtitle: [stateText(shownState(session)), session.status].filter(Boolean).join(' · '),
            icon: this.icon.gicon, activate: this.agents.window(session) ? () => Main.activateWindow(this.agents.window(session)) : null}));
    }
    // Leaving: the indicator fades and shrinks, then gives up its place.
    leave(done) {
        if (this.leaving) return;
        this.leaving = true; this.button.menu.close();
        // Destroyed only after the transition has finished with the actor.
        const finish = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.destroyNow(); done(); return GLib.SOURCE_REMOVE; });
        if (!this.content.mapped) { finish(); return; }
        let left = false;
        const once = () => { if (!left) { left = true; finish(); } };
        this.content.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: 220, mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: once});
        // Should Clutter never report the end, it leaves anyway.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => { once(); return GLib.SOURCE_REMOVE; });
    }
    destroyNow() {
        if (this.life.closed) return;
        this.life.dispose(); this.unplace?.(); this.unplace = null;
        this.spinner.remove_all_transitions(); this.ring.remove_all_transitions();
        this.button.destroy();
    }
}
