import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Emitter, Lifetime} from '../lifecycle.js';
import {ActivityStore, Arbiter, activity, parseReport, groupEntries, sanitizeOrder, classOf, remainingOf, finished, CAPSULE_TYPES, TYPES,
    COMPLETED_MS, MIN_DISPLAY_MS} from './activityModel.js';
import {PROVIDERS, statusText} from './agentModel.js';
import {actionText} from './operations.js';
import {_, fmt, formatPercent, onLanguageChanged} from '../i18n/core.js';

const AGENT_STATE = {working: 'running', waiting: 'waiting', completed: 'completed', error: 'error'};

// The Activity Manager: one place for everything that runs. Each source —
// a service that knows something runs — is read by a collector below and
// handed to the ActivityStore as its whole current set; external apps report
// theirs over D-Bus (ReportActivity), notchyctl or MCP. The store keeps the
// lifecycle (appeared, finished, lingering, expired), groupEntries
// summarises, the Arbiter decides what the closed notch shows. The island,
// the agent card and the capsule only draw what this says.
//
// Sources stay responsible for their own state: the agent service for
// sessions and hooks, the timers for deadlines, the file operations for
// their processes. Nothing here keeps a second status model or a second
// clock for them: one timeout wakes the manager when a lingering activity
// expires or the notch may change; sources wake it with their changes.
// A collector that throws drops only its own activities.
export class Activities extends Emitter {
    constructor(extension, settings) {
        super(); this.extension = extension; this.settings = settings; this.life = new Lifetime();
        this.store = new ActivityStore(); this.arbiter = new Arbiter(); this.focus = null; this.entries = []; this.visible = [];
        this.dirty = new Set(); this.pending = 0; this.wake = 0; this.screencastStarted = 0;
        this.transitionListeners = new Set(); this.actionListeners = new Set();
        this.collectors = {
            agents: () => this.agentActivities(), legacy: () => this.legacyActivities(), operations: () => this.operationActivities(),
            airdrop: () => this.airdropActivities(), media: () => this.mediaActivities(), recording: () => this.recordingActivities(),
            timers: () => this.timerActivities(), progress: () => this.progressActivities(), accessory: () => this.accessoryActivities(),
        };
        const watch = (service, source) => { if (service?.subscribe) this.life.cleanups.push(service.subscribe(() => this.queue(source))); };
        watch(extension.agents, 'agents'); watch(extension.productivity, 'legacy'); watch(extension.operations, 'operations'); watch(extension.airdrop, 'airdrop');
        watch(extension.media, 'media'); watch(extension.timers, 'timers'); watch(extension.launcherEntry, 'progress'); watch(extension.airpods, 'accessory');
        try { this.life.connect(Main.screenshotUI, 'notify::screencast-in-progress', () => this.queue('recording')); } catch (e) { console.warn(`Notchy activities: no screen recording state (${e.message})`); }
        this.life.connect(settings, 'changed', (_s, key) => {
            if (key.startsWith('activities-')) { if (key === 'activities-enabled') this.arbiter.reset(); this.refresh(); }
            if (key === 'media-enabled' || key.startsWith('agents-')) this.queue(key === 'media-enabled' ? 'media' : 'agents');
        });
        // Labels of actions and states are made in the interface language.
        this.life.cleanups.push(onLanguageChanged(() => this.queueAll()));
        this.queueAll();
    }
    get enabled() { return this.settings.get_boolean('activities-enabled'); }
    get options() {
        return {completedMs: Math.max(1, this.settings.get_int('activities-completed-seconds')) * 1000 || COMPLETED_MS, errorMs: 20000};
    }
    get order() { return sanitizeOrder(this.settings.get_strv('activities-priority')); }
    typeEnabled(type) { return !this.settings.get_strv('activities-disabled-types').includes(type); }
    // Transitions for animations: {type: 'appeared' | 'completed' | 'failed' | 'removed', activity}.
    onTransition(fn) { this.transitionListeners.add(fn); return () => this.transitionListeners.delete(fn); }
    // Actions an external reporter declared ({external id, action}); the companion forwards them over D-Bus.
    onAction(fn) { this.actionListeners.add(fn); return () => this.actionListeners.delete(fn); }

    queue(source) {
        if (this.life.closed) return;
        this.dirty.add(source);
        // Bursts (hook events, MPRIS chatter, progress lines) become one refresh.
        if (!this.pending) this.pending = this.life.later(0, () => { this.pending = 0; this.flush(); });
    }
    queueAll() { for (const source of Object.keys(this.collectors)) this.queue(source); }
    // Collect what changed now (the D-Bus methods answer with the new state).
    flush() {
        if (this.life.closed) return;
        this.life.cancel(this.pending); this.pending = 0;
        const now = Date.now(), transitions = [];
        let changed = false;
        for (const source of [...this.dirty]) {
            this.dirty.delete(source);
            let list = [];
            try { list = this.collectors[source]?.() ?? []; } catch (e) { console.warn(`Notchy activities (${source}): ${e.message}`); }
            const result = this.store.sync(source, list, now);
            changed = changed || result.changed; transitions.push(...result.transitions);
        }
        this.refresh(changed, transitions);
    }
    // Time passing and decisions: expired activities leave, the arbiter picks
    // the notch's activity, the next wake is set.
    refresh(changed = true, transitions = []) {
        if (this.life.closed) return;
        const now = Date.now(), options = this.options;
        changed = this.store.expire(now, options) || changed;
        this.visible = this.store.list().filter(item => this.typeEnabled(item.type));
        this.entries = groupEntries(this.visible.filter(item => CAPSULE_TYPES.has(item.type) && !item.quiet), {enabled: this.settings.get_boolean('activities-group')});
        const before = this.focus?.key ?? null;
        let wake = null;
        if (this.enabled) {
            const decision = this.arbiter.decide(this.entries, now, {order: this.order, minMs: MIN_DISPLAY_MS});
            this.focus = decision.focus; wake = decision.wake;
        } else this.focus = null;
        const expiry = this.store.nextWake(now, options);
        if (expiry !== null) wake = wake === null ? expiry : Math.min(wake, expiry);
        this.life.cancel(this.wake); this.wake = 0;
        if (wake !== null) this.wake = this.life.later(Math.max(10, Math.ceil(wake) + 10), () => { this.wake = 0; this.refresh(false); });
        for (const transition of transitions) for (const fn of [...this.transitionListeners]) { try { fn(transition); } catch (e) { console.error(e); } }
        if (changed || before !== (this.focus?.key ?? null) || transitions.length) this.changed();
    }
    // What the list shows: every visible activity, the most important first.
    list() {
        const order = this.order;
        return [...this.visible].sort((a, b) => order.indexOf(classOf(a)) - order.indexOf(classOf(b)) || b.started - a.started || (a.id < b.id ? -1 : 1));
    }

    // --- External reports -------------------------------------------------
    report(json) {
        if (this.life.closed) return _('Notchy is shutting down');
        const {activity: item, error} = parseReport(json);
        if (error) return error;
        const external = this.store.list().filter(a => a.source === 'external');
        if (!this.store.get(item.id) && external.length >= 24) return _('Too many activities from other apps');
        const result = this.store.put(item);
        this.refresh(result.changed, result.transitions);
        return '';
    }
    end(id) {
        const result = this.store.remove(`ext:${id}`);
        if (result.changed) this.refresh(true, result.transitions);
        return result.changed;
    }

    // --- Actions ----------------------------------------------------------
    // Runs an action of an activity. Returns '' or a message to show.
    invoke(id, action) {
        const item = this.store.get(id);
        if (!item) return _('This activity has ended');
        if (action === 'dismiss') { const result = this.store.remove(id); this.refresh(result.changed, result.transitions); if (item.source === 'external') this.emitAction(item, 'dismiss'); return ''; }
        if (!item.actions.some(a => a.id === action)) return _('This action is not available');
        const ext = this.extension;
        switch (item.source) {
        case 'timers':
            if (action === 'pause') ext.timers?.pause(item.timer);
            else if (action === 'resume') ext.timers?.resume(item.timer);
            else if (action === 'cancel') ext.timers?.cancel(item.timer);
            return '';
        case 'operations': return action === 'cancel' && ext.operations?.cancel(item.job) ? '' : _('This action is not available');
        case 'recording':
            Main.screenshotUI.stopScreencast?.().catch?.(e => console.warn(`Notchy: ${e.message}`));
            return '';
        case 'media': ext.media?.call('PlayPause'); return '';
        case 'agents': {
            const session = ext.agents?.registry.get(item.provider, item.session), window = session ? ext.agents.window(session) : null;
            if (!window) return _('The agent’s window cannot be named for sure');
            Main.activateWindow(window); return '';
        }
        case 'external': this.emitAction(item, action); return '';
        default: return _('This action is not available');
        }
    }
    emitAction(item, action) { for (const fn of [...this.actionListeners]) { try { fn(item.external, action); } catch (e) { console.error(e); } } }

    // --- Collectors (one per source) --------------------------------------
    agentActivities() {
        const agents = this.extension.agents;
        if (!agents?.enabled) return [];
        return agents.providers().flatMap(group => group.sessions.filter(s => s.connected && AGENT_STATE[s.task]).map(s => activity({
            id: `agent:${s.provider}:${s.id}`, type: 'agent', name: group.name, icon: PROVIDERS[s.provider]?.icon ?? 'notchy-agent-symbolic',
            description: [s.project, statusText(s)].filter(Boolean).join(' · '), state: AGENT_STATE[s.task], progress: s.task === 'working' ? s.progress ?? null : null,
            started: s.started, provider: s.provider, session: s.id,
            // A working agent has its own indicator; it takes the notch only when it needs you, finished or failed.
            quiet: s.task === 'working',
            actions: agents.window(s) ? [{id: 'switch', label: _('Switch')}] : []})));
    }
    // set_activity / notchyctl activity: a name and a status line. Their
    // progress is optional and 0 by default, so 0 means unknown.
    legacyActivities() {
        return [...(this.extension.productivity?.activities.values() ?? [])].map(item => activity({id: `legacy:${item.name}`, type: 'custom', legacy: true, name: item.name,
            description: item.status, progress: item.progress > 0 ? item.progress : null, expires: item.expires, icon: 'system-run-symbolic'}));
    }
    operationActivities() {
        return [...(this.extension.operations?.jobs.values() ?? [])].map(job => activity({id: `op:${job.id}`, type: 'operation', job: job.id, name: job.name ? `${actionText(job.action)} · ${job.name}` : actionText(job.action),
            description: job.state === 'running' ? '' : job.message, state: job.state, progress: job.state === 'running' ? job.progress : null, started: job.started,
            icon: 'adwaita:package-x-generic-symbolic', actions: job.state === 'running' ? [{id: 'cancel', label: _('Cancel')}] : []}));
    }
    airdropActivities() {
        const airdrop = this.extension.airdrop; if (!airdrop) return [];
        const base = {id: 'airdrop', type: 'airdrop', name: 'AirDrop', icon: 'notchy-airdrop-symbolic'};
        if (airdrop.sendProc) return [activity({...base, description: airdrop.send?.peer ? fmt(_('To %s'), airdrop.send.peer) : _('Looking for an iPhone…')})];
        if (airdrop.progress !== null) return [activity({...base, description: _('Receiving'), progress: airdrop.progress / 100})];
        if (airdrop.state === 'restoring') return [activity({...base, icon: 'network-wireless-acquiring-symbolic', description: _('Wi-Fi reconnecting…')})];
        if (airdrop.receiving || airdrop.active) return [activity({...base, description: airdrop.state === 'waking' ? _('Starting…') : airdrop.state === 'unreachable' ? _('No iPhone') : _('Visible')})];
        return [];
    }
    mediaActivities() {
        const state = this.settings.get_boolean('media-enabled') ? this.extension.media?.state : null;
        if (!state) return [];
        return [activity({id: 'media', type: 'media', name: state.title || state.name, description: state.artist || state.album || state.name, state: state.playing ? 'running' : 'paused',
            icon: 'audio-x-generic-symbolic', app: state.desktopEntry ? `${state.desktopEntry}.desktop` : '', actions: [{id: 'playpause', label: state.playing ? _('Pause') : _('Play')}]})];
    }
    // GNOME's own screen recorder (the screenshot UI): its running time, and its stop.
    recordingActivities() {
        const ui = Main.screenshotUI;
        if (!ui?.screencast_in_progress) { this.screencastStarted = 0; return []; }
        this.screencastStarted ||= Date.now();
        return [activity({id: 'recording', type: 'recording', name: _('Screen recording'), icon: 'media-record-symbolic', started: this.screencastStarted,
            actions: typeof ui.stopScreencast === 'function' ? [{id: 'stop', label: _('Stop')}] : []})];
    }
    timerActivities() {
        return (this.extension.timers?.list() ?? []).map(timer => activity({id: `timer:${timer.id}`, type: 'timer', timer: timer.id, name: timer.name,
            description: timer.kind === 'pomodoro' ? (timer.phase === 'work' ? fmt(_('Focus · round %d'), timer.cycle) : _('Break')) : '',
            state: timer.state, deadline: timer.deadline, left: timer.left, duration: timer.duration, started: timer.started, icon: 'alarm-symbolic',
            actions: timer.state === 'running' ? [{id: 'pause', label: _('Pause')}, {id: 'cancel', label: _('Cancel')}]
                : timer.state === 'paused' ? [{id: 'resume', label: _('Resume')}, {id: 'cancel', label: _('Cancel')}] : []}));
    }
    // Progress other apps publish (src/services/launcherEntry.js): the fraction they report, nothing more.
    progressActivities() {
        const source = this.extension.launcherEntry; if (!source) return [];
        return source.list().map(entry => {
            const app = source.app(entry.app);
            return activity({id: `entry:${entry.app}`, type: 'transfer', app: entry.app, name: app?.get_name() ?? entry.app.replace(/\.desktop$/, ''),
                description: _('Progress reported by the app'), state: entry.state, progress: entry.progress, started: entry.started, icon: 'folder-download-symbolic'});
        });
    }
    accessoryActivities() {
        const state = this.settings.get_boolean('airpods-enabled') ? this.extension.airpods?.state : null;
        if (!state?.connected) return [];
        const {left, right, single} = state.battery ?? {};
        const level = single ?? (left === null || left === undefined ? right : right === null || right === undefined ? left : Math.min(left, right));
        return [activity({id: 'airpods', type: 'accessory', name: state.name, icon: 'notchy-airpods-symbolic', quiet: true,
            description: level === null || level === undefined ? _('Connected') : fmt(_('Connected · %s'), formatPercent(level))})];
    }

    // What GetLiveActivities answers: the activities in their shown order,
    // the one the notch shows, nothing beyond what the list itself shows.
    toJSON() {
        const now = Date.now(), order = this.order;
        return {enabled: this.enabled, focus: this.focus ? {key: this.focus.key, ids: this.focus.members.map(m => m.external ?? m.id)} : null,
            activities: this.list().map(item => ({id: item.external ?? item.id, type: item.type, class: classOf(item), priority: order.indexOf(classOf(item)), name: item.name,
                description: item.description, state: item.state, progress: item.progress, started: item.started, updated: item.updated,
                remaining: remainingOf(item, now) === null ? null : Math.round(remainingOf(item, now) / 1000), estimate: item.estimate, app: item.app,
                actions: [...item.actions.map(a => a.id), ...(finished(item) || item.source === 'external' ? ['dismiss'] : [])], source: item.source}))};
    }
    dispose() { this.life.dispose(); this.transitionListeners.clear(); this.actionListeners.clear(); this.listeners.clear(); }
}
export {TYPES};
