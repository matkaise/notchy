// AI agent sessions as Notchy shows them: Claude Code, Codex, Antigravity and
// anything that reports over notchyctl or the MCP bridge. Pure logic without
// GNOME imports (the Node test suite covers it); src/services/agents.js adds
// D-Bus, timers and process checks.
//
// A session is one agent conversation (a Claude Code session id, a Codex
// thread, an Antigravity conversation). It has two separate states:
//   connected    the session exists (started, not ended, its process alive);
//   task         what it does: working, waiting (needs the user: a permission
//                or a question), idle (ready, nothing to do), completed (a
//                task just finished), error.
// The state shown is 'disconnected' once the session ended, else the task.
// Only events from the agent itself (its hooks) or an explicit report change a
// state; a running process alone never means "working".
//
// An ended session stays ended: hooks run as separate processes, so a
// PostToolUse or Stop can arrive after SessionEnd — even with a newer
// timestamp. Only a new start (SessionStart, `notchyctl agent start`, or an
// explicit report from notchyctl or MCP) brings a session id back, as a new
// generation. Ended ids are remembered for a while (TOMBSTONE_MS) after their
// indicator faded, so a straggler cannot create them again either.
import {_, N_, fmt} from '../i18n/core.js';

export const STATES = ['working', 'waiting', 'idle', 'completed', 'error', 'disconnected'];
export const TASK_STATES = ['working', 'waiting', 'idle', 'completed', 'error'];
// How urgent a state is: what the overflow keeps visible and what a provider's
// indicator shows when its sessions differ.
export const PRIORITY = {waiting: 5, error: 4, working: 3, completed: 2, idle: 1, disconnected: 0};
export const PROVIDERS = {
    claude: {name: 'Claude Code', app: ['claude-desktop.desktop', 'claude.desktop', 'com.anthropic.claude.desktop'], icon: 'notchy-agent-claude-symbolic'},
    codex: {name: 'Codex', app: ['chatgpt.desktop', 'codex.desktop', 'com.openai.chatgpt.desktop'], icon: 'notchy-agent-codex-symbolic'},
    antigravity: {name: 'Antigravity', app: ['antigravity_antigravity.desktop', 'antigravity.desktop', 'google-antigravity.desktop'], icon: 'notchy-agent-antigravity-symbolic'},
};
export const providerName = id => PROVIDERS[id]?.name ?? id.replace(/(^|[-_])(\w)/g, (_m, sep, c) => `${sep ? ' ' : ''}${c.toUpperCase()}`);

// Events as the hook adapter, notchyctl and the MCP bridge send them.
//   start      the session began (task: idle)
//   prompt     the user handed it a task (working)
//   tool       a tool runs or finished (working)
//   waiting    it needs the user's approval or answer (waiting)
//   resume     it continues after waiting (working)
//   stop       the task finished (completed)
//   idle       ready, nothing to do (idle)
//   error      the task failed (error)
//   end        the session ended (disconnected)
//   heartbeat  still alive, no change
//   update     explicit state and/or status/progress (notchyctl, MCP)
export const EVENTS = {start: 'idle', prompt: 'working', tool: 'working', waiting: 'waiting', resume: 'working', stop: 'completed', idle: 'idle', error: 'error', end: 'disconnected', heartbeat: null, update: null};
// Events with the same millisecond keep the order a session goes through:
// an earlier step never overrides a later one (Stop beats a PostToolUse,
// PermissionRequest beats its PreToolUse). Explicit updates always apply.
export const EVENT_RANK = {start: 0, prompt: 1, tool: 2, resume: 2, waiting: 3, idle: 4, stop: 4, error: 4, end: 5};
const STATUS_TEXT = {working: N_('Working'), waiting: N_('Waiting for you'), idle: N_('Ready'), completed: N_('Done'), error: N_('Error'), disconnected: N_('Ended')};
export const stateText = state => (STATUS_TEXT[state] ? _(STATUS_TEXT[state]) : '');
// What a hook says beyond its state, as an id (shown translated, see statusText).
export const NOTES = ['tool', 'permission', 'question', 'reply-failed', 'run-failed', 'interrupted'];
// A session's status line: its hook note in the interface language, or the
// free text an explicit report gave.
export function statusText(session) {
    switch (session?.note) {
    case 'tool': return session.tool ? fmt(_('Tool: %s'), session.tool) : '';
    case 'permission': return session.tool ? fmt(_('Approval for %s'), session.tool) : _('Approval needed');
    case 'question': return _('Question for you');
    case 'reply-failed': return _('Reply failed');
    case 'run-failed': return _('Run failed');
    case 'interrupted': return _('Interrupted');
    default: return session?.status ?? '';
    }
}

// Limits: what Notchy accepts from the session bus.
export const LIMITS = {sessions: 32, perProvider: 12, text: 140, project: 60, session: 128, ancestors: 16};
// A completed task shows as such this long, then the session is idle.
export const COMPLETED_MS = 8000;
// A session nothing can vouch for (no process to check, no heartbeat) is
// dropped after this long without any event; one that says it is working
// keeps much longer, since long tasks are normal.
export const QUIET_IDLE_MS = 2 * 3600 * 1000, QUIET_WORKING_MS = 8 * 3600 * 1000;
// Heartbeats: three missed beats end a session that announced them.
export const HEARTBEAT_MISSES = 3;
// A disconnected session stays this long for its fade-out.
export const GONE_MS = 1600;
// An ended session id ignores stragglers this long after it ended.
export const TOMBSTONE_MS = 2 * 60 * 1000;
// Events may arrive slightly out of order (hooks run as separate processes);
// an event older than the newest one applied is ignored for the state.
export const CLOCK_SLACK_MS = 0;

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

// Validates and normalises one event; returns {error} or {event}.
export function parseEvent(input, now = Date.now()) {
    let raw = input;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {error: _('Not valid JSON')}; } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {error: _('An event must be an object')};
    const provider = String(raw.provider ?? '').toLowerCase();
    if (!PROVIDER_RE.test(provider)) return {error: _('Invalid provider')};
    const session = clean(raw.session, LIMITS.session);
    if (!session) return {error: _('Session id missing')};
    const kind = String(raw.event ?? 'update');
    if (!(kind in EVENTS)) return {error: fmt(_('Unknown event: %s'), kind)};
    let state = raw.state === undefined || raw.state === null || raw.state === '' ? null : String(raw.state);
    if (state !== null && !STATES.includes(state)) return {error: fmt(_('Unknown state: %s'), state)};
    if (kind === 'update' && state === null && raw.status === undefined && raw.progress === undefined && raw.project === undefined) return {error: _('update without state, status or progress')};
    let progress;
    if (raw.progress === null) progress = null;
    else if (raw.progress !== undefined) {
        const value = Number(raw.progress);
        if (typeof raw.progress === 'boolean' || !Number.isFinite(value) || value < 0 || value > 1) return {error: _('Progress must be between 0 and 1')};
        progress = value;
    }
    const time = Number.isFinite(raw.time) && raw.time > 0 && Math.abs(raw.time - now) < 86400000 ? Math.round(raw.time) : now;
    const pid = Number.isInteger(raw.pid) && raw.pid > 1 ? raw.pid : null;
    const ancestors = Array.isArray(raw.ancestors) ? raw.ancestors.filter(p => Number.isInteger(p) && p > 1).slice(0, LIMITS.ancestors) : [];
    const heartbeat = Number.isFinite(raw.heartbeat) && raw.heartbeat >= 5 && raw.heartbeat <= 3600 ? Math.round(raw.heartbeat) : null;
    return {event: {provider, session, kind, state: state ?? EVENTS[kind], status: raw.status === undefined ? undefined : clean(raw.status, LIMITS.text),
        project: raw.project === undefined ? undefined : clean(raw.project, LIMITS.project), progress, time, pid, pidStart: raw.pidStart === undefined ? null : clean(raw.pidStart, 24),
        ancestors, heartbeat, source: ['hook', 'cli', 'mcp'].includes(raw.source) ? raw.source : 'cli', tool: raw.tool === undefined ? undefined : clean(raw.tool, 40),
        note: raw.note === '' ? '' : NOTES.includes(raw.note) ? raw.note : undefined}};
}

// The sessions and their states. apply() returns what changed:
// {changed: bool, session, transition: 'appeared' | 'completed' | 'waiting' | 'error' | 'ended' | null}.
// A session that appears waiting or failed reports 'appeared'.
export class AgentRegistry {
    constructor() { this.sessions = new Map(); this.ended = new Map(); this.generations = 0; }
    key(provider, session) { return `${provider}\u0000${session}`; }
    get(provider, session) { return this.sessions.get(this.key(provider, session)) ?? null; }
    // Whether an event may (re)open a session that ended: a start, or an
    // explicit report from notchyctl or MCP — never a late hook event — and
    // only if it is newer than the end.
    reopens(event, ended) {
        if (event.kind === 'end' || event.kind === 'heartbeat' || event.state === 'disconnected') return false;
        if (event.kind !== 'start' && event.source === 'hook') return false;
        return !ended || event.time > ended.lastEvent;
    }
    bury(key, session, now) {
        this.ended.set(key, {at: now, lastEvent: Math.max(session.lastEvent, session.endEvent ?? 0)});
        if (this.ended.size > 256) this.ended.delete(this.ended.keys().next().value);
    }
    apply(event, now = Date.now()) {
        const key = this.key(event.provider, event.session);
        let session = this.sessions.get(key), appeared = false;
        const ended = this.ended.get(key);
        if (ended && now - ended.at > TOMBSTONE_MS) this.ended.delete(key);
        if (!session) {
            // An event for a session that ended (a late hook) does not revive it.
            if (!this.reopens(event, this.ended.get(key)) && (this.ended.has(key) || event.kind === 'end' || event.state === 'disconnected'))
                return {changed: false, session: null, transition: null};
            if (this.sessions.size >= LIMITS.sessions) this.evict(now);
            if ([...this.sessions.values()].filter(s => s.provider === event.provider).length >= LIMITS.perProvider) this.evict(now, event.provider);
            session = this.fresh(event, now);
            this.sessions.set(key, session); this.ended.delete(key); appeared = true;
        } else if (!session.connected) {
            // Still fading out after its end.
            if (!this.reopens(event, {lastEvent: session.lastEvent})) {
                session.seen = now;
                return {changed: false, session, transition: null};
            }
            const started = this.fresh(event, now);
            Object.assign(session, started);
            this.ended.delete(key); appeared = true;
        }
        const before = JSON.stringify(session);
        session.seen = now;
        if (event.pid) { session.pid = event.pid; session.pidStart = event.pidStart; }
        if (event.ancestors.length) session.ancestors = event.ancestors;
        if (event.heartbeat) session.heartbeat = event.heartbeat;
        if (event.project !== undefined && event.project) session.project = event.project;
        let transition = appeared ? 'appeared' : null;
        // Out of order: an older event than the newest applied one only
        // refreshes liveness; one of the same millisecond applies only if it is
        // not an earlier step (EVENT_RANK).
        const rank = EVENT_RANK[event.kind];
        // An end always ends this generation, even when its hook process took
        // its time a moment before a step that arrived first.
        const current = (event.state === 'disconnected' && event.time >= session.started)
            || event.time > session.lastEvent - CLOCK_SLACK_MS
            || (event.time === session.lastEvent && (rank === undefined || session.lastRank === undefined || rank >= session.lastRank));
        if (current && event.kind !== 'heartbeat') {
            if (event.time >= session.lastEvent) session.lastRank = rank;
            session.lastEvent = Math.max(session.lastEvent, event.time);
            if (event.state === 'disconnected') {
                session.connected = false; session.endedAt = now; session.endEvent = event.time; transition = 'ended';
                this.bury(key, session, now);
            } else if (event.state) {
                if (event.state === 'completed' && session.task !== 'completed') transition = transition ?? 'completed';
                // Needs the user, or failed: notifications (src/services/agents.js) follow these.
                else if ((event.state === 'waiting' || event.state === 'error') && session.task !== event.state) transition = transition ?? event.state;
                session.task = event.state;
                session.completedAt = event.state === 'completed' ? now : 0;
                if (event.state === 'working' || event.state === 'waiting') session.lastActivity = event.time;
                // New work: whatever finished before has been dealt with.
                if (event.state === 'working' || event.state === 'waiting' || event.state === 'error') session.unseen = false;
                // A new task starts without the old one's progress and text.
                if (event.kind === 'prompt') { session.progress = null; session.status = ''; session.note = ''; }
                if (event.state !== 'working') session.tool = '';
            }
            if (event.tool !== undefined) session.tool = event.tool;
            if (event.status !== undefined) session.status = event.status;
            if (event.note !== undefined) session.note = event.note;
            if (event.progress !== undefined) session.progress = event.progress;
        }
        return {changed: JSON.stringify(session) !== before || appeared, session, transition};
    }
    // A session as it starts: idle, connected, a new generation (the
    // indicator's popup tells a reopened id from the one that ended).
    fresh(event, now) {
        return {id: event.session, provider: event.provider, project: '', status: '', note: '', progress: null, task: 'idle', connected: true,
            started: event.time, lastEvent: 0, lastRank: undefined, lastActivity: event.time, seen: now, completedAt: 0, endedAt: 0, endEvent: 0, pid: null, pidStart: null,
            ancestors: [], heartbeat: null, source: event.source, tool: '', unseen: false, generation: ++this.generations};
    }
    // Time passing: completed → idle, quiet and orphaned sessions, the fade of
    // ended ones. `alive(session)` tells whether its process still runs
    // (true, false, or null when there is no process to check).
    tick(now = Date.now(), alive = () => null, {completedMs = COMPLETED_MS} = {}) {
        let changed = false;
        for (const [key, session] of this.sessions) {
            if (!session.connected) {
                if (now - session.endedAt >= GONE_MS) { this.sessions.delete(key); changed = true; }
                continue;
            }
            if (session.task === 'completed' && now - session.completedAt >= completedMs) { session.task = 'idle'; changed = true; }
            const living = alive(session);
            const quiet = now - Math.max(session.seen, session.lastEvent);
            const orphan = living === false
                || (living === null && session.heartbeat && quiet > session.heartbeat * 1000 * HEARTBEAT_MISSES)
                || (living === null && !session.heartbeat && quiet > (['working', 'waiting'].includes(session.task) ? QUIET_WORKING_MS : QUIET_IDLE_MS));
            if (orphan) { session.connected = false; session.endedAt = now; session.orphaned = true; changed = true; this.bury(key, session, now); }
        }
        for (const [key, grave] of this.ended) if (now - grave.at > TOMBSTONE_MS) this.ended.delete(key);
        return changed;
    }
    // Make room: the least important, longest quiet session goes.
    evict(now, provider = null) {
        const candidates = [...this.sessions.entries()].filter(([, s]) => !provider || s.provider === provider);
        candidates.sort(([, a], [, b]) => PRIORITY[shownState(a)] - PRIORITY[shownState(b)] || a.seen - b.seen);
        if (candidates[0]) this.sessions.delete(candidates[0][0]);
    }
    end(provider, session, now = Date.now()) {
        const s = this.get(provider, session); if (!s || !s.connected) return false;
        s.connected = false; s.endedAt = now; this.bury(this.key(provider, session), s, now); return true;
    }
    list() { return [...this.sessions.values()]; }
    // Per provider: its sessions, most urgent first, and the state its indicator shows.
    // `present(session)`: false once the agent's app has closed its windows
    // while its process lives on in the background (a desktop app in the tray).
    // Such a session shows only while it works or waits; idle or finished, it
    // has nothing to say and its indicator goes.
    // A finished task that was not looked at yet stays „done“ (viewState),
    // as Herdr keeps it: the indicator stays green until you have seen it.
    providers({showIdle = true, enabled = () => true, present = () => true} = {}) {
        const groups = new Map();
        for (const session of this.sessions.values()) {
            if (!enabled(session.provider)) continue;
            const state = viewState(session);
            if (state === 'idle' && !showIdle) continue;
            if (!present(session) && (state === 'idle' || state === 'completed')) continue;
            if (!groups.has(session.provider)) groups.set(session.provider, []);
            groups.get(session.provider).push(session);
        }
        return [...groups.entries()].map(([provider, sessions]) => {
            sessions.sort((a, b) => PRIORITY[viewState(b)] - PRIORITY[viewState(a)] || b.lastActivity - a.lastActivity);
            const live = sessions.filter(s => s.connected);
            const state = live.length ? viewState(live[0]) : 'disconnected';
            const progress = live.length === 1 && state === 'working' ? live[0].progress : null;
            const unseen = live.filter(s => viewState(s) === 'completed').length;
            return {provider, name: providerName(provider), state, priority: PRIORITY[state], sessions, count: live.length, progress, unseen};
        });
    }
    // Seen: a finished task the user looked at (its window, its card) turns quiet. Returns whether anything changed.
    markSeen(provider, id = null) {
        let changed = false;
        for (const session of this.sessions.values()) {
            if (session.provider !== provider || (id !== null && session.id !== id) || !session.unseen) continue;
            session.unseen = false; changed = true;
        }
        return changed;
    }
    toJSON() { return this.list().map(s => ({...s, state: shownState(s), view: viewState(s), statusText: statusText(s)})); }
}
export const shownState = session => (session.connected ? session.task : 'disconnected');
// What the indicator and the agent card show: like shownState, but a finished
// task stays „completed“ while `unseen` (set by src/services/agents.js when
// a task finishes away from your eyes) until you looked at it.
export const viewState = session => (session.connected && session.unseen && (session.task === 'idle' || session.task === 'completed') ? 'completed' : shownState(session));

// The one window a session runs in, among its app's windows ([{title}]):
// the only window, or the only one whose title names the session's project
// folder (terminals and editors show it). Anything ambiguous gives null —
// Notchy never brings a window forward it is not sure about.
export function pickWindow(windows, project = '') {
    if (windows.length === 1) return windows[0];
    const name = String(project ?? '').trim().toLowerCase();
    if (!name || name.length < 2) return null;
    const words = title => String(title ?? '').toLowerCase().split(/[\s/\\:|·—–()[\]"'«»]+/);
    const named = windows.filter(window => words(window.title ?? window.get_title?.()).includes(name));
    return named.length === 1 ? named[0] : null;
}

// Claude Code, Codex and Antigravity hook payloads → Notchy events. Only what
// a status needs is taken: the session id, the event, a tool's name, the
// project folder's name. Prompts, tool inputs, answers and transcripts are
// never read or forwarded. Returns null for events that change nothing.
export function hookEvent(provider, payload) {
    if (!payload || typeof payload !== 'object') return null;
    const name = payload.hook_event_name ?? payload.hookEventName ?? payload.event;
    const session = payload.session_id ?? payload.conversationId ?? payload.sessionId;
    if (!name || !session) return null;
    const folder = payload.cwd ?? payload.workspacePaths?.[0] ?? '';
    const project = payload.project ?? String(folder).split('/').filter(Boolean).pop() ?? '';
    const base = {provider, session: String(session), project, source: 'hook'};
    const tool = payload.tool_name ?? payload.toolCall?.name;
    switch (`${provider}:${name}`) {
    case 'claude:SessionStart': case 'codex:SessionStart': case 'antigravity:SessionStart':
        return {...base, event: 'start'};
    case 'claude:UserPromptSubmit': case 'codex:UserPromptSubmit': case 'antigravity:PreInvocation':
        return {...base, event: 'prompt'};
    case 'claude:PreToolUse': case 'codex:PreToolUse':
        return {...base, event: 'tool', tool: String(tool ?? ''), note: tool ? 'tool' : undefined};
    case 'claude:PostToolUse': case 'claude:PostToolUseFailure': case 'claude:PostToolBatch': case 'codex:PostToolUse': case 'antigravity:PostToolUse':
    case 'claude:PermissionDenied':
        return {...base, event: 'tool', tool: '', note: ''};
    case 'antigravity:PostInvocation':
        return {...base, event: 'resume'};
    case 'claude:PermissionRequest': case 'codex:PermissionRequest':
        return {...base, event: 'waiting', tool: tool ? String(tool) : '', note: 'permission'};
    case 'claude:Notification': {
        const type = payload.notification_type;
        if (type === 'permission_prompt') return {...base, event: 'waiting', note: 'permission'};
        if (type === 'elicitation_dialog') return {...base, event: 'waiting', note: 'question'};
        if (type === 'idle_prompt') return {...base, event: 'idle'};
        return null;
    }
    case 'claude:Elicitation':
        return {...base, event: 'waiting', note: 'question'};
    case 'claude:ElicitationResult':
        return {...base, event: 'resume'};
    case 'claude:Stop': case 'codex:Stop':
        return {...base, event: 'stop'};
    case 'claude:StopFailure':
        return {...base, event: 'error', note: 'reply-failed'};
    case 'codex:Interrupt':
        return {...base, event: 'idle', note: 'interrupted'};
    case 'antigravity:Stop': {
        if (payload.error) return {...base, event: 'error', note: 'run-failed'};
        return {...base, event: payload.fullyIdle === false ? 'resume' : 'stop'};
    }
    case 'claude:SessionEnd': case 'codex:SessionEnd':
        return {...base, event: 'end'};
    default:
        return null;
    }
}
