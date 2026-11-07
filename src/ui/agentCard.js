import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {box, label, gicon} from './widgets.js';
import {agentGlyph, toolGlyph, clock} from './agentBubble.js';
import {Lifetime} from '../lifecycle.js';
import {PROVIDERS, PRIORITY, providerName, statusText, viewState, activityText} from '../services/agentModel.js';
import {_, fmt, ngettext, duration, relativeTime, formatPercent} from '../i18n/core.js';

// Rows visible before the list scrolls.
const VISIBLE_ROWS = 4;
// A limit's bar shows what is left, as Codex does: green, amber below 40 %, red below 15 %.
const meterClass = used => (used >= 85 ? 'high' : used >= 60 ? 'mid' : 'low');
const SPINS = new Set(['claude']);

// The agent list: a click on an agent's indicator opens the notch into it,
// as Nosy Notch's hover list — every session of every agent, the most urgent
// first. A row: the agent's symbol in its state's colour, the project, a small
// label naming the agent, what it does in colour (pulsing while it works) and,
// below, what its tool works on in monospace (the masked line from the hook,
// or the tool's name with „Befehle anzeigen“ off); the task's running time on
// the right. A click switches to the session's window when it can be named
// for sure; ✕ on a quiet row hides that session. Past four rows the list
// scrolls. At its foot the 5-hour and weekly limits of Claude and Codex, as
// bars; hovering one tells when it resets.
//
// The list follows the agent service: states and times change in place (the
// keyboard focus stays); sessions coming, going or reordering rebuild it.
export function agentCard(island, provider) {
    const agents = island.agents, life = new Lifetime(), rows = new Map();
    const sessionsNow = () => agents.providers().flatMap(group => group.sessions.filter(s => s.connected))
        .sort((a, b) => PRIORITY[viewState(b)] - PRIORITY[viewState(a)] || b.lastActivity - a.lastActivity);
    const keyOf = session => `${session.provider}\u0000${session.id}`;
    const root = box(true, {style_class: 'notchy-peek notchy-agent-list', reactive: true});
    const head = box(false, {style_class: 'notchy-agent-list-head'});
    const title = label(_('Agents'), 'notchy-agent-list-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const count = label('', 'notchy-agent-list-count', {y_align: Clutter.ActorAlign.CENTER});
    head.add_child(title); head.add_child(count); root.add_child(head);
    const list = box(true, {style_class: 'notchy-agent-list-rows', x_expand: true});
    const scroller = new St.ScrollView({style_class: 'notchy-scroll notchy-agent-list-scroll', x_expand: true, overlay_scrollbars: true});
    scroller.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC); scroller.set_child(list);
    root.add_child(scroller);
    const more = label('', 'notchy-agent-list-more', {x_align: Clutter.ActorAlign.CENTER, visible: false});
    root.add_child(more);
    const limits = box(true, {style_class: 'notchy-agent-limits', visible: false});
    root.add_child(limits);
    let layout = '', meters = [], usageKey = '';

    const switchTo = session => {
        const window = session ? agents.window(session) : null;
        if (!window) { island.toast('dialog-information-symbolic', _('The agent’s window cannot be named for sure')); return; }
        agents.markSeen(session.provider, session.id);
        island.close(); Main.activateWindow(window);
    };
    // The keyboard scrolls along: the focused row stays in view.
    const reveal = actor => {
        const adjustment = scroller.vadjustment, [, y] = actor.get_position(), height = actor.height;
        if (y < adjustment.value) adjustment.value = y;
        else if (y + height > adjustment.value + adjustment.page_size) adjustment.value = y + height - adjustment.page_size;
    };

    const makeRow = () => {
        const button = new St.Button({style_class: 'notchy-agent-row', can_focus: true, track_hover: true, x_expand: true});
        const line = box(false, {x_expand: true, style_class: 'notchy-agent-row-box'});
        const mark = new St.Widget({layout_manager: new Clutter.BinLayout(), width: 22, height: 22, y_align: Clutter.ActorAlign.CENTER});
        const glyph = new St.Icon({icon_size: 18, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        const unseen = new St.Widget({style_class: 'notchy-agent-unseen small', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, visible: false});
        mark.add_child(glyph); mark.add_child(unseen);
        const text = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'notchy-agent-row-text'});
        const top = box(false, {style_class: 'notchy-agent-row-top'});
        const project = label('', 'notchy-agent-row-project', {y_align: Clutter.ActorAlign.CENTER});
        const tag = label('', 'notchy-agent-tag', {y_align: Clutter.ActorAlign.CENTER});
        const state = label('', 'notchy-agent-row-state', {y_align: Clutter.ActorAlign.CENTER});
        top.add_child(project); top.add_child(tag); top.add_child(state);
        const bottom = box(false, {style_class: 'notchy-agent-row-detail'});
        const tool = new St.Icon({icon_size: 11, style_class: 'notchy-agent-row-tool', y_align: Clutter.ActorAlign.CENTER});
        const detail = label('', 'notchy-agent-row-command', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        detail.clutter_text.ellipsize = 2; // The middle of a long command goes first (Pango.EllipsizeMode.MIDDLE).
        bottom.add_child(tool); bottom.add_child(detail);
        text.add_child(top); text.add_child(bottom);
        const time = label('', 'notchy-agent-row-time', {y_align: Clutter.ActorAlign.CENTER});
        const close = new St.Button({style_class: 'notchy-agent-row-close', can_focus: false, y_align: Clutter.ActorAlign.CENTER, visible: false, accessible_name: _('Hide Session'),
            child: new St.Icon({gicon: gicon('window-close-symbolic'), icon_size: 9})});
        for (const child of [mark, text, time, close]) line.add_child(child);
        button.set_child(line);
        const row = {button, glyph, unseen, project, tag, state, bottom, tool, detail, time, close, session: null, view: '', motion: ''};
        button.connect('clicked', () => switchTo(row.session));
        close.connect('clicked', () => { const s = row.session; if (s) agents.end(s.provider, s.id); });
        button.connect('notify::hover', () => updateRow(row, row.session));
        button.connect('key-focus-in', () => reveal(button));
        return row;
    };
    // The symbol's motion, as on the indicator: turning, breathing, still.
    const move = (row, motion) => {
        if (row.motion === motion && (row.glyph.mapped ? row.moving : true)) return;
        row.motion = motion; row.moving = false;
        row.glyph.remove_all_transitions(); row.glyph.rotation_angle_z = 0; row.glyph.scale_x = row.glyph.scale_y = 1;
        row.state.remove_all_transitions(); row.state.opacity = 255;
        if (!motion || !row.glyph.mapped) return;
        row.moving = true;
        if (motion === 'spin') row.glyph.ease({rotation_angle_z: 360, duration: 1100, mode: Clutter.AnimationMode.LINEAR, repeatCount: -1});
        else row.glyph.ease({scale_x: 0.84, scale_y: 0.84, duration: 700, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
        // The state's word pulses while the agent works (Nosy Notch's shimmer).
        row.state.ease({opacity: 140, duration: 900, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
    };
    // Below the project: what the tool works on, what it waits for, how the task went.
    const detailOf = (session, view) => {
        if (view === 'working' && session.tool) return session.detail || session.tool;
        if (view === 'waiting') return session.detail || statusText(session) || _('Needs you');
        if (view === 'completed') {
            const parts = [];
            if (session.toolCount) parts.push(fmt(ngettext('%d tool call', '%d tool calls', session.toolCount), session.toolCount));
            if (session.lastTurnMs >= 1000) parts.push(clock(session.lastTurnMs));
            return parts.join(' · ');
        }
        if (view === 'error') return statusText(session);
        return statusText(session);
    };
    const updateRow = (row, session) => {
        if (!session) return;
        row.session = session;
        const now = Date.now(), view = viewState(session), name = session.project || providerName(session.provider);
        row.view = view;
        row.button.set_style_class_name(`notchy-agent-row ${view}`);
        row.glyph.set_style_class_name(`notchy-agent-glyph ${session.provider} ${view}`);
        if (row.glyph.notchyProvider !== session.provider) { row.glyph.notchyProvider = session.provider; row.glyph.gicon = agentGlyph(session.provider); }
        row.unseen.visible = view === 'completed' && session.unseen;
        if (row.project.text !== name) row.project.text = name;
        row.tag.text = PROVIDERS[session.provider]?.name.split(' ')[0] ?? providerName(session.provider);
        row.tag.set_style_class_name(`notchy-agent-tag ${session.provider}`);
        row.state.text = activityText(session);
        row.state.set_style_class_name(`notchy-agent-row-state ${view} ${session.provider}`);
        const detail = detailOf(session, view);
        row.detail.text = detail; row.bottom.visible = Boolean(detail);
        const tool = (view === 'working' || view === 'waiting') && session.tool;
        row.tool.visible = Boolean(tool);
        if (tool && row.tool.notchyTool !== session.tool) { row.tool.notchyTool = session.tool; row.tool.gicon = toolGlyph(session.tool); }
        row.time.text = view === 'working' ? clock(now - (session.turnStarted || session.lastActivity))
            : view === 'waiting' ? clock(now - session.lastActivity)
                : view === 'completed' && session.completedAt ? relativeTime(session.completedAt, now) : '';
        // ✕ on a quiet row under the pointer: working or waiting ones stay.
        const closable = !['working', 'waiting'].includes(view);
        row.close.visible = closable && row.button.hover; row.time.visible = !row.close.visible;
        row.button.accessible_name = [name, providerName(session.provider), activityText(session), detail].filter(Boolean).join(', ');
        move(row, view === 'working' ? (SPINS.has(session.provider) && session.tool ? 'spin' : 'breathe') : '');
    };

    // The limits at the foot: per agent its 5-hour and weekly window.
    const meter = (labelText, window) => {
        const actor = box(false, {style_class: 'notchy-agent-meter', x_expand: true, reactive: true, track_hover: true});
        const name = label(labelText, 'notchy-agent-meter-label', {y_align: Clutter.ActorAlign.CENTER});
        // (A row, so the fill always starts at the left; a bin centres it.)
        const track = box(false, {style_class: 'notchy-agent-meter-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const fill = new St.Widget({style_class: 'notchy-agent-meter-fill', x_expand: false});
        track.add_child(fill);
        const value = label('', 'notchy-agent-meter-value', {y_align: Clutter.ActorAlign.CENTER});
        actor.add_child(name); actor.add_child(track); actor.add_child(value);
        const m = {actor, track, fill, value, window};
        const draw = () => {
            const w = m.window;
            fill.visible = Boolean(w);
            // (Sizes only on the stage; its width arriving draws it again.)
            const left = w ? Math.max(0, 100 - w.used) : 0;
            if (w) { fill.set_style_class_name(`notchy-agent-meter-fill ${meterClass(w.used)}`); if (track.get_stage()) fill.width = Math.max(left > 0 ? 4 : 0, Math.round(track.width * left / 100)); }
            // Hovering a bar tells when it resets: "↻ 2 h 5 min".
            value.text = !w ? '–' : actor.get_stage() && actor.hover && w.resetsAt ? `↻ ${duration(w.resetsAt * 1000 - Date.now())}` : formatPercent(Math.round(left));
            actor.accessible_name = w ? fmt(_('%1$s: %2$s left'), labelText, formatPercent(Math.round(left))) : `${labelText}: –`;
        };
        m.draw = draw;
        track.connect('notify::width', draw); actor.connect('notify::hover', draw);
        draw();
        return m;
    };
    const drawLimits = usage => {
        limits.destroy_all_children(); meters = [];
        if (usage.length) limits.add_child(label(_('Usage left'), 'notchy-agent-limits-title'));
        for (const entry of usage) {
            const row = box(false, {style_class: 'notchy-agent-limit-row'});
            const tag = label(PROVIDERS[entry.provider]?.name.split(' ')[0] ?? entry.name, `notchy-agent-tag ${entry.provider}`, {y_align: Clutter.ActorAlign.CENTER});
            const tagBin = new St.Bin({child: tag, style_class: 'notchy-agent-limit-name', x_align: Clutter.ActorAlign.START});
            row.add_child(tagBin);
            for (const [text, window] of [[_('5 h'), entry.fiveHour], [_('Week'), entry.week]]) { const m = meter(text, window); meters.push(m); row.add_child(m.actor); }
            limits.add_child(row);
        }
        limits.visible = usage.length > 0;
    };

    const update = () => {
        if (life.closed) return;
        const sessions = sessionsNow(), usage = agents.usageRows();
        // Gone: the list closes; sessions coming, going or reordering: it is built anew.
        if (!sessions.length) { life.later(0, () => { if (island.peekKind === 'agent' && island.agentCard?.actor === root) island.close(); }); return; }
        const key = sessions.map(s => `${keyOf(s)}:${s.generation}`).join('|');
        if (layout && key !== layout) { life.later(0, () => { if (island.peekKind === 'agent' && island.agentCard?.actor === root) island.showAgentCard(provider, {focus: false}); }); return; }
        const first = !layout;
        layout = key;
        sessions.forEach(session => {
            let row = rows.get(keyOf(session));
            if (!row) { row = makeRow(); rows.set(keyOf(session), row); list.add_child(row.button); }
            updateRow(row, session);
        });
        count.text = fmt(ngettext('%d session', '%d sessions', sessions.length), sessions.length);
        more.text = sessions.length > VISIBLE_ROWS ? fmt(ngettext('%d more · scroll', '%d more · scroll', sessions.length - VISIBLE_ROWS), sessions.length - VISIBLE_ROWS) : '';
        more.visible = sessions.length > VISIBLE_ROWS;
        // The limits arriving or going: only their block, and the notch follows its height (the keyboard stays).
        const usageNow = usage.map(u => u.provider).join('|');
        if (first || usageNow !== usageKey) { usageKey = usageNow; drawLimits(usage); if (!first) life.later(0, () => { if (island.agentCard?.actor === root) island.resizePeek(); }); }
        else for (const [i, entry] of usage.entries()) { if (meters[2 * i]) { meters[2 * i].window = entry.fiveHour; meters[2 * i + 1].window = entry.week; meters[2 * i].draw(); meters[2 * i + 1].draw(); } }
    };
    life.cleanups.push(agents.subscribe(update));
    // The limits as fresh as Codex's file while the list is open (read at most every 10 s).
    agents.readCodexUsage(); life.every(15000, () => agents.readCodexUsage());
    // Running times move on while the list is open; the glyphs start moving once on screen.
    life.every(1000, () => { for (const row of rows.values()) if (row.session) updateRow(row, row.session); for (const m of meters) m.draw(); });
    life.connect(root, 'notify::mapped', () => { if (root.mapped) for (const row of rows.values()) { row.motion = null; updateRow(row, row.session); } });
    root.connect('destroy', () => { for (const row of rows.values()) { row.glyph.remove_all_transitions(); row.state.remove_all_transitions(); } life.dispose(); });
    update();
    // Up and Down move between the rows, Enter switches, Esc closes (the island).
    island.views.keyPress = event => {
        const key = event.get_key_symbol(), buttons = list.get_children();
        if (key !== Clutter.KEY_Down && key !== Clutter.KEY_Up) return Clutter.EVENT_PROPAGATE;
        const at = buttons.findIndex(b => b.has_key_focus());
        buttons[Math.max(0, Math.min(buttons.length - 1, (at < 0 ? -1 : at) + (key === Clutter.KEY_Down ? 1 : -1)))]?.grab_key_focus();
        return Clutter.EVENT_STOP;
    };
    return {actor: root, provider, rows, limits, scroller, more, meters: () => meters,
        // Everything the list showed has been seen.
        seen: () => { for (const row of rows.values()) if (row.session?.unseen) agents.markSeen(row.session.provider, row.session.id); },
        // The clicked agent's most urgent session takes the keyboard.
        focus: () => ([...rows.values()].find(row => row.session?.provider === provider) ?? [...rows.values()][0])?.button.grab_key_focus()};
}
