import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Emitter, Lifetime} from '../lifecycle.js';
import {AgentRegistry, parseEvent, hookEvent, pickWindow, statusText, providerName, claudeUsage, codexUsage, usageWindow, PROVIDERS, COMPLETED_MS} from './agentModel.js';
import {_, fmt} from '../i18n/core.js';

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
// Codex's limits are read from the end of its newest session file, at most this often.
const CODEX_USAGE_MS = 10000, CODEX_TAIL = 512 * 1024;

// The agent service: sessions from hook adapters (helper/agent_hook.py),
// notchyctl and the MCP bridge arrive as events over Notchy's D-Bus interface
// (Companion: AgentEvent, AgentHook, GetAgents). This keeps them per session,
// checks the agents' processes for crashes, and tells the indicators.
// Events change state; nothing here guesses a state from a window or process.
export class Agents extends Emitter {
    constructor(extension, settings) {
        super(); this.extension = extension; this.settings = settings; this.life = new Lifetime();
        this.registry = new AgentRegistry(); this.events = new Set(); this.ticker = 0; this.liveness = 0;
        this.usage = {}; this.codexRead = 0;
        this.life.connect(settings, 'changed', (_s, key) => {
            if (key === 'agents-show-commands' && !settings.get_boolean(key)) for (const session of this.registry.list()) session.detail = '';
            if (key === 'agents-show-limits') this.watchUsage();
            if (key.startsWith('agents-')) this.changed();
        });
        // Looking at an agent's window counts as having seen what it finished.
        this.life.connect(global.display, 'notify::focus-window', () => this.focusChanged());
        this.restore();
        this.watchUsage();
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
        if (this.life.closed) return _('Notchy is shutting down');
        const {event, error} = parseEvent(input);
        if (error) return error;
        if (source) event.source = source;
        if (!this.providerEnabled(event.provider)) return '';
        return this.apply(event);
    }
    // A hook payload already reduced by helper/agent_hook.py.
    hook(provider, payload) {
        if (this.life.closed) return _('Notchy is shutting down');
        let data = payload;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return _('Not valid JSON'); } }
        const mapped = hookEvent(String(provider), data);
        if (!mapped) return '';
        // „Befehle anzeigen“ off: the adapter's line is dropped here, unseen.
        if (!this.settings.get_boolean('agents-show-commands')) delete mapped.detail;
        const {event, error} = parseEvent({...mapped, time: data.time, pid: data.pid, pidStart: data.pidStart, ancestors: data.ancestors});
        if (error) return error;
        if (!this.providerEnabled(event.provider)) return '';
        return this.apply(event);
    }
    apply(event) {
        const {changed, session, transition} = this.registry.apply(event);
        if (session?.connected && !session.hadWindow && this.hostWindows(session).length) session.hadWindow = true;
        // Finished while you look elsewhere: it stays „done“ until you have seen it.
        if (transition === 'completed' && session && this.settings.get_boolean('agents-done-until-seen') && !this.focused(session)) session.unseen = true;
        if (transition && session) { this.emit({type: transition, session}); this.notify(transition, session); }
        if (changed) { this.schedule(); this.changed(); }
        if (event.provider === 'codex') this.readCodexUsage();
        return '';
    }
    // Usage limits per agent, as the list shows them: [{provider, name, fiveHour, week}]
    // with each window {used, resetsAt}; a window whose reset passed is empty again.
    usageRows(now = Date.now()) {
        if (!this.enabled || !this.settings.get_boolean('agents-show-limits')) return [];
        return ['claude', 'codex'].filter(provider => this.providerEnabled(provider) && this.usage[provider]).map(provider => ({
            provider, name: providerName(provider), fiveHour: usageWindow(this.usage[provider].fiveHour, now), week: usageWindow(this.usage[provider].week, now)}))
            .filter(row => row.fiveHour || row.week);
    }
    // Claude's limits arrive in Notchy's cache from its silent status line
    // (helper/agent_status.py); Codex's are in its own session files.
    watchUsage() {
        this.usageMonitor?.cancel(); this.usageMonitor = null;
        if (!this.settings.get_boolean('agents-show-limits')) { this.usage = {}; return; }
        const folder = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchy']));
        try { folder.make_directory_with_parents(null); } catch { /* Exists. */ }
        const file = folder.get_child('agent-usage-claude.json');
        try {
            this.usageMonitor = folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this.life.connect(this.usageMonitor, 'changed', (_m, child, other) => { if ([child, other].some(f => f?.get_basename() === 'agent-usage-claude.json')) this.readClaudeUsage(file); });
            this.life.cleanups.push(() => { this.usageMonitor?.cancel(); this.usageMonitor = null; });
        } catch (e) { console.warn(`Notchy agents: ${e.message}`); }
        this.readClaudeUsage(file);
        this.codexRead = 0; this.readCodexUsage();
    }
    readClaudeUsage(file) {
        file.load_contents_async(this.life.cancellable, (f, result) => {
            let usage = null;
            try { const [, bytes] = f.load_contents_finish(result); usage = claudeUsage(new TextDecoder().decode(bytes)); } catch { return; }
            if (!usage || this.life.closed) return;
            this.usage.claude = usage; this.changed();
        });
    }
    // The end of Codex's newest session file (sessions/YYYY/MM/DD/rollout-….jsonl).
    readCodexUsage() {
        if (this.life.closed || !this.settings.get_boolean('agents-show-limits') || Date.now() - this.codexRead < CODEX_USAGE_MS) return;
        this.codexRead = Date.now();
        const newest = codexSession(GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']));
        if (!newest) return;
        newest.read_async(GLib.PRIORITY_LOW, this.life.cancellable, (f, result) => {
            let stream;
            try {
                stream = f.read_finish(result);
                const size = stream.query_info('standard::size', null).get_size();
                if (size > CODEX_TAIL) stream.seek(size - CODEX_TAIL, GLib.SeekType.SET, null);
            } catch { return; }
            stream.read_bytes_async(CODEX_TAIL, GLib.PRIORITY_LOW, this.life.cancellable, (s, done) => {
                let usage = null;
                try { usage = codexUsage(new TextDecoder().decode(s.read_bytes_finish(done).toArray())); } catch { /* Unreadable: unchanged. */ }
                try { s.close(null); } catch { /* Closed. */ }
                if (!usage || this.life.closed) return;
                this.usage.codex = usage; this.changed();
            });
        });
    }
    // Notifications for what needs the user or just ended (Settings → Agents):
    // the agent, its project folder's name and its state — never a prompt or
    // anything the agent wrote. Not while that agent's own window has the
    // focus (you are looking at it already). A click switches to the window
    // when it can be named for sure.
    notify(transition, session) {
        const kind = transition === 'appeared' ? session.task : transition;
        if (!['waiting', 'completed', 'error'].includes(kind) || !this.settings.get_boolean(`agents-notify-${kind}`)) return;
        const window = this.window(session);
        if (window && window.has_focus?.()) return;
        const name = providerName(session.provider), project = session.project ? ` · ${session.project}` : '';
        const title = kind === 'waiting' ? fmt(_('%s needs you'), name) + project : kind === 'error' ? fmt(_('%s: task failed'), name) + project : fmt(_('%s finished its task'), name) + project;
        const body = kind === 'waiting' ? [statusText(session), window ? _('Click to switch to the agent') : _('Answer in the agent’s window')].filter(Boolean).join(' · ') : statusText(session);
        // While the notch shows it (its moment, or Smart Live Activities), the notification is not a second banner or sound.
        const activities = this.extension.activities, moments = this.settings.get_boolean('agents-moments') && Boolean(this.extension.activeIsland?.());
        const quiet = moments || Boolean(activities?.enabled && activities.typeEnabled('agent') && this.extension.activeIsland?.());
        const sound = this.settings.get_boolean('agents-notify-sound') && !moments ? (kind === 'completed' ? 'complete' : kind === 'error' ? 'dialog-error' : 'message-new-instant') : null;
        this.extension.notifier?.send({title, body, icon: PROVIDERS[session.provider]?.icon ?? 'notchy-agent-symbolic', urgent: kind === 'waiting', sound, quiet,
            activate: () => { const target = this.window(session); if (target) Main.activateWindow(target); }});
    }
    // Whether the window a session runs in has the focus now.
    focused(session) {
        const focus = global.display.focus_window;
        return Boolean(focus && this.hostWindows(session).includes(focus));
    }
    focusChanged() {
        let changed = false;
        for (const session of this.registry.list()) if (session.unseen && this.focused(session)) { session.unseen = false; changed = true; }
        if (changed) this.changed();
    }
    // The agent card was shown (or a session switched to): what it finished is seen.
    markSeen(provider, id = null) { if (this.registry.markSeen(provider, id)) this.changed(); }
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
    // its app has exactly one window, or exactly one of them names the session's project.
    window(session) { return pickWindow(this.hostWindows(session), session.project); }
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

// Codex's session file written last (sessions/YYYY/MM/DD/rollout-….jsonl). Not the
// newest dated folder: a resumed conversation keeps writing to the file of the
// day it began. Compressed (.zst) files are finished ones and skipped.
const CODEX_FILES_MAX = 4000;
function codexSession(home) {
    let newest = null, newestTime = -1, seen = 0;
    const walk = (folder, depth) => {
        let items;
        try { items = folder.enumerate_children('standard::name,standard::type,time::modified', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null); } catch { return; }
        try {
            for (let info = items.next_file(null); info && seen < CODEX_FILES_MAX; info = items.next_file(null), seen++) {
                const name = info.get_name();
                if (name.startsWith('.')) continue;
                if (info.get_file_type() === Gio.FileType.DIRECTORY && depth < 3) walk(folder.get_child(name), depth + 1);
                else if (depth === 3 && info.get_file_type() === Gio.FileType.REGULAR && name.endsWith('.jsonl')) {
                    const time = info.get_modification_date_time()?.to_unix() ?? 0;
                    if (time > newestTime) { newestTime = time; newest = folder.get_child(name); }
                }
            }
        } finally { items.close(null); }
    };
    walk(Gio.File.new_for_path(GLib.build_filenamev([home, 'sessions'])), 0);
    return newest;
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
