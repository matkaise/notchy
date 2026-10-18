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
const STATUS_TEXT = {working: 'Arbeitet', waiting: 'Wartet auf dich', idle: 'Bereit', completed: 'Fertig', error: 'Fehler', disconnected: 'Beendet'};
export const stateText = state => STATUS_TEXT[state] ?? '';

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
// Events may arrive slightly out of order (hooks run as separate processes);
// an event older than the newest one applied is ignored for the state.
export const CLOCK_SLACK_MS = 0;

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

// Validates and normalises one event; returns {error} or {event}.
export function parseEvent(input, now = Date.now()) {
    let raw = input;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {error: 'Kein gültiges JSON'}; } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {error: 'Ereignis muss ein Objekt sein'};
    const provider = String(raw.provider ?? '').toLowerCase();
    if (!PROVIDER_RE.test(provider)) return {error: 'Ungültiger Anbieter'};
    const session = clean(raw.session, LIMITS.session);
    if (!session) return {error: 'Session-ID fehlt'};
    const kind = String(raw.event ?? 'update');
    if (!(kind in EVENTS)) return {error: `Unbekanntes Ereignis: ${kind}`};
    let state = raw.state === undefined || raw.state === null || raw.state === '' ? null : String(raw.state);
    if (state !== null && !STATES.includes(state)) return {error: `Unbekannter Zustand: ${state}`};
    if (kind === 'update' && state === null && raw.status === undefined && raw.progress === undefined && raw.project === undefined) return {error: 'update ohne Zustand, Status oder Fortschritt'};
    let progress;
    if (raw.progress === null) progress = null;
    else if (raw.progress !== undefined) {
        const value = Number(raw.progress);
        if (typeof raw.progress === 'boolean' || !Number.isFinite(value) || value < 0 || value > 1) return {error: 'Fortschritt muss zwischen 0 und 1 liegen'};
        progress = value;
    }
    const time = Number.isFinite(raw.time) && raw.time > 0 && Math.abs(raw.time - now) < 86400000 ? Math.round(raw.time) : now;
    const pid = Number.isInteger(raw.pid) && raw.pid > 1 ? raw.pid : null;
    const ancestors = Array.isArray(raw.ancestors) ? raw.ancestors.filter(p => Number.isInteger(p) && p > 1).slice(0, LIMITS.ancestors) : [];
    const heartbeat = Number.isFinite(raw.heartbeat) && raw.heartbeat >= 5 && raw.heartbeat <= 3600 ? Math.round(raw.heartbeat) : null;
    return {event: {provider, session, kind, state: state ?? EVENTS[kind], status: raw.status === undefined ? undefined : clean(raw.status, LIMITS.text),
        project: raw.project === undefined ? undefined : clean(raw.project, LIMITS.project), progress, time, pid, pidStart: raw.pidStart === undefined ? null : clean(raw.pidStart, 24),
        ancestors, heartbeat, source: ['hook', 'cli', 'mcp'].includes(raw.source) ? raw.source : 'cli', tool: raw.tool === undefined ? undefined : clean(raw.tool, 40)}};
}

// The sessions and their states. apply() returns what changed:
// {changed: bool, session, transition: 'appeared' | 'completed' | 'ended' | null}.
export class AgentRegistry {
    constructor() { this.sessions = new Map(); }
    key(provider, session) { return `${provider}\u0000${session}`; }
    get(provider, session) { return this.sessions.get(this.key(provider, session)) ?? null; }
    apply(event, now = Date.now()) {
        const key = this.key(event.provider, event.session);
        let session = this.sessions.get(key), appeared = false;
        if (!session) {
            // An event for a session that already ended (a late hook) does not revive it.
            if (event.kind === 'end' || event.state === 'disconnected') return {changed: false, session: null, transition: null};
            if (this.sessions.size >= LIMITS.sessions) this.evict(now);
            if ([...this.sessions.values()].filter(s => s.provider === event.provider).length >= LIMITS.perProvider) this.evict(now, event.provider);
            session = {id: event.session, provider: event.provider, project: '', status: '', progress: null, task: 'idle', connected: true,
                started: event.time, lastEvent: 0, lastActivity: event.time, seen: now, completedAt: 0, endedAt: 0, pid: null, pidStart: null,
                ancestors: [], heartbeat: null, source: event.source, tool: ''};
            this.sessions.set(key, session); appeared = true;
        }
        const before = JSON.stringify(session);
        session.seen = now;
        if (event.pid) { session.pid = event.pid; session.pidStart = event.pidStart; }
        if (event.ancestors.length) session.ancestors = event.ancestors;
        if (event.heartbeat) session.heartbeat = event.heartbeat;
        if (event.project !== undefined && event.project) session.project = event.project;
        let transition = appeared ? 'appeared' : null;
        // Out of order: an older event than the newest applied one only refreshes liveness.
        const current = event.time >= session.lastEvent - CLOCK_SLACK_MS;
        if (current && event.kind !== 'heartbeat') {
            session.lastEvent = Math.max(session.lastEvent, event.time);
            if (event.state === 'disconnected') {
                session.connected = false; session.endedAt = now; transition = 'ended';
            } else if (event.state) {
                if (!session.connected) { session.connected = true; session.endedAt = 0; }
                if (event.state === 'completed' && session.task !== 'completed') transition = transition ?? 'completed';
                session.task = event.state;
                session.completedAt = event.state === 'completed' ? now : 0;
                if (event.state === 'working' || event.state === 'waiting') session.lastActivity = event.time;
                // A new task starts without the old one's progress and text.
                if (event.kind === 'prompt') { session.progress = null; session.status = ''; }
                if (event.state !== 'working') session.tool = '';
            }
            if (event.tool !== undefined) session.tool = event.tool;
            if (event.status !== undefined) session.status = event.status;
            if (event.progress !== undefined) session.progress = event.progress;
        }
        return {changed: JSON.stringify(session) !== before || appeared, session, transition};
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
            if (orphan) { session.connected = false; session.endedAt = now; session.orphaned = true; changed = true; }
        }
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
        s.connected = false; s.endedAt = now; return true;
    }
    list() { return [...this.sessions.values()]; }
    // Per provider: its sessions, most urgent first, and the state its indicator shows.
    // `present(session)`: false once the agent's app has closed its windows
    // while its process lives on in the background (a desktop app in the tray).
    // Such a session shows only while it works or waits; idle or finished, it
    // has nothing to say and its indicator goes.
    providers({showIdle = true, enabled = () => true, present = () => true} = {}) {
        const groups = new Map();
        for (const session of this.sessions.values()) {
            if (!enabled(session.provider)) continue;
            const state = shownState(session);
            if (state === 'idle' && !showIdle) continue;
            if (!present(session) && (state === 'idle' || state === 'completed')) continue;
            if (!groups.has(session.provider)) groups.set(session.provider, []);
            groups.get(session.provider).push(session);
        }
        return [...groups.entries()].map(([provider, sessions]) => {
            sessions.sort((a, b) => PRIORITY[shownState(b)] - PRIORITY[shownState(a)] || b.lastActivity - a.lastActivity);
            const live = sessions.filter(s => s.connected);
            const state = live.length ? shownState(live[0]) : 'disconnected';
            const progress = live.length === 1 && state === 'working' ? live[0].progress : null;
            return {provider, name: providerName(provider), state, priority: PRIORITY[state], sessions, count: live.length, progress};
        });
    }
    toJSON() { return this.list().map(s => ({...s, state: shownState(s)})); }
}
export const shownState = session => (session.connected ? session.task : 'disconnected');

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
        return {...base, event: 'tool', tool: String(tool ?? ''), status: tool ? `Werkzeug: ${tool}` : undefined};
    case 'claude:PostToolUse': case 'claude:PostToolUseFailure': case 'claude:PostToolBatch': case 'codex:PostToolUse': case 'antigravity:PostToolUse':
    case 'claude:PermissionDenied':
        return {...base, event: 'tool', tool: '', status: ''};
    case 'antigravity:PostInvocation':
        return {...base, event: 'resume'};
    case 'claude:PermissionRequest': case 'codex:PermissionRequest':
        return {...base, event: 'waiting', status: tool ? `Freigabe für ${tool}` : 'Freigabe nötig'};
    case 'claude:Notification': {
        const type = payload.notification_type;
        if (type === 'permission_prompt') return {...base, event: 'waiting', status: 'Freigabe nötig'};
        if (type === 'elicitation_dialog') return {...base, event: 'waiting', status: 'Frage an dich'};
        if (type === 'idle_prompt') return {...base, event: 'idle'};
        return null;
    }
    case 'claude:Elicitation':
        return {...base, event: 'waiting', status: 'Frage an dich'};
    case 'claude:ElicitationResult':
        return {...base, event: 'resume'};
    case 'claude:Stop': case 'codex:Stop':
        return {...base, event: 'stop'};
    case 'claude:StopFailure':
        return {...base, event: 'error', status: 'Antwort fehlgeschlagen'};
    case 'codex:Interrupt':
        return {...base, event: 'idle', status: 'Abgebrochen'};
    case 'antigravity:Stop': {
        if (payload.error) return {...base, event: 'error', status: 'Ausführung fehlgeschlagen'};
        return {...base, event: payload.fullyIdle === false ? 'resume' : 'stop'};
    }
    case 'claude:SessionEnd': case 'codex:SessionEnd':
        return {...base, event: 'end'};
    default:
        return null;
    }
}
