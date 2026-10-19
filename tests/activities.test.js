import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityStore, Arbiter, activity, parseReport, groupEntries, classOf, sanitizeOrder, entryTitle, formatClock, remainingOf, ticking, sidePriority,
    CLASSES, MIN_DISPLAY_MS, COMPLETED_MS, ERROR_MS} from '../src/services/activityModel.js';
import {TimerSet, parseDuration, parseTimerQuery, timerName} from '../src/services/timerModel.js';
import {launcherEntryUpdate, LauncherEntries, STALE_MS} from '../src/services/progressModel.js';
import {AgentRegistry, parseEvent, hookEvent, pickWindow} from '../src/services/agentModel.js';
import {planSides} from '../src/ui/sideLayout.js';
import {useLanguage} from './i18n-helper.js';

useLanguage('de');

const T = Date.UTC(2026, 9, 19, 10);
const dl = (id, fields = {}) => activity({id, type: 'transfer', name: id, ...fields});
// The arbiter's view of a store: entries as the manager builds them.
const decide = (arbiter, store, now, options = {}) => arbiter.decide(groupEntries(store.list(), {enabled: options.group ?? true}), now, options);

test('reports from other apps are validated; nothing is invented', () => {
    for (const bad of [null, [], 'nope', {name: 'x'}, {id: 'a b', name: 'x'}, {id: 'a', name: ''}, {id: 'a', name: 'x', type: 'agent'}, {id: 'a', name: 'x', type: 'media'},
        {id: 'a', name: 'x', state: 'busy'}, {id: 'a', name: 'x', progress: 1.5}, {id: 'a', name: 'x', progress: '0.5'}, {id: 'a', name: 'x', progress: true},
        {id: 'a', name: 'x', remaining: -1}, {id: 'a', name: 'x', ttl: 1}, {id: 'a', name: 'x', icon: '../../etc/passwd'}, {id: 'a', name: 'x', app: 'firefox'},
        {id: 'a', name: 'x', actions: [{id: 'pause', label: 'P'}]}, {id: 'a', name: 'x', actions: [{id: 'Bad Id', label: 'x'}]}, {id: 'a', name: 'x', actions: 'open'}]) {
        assert.ok(parseReport(bad, T).error, JSON.stringify(bad));
    }
    const {activity: item} = parseReport({id: 'iso', name: 'Ubuntu ISO\u0007', type: 'transfer', remaining: 30, ttl: 60, actions: [{id: 'open', label: 'Öffnen'}]}, T);
    assert.equal(item.id, 'ext:iso'); assert.equal(item.name, 'Ubuntu ISO');
    assert.equal(item.progress, null, 'no progress given: none shown, never 0 %');
    assert.equal(item.deadline, T + 30000); assert.equal(item.estimate, true, 'a reporter’s remaining time is an estimate');
    assert.equal(item.expires, T + 60000);
    assert.equal(parseReport({id: 'x', name: 'x'}, T).activity.expires, T + 3600000, 'reports expire after an hour by default');
    assert.equal(parseReport({id: 'x', name: 'x', progress: 0}, T).activity.progress, 0, 'a measured 0 stays 0');
    assert.equal(parseReport({id: 'p', name: 'x', state: 'paused', remaining: 10}, T).activity.left, 10000, 'paused: the time left, no deadline');
});

test('several activities at once, each with its own lifecycle', () => {
    const store = new ActivityStore();
    let r = store.sync('ops', [dl('a'), dl('b', {progress: 0.2})], T);
    assert.deepEqual(r.transitions.map(t => t.type), ['appeared', 'appeared']);
    r = store.sync('timers', [activity({id: 't', type: 'timer', name: 'Tee', deadline: T + 60000})], T);
    assert.equal(store.list().length, 3, 'sources keep their activities apart');
    r = store.sync('ops', [dl('a'), dl('b', {progress: 0.2})], T + 10);
    assert.equal(r.changed, false, 'the same report again changes nothing');
    r = store.sync('ops', [dl('a', {progress: 0.5}), dl('b', {progress: 0.2})], T + 20);
    assert.ok(r.changed && r.transitions.length === 0, 'progress is a change, not a transition');
    // A download that stops being reported while it runs is gone at once — never „done“.
    r = store.sync('ops', [dl('b', {progress: 0.2})], T + 30);
    assert.deepEqual(r.transitions.map(t => t.type), ['removed']);
    assert.ok(!store.get('a'));
});

test('finished activities linger, then expire and do not come back while still reported', () => {
    const store = new ActivityStore(), options = {completedMs: COMPLETED_MS};
    store.sync('ops', [dl('a', {progress: 0.9})], T);
    let r = store.sync('ops', [dl('a', {state: 'completed'})], T + 100);
    assert.deepEqual(r.transitions.map(t => t.type), ['completed']);
    // The source drops it (its job ended): the finished one stays its time.
    store.sync('ops', [], T + 200);
    assert.ok(store.get('a')?.ghost, 'a finished activity outlives its source');
    assert.equal(store.nextWake(T + 200, options), COMPLETED_MS - 100);
    assert.ok(!store.expire(T + 100 + COMPLETED_MS - 1, options) && store.get('a'));
    assert.ok(store.expire(T + 100 + COMPLETED_MS, options) && !store.get('a'), 'gone after its linger');
    // A source that keeps reporting „completed“ (the agent model keeps it longer) does not revive it.
    store.sync('agents', [activity({id: 'g', type: 'agent', name: 'Claude', state: 'completed'})], T);
    store.expire(T + COMPLETED_MS, options);
    r = store.sync('agents', [activity({id: 'g', type: 'agent', name: 'Claude', state: 'completed'})], T + COMPLETED_MS + 5);
    assert.ok(!store.get('g') && !r.changed, 'an expired finished activity stays expired');
    r = store.sync('agents', [activity({id: 'g', type: 'agent', name: 'Claude', state: 'running'})], T + COMPLETED_MS + 10);
    assert.ok(store.get('g') && r.transitions[0].type === 'appeared', 'running again is a new appearance');
    // Errors stay longer.
    store.sync('ops', [dl('e', {state: 'error'})], T);
    store.expire(T + COMPLETED_MS, options);
    assert.ok(store.get('e'), 'a failure stays longer than a success');
    store.expire(T + ERROR_MS, options);
    assert.ok(!store.get('e'));
});

test('a download interrupted: the error is the source’s, the bar disappears', () => {
    const store = new ActivityStore();
    store.sync('ops', [dl('iso', {progress: 0.4})], T);
    const r = store.sync('ops', [dl('iso', {state: 'error', description: 'Netzwerk weg'})], T + 1);
    assert.deepEqual(r.transitions.map(t => t.type), ['failed']);
    assert.equal(classOf(store.get('iso')), 'error');
    // External reports expire with their ttl when their reporter vanished.
    const ext = parseReport({id: 'x', name: 'x', progress: 0.3, ttl: 5}, T).activity;
    store.put(ext, T);
    assert.ok(store.expire(T + 5000) && !store.get('ext:x'), 'a vanished reporter leaves nothing behind');
});

test('activities that end at the same moment', () => {
    const store = new ActivityStore(), arbiter = new Arbiter();
    store.sync('ops', [dl('a', {progress: 0.5}), dl('b', {progress: 0.6})], T);
    store.sync('ops', [dl('a', {state: 'completed'}), dl('b', {state: 'completed'})], T + 50);
    const grouped = groupEntries(store.list());
    assert.equal(grouped.length, 1, 'two finished transfers are one entry');
    assert.equal(entryTitle(grouped[0]), '2 Übertragungen');
    assert.equal(decide(arbiter, store, T + 50).focus.cls, 'completed');
    store.expire(T + 50 + COMPLETED_MS);
    assert.equal(decide(arbiter, store, T + 50 + COMPLETED_MS).focus, null, 'both leave together');
    const single = groupEntries(store.list(), {enabled: false});
    assert.equal(single.length, 0);
});

test('classes follow the state, then the type; the order is configurable', () => {
    assert.equal(classOf(activity({type: 'agent', state: 'waiting'})), 'attention');
    assert.equal(classOf(activity({type: 'timer', state: 'error'})), 'error');
    assert.equal(classOf(activity({type: 'transfer', state: 'completed'})), 'completed');
    assert.equal(classOf(activity({type: 'airdrop'})), 'transfer');
    assert.equal(classOf(activity({type: 'recording'})), 'timer');
    assert.equal(classOf(activity({type: 'timer', state: 'paused'})), 'timer');
    assert.equal(classOf(activity({type: 'media', state: 'paused'})), 'media');
    assert.equal(classOf(activity({type: 'agent'})), 'background');
    assert.deepEqual(sanitizeOrder(['media', 'bogus', 'media', 'timer']), ['media', 'timer', 'attention', 'error', 'completed', 'transfer', 'background']);
    assert.deepEqual(sanitizeOrder(null), CLASSES);
    assert.ok(sidePriority({cls: 'attention'}) > sidePriority({cls: 'transfer'}) && sidePriority({cls: 'background'}) >= 1);
});

test('priority changes: urgent at once, others after the minimum display time', () => {
    const store = new ActivityStore(), arbiter = new Arbiter();
    store.sync('media', [activity({id: 'media', type: 'media', name: 'Song'})], T);
    assert.equal(decide(arbiter, store, T).focus.type, 'media');
    // A download is more important than music, but waits for the minimum display time.
    store.sync('ops', [dl('iso', {progress: 0.1})], T + 500);
    let d = decide(arbiter, store, T + 500);
    assert.equal(d.focus.type, 'media'); assert.equal(d.wake, MIN_DISPLAY_MS - 500, 'its turn comes at a known time, no polling');
    d = decide(arbiter, store, T + MIN_DISPLAY_MS);
    assert.ok(d.changed && d.focus.type === 'transfer');
    // An agent that needs the user interrupts at once.
    store.sync('agents', [activity({id: 'agent:claude:a', type: 'agent', name: 'Claude Code', state: 'waiting'})], T + MIN_DISPLAY_MS + 10);
    d = decide(arbiter, store, T + MIN_DISPLAY_MS + 10);
    assert.ok(d.changed && d.focus.cls === 'attention', 'urgent events ignore the minimum display time');
    // Answered: back to what it interrupted (the download), not to the music.
    store.sync('agents', [activity({id: 'agent:claude:a', type: 'agent', name: 'Claude Code', quiet: true})], T + MIN_DISPLAY_MS + 20);
    d = arbiter.decide(groupEntries(store.list().filter(a => !a.quiet)), T + MIN_DISPLAY_MS + 20);
    assert.equal(d.focus.type, 'transfer', 'the notch returns to the interrupted activity');
});

test('hysteresis: equal activities do not take turns, a flapping one does not jump', () => {
    const store = new ActivityStore(), arbiter = new Arbiter();
    store.sync('ops', [dl('a', {progress: 0.1})], T);
    assert.equal(decide(arbiter, store, T, {group: false}).focus.id, 'a');
    store.sync('ops', [dl('a', {progress: 0.1}), dl('b', {progress: 0.9})], T + 10000);
    assert.equal(decide(arbiter, store, T + 10000, {group: false}).focus.id, 'a', 'a newer transfer of the same rank does not take over');
    // A flapping timer: completed and running in quick succession.
    const flap = new ActivityStore(), arb = new Arbiter();
    flap.sync('media', [activity({id: 'media', type: 'media', name: 'Song'})], T);
    decide(arb, flap, T);
    let switches = 0;
    for (let i = 0; i < 10; i++) {
        flap.sync('timers', i % 2 ? [] : [activity({id: 't', type: 'timer', name: 'x', deadline: T + 1e6})], T + 100 + i * 100);
        if (decide(arb, flap, T + 100 + i * 100).changed) switches++;
    }
    assert.equal(switches, 0, 'within the minimum display time nothing non-urgent takes the notch');
});

test('grouping sums only exact progress', () => {
    const exact = groupEntries([dl('a', {progress: 0.5, total: 100}), dl('b', {progress: 1, total: 300})])[0];
    assert.equal(exact.count, 2); assert.equal(exact.progress, 0.875, 'weighted by size');
    const unknown = groupEntries([dl('a', {progress: 0.5}), dl('b', {progress: 1, total: 300})])[0];
    assert.equal(unknown.progress, null, 'without every size, no combined percentage');
    const mixed = groupEntries([dl('a', {progress: 0.5}), dl('b', {state: 'error'})]);
    assert.equal(mixed.length, 2, 'different classes are not merged');
    assert.equal(groupEntries([activity({id: 'l', type: 'custom', legacy: true, name: 'x'}), activity({id: 'm', type: 'custom', legacy: true, name: 'y'})]).length, 2, 'set_activity entries keep their own line');
    const agents = groupEntries([activity({id: 'a', type: 'agent', name: 'Claude', state: 'waiting'}), activity({id: 'b', type: 'agent', name: 'Codex', state: 'waiting'})])[0];
    assert.equal(entryTitle(agents), '2 Agenten warten');
});

test('clocks, remaining time and the second hand', () => {
    assert.equal(formatClock(754000), '12:34'); assert.equal(formatClock(3723000), '1:02:03'); assert.equal(formatClock(400), '0:01'); assert.equal(formatClock(-5), '0:00');
    const running = activity({type: 'timer', deadline: T + 5000, state: 'running'});
    assert.equal(remainingOf(running, T), 5000); assert.equal(remainingOf(running, T + 9000), 0);
    assert.equal(remainingOf(activity({type: 'timer', left: 4000, state: 'paused'}), T), 4000);
    assert.equal(remainingOf(activity({type: 'transfer'}), T), null, 'unknown stays unknown');
    assert.ok(ticking(running) && ticking(activity({type: 'recording'})) && !ticking(activity({type: 'timer', left: 3, state: 'paused'})) && !ticking(dl('x', {progress: 0.4})));
});

test('timers: countdown, pause, resume, cancel, Pomodoro phases, restore', () => {
    for (const [text, ms] of [['25', 1500000], ['25m', 1500000], ['10 Minuten', 600000], ['1h30', 5400000], ['90s', 90000], ['1:30', 90000], ['1,5 h', 5400000], ['2 Std', 7200000]]) assert.equal(parseDuration(text), ms, text);
    for (const text of ['', 'abc', '0', '1:75', '25 parsecs', '48h']) assert.equal(parseDuration(text), null, text);
    assert.deepEqual(parseTimerQuery('timer 10 min Tee'), {ms: 600000, name: 'Tee'});
    assert.deepEqual(parseTimerQuery('pomo'), {pomodoro: true});
    assert.equal(parseTimerQuery('timer'), null); assert.equal(parseTimerQuery('termin'), null);
    assert.equal(timerName(300000), '5-Min.-Timer');
    const set = new TimerSet();
    const tea = set.start({ms: 60000, name: 'Tee'}, T);
    assert.equal(set.nextWake(T), 60000, 'one wake at the deadline, nothing ticks');
    assert.ok(set.pause(tea.id, T + 20000)); assert.equal(set.remaining(tea, T + 50000), 40000, 'paused time does not pass');
    assert.equal(set.nextWake(T + 20000), null);
    assert.ok(set.resume(tea.id, T + 30000)); assert.equal(tea.deadline, T + 70000);
    assert.ok(!set.resume(tea.id, T + 30000), 'resuming twice does nothing');
    assert.deepEqual(set.advance(T + 70000).map(e => e.ended), ['completed']);
    assert.equal(tea.state, 'completed');
    assert.ok(set.prune(T + 80000, 10000) && !set.get(tea.id));
    const pomo = set.start({pomodoro: true, work: 25, rest: 5}, T);
    // The Shell was away for 31 minutes: work and break ended, round two runs from the deadlines.
    assert.deepEqual(set.advance(T + 31 * 60000).map(e => e.ended), ['work', 'rest']);
    assert.equal(pomo.phase, 'work'); assert.equal(pomo.cycle, 2); assert.equal(pomo.deadline, T + 55 * 60000);
    assert.ok(set.cancel(pomo.id) && !set.get(pomo.id));
    assert.equal(set.start({ms: 500}, T), null, 'less than a second is refused');
    const saved = JSON.parse(JSON.stringify(new TimerSet().toJSON()));
    const a = new TimerSet(); a.start({ms: 600000}, T); const copy = new TimerSet(); copy.restore(JSON.parse(JSON.stringify(a.toJSON())));
    assert.equal(copy.list()[0].deadline, T + 600000, 'a running timer survives disabling Notchy');
    copy.restore({timers: [{id: 'x', kind: 'countdown', state: 'running'}, null, {id: 'y', kind: 'evil', state: 'running', deadline: 1}]});
    assert.equal(copy.list().length, 1, 'broken saved timers are skipped');
    assert.ok(saved.timers.length === 0);
    const many = new TimerSet();
    for (let i = 0; i < 10; i++) many.start({ms: 60000}, T + i);
    assert.equal(many.list().length, 8, 'at most eight timers');
});

test('progress other apps publish (LauncherEntry): only what they say', () => {
    assert.equal(launcherEntryUpdate('file:///x', {progress: 0.5}), null);
    assert.equal(launcherEntryUpdate('application://evil', {progress: 0.5}), null);
    assert.equal(launcherEntryUpdate('application://firefox.desktop', {count: 3}), null, 'counts are not progress');
    const entries = new LauncherEntries();
    assert.ok(entries.update(launcherEntryUpdate('application://google-chrome.desktop', {progress: 0.2, 'progress-visible': true}), ':1.5', T));
    assert.ok(entries.update(launcherEntryUpdate('application://google-chrome.desktop', {progress: 0.6}), ':1.5', T + 1000), 'partial updates keep the rest');
    assert.equal(entries.list(T + 1000)[0].progress, 0.6);
    // Hidden after a complete value: finished; hidden half-way: it just leaves (a cancel is no success).
    entries.update(launcherEntryUpdate('application://google-chrome.desktop', {progress: 1}), ':1.5', T + 2000);
    entries.update(launcherEntryUpdate('application://google-chrome.desktop', {'progress-visible': false}), ':1.5', T + 2100);
    assert.equal(entries.list(T + 2100)[0].state, 'completed');
    entries.update(launcherEntryUpdate('application://org.gnome.Nautilus.desktop', {progress: 0.3, 'progress-visible': true}), ':1.9', T);
    entries.update(launcherEntryUpdate('application://org.gnome.Nautilus.desktop', {'progress-visible': false}), ':1.9', T + 10);
    assert.ok(!entries.list(T + 10).some(e => e.app === 'org.gnome.Nautilus.desktop'));
    // An app that quits takes its progress along; a silent one goes stale.
    entries.update(launcherEntryUpdate('application://transmission.desktop', {progress: 0.1, 'progress-visible': true}), ':1.7', T);
    assert.ok(entries.vanished(':1.7') && !entries.list(T).some(e => e.app === 'transmission.desktop'));
    entries.update(launcherEntryUpdate('application://x.desktop', {progress: 0.1, 'progress-visible': true}), ':1.8', T);
    assert.ok(!entries.list(T + STALE_MS + 1).some(e => e.app === 'x.desktop'));
});

test('agents: parallel sessions, late events, crashes and the history of ended sessions', () => {
    const agents = new AgentRegistry();
    const hook = (provider, payload, time) => { const {event} = parseEvent({...hookEvent(provider, payload), time}, time); return agents.apply(event, time); };
    hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: '/p/Notchy'}, T);
    hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 'b', cwd: '/p/Website'}, T + 1);
    let r = hook('claude', {hook_event_name: 'PermissionRequest', session_id: 'b', tool_name: 'Bash'}, T + 2);
    assert.equal(r.transition, 'waiting', 'waiting is a transition (for notifications)');
    r = hook('claude', {hook_event_name: 'StopFailure', session_id: 'a'}, T + 3);
    assert.equal(r.transition, 'error');
    r = hook('claude', {hook_event_name: 'PermissionRequest', session_id: 'b', tool_name: 'Bash'}, T + 4);
    assert.equal(r.transition, null, 'the same state again notifies nobody twice');
    assert.equal(agents.providers()[0].count, 2);
    hook('claude', {hook_event_name: 'SessionEnd', session_id: 'b'}, T + 5);
    // A late event after the end neither revives it nor shows in the history twice.
    hook('claude', {hook_event_name: 'PostToolUse', session_id: 'b'}, T + 6);
    assert.equal(agents.recent(T + 10, 600000).length, 1);
    assert.equal(agents.recent(T + 10, 600000)[0].project, 'Website');
    // A crashed process ends the session (no notification as an error: a kill is no failure).
    agents.tick(T + 20, session => (session.id === 'a' ? false : null));
    assert.equal(agents.recent(T + 30, 600000)[0].orphaned, true, 'the history knows the process was gone');
    assert.equal(agents.recent(T + 700000, 600000).length, 0, 'ended sessions leave the history after its time');
    assert.equal(agents.recent(T + 40, 0).length, 0, '0 minutes: no history');
});

test('switching to an agent only when its window is unambiguous', () => {
    const w = title => ({title});
    assert.equal(pickWindow([w('anything')], 'Notchy').title, 'anything', 'the only window of its app');
    assert.equal(pickWindow([w('matthias@pc: ~/Notchy'), w('matthias@pc: ~/Website')], 'Notchy').title, 'matthias@pc: ~/Notchy');
    assert.equal(pickWindow([w('Notchy — bash'), w('Notchy — tests')], 'Notchy'), null, 'two candidates: none');
    assert.equal(pickWindow([w('NotchyFork'), w('x')], 'Notchy'), null, 'a word, not a substring');
    assert.equal(pickWindow([w('a'), w('b')], ''), null, 'no project: no guess');
    assert.equal(pickWindow([], 'Notchy'), null);
});

test('indicators: a maximum, urgent ones kept, very narrow bars', () => {
    const items = [{id: 'airpods', order: 0, priority: 6, preferred: 'right', width: 26}, {id: 'agent:claude', order: 1, priority: 5, width: 26},
        {id: 'agent:codex', order: 2, priority: 3, width: 26}, {id: 'activity:t', order: 3, priority: 1.6, width: 26}, {id: 'shelf', order: 4, priority: 0.5, preferred: 'right', width: 40}];
    const plan = planSides(items, 400, new Map(), {max: 2, groupWidth: 30});
    const visible = [...plan.visible.left, ...plan.visible.right];
    assert.equal(visible.length, 2, 'at most two shown');
    assert.ok(visible.includes('airpods') && visible.includes('agent:claude'), 'the most urgent stay');
    assert.equal(plan.hidden.left.length + plan.hidden.right.length, 3);
    assert.ok(plan.groups.left || plan.groups.right, 'the rest is in a "+N" group');
    assert.equal(planSides(items, 400, new Map(), {max: 0}).hidden.right.length + planSides(items, 400, new Map(), {max: 0}).hidden.left.length, 0, '0 = as many as fit');
    const narrow = planSides(items, 20, new Map(), {groupWidth: 30});
    assert.equal(narrow.width, 0, 'a bar too narrow for even the group shows nothing');
    // Different scale factors only change the widths; the sides stay equally wide.
    const scaled = planSides(items.map(i => ({...i, width: i.width * 2})), 400, new Map(), {groupWidth: 60});
    assert.ok(scaled.used.left <= 400 && scaled.used.right <= 400);
});
