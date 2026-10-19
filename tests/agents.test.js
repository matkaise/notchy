import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEvent, AgentRegistry, hookEvent, shownState, statusText, stateText, COMPLETED_MS, QUIET_IDLE_MS, QUIET_WORKING_MS, GONE_MS, TOMBSTONE_MS, PRIORITY} from '../src/services/agentModel.js';
import {useLanguage} from './i18n-helper.js';

useLanguage('de');

const T = Date.UTC(2026, 9, 18, 10);
const ev = (fields, now = T) => { const {event, error} = parseEvent({time: now, ...fields}, now); if (error) throw Error(error); return event; };
const hook = (provider, payload, time) => ev({...hookEvent(provider, payload), time}, time);

test('events are validated: provider, session, state, progress', () => {
    for (const bad of [null, [], 'nope', {provider: 'Claude Code', session: 'a'}, {provider: 'claude'}, {provider: 'claude', session: 'a', event: 'explode'},
        {provider: 'claude', session: 'a', state: 'busy'}, {provider: 'claude', session: 'a', progress: 2}, {provider: 'claude', session: 'a', progress: Number.NaN},
        {provider: 'claude', session: 'a', progress: true}, {provider: 'claude', session: 'a', event: 'update'}]) assert.ok(parseEvent(bad).error, JSON.stringify(bad));
    const {event} = parseEvent('{"provider":"claude","session":"s\\u0007x","event":"update","state":"working","status":"' + 'x'.repeat(500) + '","progress":0.25}');
    assert.equal(event.session, 's x'); assert.equal(event.status.length, 140); assert.equal(event.progress, 0.25); assert.equal(event.state, 'working');
});
test('one Claude Code session through its hooks: prompt, tools, approval, answer, end', () => {
    const agents = new AgentRegistry(), s = 'sess-1';
    let r = agents.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: s, cwd: '/home/m/Notchy'}, T), T);
    assert.equal(r.transition, 'appeared'); assert.equal(shownState(r.session), 'idle', 'a started session is idle, not working');
    assert.equal(r.session.project, 'Notchy');
    agents.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'secret plan'}, T + 1), T + 1);
    assert.equal(shownState(agents.get('claude', s)), 'working');
    assert.ok(!JSON.stringify(agents.toJSON()).includes('secret'), 'prompts are never kept');
    agents.apply(hook('claude', {hook_event_name: 'PreToolUse', session_id: s, tool_name: 'Bash', tool_input: {command: 'rm -rf /tmp/x'}}, T + 2), T + 2);
    assert.equal(statusText(agents.get('claude', s)), 'Werkzeug: Bash'); assert.equal(agents.get('claude', s).note, 'tool', 'the status is stored as an id, not as text');
    assert.ok(!JSON.stringify(agents.toJSON()).includes('rm -rf'));
    agents.apply(hook('claude', {hook_event_name: 'Notification', session_id: s, notification_type: 'permission_prompt'}, T + 3), T + 3);
    assert.equal(shownState(agents.get('claude', s)), 'waiting');
    agents.apply(hook('claude', {hook_event_name: 'PostToolUse', session_id: s, tool_name: 'Bash'}, T + 4), T + 4);
    assert.equal(shownState(agents.get('claude', s)), 'working', 'approval given: working again, even between tools');
    r = agents.apply(hook('claude', {hook_event_name: 'Stop', session_id: s}, T + 5), T + 5);
    assert.equal(r.transition, 'completed'); assert.equal(shownState(r.session), 'completed');
    agents.tick(T + 5 + COMPLETED_MS);
    assert.equal(shownState(agents.get('claude', s)), 'idle', 'completed turns idle after a moment');
    r = agents.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: s, reason: 'prompt_input_exit'}, T + 9000), T + 9000);
    assert.equal(r.transition, 'ended'); assert.equal(shownState(r.session), 'disconnected');
    agents.tick(T + 9000 + GONE_MS);
    assert.equal(agents.list().length, 0, 'an ended session leaves after its fade');
});
test('two parallel Claude Code sessions and Claude, Codex and Antigravity at once', () => {
    const agents = new AgentRegistry();
    agents.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 'a'}, T), T);
    agents.apply(hook('claude', {hook_event_name: 'PermissionRequest', session_id: 'b', tool_name: 'Edit'}, T + 1), T + 1);
    agents.apply(hook('codex', {hook_event_name: 'UserPromptSubmit', session_id: 'c'}, T + 2), T + 2);
    agents.apply(hook('antigravity', {hook_event_name: 'PreInvocation', conversationId: 'd', workspacePaths: ['/w/app']}, T + 3), T + 3);
    const groups = Object.fromEntries(agents.providers().map(g => [g.provider, g]));
    assert.deepEqual(Object.keys(groups).sort(), ['antigravity', 'claude', 'codex']);
    assert.equal(groups.claude.count, 2); assert.equal(groups.claude.state, 'waiting', 'the most urgent session decides the indicator');
    assert.equal(groups.claude.sessions[0].id, 'b'); assert.equal(statusText(groups.claude.sessions[0]), 'Freigabe für Edit');
    assert.equal(groups.antigravity.sessions[0].project, 'app');
    assert.ok(PRIORITY.waiting > PRIORITY.error && PRIORITY.error > PRIORITY.working && PRIORITY.working > PRIORITY.idle);
});
test('events arriving out of order do not turn a finished task back to working', () => {
    const agents = new AgentRegistry();
    agents.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 'a'}, T), T);
    agents.apply(hook('claude', {hook_event_name: 'Stop', session_id: 'a'}, T + 20), T + 20);
    const late = agents.apply(hook('claude', {hook_event_name: 'PostToolUse', session_id: 'a'}, T + 10), T + 30);
    assert.equal(shownState(late.session), 'completed');
    // A hook for an already ended session does not bring it back.
    agents.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: 'a'}, T + 40), T + 40);
    agents.tick(T + 40 + GONE_MS);
    assert.equal(agents.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: 'a'}, T + 41), T + 50).session, null);
    // Repeated events change nothing.
    agents.apply(hook('codex', {hook_event_name: 'UserPromptSubmit', session_id: 'x'}, T), T);
    assert.equal(agents.apply(hook('codex', {hook_event_name: 'PreToolUse', session_id: 'x', tool_name: 'shell'}, T + 1), T + 1).changed, true);
    assert.equal(agents.apply(hook('codex', {hook_event_name: 'PreToolUse', session_id: 'x', tool_name: 'shell'}, T + 1), T + 1).changed, false);
});
test('crashes, missing hooks and long tasks: liveness decides, not a fixed timer', () => {
    const agents = new AgentRegistry();
    agents.apply(ev({provider: 'claude', session: 'crash', event: 'prompt', pid: 4242}), T);
    agents.apply(ev({provider: 'codex', session: 'long', event: 'prompt', pid: 4343}), T);
    agents.apply(ev({provider: 'mcp-tool', session: 'manual', event: 'update', state: 'working', source: 'mcp'}), T);
    agents.apply(ev({provider: 'cli', session: 'beat', event: 'update', state: 'working', heartbeat: 30}), T);
    const alive = s => (s.pid === 4242 ? false : s.pid === 4343 ? true : null);
    agents.tick(T + 60000, alive);
    assert.equal(shownState(agents.get('claude', 'crash')), 'disconnected', 'a crashed agent process ends its session');
    assert.equal(agents.get('claude', 'crash').orphaned, true);
    agents.tick(T + 10 * 3600 * 1000, alive);
    assert.equal(shownState(agents.get('codex', 'long')), 'working', 'a long task of a living process stays');
    assert.equal(shownState(agents.get('cli', 'beat')), 'disconnected', 'three missed heartbeats end a session');
    assert.equal(shownState(agents.get('mcp-tool', 'manual')), 'disconnected', 'a manual session nothing vouches for ends after a long quiet time');
    agents.tick(T + 10 * 3600 * 1000 + GONE_MS, alive);
    assert.equal(agents.get('mcp-tool', 'manual'), null);
    const quiet = new AgentRegistry();
    quiet.apply(ev({provider: 'cli', session: 'idle', event: 'update', state: 'idle'}), T);
    quiet.apply(ev({provider: 'cli', session: 'work', event: 'update', state: 'working'}), T);
    quiet.tick(T + QUIET_IDLE_MS + 1);
    assert.equal(shownState(quiet.get('cli', 'idle')), 'disconnected');
    assert.equal(shownState(quiet.get('cli', 'work')), 'working', 'working lasts longer than an idle session without proof');
    quiet.tick(T + QUIET_WORKING_MS + 1);
    assert.equal(shownState(quiet.get('cli', 'work')), 'disconnected');
});
test('Antigravity: invocations work, Stop completes or fails; Codex: interrupts and approvals', () => {
    const agents = new AgentRegistry();
    agents.apply(hook('antigravity', {hook_event_name: 'SessionStart', conversationId: 'g'}, T), T);
    assert.equal(shownState(agents.get('antigravity', 'g')), 'idle');
    agents.apply(hook('antigravity', {hook_event_name: 'PreInvocation', conversationId: 'g'}, T + 1), T + 1);
    agents.apply(hook('antigravity', {hook_event_name: 'PostToolUse', conversationId: 'g', toolCall: {name: 'run_command'}}, T + 2), T + 2);
    agents.apply(hook('antigravity', {hook_event_name: 'Stop', conversationId: 'g', fullyIdle: false}, T + 3), T + 3);
    assert.equal(shownState(agents.get('antigravity', 'g')), 'working', 'a Stop that leaves work pending is not a completion');
    agents.apply(hook('antigravity', {hook_event_name: 'Stop', conversationId: 'g', fullyIdle: true}, T + 4), T + 4);
    assert.equal(shownState(agents.get('antigravity', 'g')), 'completed');
    agents.apply(hook('antigravity', {hook_event_name: 'PreInvocation', conversationId: 'g'}, T + 5), T + 5);
    agents.apply(hook('antigravity', {hook_event_name: 'Stop', conversationId: 'g', error: true}, T + 6), T + 6);
    assert.equal(shownState(agents.get('antigravity', 'g')), 'error');
    agents.apply(hook('codex', {hook_event_name: 'PermissionRequest', session_id: 'c', tool_name: 'shell'}, T), T);
    assert.equal(shownState(agents.get('codex', 'c')), 'waiting');
    agents.apply(hook('codex', {hook_event_name: 'Interrupt', session_id: 'c'}, T + 1), T + 1);
    assert.equal(shownState(agents.get('codex', 'c')), 'idle');
    assert.equal(hookEvent('claude', {hook_event_name: 'Notification', session_id: 'x', notification_type: 'auth_success'}), null);
    assert.equal(hookEvent('claude', {hook_event_name: 'SessionStart'}), null, 'no session id, no event');
});
test('limits: sessions per provider and in total; progress is never invented', () => {
    const agents = new AgentRegistry();
    for (let i = 0; i < 40; i++) agents.apply(ev({provider: 'claude', session: `s${i}`, event: 'prompt'}, T + i), T + i);
    assert.ok(agents.list().length <= 12);
    const group = agents.providers()[0];
    assert.equal(group.progress, null, 'several sessions without reported progress: no progress');
    const one = new AgentRegistry();
    one.apply(ev({provider: 'codex', session: 'p', event: 'update', state: 'working', progress: 0.4}), T);
    assert.equal(one.providers()[0].progress, 0.4);
    one.apply(ev({provider: 'codex', session: 'p', event: 'prompt'}, T + 1), T + 1);
    assert.equal(one.providers()[0].progress, null, 'a new task drops the old progress');
    assert.equal(one.providers({showIdle: false}).length, 1);
    one.apply(ev({provider: 'codex', session: 'p', event: 'idle'}, T + 2), T + 2);
    assert.equal(one.providers({showIdle: false}).length, 0, 'idle agents can be hidden');
});

// The layout beside the notch.
import {planSides} from '../src/ui/sideLayout.js';
const item = (id, order, priority = 3, preferred = null, width = 26) => ({id, order, priority, preferred, width});
test('indicators: AirPods right, agents fill the emptier side, both sides balanced', () => {
    const one = planSides([item('airpods', 0, 6, 'right'), item('claude', 1)], 400);
    assert.deepEqual([one.sides.get('airpods'), one.sides.get('claude')], ['right', 'left'], 'the first agent goes where nothing is');
    const three = planSides([item('airpods', 0, 6, 'right'), item('claude', 1), item('codex', 2), item('antigravity', 3)], 400);
    assert.deepEqual(three.visible, {left: ['claude', 'codex'], right: ['airpods', 'antigravity']}, 'alternating, a tie goes left');
    assert.equal(three.used.left, three.used.right, 'both sides use the same width');
    assert.equal(three.width, 26 * 2 + 6);
});
test('indicators keep their side on updates and only rebalance a drift of two', () => {
    const items = [item('a', 0), item('b', 1), item('c', 2), item('d', 3)];
    const first = planSides(items, 400);
    const again = planSides(items.map(i => ({...i, priority: 5})), 400, first.sides);
    assert.deepEqual([...again.sides], [...first.sides], 'a state change moves nothing');
    // Both on the left were removed: the right has two more; the newest moves.
    const left = [...first.sides].filter(([, s]) => s === 'left').map(([id]) => id);
    const rest = items.filter(i => !left.includes(i.id));
    rest.push(item('e', 4)); rest.push(item('f', 5));
    const previous = new Map([...first.sides].filter(([id]) => !left.includes(id)));
    previous.set('e', 'right'); previous.set('f', 'right');
    const rebalanced = planSides(rest, 400, previous);
    assert.ok(Math.abs(rebalanced.visible.left.length - rebalanced.visible.right.length) <= 1);
    assert.ok(rebalanced.sides.get('b') === previous.get('b') || rebalanced.sides.get('d') === previous.get('d'), 'older ones stay');
});
test('without room: spill to the other side, then a +N group keeps the urgent ones', () => {
    const many = Array.from({length: 9}, (_, i) => item(`agent${i}`, i + 1, i === 7 ? 5 : 3));
    const plan = planSides([item('airpods', 0, 6, 'right'), ...many], 100, new Map(), {groupWidth: 30});
    for (const side of ['left', 'right']) assert.ok(plan.used[side] <= 100, `${side} fits (${plan.used[side]})`);
    assert.ok(plan.hidden.left.length + plan.hidden.right.length > 0, 'the rest is grouped');
    const shown = [...plan.visible.left, ...plan.visible.right];
    assert.ok(shown.includes('airpods') && shown.includes('agent7'), 'AirPods and a waiting agent stay visible');
    const narrow = planSides([item('airpods', 0, 6, 'right'), item('claude', 1)], 20);
    assert.deepEqual(narrow.visible, {left: [], right: []}, 'a very narrow screen shows no indicator');
    assert.deepEqual(narrow.groups, {left: false, right: false}, 'and no group either: it would cover other panel items');
    assert.deepEqual(narrow.used, {left: 0, right: 0});
    const spill = planSides([item('x', 0, 3, null, 26), item('y', 1, 3, null, 26), item('z', 2, 3, null, 26)], 60, new Map([['x', 'left'], ['y', 'left'], ['z', 'left']]));
    assert.deepEqual([spill.hidden.left.length, spill.hidden.right.length], [0, 0], 'what does not fit moves to the other side first');
});
test('fixed sides and automatic distribution off', () => {
    const fixed = planSides([item('claude', 1, 3, 'right'), item('codex', 2, 3, 'right')], 400);
    assert.deepEqual(fixed.visible.right, ['claude', 'codex']);
    const off = planSides([item('claude', 1), item('codex', 2)], 400, new Map(), {auto: false});
    assert.deepEqual(off.visible, {left: [], right: ['claude', 'codex']});
});
test('an app closed to the background: idle and finished sessions go, working ones stay', () => {
    const agents = new AgentRegistry();
    agents.apply(ev({provider: 'codex', session: 'idle', event: 'stop'}), T);
    agents.apply(ev({provider: 'codex', session: 'busy', event: 'prompt'}), T);
    agents.apply(ev({provider: 'claude', session: 'waits', event: 'waiting'}), T);
    const away = s => s.id !== 'nothing';
    const shown = agents.providers({present: s => !away(s)});
    assert.deepEqual(shown.map(g => [g.provider, g.sessions.map(s => s.id)]), [['codex', ['busy']], ['claude', ['waits']]]);
    assert.equal(agents.providers({present: () => true}).find(g => g.provider === 'codex').count, 2, 'with the window back both return');
});

// The lifecycle after SessionEnd: hooks run as separate processes, so steps of
// the old run can arrive after the end — with an older or even a newer time.
test('a late PostToolUse or Stop after SessionEnd never brings the agent back', () => {
    for (const late of ['PostToolUse', 'Stop', 'PreToolUse', 'Notification', 'UserPromptSubmit']) {
        const agents = new AgentRegistry(), s = `late-${late}`;
        agents.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: s}, T), T);
        agents.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: s}, T + 1), T + 1);
        agents.apply(hook('claude', {hook_event_name: 'PreToolUse', session_id: s, tool_name: 'Bash'}, T + 2), T + 2);
        let r = agents.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: s}, T + 3), T + 3);
        assert.equal(r.transition, 'ended');
        const payload = {hook_event_name: late, session_id: s, notification_type: 'permission_prompt'};
        // During the fade-out, with the same millisecond and with a newer one.
        for (const time of [T + 2, T + 3, T + 4]) {
            r = agents.apply(hook('claude', payload, time), T + 5);
            assert.equal(shownState(agents.get('claude', s)), 'disconnected', `${late} at +${time - T} during the fade`);
            assert.equal(r.transition, null);
        }
        // After the fade, when the session is gone from the list.
        agents.tick(T + 3 + GONE_MS);
        assert.equal(agents.get('claude', s), null);
        r = agents.apply(hook('claude', payload, T + 3 + GONE_MS + 500), T + 3 + GONE_MS + 600);
        assert.equal(r.session, null, `${late} after the fade does not create the session again`);
        assert.equal(agents.providers().length, 0);
    }
});
test('a new start after SessionEnd is a new generation; so is an explicit report from notchyctl or MCP', () => {
    const agents = new AgentRegistry();
    agents.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: 'r'}, T), T);
    const first = agents.get('claude', 'r').generation;
    agents.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: 'r'}, T + 1), T + 1);
    // `claude --resume` starts the same session id again, during the fade-out …
    let r = agents.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: 'r'}, T + 200), T + 200);
    assert.equal(r.transition, 'appeared'); assert.equal(shownState(r.session), 'idle');
    assert.ok(r.session.generation > first, 'a new generation');
    agents.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 'r'}, T + 300), T + 300);
    assert.equal(shownState(agents.get('claude', 'r')), 'working');
    // … and after it.
    agents.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: 'r'}, T + 400), T + 400);
    agents.tick(T + 400 + GONE_MS);
    r = agents.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: 'r'}, T + 5000), T + 5000);
    assert.equal(r.transition, 'appeared');
    // A SessionStart that is not newer than the end belongs to the old run.
    const old = new AgentRegistry();
    old.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: 'o'}, T), T);
    old.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: 'o'}, T + 10), T + 10);
    assert.equal(shownState(old.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: 'o'}, T + 10), T + 20).session), 'disconnected');
    // notchyctl: stop, then a new update for the same id — an explicit report.
    const cli = new AgentRegistry();
    cli.apply(ev({provider: 'aider', session: 'build', event: 'start', source: 'cli'}, T), T);
    cli.apply(ev({provider: 'aider', session: 'build', event: 'end', source: 'cli'}, T + 1), T + 1);
    r = cli.apply(ev({provider: 'aider', session: 'build', event: 'update', state: 'working', source: 'cli'}, T + 2), T + 2);
    assert.equal(shownState(r.session), 'working');
    // A heartbeat alone never revives anything.
    cli.apply(ev({provider: 'aider', session: 'build', event: 'end', source: 'cli'}, T + 3), T + 3);
    cli.tick(T + 3 + GONE_MS);
    assert.equal(cli.apply(ev({provider: 'aider', session: 'build', event: 'heartbeat', source: 'cli'}, T + 4), T + 3 + GONE_MS + 1).session, null);
});
test('the memory of ended sessions is bounded in time', () => {
    const agents = new AgentRegistry();
    agents.apply(hook('codex', {hook_event_name: 'SessionStart', session_id: 'z'}, T), T);
    agents.apply(hook('codex', {hook_event_name: 'SessionEnd', session_id: 'z'}, T + 1), T + 1);
    agents.tick(T + 1 + GONE_MS);
    assert.equal(agents.ended.size, 1);
    agents.tick(T + 1 + TOMBSTONE_MS + 1);
    assert.equal(agents.ended.size, 0, 'forgotten after a while');
    // Much later, the same id from a hook is simply a session again (Notchy enabled mid-session).
    const r = agents.apply(hook('codex', {hook_event_name: 'PreToolUse', session_id: 'z', tool_name: 'shell'}, T + TOMBSTONE_MS + 10), T + TOMBSTONE_MS + 10);
    assert.equal(shownState(r.session), 'working');
});
test('hook events with the same millisecond keep the order a session goes through', () => {
    // Stop and the last PostToolUse at once, arriving the wrong way round: done, not working.
    const a = new AgentRegistry();
    a.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 's'}, T), T);
    a.apply(hook('claude', {hook_event_name: 'Stop', session_id: 's'}, T + 5), T + 5);
    a.apply(hook('claude', {hook_event_name: 'PostToolUse', session_id: 's'}, T + 5), T + 6);
    assert.equal(shownState(a.get('claude', 's')), 'completed');
    // PermissionRequest and its PreToolUse at once: waiting wins whatever arrives last.
    for (const order of [['PreToolUse', 'PermissionRequest'], ['PermissionRequest', 'PreToolUse']]) {
        const b = new AgentRegistry();
        b.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 'p'}, T), T);
        for (const name of order) b.apply(hook('claude', {hook_event_name: name, session_id: 'p', tool_name: 'Bash'}, T + 7), T + 8);
        assert.equal(shownState(b.get('claude', 'p')), 'waiting', order.join(' → '));
    }
    // In the right order, steps of the same millisecond still apply.
    const c = new AgentRegistry();
    c.apply(hook('codex', {hook_event_name: 'UserPromptSubmit', session_id: 'q'}, T), T);
    c.apply(hook('codex', {hook_event_name: 'PostToolUse', session_id: 'q'}, T + 9), T + 9);
    c.apply(hook('codex', {hook_event_name: 'Stop', session_id: 'q'}, T + 9), T + 9);
    assert.equal(shownState(c.get('codex', 'q')), 'completed');
    // An explicit update of the same millisecond always applies.
    c.apply(ev({provider: 'codex', session: 'q', event: 'update', state: 'working', source: 'cli'}, T + 9), T + 10);
    assert.equal(shownState(c.get('codex', 'q')), 'working');
});
test('SessionEnd ends the session even when a step with a later time arrived first', () => {
    const agents = new AgentRegistry();
    agents.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: 'e'}, T), T);
    agents.apply(hook('claude', {hook_event_name: 'PostToolUse', session_id: 'e'}, T + 20), T + 20);
    const r = agents.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: 'e'}, T + 15), T + 21);
    assert.equal(r.transition, 'ended'); assert.equal(shownState(r.session), 'disconnected');
    // But never an end older than the session's own start (a previous run's straggler).
    const restarted = new AgentRegistry();
    restarted.apply(hook('claude', {hook_event_name: 'SessionStart', session_id: 'n'}, T + 100), T + 100);
    restarted.apply(hook('claude', {hook_event_name: 'SessionEnd', session_id: 'n'}, T + 50), T + 101);
    assert.equal(shownState(restarted.get('claude', 'n')), 'idle');
});
test('statuses are stored as ids and shown in the interface language', () => {
    const agents = new AgentRegistry();
    agents.apply(hook('claude', {hook_event_name: 'PermissionRequest', session_id: 'x', tool_name: 'Edit'}, T), T);
    const session = agents.get('claude', 'x');
    assert.deepEqual([session.note, session.tool, session.status], ['permission', 'Edit', '']);
    assert.equal(statusText(session), 'Freigabe für Edit');
    useLanguage('en');
    assert.equal(statusText(session), 'Approval for Edit'); assert.equal(stateText('working'), 'Working');
    useLanguage('de');
    agents.apply(ev({provider: 'claude', session: 'x', event: 'update', status: 'Tests laufen', source: 'cli'}, T + 1), T + 1);
    agents.apply(hook('claude', {hook_event_name: 'UserPromptSubmit', session_id: 'x'}, T + 2), T + 2);
    assert.equal(statusText(agents.get('claude', 'x')), '', 'a new task clears note and status');
    agents.apply(ev({provider: 'cli', session: 'y', event: 'update', state: 'working', status: 'Tests laufen'}, T), T);
    assert.equal(statusText(agents.get('cli', 'y')), 'Tests laufen', 'free text from notchyctl is shown as given');
    assert.equal(parseEvent({provider: 'cli', session: 'y', note: 'nonsense', state: 'idle'}).event.note, undefined, 'unknown notes are dropped');
    assert.match(parseEvent('{').error, /JSON/);
});

test('beside the notch: a group wider than the room is not drawn either', () => {
    // Room for an indicator but not for the group: nothing that would cover other panel items.
    const tight = planSides([item('a', 0), item('b', 1), item('c', 2)], 28, new Map(), {groupWidth: 30});
    for (const side of ['left', 'right']) assert.ok(tight.used[side] <= 28, `${side} (${tight.used[side]})`);
    assert.ok(!tight.groups.left && !tight.groups.right);
    // Exactly room for the group and one indicator.
    const exact = planSides([item('a', 0, 5), item('b', 1), item('c', 2), item('d', 3), item('e', 4), item('f', 5)], 30 + 6 + 26, new Map(), {groupWidth: 30});
    for (const side of ['left', 'right']) assert.equal(exact.used[side], 62, side);
    assert.ok(exact.groups.left && exact.groups.right);
    assert.deepEqual([exact.visible.left.length, exact.visible.right.length], [1, 1]);
    assert.ok([...exact.visible.left, ...exact.visible.right].includes('a'), 'the urgent one stays');
    // No room at all.
    const none = planSides([item('airpods', 0, 6, 'right'), item('claude', 1)], 0);
    assert.deepEqual([none.visible, none.groups, none.width], [{left: [], right: []}, {left: false, right: false}, 0]);
    // Different room per side (an extension's items on one side only).
    const uneven = planSides([item('a', 0), item('b', 1), item('c', 2), item('d', 3)], {left: 20, right: 200});
    assert.equal(uneven.used.left, 0); assert.ok(uneven.used.right <= 200);
    assert.deepEqual(uneven.visible.left, []); assert.equal(uneven.visible.right.length, 4, 'everything moves to the side with room');
});
test('beside the notch: AirPods with several agents on a narrow screen; one that leaves and returns at once', () => {
    const many = [item('airpods', 0, 6, 'right'), item('claude', 1, 5), item('codex', 2), item('antigravity', 3), item('aider', 4)];
    const plan = planSides(many, 90, new Map(), {groupWidth: 30});
    const shown = [...plan.visible.left, ...plan.visible.right];
    assert.ok(shown.includes('airpods') && shown.includes('claude'), 'AirPods and the waiting agent stay visible');
    for (const side of ['left', 'right']) assert.ok(plan.used[side] <= 90);
    assert.equal(new Set([...shown, ...plan.hidden.left, ...plan.hidden.right]).size, many.length, 'every indicator is either shown or in a group, never twice');
    // Codex leaves and comes back right away: it keeps its side, nothing else moves.
    const before = planSides(many, 400);
    const without = planSides(many.filter(i => i.id !== 'codex'), 400, before.sides);
    const back = planSides(many, 400, new Map([...without.sides, ['codex', before.sides.get('codex')]]));
    assert.deepEqual([...back.sides].sort(), [...before.sides].sort());
});
