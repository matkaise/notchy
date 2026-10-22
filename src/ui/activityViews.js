import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {box, label, gicon, scroll} from './widgets.js';
import {entryTitle, stateLabel, remainingOf, elapsedOf, formatClock, ticking, classOf, finished, typeText} from '../services/activityModel.js';
import {PROVIDERS, stateText, shownState, statusText, providerName} from '../services/agentModel.js';
import {_, fmt, ngettext, formatPercent, duration, relativeTime} from '../i18n/core.js';

// The symbol of each type, when an activity brings none of its own.
const TYPE_ICON = {transfer: 'adwaita:folder-download-symbolic', operation: 'adwaita:package-x-generic-symbolic', airdrop: 'notchy-airdrop-symbolic', timer: 'adwaita:alarm-symbolic',
    recording: 'adwaita:media-record-symbolic', agent: 'notchy-agent-symbolic', media: 'adwaita:audio-x-generic-symbolic', accessory: 'notchy-airpods-symbolic', custom: 'adwaita:system-run-symbolic'};
const center = {y_align: Clutter.ActorAlign.CENTER};
const TRACK = 70;

// An activity's symbol: its app's icon, an agent's app icon, its own or its type's.
export function iconFor(item, agents = null) {
    if (item.type === 'agent' && agents) { const appIcon = agents.appIcon(item.provider); if (appIcon) return appIcon; }
    if (item.app && item.type !== 'media') { const app = Shell.AppSystem.get_default().lookup_app(item.app); if (app) return app.get_icon(); }
    return gicon(item.icon || TYPE_ICON[item.type] || TYPE_ICON.custom);
}
// An icon set only when it changed (as Island's setIcon).
function setIcon(actor, source) {
    const key = source?.to_string?.() ?? String(source);
    if (actor.notchyIcon === key) return;
    actor.notchyIcon = key; actor.gicon = source;
}
const setClass = (actor, classes) => { if (actor.get_style_class_name() !== classes.trim()) actor.set_style_class_name(classes.trim()); };
// A remaining time ("12:35", "~4:10" for a reporter's estimate) or a running time.
export function clockOf(item, now = Date.now()) {
    const left = remainingOf(item, now);
    if (left !== null) return `${item.estimate ? '~' : ''}${formatClock(left)}`;
    return item.type === 'recording' || item.type === 'operation' ? formatClock(elapsedOf(item, now)) : '';
}
// A timer's elapsed share (a measurement: its deadline and length are exact).
function progressOf(item, now) {
    if (item.progress !== null && item.progress !== undefined) return item.progress;
    if (item.type === 'timer' && item.duration > 0 && !finished(item)) return Math.max(0, Math.min(1, 1 - remainingOf(item, now) / item.duration));
    return null;
}
// Fades a new part in (a different activity took the notch), when animations are on.
const appear = (actor, animate) => {
    if (!animate) return actor;
    actor.opacity = 0; actor.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    return actor;
};

// The closed notch's parts for one entry (an activity or a group), as
// Island.updateCompact's syncRow takes them: [{key, make, update}] left and
// right of the clock. Keys carry the entry and its state, so updates keep
// the actors (a progress bar grows, a clock ticks) while another activity
// or a new state fades in fresh ones.
export function compactParts(entry, {agents = null, animate = true, now = Date.now()} = {}) {
    const lead = entry.members[0], cls = entry.cls, key = `${entry.key}:${cls}`;
    const glyph = (name, style, source, extra = null) => ({key: `act-icon:${key}:${name}`, make: () => {
        const actor = new St.Icon({icon_size: 16, style_class: `notchy-act-icon ${style}`, pivot_point: new Graphene.Point({x: 0.5, y: 0.5}), ...center});
        appear(actor, animate); extra?.(actor); return actor;
    }, update: actor => { setIcon(actor, source); setClass(actor, `notchy-act-icon ${style}`); }});
    const text = (name, style, value) => ({key: `act-${name}:${key}`, make: () => appear(label(value, `notchy-act-text ${style}`, center), animate),
        update: actor => { if (actor.text !== value) actor.text = value; setClass(actor, `notchy-act-text ${style}`); }});
    const track = ratio => ({key: `act-track:${key}`, make: () => {
        const actor = new St.Widget({style_class: 'notchy-hud-track notchy-act-track', width: TRACK, ...center});
        actor.add_child(new St.Widget({style_class: 'notchy-hud-fill notchy-act-fill', width: Math.round(TRACK * ratio)}));
        return appear(actor, animate);
    }, update: actor => {
        const fill = actor.get_first_child(), width = Math.round(TRACK * Math.max(0, Math.min(1, ratio)));
        if (fill.width === width && !fill.get_transition('width')) return;
        if (animate) fill.ease({width, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD}); else fill.width = width;
    }});
    const icon = iconFor(lead, agents), title = entryTitle(entry);
    // A finished one: a check that pops once; a failed one: a short shake.
    if (cls === 'completed') {
        return {left: [glyph('done', 'done', gicon('adwaita:object-select-symbolic'), actor => {
            if (!animate) return;
            actor.scale_x = actor.scale_y = 0.4;
            actor.ease({scale_x: 1, scale_y: 1, duration: 360, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        })], right: [text('done', 'done', title)]};
    }
    if (cls === 'error') {
        return {left: [glyph('error', 'error', gicon('adwaita:dialog-error-symbolic'), actor => {
            if (!animate) return;
            actor.translation_x = -3;
            actor.ease({translation_x: 0, duration: 70, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: 3, autoReverse: true});
        })], right: [text('error', 'error', entry.count > 1 ? title : fmt(_('%s failed'), title))]};
    }
    if (cls === 'attention') {
        // Short enough for the notch: „Claude Code wartet“ (its symbol stands beside it).
        const words = entry.count > 1 ? title : fmt(_('%s is waiting'), lead.type === 'agent' ? lead.name : title);
        return {left: [glyph('waiting', 'waiting', icon)], right: [text('waiting', 'waiting', words)]};
    }
    if (lead.type === 'recording') {
        return {left: [{key: `act-dot:${key}`, make: () => appear(new St.Widget({style_class: 'notchy-act-rec', ...center}), animate)}],
            right: [text('clock', 'clock', clockOf(lead, now))]};
    }
    if (lead.type === 'timer' && entry.count === 1) {
        return {left: [glyph('timer', lead.state === 'paused' ? 'paused' : '', icon)], right: [text('clock', `clock${lead.state === 'paused' ? ' paused' : ''}`, clockOf(lead, now))]};
    }
    const progress = entry.count === 1 ? progressOf(lead, now) : entry.progress;
    if (progress !== null) return {left: [glyph('kind', '', icon)], right: [track(progress), text('value', 'value', formatPercent(Math.round(progress * 100)))]};
    // Running without a measured progress: its name, never a made-up bar.
    // A download shows its size so far beside its name.
    const words = entry.count > 1 ? title : lead.description && (lead.type === 'custom' || lead.download) ? `${title} · ${lead.description}` : title;
    return {left: [glyph('kind', '', icon)], right: [text('name', '', words)]};
}
// Whether the notch's entry needs a second hand (a timer, a recording).
export const entryTicks = entry => Boolean(entry?.members.some(ticking));

// The Activities tab: the Agent Control Center (every agent with its
// sessions) and everything else that runs, each with its state, progress,
// time and actions. Rows are kept per key and updated in place — a state
// change never rebuilds the page, so a focused button keeps the keyboard.
export class ActivitiesPage {
    constructor(views) {
        this.views = views; this.island = views.island; this.activities = views.activities; this.agents = views.agents; this.timers = views.timers; this.life = views.pageLife;
        this.rows = new Map();
        this.actor = box(true, {style_class: 'notchy-page notchy-activities', y_expand: true});
        const head = box(false, {style_class: 'notchy-act-head'});
        this.summary = label('', 'notchy-act-summary', {x_expand: true, ...center});
        head.add_child(this.summary);
        // Quick timers, so the tab is useful while nothing runs.
        for (const [title, run] of [[_('5 min'), () => this.timers?.start({ms: 300000})], [_('25 min'), () => this.timers?.start({ms: 1500000})], ['Pomodoro', () => this.timers?.start({pomodoro: true})]]) {
            const b = new St.Button({style_class: 'notchy-act-chip', label: title, can_focus: true, accessible_name: fmt(_('Start a timer: %s'), title), ...center});
            b.connect('clicked', () => { const result = run(); if (typeof result === 'string') this.island.toast('dialog-warning-symbolic', result); });
            head.add_child(b);
        }
        this.actor.add_child(head);
        this.list = box(true, {style_class: 'notchy-act-list', x_expand: true});
        this.empty = box(true, {style_class: 'notchy-act-empty', x_expand: true, y_expand: true, visible: false, ...center});
        this.empty.add_child(new St.Icon({gicon: gicon('adwaita:view-list-bullet-symbolic'), icon_size: 32, style_class: 'notchy-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this.empty.add_child(label(_('Nothing running'), 'notchy-title', {x_align: Clutter.ActorAlign.CENTER}));
        this.empty.add_child(label(_('Downloads, timers, recordings and agents appear here.'), 'notchy-muted', {x_align: Clutter.ActorAlign.CENTER}));
        this.scroller = scroll(this.list, 240);
        this.actor.add_child(this.scroller); this.actor.add_child(this.empty);
        if (this.activities) this.life.cleanups.push(this.activities.subscribe(() => this.sync()));
        if (this.agents) this.life.cleanups.push(this.agents.subscribe(() => this.sync()));
        // A second hand for running times, only while the tab is open.
        this.life.every(1000, () => this.tick());
        this.sync();
    }
    // The rows in their order: agents (each a head and its sessions), the
    // other activities, then ended agent sessions.
    plan() {
        const rows = [];
        const groups = this.agents?.enabled ? this.agents.providers() : [];
        if (groups.length) rows.push({key: 'section:agents', kind: 'section', title: _('Agents')});
        for (const group of groups) {
            rows.push({key: `agent:${group.provider}`, kind: 'agent', group});
            for (const session of group.sessions) rows.push({key: `session:${group.provider}:${session.id}`, kind: 'session', group, session});
        }
        const items = (this.activities?.list() ?? []).filter(item => item.type !== 'agent');
        if (items.length) rows.push({key: 'section:activities', kind: 'section', title: _('Activities')});
        for (const item of items) rows.push({key: `activity:${item.id}`, kind: 'activity', item});
        const recent = this.agents?.recent?.() ?? [];
        if (recent.length) rows.push({key: 'section:ended', kind: 'section', title: _('Ended sessions')});
        for (const ended of recent) rows.push({key: `ended:${ended.provider}:${ended.id}:${ended.generation}`, kind: 'ended', ended});
        return rows;
    }
    sync() {
        if (this.life.closed) return;
        const plan = this.plan(), keys = new Set(plan.map(r => r.key));
        const focus = global.stage.get_key_focus();
        for (const [key, row] of this.rows) {
            if (keys.has(key)) continue;
            // A row with the keyboard focus hands it to the list before it goes.
            if (focus && row.actor.contains(focus)) this.actor.grab_key_focus();
            row.actor.destroy(); this.rows.delete(key);
        }
        plan.forEach((spec, index) => {
            let row = this.rows.get(spec.key);
            if (!row) { row = this.make(spec); this.rows.set(spec.key, row); this.list.insert_child_at_index(row.actor, index); }
            else if (this.list.get_child_at_index(index) !== row.actor) this.list.set_child_at_index(row.actor, index);
            row.spec = spec; row.update(spec);
        });
        const live = plan.filter(r => r.kind === 'activity' || r.kind === 'session');
        this.empty.visible = !plan.length; this.scroller.visible = Boolean(plan.length);
        const waiting = live.filter(r => (r.kind === 'session' && shownState(r.session) === 'waiting') || (r.kind === 'activity' && r.item.state === 'waiting')).length;
        this.summary.text = !live.length ? _('Activities') : waiting ? fmt(ngettext('%d needs you', '%d need you', waiting), waiting) : fmt(ngettext('%d running', '%d running', live.length), live.length);
    }
    tick() { for (const row of this.rows.values()) row.tick?.(); }
    make(spec) {
        if (spec.kind === 'section') {
            const actor = label(spec.title, 'notchy-act-section');
            return {actor, update: s => { if (actor.text !== s.title) actor.text = s.title; }};
        }
        if (spec.kind === 'agent') return this.agentHead();
        if (spec.kind === 'ended') return this.endedRow();
        return this.itemRow(spec.kind);
    }
    agentHead() {
        const actor = box(false, {style_class: 'notchy-act-agent'});
        const icon = new St.Icon({icon_size: 16, style_class: 'notchy-act-row-icon', ...center});
        const name = label('', 'notchy-act-agent-name', center), sub = label('', 'notchy-act-agent-sub', {x_expand: true, ...center});
        for (const child of [icon, name, sub]) actor.add_child(child);
        return {actor, update: ({group}) => {
            setIcon(icon, this.agents.appIcon(group.provider) ?? gicon(PROVIDERS[group.provider]?.icon ?? 'notchy-agent-symbolic'));
            if (name.text !== group.name) name.text = group.name;
            const text = group.count > 1 ? fmt(ngettext('%1$s · %2$d session', '%1$s · %2$d sessions', group.count), stateText(group.state), group.count) : stateText(group.state);
            if (sub.text !== text) sub.text = text;
            actor.set_style_class_name(`notchy-act-agent ${group.state}`);
        }};
    }
    // One session or one activity: a dot or symbol, two lines, a time, a bar, buttons.
    itemRow(kind) {
        const actor = box(false, {style_class: `notchy-act-row ${kind}`, x_expand: true});
        const icon = new St.Icon({icon_size: 18, style_class: 'notchy-act-row-icon', ...center});
        const column = box(true, {x_expand: true, ...center});
        const title = label('', 'notchy-act-row-title'), sub = label('', 'notchy-act-row-sub');
        const bar = new St.Widget({style_class: 'notchy-act-progress', x_expand: true, visible: false});
        const fill = new St.Widget({style_class: 'notchy-act-progress-fill'}); bar.add_child(fill);
        column.add_child(title); column.add_child(sub); column.add_child(bar);
        const time = label('', 'notchy-act-row-time', center);
        const buttons = box(false, {style_class: 'notchy-act-buttons', ...center});
        for (const child of [icon, column, time, buttons]) actor.add_child(child);
        const row = {actor, buttons: new Map()};
        const setButtons = list => {
            const wanted = new Set(list.map(b => b.id));
            for (const [id, b] of row.buttons) if (!wanted.has(id)) { if (b.has_key_focus()) actor.grab_key_focus?.(); b.destroy(); row.buttons.delete(id); }
            list.forEach((spec, index) => {
                let b = row.buttons.get(spec.id);
                if (!b) {
                    b = new St.Button({style_class: `notchy-act-button${spec.icon ? ' round' : ''}`, can_focus: true, accessible_name: spec.label, ...center});
                    if (spec.icon) b.child = new St.Icon({gicon: gicon(spec.icon), icon_size: 14}); else b.label = spec.label;
                    b.connect('clicked', () => row.run?.(spec.id));
                    row.buttons.set(spec.id, b); buttons.insert_child_at_index(b, index);
                } else if (!spec.icon && b.label !== spec.label) b.label = spec.label;
                b.accessible_name = spec.label;
            });
        };
        // The fill follows the bar's allocated width (never measured before the row is on the stage).
        let shown = null;
        const place = () => { if (shown !== null && bar.has_allocation()) fill.width = Math.round(shown * Math.max(1, bar.allocation.get_width())); };
        bar.connect('notify::allocation', place);
        const setProgress = value => {
            bar.visible = value !== null && value !== undefined;
            shown = bar.visible ? Math.max(0, Math.min(1, value)) : null;
            place();
        };
        row.update = spec => {
            const now = Date.now();
            if (spec.kind === 'session') {
                const {session, group} = spec, state = shownState(session);
                setIcon(icon, gicon('adwaita:media-record-symbolic')); icon.icon_size = 10;
                icon.set_style_class_name(`notchy-act-row-icon notchy-act-dot ${state}`);
                const name = session.project || fmt(_('Session %s'), session.id.length > 18 ? session.id.slice(0, 8) : session.id);
                if (title.text !== name) title.text = name;
                // Waiting: what it waits for and where to answer.
                const window = this.agents.window(session);
                const hint = state === 'waiting' ? (window ? _('Answer in the agent’s window') : _('Answer where the agent runs')) : '';
                const text = [stateText(state), statusText(session), hint].filter(Boolean).join(' · ');
                if (sub.text !== text) sub.text = text;
                setProgress(state === 'working' ? session.progress : null);
                row.tick = () => { time.text = `${duration(Date.now() - session.started)} · ${relativeTime(session.lastEvent || session.started)}`; };
                setButtons(window ? [{id: 'switch', label: _('Switch')}] : []);
                row.run = () => { const target = this.agents.window(session); if (target) { Main.activateWindow(target); this.island.close(); } else this.island.toast('dialog-information-symbolic', _('The agent’s window cannot be named for sure')); };
                actor.set_style_class_name(`notchy-act-row session ${state}`);
                actor.accessible_name = `${group.name}: ${name}, ${text}`;
            } else {
                const {item} = spec, cls = classOf(item);
                setIcon(icon, iconFor(item, this.agents));
                icon.set_style_class_name(`notchy-act-row-icon ${cls}`);
                if (title.text !== item.name) title.text = item.name;
                const text = [item.type === 'custom' || item.type === 'accessory' ? '' : typeText(item.type), item.state === 'running' && item.type !== 'custom' ? '' : stateLabel(item.state), item.description].filter(Boolean).join(' · ');
                if (sub.text !== text) sub.text = text;
                row.tick = () => {
                    const at = Date.now();
                    time.text = clockOf(item, at);
                    setProgress(progressOf(item, at));
                };
                const list = item.actions.map(a => ({id: a.id, label: a.label}));
                if (finished(item) || item.source === 'external') list.push({id: 'dismiss', label: _('Dismiss'), icon: 'adwaita:window-close-symbolic'});
                setButtons(list);
                row.run = action => {
                    const message = this.activities.invoke(item.id, action);
                    if (message) this.island.toast('dialog-information-symbolic', message);
                    else if (action === 'switch') this.island.close();
                };
                actor.set_style_class_name(`notchy-act-row activity ${cls}`);
                actor.accessible_name = `${item.name}, ${text}`;
            }
            row.tick();
        };
        return row;
    }
    endedRow() {
        const actor = box(false, {style_class: 'notchy-act-row ended'});
        const icon = new St.Icon({icon_size: 16, style_class: 'notchy-act-row-icon', ...center});
        const column = box(true, {x_expand: true, ...center}), title = label('', 'notchy-act-row-title'), sub = label('', 'notchy-act-row-sub');
        column.add_child(title); column.add_child(sub);
        const time = label('', 'notchy-act-row-time', center);
        for (const child of [icon, column, time]) actor.add_child(child);
        const row = {actor};
        row.update = ({ended}) => {
            setIcon(icon, this.agents.appIcon(ended.provider) ?? gicon(PROVIDERS[ended.provider]?.icon ?? 'notchy-agent-symbolic'));
            title.text = `${providerName(ended.provider)}${ended.project ? ` · ${ended.project}` : ''}`;
            sub.text = ended.orphaned ? _('Process gone') : _('Ended');
            row.tick = () => { time.text = `${duration(ended.ended - ended.started)} · ${relativeTime(ended.ended)}`; };
            row.tick();
        };
        return row;
    }
}
