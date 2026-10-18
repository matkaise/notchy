import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEvent, AgentRegistry, hookEvent, shownState, COMPLETED_MS, QUIET_IDLE_MS, QUIET_WORKING_MS, GONE_MS, PRIORITY} from '../src/services/agentModel.js';

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
    assert.equal(agents.get('claude', s).status, 'Werkzeug: Bash'); assert.ok(!JSON.stringify(agents.toJSON()).includes('rm -rf'));
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
    assert.equal(groups.claude.sessions[0].id, 'b'); assert.equal(groups.claude.sessions[0].status, 'Freigabe für Edit');
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
    assert.deepEqual(narrow.visible, {left: [], right: []}, 'a very narrow screen shows only groups');
    const spill = planSides([item('x', 0, 3, null, 26), item('y', 1, 3, null, 26), item('z', 2, 3, null, 26)], 60, new Map([['x', 'left'], ['y', 'left'], ['z', 'left']]));
    assert.deepEqual([spill.hidden.left.length, spill.hidden.right.length], [0, 0], 'what does not fit moves to the other side first');
});
test('fixed sides and automatic distribution off', () => {
    const fixed = planSides([item('claude', 1, 3, 'right'), item('codex', 2, 3, 'right')], 400);
    assert.deepEqual(fixed.visible.right, ['claude', 'codex']);
    const off = planSides([item('claude', 1), item('codex', 2)], 400, new Map(), {auto: false});
    assert.deepEqual(off.visible, {left: [], right: ['claude', 'codex']});
});
