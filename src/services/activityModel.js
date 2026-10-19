// Smart Live Activities: everything that runs right now and is worth a
// glance — a download, a file Notchy compresses, an AirDrop transfer, a
// timer, a screen recording, an agent waiting for you, the music. Pure logic
// without GNOME imports (covered by tests/activities.test.js);
// src/services/activities.js connects the sources and the one clock.
//
// The way through:
//   sources        services that know something runs (agents, file work,
//                  timers, a reporting app …) describe their activities;
//   ActivityStore  one normalised record per activity: what appeared, what
//                  finished, how long a finished one lingers, what expired;
//   groupEntries   similar activities summarised („3 transfers“);
//   Arbiter        which entry the closed notch shows: a ranked choice with a
//                  minimum display time, hysteresis and a way back to the
//                  activity an urgent one interrupted;
//   the island     draws it (src/ui/island.js, src/ui/activityViews.js).
//
// Nothing here invents a value: progress is null unless the source measured
// it, a remaining time only exists when the source knows its deadline.
import {_, N_, fmt, ngettext} from '../i18n/core.js';

export const TYPES = ['transfer', 'operation', 'airdrop', 'timer', 'recording', 'agent', 'media', 'accessory', 'custom'];
// What external reporters (D-Bus, notchyctl, MCP) may claim; the rest belong to Notchy's own sources.
export const EXTERNAL_TYPES = ['transfer', 'operation', 'timer', 'recording', 'custom'];
export const STATES = ['running', 'waiting', 'paused', 'completed', 'error'];
// Priority classes, most important first: the default order of the
// „Priorities“ setting. An activity's class follows from its state first
// (waiting, error, completed), else from its type.
export const CLASSES = ['attention', 'error', 'completed', 'transfer', 'timer', 'media', 'background'];
const BASE = {transfer: 'transfer', operation: 'transfer', airdrop: 'transfer', timer: 'timer', recording: 'timer', media: 'media', agent: 'background', accessory: 'background', custom: 'background'};
// Classes that interrupt at once, whatever the minimum display time says.
export const URGENT = new Set(['attention', 'error']);
// Types the closed notch may show (AirPods keep their own indicator).
export const CAPSULE_TYPES = new Set(TYPES.filter(type => type !== 'accessory'));
// Types summarised when several are alike (one per class: „2 transfers“, „2 agents waiting“).
const GROUPABLE = new Set(['transfer', 'operation', 'timer', 'agent', 'custom']);

export const LIMITS = {activities: 64, external: 24, id: 96, name: 60, text: 140, actions: 3, actionId: 32, actionLabel: 24, icon: 80};
// A finished activity stays this long (Settings → Live Activities), a failed one longer.
export const COMPLETED_MS = 4000, ERROR_MS = 20000;
// An activity shown in the closed notch keeps it at least this long, unless an urgent one arrives.
export const MIN_DISPLAY_MS = 3000;
// External reports expire after their ttl (default an hour), so a reporter
// that vanished leaves nothing behind; one that runs longer reports again.
export const DEFAULT_TTL_S = 3600, MIN_TTL_S = 5, MAX_TTL_S = 86400;

const TYPE_TEXT = {transfer: N_('Transfer'), operation: N_('File operation'), airdrop: 'AirDrop', timer: N_('Timer'), recording: N_('Screen recording'),
    agent: N_('Agent'), media: N_('Media'), accessory: N_('Accessory'), custom: N_('Activity')};
const STATE_TEXT = {running: N_('Running'), waiting: N_('Waiting for you'), paused: N_('Paused'), completed: N_('Done'), error: N_('Failed')};
const CLASS_TEXT = {attention: N_('Needs you'), error: N_('Errors'), completed: N_('Just finished'), transfer: N_('Transfers and downloads'),
    timer: N_('Timers and recordings'), media: N_('Media'), background: N_('Background activities')};
export const typeText = type => (TYPE_TEXT[type] ? _(TYPE_TEXT[type]) : String(type ?? ''));
export const stateLabel = state => (STATE_TEXT[state] ? _(STATE_TEXT[state]) : '');
export const classText = cls => (CLASS_TEXT[cls] ? _(CLASS_TEXT[cls]) : String(cls ?? ''));

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,95}$/, ACTION_RE = /^[a-z][a-z0-9._-]{0,31}$/, ICON_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/, APP_RE = /^[A-Za-z0-9][\w.-]{0,120}\.desktop$/;
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const finished = activity => activity?.state === 'completed' || activity?.state === 'error';
// A progress value, or null when it is not a real measurement.
export function progressOf(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

// The configured order of classes: known ones, each once, missing ones appended in the default order.
export function sanitizeOrder(order) {
    const seen = new Set((Array.isArray(order) ? order : []).filter(cls => CLASSES.includes(cls)));
    return [...seen, ...CLASSES.filter(cls => !seen.has(cls))];
}
export function classOf(activity) {
    switch (activity?.state) {
    case 'waiting': return 'attention';
    case 'error': return 'error';
    case 'completed': return 'completed';
    case 'paused': return activity.type === 'media' || activity.type === 'timer' ? BASE[activity.type] : 'background';
    default: return BASE[activity?.type] ?? 'background';
    }
}

// An activity as the store keeps it. Sources build theirs with activity();
// external reports go through parseReport() first.
//   id, type, source, name, icon, description, state, progress (0..1 | null),
//   total (bytes, for summing transfers), started, deadline (ms, while it
//   counts down), left (ms, while paused), estimate (the deadline is the
//   reporter's guess), duration (a timer's phase, ms), app (desktop id),
//   actions [{id, label}], legacy (set_activity), quiet (listed only, never
//   in the notch or beside it), expires, updated, finishedAt.
export function activity(fields) {
    return {type: 'custom', source: '', name: '', icon: '', description: '', state: 'running', progress: null, total: null, started: 0, deadline: null, left: null,
        estimate: false, duration: null, app: '', actions: [], legacy: false, quiet: false, expires: null, ...fields};
}

// A report from outside (D-Bus ReportActivity, notchyctl live, MCP): JSON
// text or an object. Returns {activity} or {error} (a translated message).
export function parseReport(input, now = Date.now()) {
    let raw = input;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {error: _('Not valid JSON')}; } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {error: _('An activity must be an object')};
    const id = String(raw.id ?? '');
    if (!ID_RE.test(id)) return {error: _('Invalid activity id')};
    const type = raw.type === undefined ? 'custom' : String(raw.type);
    if (!EXTERNAL_TYPES.includes(type)) return {error: fmt(_('Unknown activity type: %s'), type)};
    const state = raw.state === undefined ? 'running' : String(raw.state);
    if (!STATES.includes(state)) return {error: fmt(_('Unknown state: %s'), state)};
    const name = clean(raw.name, LIMITS.name);
    if (!name) return {error: _('An activity needs a name')};
    let progress = null;
    if (raw.progress !== undefined && raw.progress !== null) {
        progress = progressOf(raw.progress);
        if (progress === null) return {error: _('Progress must be between 0 and 1')};
    }
    const seconds = (value, min, max) => (value === undefined || value === null ? undefined : typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : NaN);
    const remaining = seconds(raw.remaining, 0, MAX_TTL_S), ttl = seconds(raw.ttl, MIN_TTL_S, MAX_TTL_S), total = seconds(raw.total, 1, Number.MAX_SAFE_INTEGER);
    if (Number.isNaN(remaining)) return {error: _('The remaining time must be between 0 and 86400 seconds')};
    if (Number.isNaN(ttl)) return {error: _('The lifetime must be between 5 and 86400 seconds')};
    if (Number.isNaN(total)) return {error: _('The total must be a positive number')};
    const icon = raw.icon === undefined ? '' : String(raw.icon);
    if (icon && !ICON_RE.test(icon)) return {error: _('Invalid icon name')};
    const app = raw.app === undefined ? '' : String(raw.app);
    if (app && !APP_RE.test(app)) return {error: _('Invalid application id')};
    if (raw.actions !== undefined && !Array.isArray(raw.actions)) return {error: _('Actions must be a list')};
    const actions = [];
    for (const entry of raw.actions ?? []) {
        const actionId = String(entry?.id ?? ''), label = clean(entry?.label, LIMITS.actionLabel);
        if (!ACTION_RE.test(actionId) || !label) return {error: _('Each action needs an id (a-z, 0-9, ._-) and a label')};
        if (['dismiss', 'pause', 'resume', 'cancel', 'stop', 'switch'].includes(actionId)) return {error: fmt(_('The action id %s is reserved'), actionId)};
        if (actions.length < LIMITS.actions && !actions.some(a => a.id === actionId)) actions.push({id: actionId, label, external: true});
    }
    return {activity: activity({id: `ext:${id}`, external: id, type, name, state, progress, total: total ?? null, icon, app, actions,
        description: clean(raw.description ?? raw.status, LIMITS.text),
        deadline: remaining === undefined || finished({state}) || state === 'paused' ? null : now + remaining * 1000, left: state === 'paused' && remaining !== undefined ? remaining * 1000 : null,
        estimate: remaining !== undefined && type !== 'timer', expires: now + (ttl ?? DEFAULT_TTL_S) * 1000, source: 'external'})};
}

// The fields whose change is a change worth drawing.
const SHOWN = ['type', 'name', 'icon', 'description', 'state', 'progress', 'total', 'deadline', 'left', 'duration', 'app', 'legacy', 'quiet'];
const same = (a, b) => SHOWN.every(key => a[key] === b[key]) && JSON.stringify(a.actions) === JSON.stringify(b.actions);

// The activities and their lifecycle. Each source replaces its whole set with
// sync(); an external report adds one with put(). Returns, like the agent
// registry, what happened: {changed, transitions: [{type, activity}]} with
// type 'appeared' | 'completed' | 'failed' | 'removed'.
//
// A finished activity (completed or failed) stays for its linger time, also
// when its source no longer reports it (a file operation that ended). Once it
// expired it does not come back while its source still reports it finished
// (the agent model keeps „completed“ longer than the notch does). An
// activity a source drops while it still runs is removed at once: Notchy
// never claims it finished.
export class ActivityStore {
    constructor() { this.items = new Map(); this.expired = new Map(); }
    sync(source, list, now = Date.now()) {
        const result = {changed: false, transitions: []}, seen = new Set();
        for (const fields of list) { seen.add(fields.id); this.apply({...fields, source}, now, result); }
        for (const [id, item] of this.items) if (item.source === source && !seen.has(id) && !item.ghost) this.drop(id, item, now, result);
        for (const [id, grave] of this.expired) if (grave.source === source && !seen.has(id)) this.expired.delete(id);
        return result;
    }
    put(fields, now = Date.now()) { const result = {changed: false, transitions: []}; this.apply(fields, now, result); return result; }
    remove(id, now = Date.now()) {
        const result = {changed: false, transitions: []}, item = this.items.get(id);
        this.expired.delete(id);
        if (item) { this.items.delete(id); result.changed = true; result.transitions.push({type: 'removed', activity: item}); }
        return result;
    }
    apply(fields, now, result) {
        const next = activity(fields), old = this.items.get(next.id);
        if (finished(next) && this.expired.has(next.id)) return;
        if (!finished(next)) this.expired.delete(next.id);
        if (!old) {
            if (this.items.size >= LIMITS.activities) this.evict();
            next.started = next.started || now; next.updated = now; next.finishedAt = finished(next) ? now : 0;
            this.items.set(next.id, next); result.changed = true;
            result.transitions.push({type: 'appeared', activity: next});
            if (finished(next)) result.transitions.push({type: next.state === 'error' ? 'failed' : 'completed', activity: next});
            return;
        }
        next.started = fields.started || old.started;
        next.finishedAt = finished(next) ? (finished(old) && old.state === next.state && !old.ghost ? old.finishedAt : now) : 0;
        const changed = !same(old, next) || Boolean(old.ghost);
        next.updated = changed ? now : old.updated;
        this.items.set(next.id, next);
        if (!changed) return;
        result.changed = true;
        if (finished(next) && (!finished(old) || old.state !== next.state)) result.transitions.push({type: next.state === 'error' ? 'failed' : 'completed', activity: next});
    }
    drop(id, item, now, result) {
        if (finished(item)) { item.ghost = true; return; }
        this.items.delete(id); result.changed = true; result.transitions.push({type: 'removed', activity: item});
    }
    // The least important, longest unchanged activity makes room.
    evict() {
        const order = [...this.items.values()].sort((a, b) => CLASSES.indexOf(classOf(b)) - CLASSES.indexOf(classOf(a)) || a.updated - b.updated);
        if (order[0]) this.items.delete(order[0].id);
    }
    linger(item, {completedMs = COMPLETED_MS, errorMs = ERROR_MS} = {}) { return item.state === 'error' ? Math.max(errorMs, completedMs) : completedMs; }
    // Time passing: finished ones after their linger, external reports after their ttl.
    expire(now = Date.now(), options = {}) {
        let changed = false;
        for (const [id, item] of this.items) {
            const lingered = finished(item) && now - item.finishedAt >= this.linger(item, options);
            const stale = item.expires !== null && item.expires <= now;
            if (!lingered && !stale) continue;
            this.items.delete(id); changed = true;
            if (lingered && !item.ghost && !stale) this.expired.set(id, {source: item.source, at: now});
        }
        // Graves of a source that never reports again are kept a bounded while.
        if (this.expired.size > 256) this.expired.delete(this.expired.keys().next().value);
        return changed;
    }
    // When expire() next has something to do (ms from now), or null.
    nextWake(now = Date.now(), options = {}) {
        let next = Infinity;
        for (const item of this.items.values()) {
            if (finished(item)) next = Math.min(next, item.finishedAt + this.linger(item, options) - now);
            if (item.expires !== null) next = Math.min(next, item.expires - now);
        }
        return Number.isFinite(next) ? Math.max(0, next) : null;
    }
    list() { return [...this.items.values()]; }
    get(id) { return this.items.get(id) ?? null; }
}

// Remaining and elapsed time of an activity (ms), or null where unknown.
export function remainingOf(item, now = Date.now()) {
    if (item.left !== null && item.left !== undefined) return Math.max(0, item.left);
    if (item.deadline !== null && item.deadline !== undefined) return Math.max(0, item.deadline - now);
    return null;
}
export const elapsedOf = (item, now = Date.now()) => Math.max(0, now - (item.started || now));
// "4:05", "12:35", "1:02:03".
export function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, seconds = total % 60;
    const two = n => String(n).padStart(2, '0');
    return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}
// Whether an activity shows a running clock (and the view needs a second hand).
export const ticking = item => (item.type === 'recording' && item.state === 'running') || (item.deadline !== null && item.deadline !== undefined && item.state === 'running');

// Similar activities summarised: one entry per type and class when grouping
// is on (two downloads → „2 transfers“), else one per activity. An entry:
//   {key, type, cls, members, count, progress, state, started, updated, id?}
// A group's progress is only given when every member reports its size, so the
// sum is exact; otherwise it shows the count without a percentage.
export function groupEntries(activities, {enabled = true} = {}) {
    const entries = new Map();
    for (const item of activities) {
        const cls = classOf(item), key = enabled && GROUPABLE.has(item.type) && !item.legacy ? `${item.type}:${cls}` : `one:${item.id}`;
        if (!entries.has(key)) entries.set(key, {key, type: item.type, cls, members: []});
        entries.get(key).members.push(item);
    }
    return [...entries.values()].map(entry => {
        const {members} = entry;
        members.sort((a, b) => b.started - a.started || (a.id < b.id ? -1 : 1));
        const lead = members[0];
        let progress = null;
        if (members.length === 1) progress = lead.progress;
        else if (members.every(m => m.progress !== null && m.total > 0)) {
            const total = members.reduce((sum, m) => sum + m.total, 0);
            progress = members.reduce((sum, m) => sum + m.progress * m.total, 0) / total;
        }
        return {...entry, count: members.length, progress, state: lead.state, id: members.length === 1 ? lead.id : null,
            started: Math.max(...members.map(m => m.started)), updated: Math.max(...members.map(m => m.updated))};
    });
}
// An entry's title as the notch shows it: the activity's name, or what a group holds.
export function entryTitle(entry) {
    if (entry.count === 1) return entry.members[0].name;
    const n = entry.count;
    switch (entry.type) {
    case 'transfer': return fmt(ngettext('%d transfer', '%d transfers', n), n);
    case 'operation': return fmt(ngettext('%d file operation', '%d file operations', n), n);
    case 'timer': return fmt(ngettext('%d timer', '%d timers', n), n);
    case 'agent': return entry.cls === 'attention' ? fmt(ngettext('%d agent waiting', '%d agents waiting', n), n) : fmt(ngettext('%d agent', '%d agents', n), n);
    default: return fmt(ngettext('%d activity', '%d activities', n), n);
    }
}

// Which entry the closed notch shows. decide() is called with the current
// entries whenever something changed (and at the time it asked for):
//   - the best ranked entry wins (the configured class order; within a class
//     the newest);
//   - the entry shown keeps the notch at least `minMs`; a better one waits
//     (its turn comes at `wake`), unless it is urgent (needs the user, or an
//     error) — then it shows at once;
//   - an entry of the same rank never takes over from the one shown
//     (hysteresis: equal activities do not take turns);
//   - when the shown entry goes, the notch returns to the one it interrupted,
//     if that is still among the best;
//   - an entry of the same key keeps its place (a group growing from one to
//     two transfers keeps the notch, as its key stays the same).
// Returns {focus, changed, wake}: wake in ms from now, or null.
export class Arbiter {
    constructor() { this.focus = null; this.since = 0; this.history = []; }
    rank(entry, order) { const index = order.indexOf(entry.cls); return index < 0 ? order.length : index; }
    sort(entries, order) {
        return [...entries].sort((a, b) => this.rank(a, order) - this.rank(b, order) || b.started - a.started || (a.key < b.key ? -1 : 1));
    }
    decide(entries, now = Date.now(), {order = CLASSES, minMs = MIN_DISPLAY_MS} = {}) {
        const ranked = this.sort(entries, order), best = ranked[0] ?? null;
        const current = ranked.find(entry => entry.key === this.focus) ?? null;
        const before = this.focus;
        let wake = null;
        if (!best) this.set(null, now);
        else if (!current) {
            // The shown one went: back to what it interrupted, if that is as good as the best.
            const rank = this.rank(best, order);
            const back = [...this.history].reverse().map(key => ranked.find(entry => entry.key === key)).find(entry => entry && this.rank(entry, order) === rank);
            this.set((back ?? best).key, now, false);
        } else if (best.key !== current.key && this.rank(best, order) < this.rank(current, order)) {
            const due = this.since + minMs;
            if (URGENT.has(best.cls) || now >= due) this.set(best.key, now);
            else wake = due - now;
        }
        const focus = ranked.find(entry => entry.key === this.focus) ?? null;
        return {focus, changed: before !== this.focus, wake};
    }
    // remember: the replaced entry is one to return to.
    set(key, now, remember = true) {
        if (key === this.focus) return;
        if (remember && this.focus) { this.history = this.history.filter(k => k !== this.focus); this.history.push(this.focus); if (this.history.length > 8) this.history.shift(); }
        this.history = this.history.filter(k => k !== key);
        this.focus = key; this.since = now;
    }
    reset() { this.focus = null; this.since = 0; this.history = []; }
}

// The weight of an entry beside the notch (SideIndicators' priority): urgent
// first, like the agents' waiting and error states.
export const sidePriority = (entry, order = CLASSES) => Math.max(1, 5 - Math.max(0, order.indexOf(entry.cls)) * 0.6);
