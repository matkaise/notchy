import {Emitter, Lifetime} from '../lifecycle.js';
import {TimerSet, parseDuration} from './timerModel.js';
import {formatClock} from './activityModel.js';
import {_, fmt} from '../i18n/core.js';

// A finished countdown stays in the list this long.
const KEEP_MS = 10000;

// Countdown and Pomodoro timers (Thunderstorm „timer 10 min“, notchyctl
// timer, D-Bus Timer). One timeout waits for the nearest deadline; nothing
// ticks while timers run — the island draws the remaining time itself while
// it is on screen. Timers are saved with their deadlines, so a running timer
// survives disabling Notchy or restarting the Shell.
export class Timers extends Emitter {
    constructor(extension, settings) {
        super(); this.extension = extension; this.settings = settings; this.life = new Lifetime(); this.set = new TimerSet(); this.wake = 0;
        this.set.restore(extension.store?.read('timers', null));
        // Deadlines passed while Notchy was away end now, quietly (no stack of old alarms).
        this.set.advance(Date.now()); this.set.prune(Date.now(), KEEP_MS);
        this.schedule();
    }
    list() { return this.set.list(); }
    get(id) { return this.set.get(id); }
    // {ms | duration ("25m"), name} or {pomodoro: true}. Returns the timer or an error message.
    start(options = {}) {
        if (this.life.closed) return _('Notchy is shutting down');
        const pomodoro = Boolean(options.pomodoro);
        const ms = pomodoro ? 0 : options.ms ?? parseDuration(options.duration);
        if (!pomodoro && !ms) return _('Unknown duration, for example 10m, 1h30 or 90s');
        const timer = this.set.start({ms, name: options.name, pomodoro, work: this.settings.get_int('pomodoro-work-minutes'), rest: this.settings.get_int('pomodoro-break-minutes')});
        if (!timer) return _('A timer runs between one second and 24 hours');
        this.save(); this.schedule(); this.changed();
        return timer;
    }
    pause(id) { return this.done(this.set.pause(id)); }
    resume(id) { return this.done(this.set.resume(id)); }
    cancel(id) { return this.done(this.set.cancel(id)); }
    done(changed) { if (changed) { this.save(); this.schedule(); this.changed(); } return changed; }
    tick() {
        this.wake = 0;
        const now = Date.now();
        const ended = this.set.advance(now), pruned = this.set.prune(now, KEEP_MS);
        for (const {timer, ended: phase} of ended) this.announce(timer, phase);
        if (ended.length || pruned) { this.save(); this.changed(); }
        this.schedule();
    }
    announce(timer, phase) {
        const sound = this.settings.get_boolean('activities-sound') ? 'alarm-clock-elapsed' : null;
        const body = phase === 'completed' ? _('Time is up') : phase === 'work' ? fmt(_('Break: %s'), formatClock(timer.rest)) : fmt(_('Focus: %s'), formatClock(timer.work));
        this.extension.notifier?.send({title: timer.name, body, icon: 'alarm-symbolic', sound, urgent: phase === 'completed'});
    }
    schedule() {
        this.life.cancel(this.wake); this.wake = 0;
        const next = this.set.nextWake(Date.now(), KEEP_MS);
        // The timeout wakes a little after the deadline, so the timer is due.
        if (next !== null) this.wake = this.life.later(Math.min(next + 20, 2 ** 31 - 1), () => this.tick());
    }
    save() { this.extension.store?.write('timers', this.set.toJSON()); }
    dispose() { this.save(); this.life.dispose(); this.listeners.clear(); }
}
