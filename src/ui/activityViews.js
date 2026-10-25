import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {label, gicon} from './widgets.js';
import {entryTitle, remainingOf, elapsedOf, formatClock, ticking, finished} from '../services/activityModel.js';
import {_, fmt, formatPercent} from '../i18n/core.js';

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
    const words = entry.count > 1 ? title : lead.description && lead.type === 'custom' ? `${title} · ${lead.description}` : title;
    return {left: [glyph('kind', '', icon)], right: [text('name', '', words)]};
}
// Whether the notch's entry needs a second hand (a timer, a recording).
export const entryTicks = entry => Boolean(entry?.members.some(ticking));
