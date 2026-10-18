import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Emitter, Lifetime} from '../lifecycle.js';
import {AgentRegistry, parseEvent, hookEvent, PROVIDERS, COMPLETED_MS} from './agentModel.js';

// How often running agent processes are checked while sessions with a
// process exist. No timer runs without sessions.
const LIVENESS_MS = 10000;
// A completed task, a fade-out and quiet sessions need a slower clock.
const TICK_MS = 1000;
const BUILTIN = Object.keys(PROVIDERS);
// A closed app window counts after this long (a window being replaced is not a close).
const AWAY_GRACE_MS = 3000;
const SHELL_PID = new Gio.Credentials().get_unix_pid();
// Sessions saved at disable come back within this time.
const RESTORE_MS = 15 * 60 * 1000;

// The agent service: sessions from hook adapters (helper/agent_hook.py),
// notchyctl and the MCP bridge arrive as events over Notchy's D-Bus interface
// (Companion: AgentEvent, AgentHook, GetAgents). This keeps them per session,
// checks the agents' processes for crashes, and tells the indicators.
// Events change state; nothing here guesses a state from a window or process.
export class Agents extends Emitter {
    constructor(extension, settings) {
        super(); this.extension = extension; this.settings = settings; this.life = new Lifetime();
        this.registry = new AgentRegistry(); this.events = new Set(); this.ticker = 0; this.liveness = 0;
        this.life.connect(settings, 'changed', (_s, key) => { if (key.startsWith('agents-')) this.changed(); });
        this.restore();
    }
    // Disabling Notchy (or logging the Shell out of a lock) must not forget
    // a task that is still running: sessions are kept for a while and come
    // back if their agent process still runs.
    restore() {
        const saved = this.extension.store?.read('agents-sessions', null);
        if (!saved || !Array.isArray(saved.sessions) || !(Date.now() - saved.at < RESTORE_MS)) return;
        for (const session of saved.sessions.slice(0, 32)) {
            if (!session?.connected || !session.provider || !session.id) continue;
            if (session.pid && !processAlive(session.pid, session.pidStart)) continue;
            const {event} = parseEvent({provider: session.provider, session: session.id, event: 'update', state: session.task, status: session.status, project: session.project,
                progress: session.progress, time: session.lastEvent || Date.now(), pid: session.pid, pidStart: session.pidStart ?? undefined, ancestors: session.ancestors, heartbeat: session.heartbeat ?? undefined, source: session.source});
            if (event) { this.registry.apply(event); const restored = this.registry.get(event.provider, event.session); if (restored) restored.started = session.started ?? restored.started; }
        }
        this.schedule();
    }
    get enabled() { return this.settings.get_boolean('agents-enabled'); }
    providerEnabled(provider) {
        if (!this.enabled) return false;
        return BUILTIN.includes(provider) ? this.settings.get_boolean(`agents-${provider}`) : true;
    }
    // Transitions for animations: {type: 'appeared' | 'completed' | 'ended', session}.
    onEvent(fn) { this.events.add(fn); return () => this.events.delete(fn); }
    emit(event) { for (const fn of [...this.events]) { try { fn(event); } catch (e) { console.error(e); } } }
    // One structured event (JSON text or object). Returns '' or an error message.
    report(input, source = null) {
        if (this.life.closed) return 'Notchy wird beendet';
        const {event, error} = parseEvent(input);
        if (error) return error;
        if (source) event.source = source;
        if (!this.providerEnabled(event.provider)) return '';
        return this.apply(event);
    }
    // A hook payload already reduced by helper/agent_hook.py.
    hook(provider, payload) {
        if (this.life.closed) return 'Notchy wird beendet';
        let data = payload;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return 'Kein gültiges JSON'; } }
        const mapped = hookEvent(String(provider), data);
        if (!mapped) return '';
        const {event, error} = parseEvent({...mapped, time: data.time, pid: data.pid, pidStart: data.pidStart, ancestors: data.ancestors});
        if (error) return error;
        if (!this.providerEnabled(event.provider)) return '';
        return this.apply(event);
    }
    apply(event) {
        const {changed, session, transition} = this.registry.apply(event);
        if (session?.connected && !session.hadWindow && this.hostWindows(session).length) session.hadWindow = true;
        if (transition && session) this.emit({type: transition, session});
        if (changed) { this.schedule(); this.changed(); }
        return '';
    }
    end(provider, session) { if (this.registry.end(provider, session)) { this.emit({type: 'ended', session: this.registry.get(provider, session)}); this.schedule(); this.changed(); } }
    get sessions() { return this.registry.list(); }
    providers() {
        return this.registry.providers({showIdle: this.settings.get_boolean('agents-show-idle'), enabled: provider => this.providerEnabled(provider), present: session => !session.away});
    }
    toJSON() { return this.registry.toJSON(); }
    // The clocks run only while there is something to watch.
    schedule() {
        const any = this.registry.sessions.size > 0;
        if (any && !this.ticker) this.ticker = this.life.every(TICK_MS, () => this.tick());
        else if (!any && this.ticker) { this.life.cancel(this.ticker); this.ticker = 0; }
        const processes = this.registry.list().some(s => s.connected && s.pid);
        if (processes && !this.liveness) this.liveness = this.life.every(LIVENESS_MS, () => this.checkProcesses());
        else if (!processes && this.liveness) { this.life.cancel(this.liveness); this.liveness = 0; }
    }
    tick(alive = () => null) {
        const before = new Set(this.registry.list().filter(s => s.connected).map(s => s));
        let changed = this.registry.tick(Date.now(), alive, {completedMs: Math.max(2, this.settings.get_int('agents-completed-seconds')) * 1000 || COMPLETED_MS});
        changed = this.refreshPresence() || changed;
        for (const session of before) if (!session.connected) this.emit({type: 'ended', session});
        if (changed) this.changed();
        this.schedule();
    }
    // A session's agent process: gone, or a different process with the same
    // id (its start time differs), means the agent crashed or quit.
    checkProcesses() { this.tick(session => (session.pid ? processAlive(session.pid, session.pidStart) : null)); }
    // The windows of the app a session runs in: those of the nearest of its
    // process ancestors that owns any (the terminal, Claude, the ChatGPT app).
    hostWindows(session) {
        const byPid = new Map();
        for (const actor of global.get_window_actors()) {
            const window = actor.meta_window, pid = window?.get_pid?.();
            if (!pid || pid <= 0 || pid === SHELL_PID || window.skip_taskbar) continue;
            if (!byPid.has(pid)) byPid.set(pid, []);
            byPid.get(pid).push(window);
        }
        for (const pid of [session.pid, ...session.ancestors].filter(Boolean)) if (byPid.has(pid)) return byPid.get(pid);
        return [];
    }
    // The window that belongs to a session, when one can be named for sure:
    // its app has exactly one window.
    window(session) { const windows = this.hostWindows(session); return windows.length === 1 ? windows[0] : null; }
    // Closing an app's window while it keeps running in the background (a
    // desktop app in the tray) leaves its agent process alive and sends no
    // session end. A session whose app had a window and has none for a few
    // seconds counts as away: idle or finished, its indicator goes; working
    // or waiting, it stays (the task really runs on). The window coming back
    // brings it back. A session that never had a window (a CLI over SSH, in
    // tmux) is never away.
    refreshPresence(now = Date.now()) {
        let changed = false;
        for (const session of this.registry.list()) {
            if (!session.connected) continue;
            if (this.hostWindows(session).length) { session.hadWindow = true; session.awaySince = 0; }
            else if (session.hadWindow && !session.awaySince) session.awaySince = now;
            const away = Boolean(session.hadWindow && session.awaySince && now - session.awaySince >= AWAY_GRACE_MS);
            if (away !== Boolean(session.away)) { session.away = away; changed = true; }
        }
        return changed;
    }
    // The provider's application icon if it is installed, else Notchy's own glyph.
    appIcon(provider) {
        const system = Shell.AppSystem.get_default();
        for (const id of PROVIDERS[provider]?.app ?? []) { const app = system.lookup_app(id); if (app) return app.get_icon(); }
        return null;
    }
    dispose() {
        this.extension.store?.write('agents-sessions', {at: Date.now(), sessions: this.registry.list().filter(s => s.connected)});
        this.life.dispose(); this.events.clear(); this.listeners.clear();
    }
}

// /proc/<pid>/stat field 22 is the process start time in clock ticks.
export function processAlive(pid, start) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        if (!ok) return false;
        if (!start) return true;
        const text = new TextDecoder().decode(bytes), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        return fields[19] === String(start);
    } catch { return false; }
}
export const AGENT_DBUS = ` <method name="AgentEvent"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
 <method name="AgentHook"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
 <method name="GetAgents"><arg type="s" direction="out"/></method>
 <signal name="AgentsChanged"><arg type="s"/></signal>`;
