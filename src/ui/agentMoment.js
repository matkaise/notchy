import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {box, label, gicon} from './widgets.js';
import {clock} from './agentBubble.js';
import {Lifetime} from '../lifecycle.js';
import {providerName, statusText, viewState} from '../services/agentModel.js';
import {_, fmt, ngettext} from '../i18n/core.js';

// Confetti colours: done green, amber, the agents' colours, white.
const CONFETTI = [[0.29, 0.87, 0.5], [0.96, 0.65, 0.14], [0.5, 0.67, 1], [0.85, 0.47, 0.34], [0.73, 0.64, 1], [1, 1, 1]];
const GREEN = [0.29, 0.87, 0.5];

// An agent's moment out of the notch, as Nosy Notch has them:
//   waiting    it needs you — an amber orb with a waving hand, the card shakes
//              once; agent, project, what it wants to run (the tool and its
//              masked line). Notchy answers nothing: „Zum Fenster“ brings the
//              agent's window forward, „Später“ folds the card away. It stays
//              until answered (then it closes by itself) or folded.
//   completed  a check draws itself, confetti flies; the project, the task's
//              time and how many tools it used. A click switches to it.
//   error      a red orb with a twitching warning sign and the reason.
// ✕ closes each. The island decides when one may show (src/ui/island.js agentMoment).
export function agentMoment(island, kind, session) {
    const agents = island.agents, life = new Lifetime(), name = providerName(session.provider);
    const root = new St.Widget({style_class: `notchy-peek notchy-agent-moment ${kind}`, layout_manager: new Clutter.BinLayout(), reactive: true});
    const column = box(true, {x_expand: true, style_class: 'notchy-agent-moment-column'});
    const main = box(false, {x_expand: true, style_class: 'notchy-agent-moment-main'});
    const orb = new St.Widget({style_class: `notchy-agent-orb ${kind}`, layout_manager: new Clutter.BinLayout(), width: 44, height: 44, y_align: Clutter.ActorAlign.CENTER});
    main.add_child(orb);
    const text = box(true, {x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'notchy-agent-moment-text'});
    const top = box(false, {style_class: 'notchy-agent-moment-top'});
    const heading = label('', 'notchy-agent-moment-title', {y_align: Clutter.ActorAlign.END});
    const project = label(session.project || '', `notchy-agent-moment-project ${kind}`, {y_align: Clutter.ActorAlign.END, visible: Boolean(session.project)});
    const took = label('', 'notchy-agent-moment-took', {y_align: Clutter.ActorAlign.END, visible: false});
    top.add_child(heading); top.add_child(project); top.add_child(took);
    const message = label('', 'notchy-agent-moment-message');
    message.clutter_text.set_line_wrap(true); message.clutter_text.ellipsize = 0;
    const command = label('', 'notchy-agent-moment-command', {x_align: Clutter.ActorAlign.START, visible: false});
    command.clutter_text.ellipsize = 2;
    text.add_child(top); text.add_child(message); text.add_child(command);
    main.add_child(text);
    column.add_child(main);
    const close = new St.Button({style_class: 'notchy-agent-moment-close', can_focus: true, accessible_name: _('Close'), x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true,
        child: new St.Icon({gicon: gicon('window-close-symbolic'), icon_size: 9})});
    close.connect('clicked', () => island.close());
    root.add_child(column); root.add_child(close);
    const window = agents.window(session);
    const toWindow = () => {
        const target = agents.window(session);
        agents.markSeen(session.provider, session.id);
        island.close();
        if (target) Main.activateWindow(target);
        else island.toast('dialog-information-symbolic', _('The agent’s window cannot be named for sure'));
    };
    let go = null;

    if (kind === 'waiting') {
        const hand = new St.Icon({gicon: gicon('notchy-hand-symbolic'), icon_size: 20, style_class: 'notchy-agent-orb-icon waiting', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 1})});
        orb.add_child(hand);
        heading.text = fmt(_('%s needs you'), name);
        message.text = session.note === 'question' ? _('has a question for you.') : session.tool ? fmt(_('wants to run %s.'), session.tool) : _('is waiting for your answer.');
        command.text = session.detail || ''; command.visible = Boolean(session.detail);
        const actions = box(false, {style_class: 'notchy-agent-moment-actions'});
        const hint = label(window ? _('or answer in its window') : _('answer where it runs'), 'notchy-agent-moment-hint', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const later = new St.Button({style_class: 'notchy-button notchy-pill-button', label: _('Later'), can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        later.connect('clicked', () => island.close());
        actions.add_child(hint); actions.add_child(later);
        if (window) {
            go = new St.Button({style_class: 'notchy-button notchy-pill-button notchy-agent-moment-go', label: _('Go to Window'), can_focus: true, y_align: Clutter.ActorAlign.CENTER});
            go.connect('clicked', toWindow);
            actions.add_child(go);
        }
        column.add_child(actions);
        // A quick wave every few seconds; the card shakes once as it opens.
        const wave = () => { hand.remove_all_transitions(); hand.rotation_angle_z = -14; hand.ease({rotation_angle_z: 14, duration: 110, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: 5, autoReverse: true, onStopped: () => { hand.rotation_angle_z = 0; }}); };
        const shake = (steps = [-7, 6, -4, 3, -1, 0]) => {
            if (!steps.length || life.closed) return;
            column.ease({translation_x: steps[0], duration: 70, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, onComplete: () => shake(steps.slice(1))});
        };
        whenMapped(root, life, () => { wave(); shake(); life.every(2600, wave); });
        // Answered (in the terminal, the app, anywhere): the card goes by itself.
        life.cleanups.push(agents.subscribe(() => {
            const now = agents.registry.get(session.provider, session.id);
            if ((!now || viewState(now) !== 'waiting') && island.peekKind === 'agent-moment' && island.peekView?.actor === root) life.later(0, () => island.close());
        }));
        root.connect('destroy', () => hand.remove_all_transitions());
    } else if (kind === 'completed') {
        const area = new St.DrawingArea({width: 120, height: 120, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        orb.add_child(area); orb.clip_to_allocation = false;
        heading.text = _('Done');
        if (session.lastTurnMs >= 1000) { took.text = `· ${clock(session.lastTurnMs)}`; took.visible = true; }
        const tools = session.toolCount ? `${fmt(ngettext('%d tool call', '%d tool calls', session.toolCount), session.toolCount)} – ` : '';
        message.text = tools + fmt(_('%s is waiting for your next message.'), name);
        // The check draws itself, then confetti bursts around it.
        const pieces = Array.from({length: 26}, (_x, i) => {
            const angle = Math.random() * Math.PI * 2;
            return {angle, reach: 28 + Math.random() * 30, spin: Math.random() * 9 - 4.5, color: CONFETTI[i % CONFETTI.length], delay: Math.random() * 0.1};
        });
        let progress = 0;
        area.connect('repaint', () => {
            const cr = area.get_context(), [w, h] = area.get_surface_size(), cx = w / 2, cy = h / 2;
            try {
                const ring = Math.min(1, progress / 0.45), tick = Math.max(0, Math.min(1, (progress - 0.4) / 0.25));
                cr.setLineCap(Cairo.LineCap.ROUND); cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.setSourceRGBA(...GREEN, 1); cr.setLineWidth(2.6);
                if (ring > 0) { cr.arc(cx, cy, 18, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * ring); cr.stroke(); }
                if (tick > 0) {
                    const points = [[cx - 8, cy + 0.5], [cx - 2.5, cy + 6], [cx + 8.5, cy - 6]];
                    const first = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]), second = Math.hypot(points[2][0] - points[1][0], points[2][1] - points[1][1]);
                    let left = tick * (first + second);
                    cr.setLineWidth(3); cr.moveTo(...points[0]);
                    const part = Math.min(1, left / first); cr.lineTo(points[0][0] + (points[1][0] - points[0][0]) * part, points[0][1] + (points[1][1] - points[0][1]) * part);
                    left -= first;
                    if (left > 0) { const rest = Math.min(1, left / second); cr.lineTo(points[1][0] + (points[2][0] - points[1][0]) * rest, points[1][1] + (points[2][1] - points[1][1]) * rest); }
                    cr.stroke();
                }
                for (const piece of pieces) {
                    const p = Math.max(0, Math.min(1, (progress - 0.3 - piece.delay) / 0.7));
                    if (p <= 0 || p >= 1) continue;
                    const eased = 1 - (1 - p) ** 3, x = cx + Math.cos(piece.angle) * piece.reach * eased, y = cy + Math.sin(piece.angle) * piece.reach * eased + 16 * p * p;
                    cr.save(); cr.translate(x, y); cr.rotate(piece.spin * p);
                    cr.setSourceRGBA(...piece.color, 1 - p); cr.rectangle(-2.5, -4, 5, 8); cr.fill(); cr.restore();
                }
            } finally { cr.$dispose(); }
        });
        whenMapped(root, life, () => {
            const timeline = new Clutter.Timeline({actor: area, duration: 1500});
            timeline.connect('new-frame', () => { progress = timeline.get_progress(); area.queue_repaint(); });
            timeline.connect('completed', () => { progress = 1; area.queue_repaint(); });
            timeline.start();
            root.connect('destroy', () => timeline.stop());
        });
        // A click on the card: to the agent's window.
        clickable(root, toWindow);
    } else {
        const sign = new St.Icon({gicon: gicon('notchy-warning-symbolic'), icon_size: 19, style_class: 'notchy-agent-orb-icon error', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        orb.add_child(sign);
        heading.text = fmt(_('%s hit a snag'), name);
        message.text = `${statusText(session) || _('The task failed')} – ${_('details in its window.')}`;
        // A short glitch every couple of seconds.
        const twitch = () => { sign.remove_all_transitions(); sign.translation_x = -2.5; sign.ease({translation_x: 2, duration: 60, repeatCount: 3, autoReverse: true, mode: Clutter.AnimationMode.LINEAR, onStopped: () => { sign.translation_x = 0; }}); };
        whenMapped(root, life, () => { twitch(); life.every(2200, twitch); });
        clickable(root, toWindow);
        root.connect('destroy', () => sign.remove_all_transitions());
    }
    root.connect('destroy', () => { column.remove_all_transitions(); life.dispose(); });
    return {actor: root, kind, session, waiting: kind === 'waiting', focus: () => (go ?? close).grab_key_focus()};
}

// A primary click on the card (its buttons keep their own clicks). Plain
// events: Clutter's click action is gone in newer GNOME releases.
function clickable(actor, fn) {
    actor.connect('button-release-event', (_a, event) => {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
        fn(); return Clutter.EVENT_STOP;
    });
}

// Clutter skips animations of actors not on screen yet: run once mapped.
function whenMapped(actor, life, fn) {
    if (actor.mapped) { fn(); return; }
    let id = actor.connect('notify::mapped', () => { if (!actor.mapped) return; actor.disconnect(id); id = 0; fn(); });
    life.cleanups.push(() => { if (id) actor.disconnect(id); id = 0; });
}
