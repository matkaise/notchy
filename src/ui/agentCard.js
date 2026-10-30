import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {box, label, gicon} from './widgets.js';
import {Lifetime} from '../lifecycle.js';
import {PROVIDERS, stateText, viewState} from '../services/agentModel.js';
import {_, N_, fmt, ngettext, duration, formatPercent} from '../i18n/core.js';

// Ring colours per state (RGBA), as the indicators beside the notch draw them.
const COLOR = {working: [0.42, 0.71, 1, 1], waiting: [1, 0.62, 0.04, 1], error: [1, 0.27, 0.23, 1], completed: [0.2, 0.78, 0.35, 1]};
const RING = 64;
// Rings per row: as many as stand beside the agent's symbol in the card's width.
const PER_ROW = 3;
const MARK = {waiting: '?', completed: '✓', error: '!'};
// Short words under a ring (the card's rings are narrow).
const SHORT = {working: N_('Working'), waiting: N_('Waiting'), idle: N_('Ready'), completed: N_('Done'), error: N_('Error')};
const shortText = view => (SHORT[view] ? _(SHORT[view]) : stateText(view));

// An agent's card: a click on its indicator springs the notch open into it,
// as the AirPods card does — the agent's symbol large on the left, each of
// its sessions as a ring on the right (waiting, working, done but not seen
// yet, quiet), its project and state below; more sessions wrap into rows, and
// past about three rows those scroll. A click on a ring switches to
// that session's window when it can be named for sure. A session that waits
// for the user adds one line with two buttons, as the AirDrop question does;
// Notchy answers nothing itself. With several agents a small pill of their
// symbols at the foot switches between their cards.
//
// The card follows the agent service: a state changing updates the rings in
// place (the keyboard focus stays); only sessions coming or going rebuild it.
export function agentCard(island, provider) {
    const agents = island.agents, life = new Lifetime(), rings = new Map();
    const group = () => agents.providers().find(g => g.provider === provider) ?? null;
    const sessionsOf = g => (g?.sessions ?? []).filter(s => s.connected);
    const appIcon = () => agents.appIcon(provider) ?? gicon(PROVIDERS[provider]?.icon ?? 'notchy-agent-symbolic');
    const root = box(true, {style_class: 'notchy-peek notchy-agent-card', reactive: true});
    const title = label('', 'notchy-agent-card-title', {x_align: Clutter.ActorAlign.CENTER});
    const sub = label('', 'notchy-agent-card-sub', {x_align: Clutter.ActorAlign.CENTER});
    root.add_child(title); root.add_child(sub);
    const body = box(false, {style_class: 'notchy-agent-card-body', x_expand: true});
    const hero = new St.Icon({gicon: appIcon(), icon_size: 56, style_class: 'notchy-agent-card-hero', y_align: Clutter.ActorAlign.CENTER});
    const rows = box(true, {style_class: 'notchy-agent-card-grid', x_expand: true});
    const scroller = new St.ScrollView({style_class: 'notchy-scroll notchy-agent-card-scroll', x_expand: true, overlay_scrollbars: true});
    scroller.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC); scroller.set_child(rows);
    body.add_child(hero); body.add_child(scroller); root.add_child(body);
    const ringButtons = () => rows.get_children().flatMap(row => row.get_children());
    const rowAt = index => {
        const at = Math.floor(index / PER_ROW);
        if (at === rows.get_n_children()) rows.add_child(box(false, {style_class: 'notchy-agent-card-rings', x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
        return rows.get_child_at_index(at);
    };
    // The keyboard scrolls along: the focused ring's row stays in view.
    const reveal = button => {
        const row = button.get_parent(), adjustment = scroller.vadjustment, [, y] = row.get_position(), height = row.height;
        if (y < adjustment.value) adjustment.value = y;
        else if (y + height > adjustment.value + adjustment.page_size) adjustment.value = y + height - adjustment.page_size;
    };
    // Needs you: what it waits for and where to answer.
    const ask = box(false, {style_class: 'notchy-agent-card-ask', visible: false});
    const askText = label('', 'notchy-agent-card-ask-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    askText.clutter_text.set_line_wrap(true); askText.clutter_text.ellipsize = 0;
    const later = new St.Button({style_class: 'notchy-button notchy-pill-button', label: _('Later'), can_focus: true, y_align: Clutter.ActorAlign.CENTER});
    const go = new St.Button({style_class: 'notchy-button notchy-pill-button notchy-agent-card-go', label: _('Go to Window'), can_focus: true, y_align: Clutter.ActorAlign.CENTER});
    later.connect('clicked', () => island.close());
    ask.add_child(askText); ask.add_child(later); ask.add_child(go);
    root.add_child(ask);
    // Several agents: their symbols in a pill, like the tab bar.
    const pill = box(false, {style_class: 'notchy-agent-card-switch', x_align: Clutter.ActorAlign.CENTER, visible: false});
    root.add_child(pill);
    let waitingSession = null, layout = '';

    const switchTo = session => {
        const window = session ? agents.window(session) : null;
        if (!window) { island.toast('dialog-information-symbolic', _('The agent’s window cannot be named for sure')); return; }
        agents.markSeen(session.provider, session.id);
        island.close(); Main.activateWindow(window);
    };
    go.connect('clicked', () => switchTo(waitingSession));

    const makeRing = () => {
        const button = new St.Button({style_class: 'notchy-agent-card-session', can_focus: true, track_hover: true, x_align: Clutter.ActorAlign.CENTER});
        const column = box(true, {x_align: Clutter.ActorAlign.CENTER});
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), width: RING, height: RING, x_align: Clutter.ActorAlign.CENTER});
        const area = new St.DrawingArea({width: RING, height: RING});
        // Working without a reported progress: a short arc turning (a transform, no repaints).
        const spinner = new St.DrawingArea({width: RING, height: RING, visible: false, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        const symbol = new St.Icon({icon_size: 22, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const mark = label('', 'notchy-agent-card-mark', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        for (const child of [area, spinner, symbol, mark]) stack.add_child(child);
        const project = label('', 'notchy-agent-card-project', {x_align: Clutter.ActorAlign.CENTER});
        const state = label('', 'notchy-agent-card-state', {x_align: Clutter.ActorAlign.CENTER});
        column.add_child(stack); column.add_child(project); column.add_child(state);
        button.set_child(column);
        const ring = {button, area, spinner, symbol, mark, project, state, session: null, view: 'idle', spinning: false};
        area.connect('repaint', () => {
            const cr = area.get_context(), [w, h] = area.get_surface_size(), r = Math.min(w, h) / 2 - 2.5;
            try {
                cr.setLineWidth(3); cr.setSourceRGBA(1, 1, 1, 0.14); cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI); cr.stroke();
                const color = COLOR[ring.view]; if (!color) return;
                cr.setSourceRGBA(...color); cr.setLineCap(Cairo.LineCap.ROUND);
                const progress = ring.view === 'working' ? ring.session?.progress : null;
                if (ring.view === 'working' && (progress === null || progress === undefined)) return;
                cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * (ring.view === 'working' ? Math.max(0.02, progress) : 1)); cr.stroke();
            } finally { cr.$dispose(); }
        });
        spinner.connect('repaint', () => {
            const cr = spinner.get_context(), [w, h] = spinner.get_surface_size(), r = Math.min(w, h) / 2 - 2.5;
            try { cr.setLineWidth(3); cr.setLineCap(Cairo.LineCap.ROUND); cr.setSourceRGBA(...COLOR.working); cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 0.45); cr.stroke(); } finally { cr.$dispose(); }
        });
        ring.spin = () => {
            if (!ring.spinning || !spinner.mapped || spinner.get_transition('rotation-angle-z')) return;
            spinner.rotation_angle_z = 0;
            spinner.ease({rotation_angle_z: 360, duration: 1400, mode: Clutter.AnimationMode.LINEAR, repeatCount: -1});
        };
        life.connect(spinner, 'notify::mapped', () => ring.spin());
        button.connect('clicked', () => switchTo(ring.session));
        button.connect('key-focus-in', () => reveal(button));
        return ring;
    };
    const time = session => {
        const now = Date.now(), view = viewState(session);
        if (view === 'completed') return session.unseen ? _('new') : duration(now - (session.completedAt || session.lastEvent || now));
        if (view === 'waiting') return duration(now - session.lastActivity);
        if (view === 'working') return duration(now - session.started);
        return duration(now - (session.lastEvent || session.started));
    };
    const updateRing = (ring, session) => {
        ring.session = session;
        const view = viewState(session), progress = view === 'working' ? session.progress : null, known = progress !== null && progress !== undefined;
        ring.view = view;
        const name = session.project || fmt(_('Session %s'), session.id.length > 18 ? session.id.slice(0, 8) : session.id);
        if (ring.project.text !== name) ring.project.text = name;
        const words = `${shortText(view)} · ${time(session)}`;
        if (ring.state.text !== words) ring.state.text = words;
        ring.button.set_style_class_name(`notchy-agent-card-session ${view}`);
        ring.button.accessible_name = `${name}: ${stateText(view)}`;
        // In the middle: ?, ✓ or !, a real percentage, else the agent's symbol (dim while quiet).
        const mark = MARK[view] ?? (known ? formatPercent(Math.round(progress * 100)) : '');
        ring.mark.text = mark; ring.mark.visible = Boolean(mark);
        ring.mark.set_style_class_name(`notchy-agent-card-mark ${view}${known ? ' value' : ''}`);
        ring.symbol.visible = !mark;
        if (!mark && ring.symbol.notchyIcon !== provider) { ring.symbol.notchyIcon = provider; ring.symbol.gicon = appIcon(); }
        ring.symbol.opacity = view === 'idle' ? 110 : 255;
        const spinning = view === 'working' && !known;
        if (spinning !== ring.spinning) { ring.spinning = spinning; ring.spinner.visible = spinning; ring.spinner.remove_all_transitions(); ring.spinner.rotation_angle_z = 0; ring.spin(); }
        ring.area.queue_repaint();
    };
    const summary = g => {
        const sessions = sessionsOf(g), waiting = sessions.filter(s => viewState(s) === 'waiting').length, done = sessions.filter(s => viewState(s) === 'completed').length;
        const parts = [fmt(ngettext('%d session', '%d sessions', sessions.length), sessions.length)];
        if (waiting) parts.push(fmt(ngettext('%d waits for you', '%d wait for you', waiting), waiting));
        else if (done) parts.push(fmt(ngettext('%d finished', '%d finished', done), done));
        return parts.join(' · ');
    };
    const askFor = session => {
        const name = session.project || PROVIDERS[provider]?.name || provider, window = agents.window(session);
        const where = window ? _('confirm in its window') : _('answer where it runs');
        if (session.note === 'permission' && session.tool) return fmt(_('%1$s wants to run %2$s – %3$s.'), name, session.tool, where);
        if (session.note === 'question') return fmt(_('%1$s has a question for you – %2$s.'), name, where);
        return fmt(_('%1$s waits for you – %2$s.'), name, where);
    };
    const update = () => {
        if (life.closed) return;
        const g = group(), sessions = sessionsOf(g), all = agents.providers().filter(x => sessionsOf(x).length);
        // Gone: the card closes; sessions or agents coming or going: it is built anew.
        if (!sessions.length) { life.later(0, () => { if (island.peekKind === 'agent' && island.agentCardProvider === provider) island.close(); }); return; }
        const key = `${sessions.map(s => `${s.id}:${s.generation}`).join('|')}#${all.map(x => x.provider).join('|')}`;
        if (layout && key !== layout) { life.later(0, () => { if (island.peekKind === 'agent' && island.agentCardProvider === provider) island.showAgentCard(provider, {focus: false}); }); return; }
        layout = key;
        title.text = g.name; sub.text = summary(g);
        sessions.forEach((session, index) => {
            let ring = rings.get(session.id);
            if (!ring) { ring = makeRing(); rings.set(session.id, ring); rowAt(index).add_child(ring.button); }
            updateRing(ring, session);
        });
        waitingSession = sessions.find(s => viewState(s) === 'waiting') ?? null;
        ask.visible = Boolean(waitingSession);
        if (waitingSession) { askText.text = askFor(waitingSession); go.visible = Boolean(agents.window(waitingSession)); }
        if (!pill.get_n_children() && all.length > 1) {
            for (const other of all) {
                const icon = new St.Icon({gicon: agents.appIcon(other.provider) ?? gicon(PROVIDERS[other.provider]?.icon ?? 'notchy-agent-symbolic'), icon_size: 14});
                const dot = new St.Widget({style_class: `notchy-agent-card-dot ${other.state}`, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START});
                const content = new St.Widget({layout_manager: new Clutter.BinLayout(), width: 46, height: 28});
                const center = new St.Bin({child: icon, x_expand: true, y_expand: true});
                content.add_child(center); content.add_child(dot);
                const b = new St.Button({style_class: `notchy-tab${other.provider === provider ? ' active' : ''}`, child: content, can_focus: true, accessible_name: `${other.name}: ${stateText(other.state)}`});
                b.notchyDot = dot; b.notchyProvider = other.provider;
                b.connect('clicked', () => { if (other.provider !== provider) island.showAgentCard(other.provider); });
                pill.add_child(b);
            }
        }
        for (const b of pill.get_children()) { const other = all.find(x => x.provider === b.notchyProvider); if (other) b.notchyDot.set_style_class_name(`notchy-agent-card-dot ${other.state}`); }
        pill.visible = all.length > 1;
    };
    life.cleanups.push(agents.subscribe(update));
    // Running times move on while the card is open.
    life.every(1000, () => { for (const ring of rings.values()) if (ring.session) updateRing(ring, ring.session); });
    root.connect('destroy', () => life.dispose());
    update();
    // Arrows move between the rings, up and down by a row; Enter switches; Esc closes (the island).
    island.views.keyPress = event => {
        const key = event.get_key_symbol(), buttons = [...ringButtons(), ...(ask.visible ? [later, go].filter(b => b.visible) : []), ...pill.get_children()];
        const at = buttons.findIndex(b => b.has_key_focus());
        if (key === Clutter.KEY_Right || key === Clutter.KEY_Left) {
            const next = buttons[Math.max(0, Math.min(buttons.length - 1, (at < 0 ? -1 : at) + (key === Clutter.KEY_Right ? 1 : -1)))];
            next?.grab_key_focus(); return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            const count = ringButtons().length, target = (at < 0 ? 0 : at) + (key === Clutter.KEY_Down ? PER_ROW : -PER_ROW);
            if (at < count && target >= 0) buttons[Math.min(target, count - 1)]?.grab_key_focus();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    };
    return {actor: root, provider, rings, ask, go, pill,
        // The most urgent session takes the keyboard (the rings are sorted by urgency).
        focus: () => ringButtons()[0]?.grab_key_focus()};
}
