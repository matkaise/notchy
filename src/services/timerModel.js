// Countdown and Pomodoro timers: pure logic without GNOME imports (covered
// by tests/activities.test.js). A running timer is a deadline, a paused one
// the time it had left — nothing counts seconds, so a timer is exact however
// late the clock that ends it fires, and it survives disabling Notchy.
// src/services/timers.js adds the one timeout, notifications and storage.
import {_, fmt} from '../i18n/core.js';

export const LIMITS = {timers: 8, name: 40, ms: 24 * 3600 * 1000};
export const POMODORO = {work: 25, rest: 5};

// "25", "25m", "25 min", "1h30", "1 h 30 min", "90s", "1:30" (minutes:seconds),
// "1:02:03", "1,5 h", "2 Std", "10 Minuten" → milliseconds, or null.
const UNIT = {h: 3600, std: 3600, stunde: 3600, stunden: 3600, hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
    m: 60, min: 60, mins: 60, minute: 60, minuten: 60, minutes: 60,
    s: 1, sec: 1, secs: 1, sek: 1, second: 1, seconds: 1, sekunde: 1, sekunden: 1};
export function parseDuration(text) {
    const input = String(text ?? '').trim().toLowerCase().replace(/,/g, '.');
    if (!input) return null;
    let seconds = 0;
    if (/^\d+(:\d{1,2}){1,2}$/.test(input)) {
        const parts = input.split(':').map(Number);
        if (parts.slice(1).some(p => p >= 60)) return null;
        seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
    } else if (/^\d+(\.\d+)?$/.test(input)) seconds = Number(input) * 60;
    else {
        const re = /(\d+(?:\.\d+)?)\s*([a-zäöü]+)?\s*/gy;
        let match, consumed = 0, last = 60;
        while ((match = re.exec(input)) && match[0]) {
            consumed = re.lastIndex;
            const unit = match[2] ? UNIT[match[2]] : null;
            if (match[2] && !unit) return null;
            // A bare number after an hour means minutes ("1h30"), after minutes seconds.
            const factor = unit ?? (last === 3600 ? 60 : last === 60 ? 1 : null);
            if (factor === null) return null;
            seconds += Number(match[1]) * factor; last = factor;
        }
        if (consumed !== input.length) return null;
    }
    const ms = Math.round(seconds * 1000);
    return ms >= 1000 && ms <= LIMITS.ms ? ms : null;
}
// A timer's default name: "5 min timer", "Pomodoro".
export function timerName(ms) {
    const minutes = Math.round(ms / 60000);
    if (ms < 60000) return fmt(_('%d s timer'), Math.round(ms / 1000));
    return minutes % 60 || minutes < 60 ? fmt(_('%d min timer'), minutes) : fmt(_('%d h timer'), minutes / 60);
}

// The timers. Each: {id, name, kind: 'countdown' | 'pomodoro', phase: 'work' |
// 'rest' (Pomodoro), cycle, duration (this phase, ms), deadline (running) or
// left (paused), state: 'running' | 'paused' | 'completed', started, work,
// rest (Pomodoro phase lengths, ms), finishedAt}.
export class TimerSet {
    constructor() { this.timers = new Map(); this.seq = 0; }
    list() { return [...this.timers.values()]; }
    get(id) { return this.timers.get(id) ?? null; }
    // {ms, name} for a countdown, {pomodoro: true, work, rest} (minutes) for a Pomodoro.
    start(options, now = Date.now()) {
        const pomodoro = Boolean(options.pomodoro);
        const work = pomodoro ? Math.round((options.work ?? POMODORO.work) * 60000) : 0, rest = pomodoro ? Math.round((options.rest ?? POMODORO.rest) * 60000) : 0;
        const duration = pomodoro ? work : Math.round(options.ms);
        if (!(duration >= 1000 && duration <= LIMITS.ms) || (pomodoro && !(rest >= 60000 && rest <= LIMITS.ms))) return null;
        // The oldest finished, then the oldest timer makes room.
        if (this.timers.size >= LIMITS.timers) {
            const victim = this.list().sort((a, b) => (b.state === 'completed') - (a.state === 'completed') || a.started - b.started)[0];
            this.timers.delete(victim.id);
        }
        const name = String(options.name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, LIMITS.name) || (pomodoro ? 'Pomodoro' : timerName(duration));
        const timer = {id: `t${++this.seq}`, name, kind: pomodoro ? 'pomodoro' : 'countdown', phase: 'work', cycle: 1, duration, deadline: now + duration, left: null,
            state: 'running', started: now, work, rest, finishedAt: 0};
        this.timers.set(timer.id, timer);
        return timer;
    }
    pause(id, now = Date.now()) {
        const timer = this.get(id); if (timer?.state !== 'running') return false;
        timer.left = Math.max(0, timer.deadline - now); timer.deadline = null; timer.state = 'paused'; return true;
    }
    resume(id, now = Date.now()) {
        const timer = this.get(id); if (timer?.state !== 'paused') return false;
        timer.deadline = now + timer.left; timer.left = null; timer.state = 'running'; return true;
    }
    cancel(id) { return this.timers.delete(id); }
    remaining(timer, now = Date.now()) { return timer.state === 'paused' ? timer.left : timer.state === 'running' ? Math.max(0, timer.deadline - now) : 0; }
    // Deadlines passed: a countdown completes, a Pomodoro moves to its next
    // phase (work → rest → work, the cycle counting up) from the deadline, not
    // from now, so a late clock does not stretch it. Returns [{timer, ended:
    // 'completed' | 'work' | 'rest'}]: what ended, for notifications.
    advance(now = Date.now()) {
        const ended = [];
        for (const timer of this.timers.values()) {
            if (timer.state !== 'running' || timer.deadline > now) continue;
            if (timer.kind === 'countdown') {
                timer.state = 'completed'; timer.finishedAt = timer.deadline; timer.deadline = null; timer.left = 0;
                ended.push({timer, ended: 'completed'});
                continue;
            }
            // Several phases may have passed while the Shell was away.
            let deadline = timer.deadline, guard = 0;
            while (deadline <= now && guard++ < 1000) {
                ended.push({timer, ended: timer.phase});
                if (timer.phase === 'work') { timer.phase = 'rest'; timer.duration = timer.rest; } else { timer.phase = 'work'; timer.duration = timer.work; timer.cycle++; }
                deadline += timer.duration;
            }
            timer.deadline = deadline;
        }
        return ended;
    }
    // A finished countdown leaves after `keepMs`.
    prune(now = Date.now(), keepMs = 10000) {
        let changed = false;
        for (const [id, timer] of this.timers) if (timer.state === 'completed' && now - timer.finishedAt >= keepMs) { this.timers.delete(id); changed = true; }
        return changed;
    }
    // When advance() or prune() next has something to do (ms from now), or null.
    nextWake(now = Date.now(), keepMs = 10000) {
        let next = Infinity;
        for (const timer of this.timers.values()) {
            if (timer.state === 'running') next = Math.min(next, timer.deadline - now);
            if (timer.state === 'completed') next = Math.min(next, timer.finishedAt + keepMs - now);
        }
        return Number.isFinite(next) ? Math.max(0, next) : null;
    }
    toJSON() { return {seq: this.seq, timers: this.list()}; }
    // Timers saved at disable (or a Shell restart): running ones keep their deadline.
    restore(saved) {
        if (!saved || !Array.isArray(saved.timers)) return;
        this.seq = Number.isInteger(saved.seq) ? saved.seq : 0;
        for (const t of saved.timers.slice(0, LIMITS.timers)) {
            if (!t || typeof t.id !== 'string' || !['countdown', 'pomodoro'].includes(t.kind) || !['running', 'paused', 'completed'].includes(t.state)) continue;
            if (t.state === 'running' && !Number.isFinite(t.deadline)) continue;
            if (t.state === 'paused' && !Number.isFinite(t.left)) continue;
            this.timers.set(t.id, {...t, name: String(t.name ?? '').slice(0, LIMITS.name)});
        }
    }
}

// Thunderstorm's timer queries: "timer 10 min", "timer 1h30 Pizza",
// "countdown 90s", "pomodoro". The duration comes first, an optional name after it.
export const TIMER_PREFIX = /^(?:timer|countdown|kurzzeitwecker|wecker)\s+(.+)$/i;
export function parseTimerQuery(query) {
    const q = String(query ?? '').trim();
    if (q.length >= 4 && 'pomodoro'.startsWith(q.toLowerCase())) return {pomodoro: true};
    const match = TIMER_PREFIX.exec(q); if (!match) return null;
    const tokens = match[1].split(/\s+/);
    for (let n = Math.min(tokens.length, 4); n > 0; n--) {
        const ms = parseDuration(tokens.slice(0, n).join(' '));
        if (ms) return {ms, name: tokens.slice(n).join(' ').slice(0, 40)};
    }
    return null;
}
