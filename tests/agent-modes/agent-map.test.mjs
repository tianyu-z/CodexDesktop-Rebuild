import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentMap } from '../../runtime/agent-modes/agent-map.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';

const spawn = (id, target, prompt, extra = {}) => ({ id, type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'chat', receiverThreadIds: target ? [target] : [], prompt, status: 'completed', agentsStates: target ? { [target]: { status: 'running' } } : {}, ...extra });
const row = (engine, items, extra = {}) => ({ engine, turn: { id: 'turn', status: 'inProgress', items, startedAt: 100 }, runs: [], ...extra });
const chat = (...turns) => ({ id: 'chat', thread: { name: 'Build project' }, mode: 'codex', turns });
const agent = (id, prompt, parentId, extra = {}) => ({ id, type: 'dynamicToolCall', namespace: 'claude_code', tool: 'Agent', arguments: { description: prompt, prompt }, status: 'inProgress', ...(parentId ? { cdxParentToolUseId: parentId } : {}), ...extra });

test('Codex spawn, followup and wait describe one child with real dispatches and terminal state', () => {
  const graph = buildAgentMap(chat(row('codex', [spawn('call', 'child', 'Inspect auth', { model: 'gpt-test' }),
    spawn('follow', 'child', 'Check cookies too', { tool: 'sendInput' }),
    spawn('wait', 'child', null, { tool: 'wait', agentsStates: { child: { status: 'completed', message: 'Found issue' } } })])));
  assert.equal(graph.nodes.length, 2);
  const child = graph.nodes[1];
  assert.equal(child.parentId, graph.nodes[0].id);
  assert.equal(child.prompt, 'Inspect auth');
  assert.equal(child.model, 'gpt-test');
  assert.equal(child.status, 'completed');
  assert.equal(child.result, 'Found issue');
  assert.deepEqual(child.dispatches.map(call => call.tool), ['spawnAgent', 'sendInput', 'wait']);
  assert.equal(child.tokenCount, undefined);
});

test('failed and pending spawn attempts remain visible without inventing a native child', () => {
  const graph = buildAgentMap(chat(row('codex', [spawn('failed', null, 'Check UI', { status: 'failed' }), spawn('pending', null, 'Check API', { status: 'inProgress' })])));
  assert.deepEqual(graph.nodes.slice(1).map(node => node.status), ['failed', 'pending']);
  assert.equal(graph.nodes[1].sessionId, undefined);
});

test('Claude task notifications join Agent calls and retain nested parentage without including Bash tasks', () => {
  const graph = buildAgentMap(chat(row('claude', [agent('a', 'Audit'), agent('b', 'Nested check', 'a'), { id: 'shell', type: 'commandExecution', command: 'sleep 1' }], {
    runs: [{ id: 'r', nativeTasks: [
      { id: 'task-a', toolUseId: 'a', taskType: 'local_agent', status: 'completed', usage: { total_tokens: 50, duration_ms: 1234 }, summary: 'Audit done' },
      { id: 'shell', taskType: 'local_bash', status: 'running' },
    ] }], agentModels: { a: 'claude-actual' },
  })));
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes[2].parentId, graph.nodes[1].id);
  assert.equal(graph.nodes[1].status, 'completed');
  assert.equal(graph.nodes[1].tokenCount, 50);
  assert.equal(graph.nodes[1].durationMs, 1234);
  assert.equal(graph.nodes[1].model, 'claude-actual');
});

test('Both preserves distinct role attempts, scoped subagents, and frozen dispatch prompt', () => {
  const runs = ['r1', 'r2'].map((id, i) => ({ id, roleId: 'reviewer', stepId: 'review', round: 0, attempt: i + 1, engine: 'claude', status: i ? 'running' : 'failed', requestedModel: 'claude-x', dispatch: { prompt: 'Exact role input', instructions: 'Inspect only', tool: 'workflow.run', arguments: { roleId: 'reviewer' } } }));
  const graph = buildAgentMap(chat(row('both', runs.map(run => agent(`${run.id}:a`, 'Inspect nested', null, { cdxRunId: run.id, cdxEngineSource: 'claude' })), { runs, workflow: { state: {} } })));
  assert.equal(graph.nodes.length, 5);
  const roles = graph.nodes.filter(node => node.kind === 'role');
  assert.deepEqual(roles.map(node => node.attempt), [1, 2]);
  assert.equal(roles[0].prompt, 'Exact role input');
  assert.equal(roles[0].instructions, 'Inspect only');
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'subagent').map(node => node.parentId), roles.map(node => node.id));
});

test('historical engine provenance and turn choice survive current mode changes', () => {
  const first = row('claude', [agent('a', 'Old')]);
  const second = row('codex', []); second.turn.id = 'latest';
  const value = chat(first, second); value.mode = 'both';
  assert.equal(buildAgentMap(value).turnId, 'latest');
  assert.equal(buildAgentMap(value, 'turn').nodes[1].engine, 'claude');
  assert.throws(() => buildAgentMap(value, 'missing'), /turn/i);
  assert.deepEqual(buildAgentMap(chat()).nodes, []);
});

test('completed parent does not falsely mark an unresolved background subagent running or successful', () => {
  const record = row('claude', [agent('a', 'Background', null, { status: 'completed', arguments: { prompt: 'Background', run_in_background: true } })]);
  record.turn.status = 'completed';
  const graph = buildAgentMap(chat(record));
  assert.equal(graph.nodes[1].status, 'unknown');
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-map-'));
  const store = new ConversationStore(dir), calls = [];
  store.ensureThread({ id: 'chat', cwd: dir, turns: [] });
  store.putTurn('chat', row('codex', [spawn('s', 'child', 'Audit')]).turn, { engine: 'codex' });
  const native = { async request(method, params) { calls.push({ method, params });
    if (params.threadId === 'child') return { thread: { id: 'child', agentNickname: 'Ada', turns: [{ id: 'ct', status: 'completed', items: [spawn('nested', 'grandchild', 'Inspect', { senderThreadId: 'child' })] }] } };
    if (params.threadId === 'grandchild') throw new Error('Native history unavailable');
    throw new Error('Unexpected read');
  } };
  const router = new EngineRouter({ store, native, adapter: {}, emit() {} });
  t.after(async () => { await router.close(); rmSync(dir, { recursive: true, force: true }); });
  return { router, store, calls, dir };
}

test('map API reads only recorded spawned descendants and persists partial snapshots across reloads', async t => {
  const f = fixture(t);
  const graph = await f.router.request('engine/agents/read', { threadId: 'chat' });
  assert.equal(graph.nodes.length, 3);
  const child = graph.nodes.find(node => node.sessionId === 'child'), nested = graph.nodes.find(node => node.sessionId === 'grandchild');
  assert.equal(child.label, 'Audit');
  assert.equal(nested.parentId, child.id);
  assert.equal(graph.warnings.length, 1);
  assert.deepEqual(f.calls.map(call => call.params.threadId), ['child', 'grandchild']);
  assert.equal(f.store.has('child'), false);
  assert.equal(buildAgentMap(new ConversationStore(f.dir).get('chat')).nodes.length, 3);
});

test('a wait target without a recorded spawn is not read as owned history', async t => {
  const f = fixture(t);
  f.store.putTurn('chat', row('codex', [spawn('w', 'unrelated', null, { tool: 'wait' })]).turn, { engine: 'codex' });
  const graph = await f.router.request('engine/agents/read', { threadId: 'chat' });
  assert.equal(graph.nodes.length, 1);
  assert.equal(f.calls.length, 0);
});

test('forked child history cannot turn inherited ancestor spawns into new descendants', async t => {
  const f = fixture(t);
  f.router.native.request = async (method, params) => {
    assert.equal(params.threadId, 'child');
    return { thread: { id: 'child', turns: [{ id: 'turn', status: 'completed', items: [spawn('unrelated', 'other', 'Old ancestor dispatch')] }, { id: 'own', status: 'completed', items: [] }] } };
  };
  const graph = await f.router.request('engine/agents/read', { threadId: 'chat' });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.warnings.length, 0);
});

test('a stalled native child read times out without blocking independent mode reads', async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.router.native.request = () => new Promise(() => {});
  const reading = f.router.request('engine/agents/read', { threadId: 'chat' });
  const mode = await f.router.request('engine/mode/read', { threadId: 'chat' });
  assert.equal(mode.engineMode, 'codex');
  t.mock.timers.tick(3000);
  const graph = await reading;
  assert.equal(graph.nodes.length, 2);
  assert.match(graph.warnings[0], /timed out/i);
});

test('activity-only Codex records join exact raw dispatch by call id', () => {
  const record = row('codex', [{ id: 'call', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/audit' }], {
    agentHistory: { 'turn:turn': { dispatches: { call: { tool: 'collaboration.spawn_agent', arguments: { task_name: 'audit', message: 'Audit permissions', fork_turns: 'none' }, prompt: 'Audit permissions' } } } },
  });
  const graph = buildAgentMap(chat(record));
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[1].prompt, 'Audit permissions');
  assert.equal(graph.nodes[1].dispatches[0].arguments.fork_turns, 'none');
});

test('a later followup keeps the previous spawned child visible without including unrelated agents', () => {
  const first = row('codex', [spawn('initial', 'child', 'Inspect auth'), spawn('other', 'unrelated', 'Other task')]);
  const second = row('codex', [spawn('follow', 'child', 'Inspect CSS', { tool: 'followupTask' })]); second.turn.id = 'later';
  const graph = buildAgentMap(chat(first, second));
  assert.deepEqual(graph.nodes.filter(node => node.kind === 'subagent').map(node => node.sessionId), ['child']);
  assert.ok(graph.nodes[1].dispatches.some(dispatch => dispatch.arguments.prompt === 'Inspect CSS'));
});

test('old turns cannot absorb later results or descendants from a reused child', () => {
  const first = row('codex', [spawn('initial', 'child', 'Inspect auth')]); first.turn.completedAt = 110;
  const second = row('codex', [spawn('follow', 'child', 'Inspect CSS', { tool: 'followupTask' })]); second.turn.id = 'later'; second.turn.startedAt = 120;
  first.agentThreads = { '["turn:turn","codex","child"]': { readAt: Date.now(), turns: [
    { id: 'c1', status: 'completed', startedAt: 102, result: 'Auth passed', items: [] },
    { id: 'c2', status: 'completed', startedAt: 121, result: 'CSS broken', items: [spawn('later-child', 'other', 'CSS child', { senderThreadId: 'child' })] },
  ] } };
  const graph = buildAgentMap(chat(first, second), 'turn');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[1].result, 'Auth passed');
});

test('fresh native running telemetry survives parent completion', () => {
  const record = row('codex', [spawn('initial', 'child', 'Inspect')]); record.turn.status = 'completed';
  record.agentThreads = { '["turn:turn","codex","child"]': { readAt: Date.now(), turns: [{ id: 'c1', status: 'inProgress', items: [] }] } };
  assert.equal(buildAgentMap(chat(record)).nodes[1].status, 'running');
});

test('background agent duration follows task execution instead of launcher completion', () => {
  const graph = buildAgentMap(chat(row('claude', [agent('a', 'Background', null, { status: 'completed', startedAt: 1000, completedAt: 1007, durationMs: 7, arguments: { prompt: 'Background', run_in_background: true } })], {
    runs: [{ nativeTasks: [{ id: 'task', toolUseId: 'a', status: 'running', startedAt: 1002 }] }],
  })));
  assert.equal(graph.nodes[1].startedAt, 1002);
  assert.equal(graph.nodes[1].completedAt, undefined);
  assert.equal(graph.nodes[1].durationMs, undefined);
});

test('accepted workflow guidance is shown only for its actual recipients', () => {
  const record = row('both', [], { runs: [{ id: 'r', engine: 'claude', roleId: 'worker', stepId: 'work', status: 'running' }], workflow: { state: { guidance: [
    { text: 'Focus on auth', deliveries: [{ runId: 'r', status: 'accepted' }] },
    { text: 'Rejected advice', deliveries: [{ runId: 'r', status: 'failed' }] },
  ] } } });
  assert.deepEqual(buildAgentMap(chat(record)).nodes[1].dispatches.map(dispatch => dispatch.prompt), ['Focus on auth']);
});

test('Claude followup messages join a unique named recipient within their owning role', () => {
  const record = row('claude', [agent('a', 'Inspect', null, { arguments: { prompt: 'Inspect', name: 'reviewer' } }),
    { id: 'send', type: 'dynamicToolCall', namespace: 'claude_code', tool: 'SendMessage', status: 'completed', arguments: { recipient: 'reviewer', content: 'Check cookies too' } },
    { id: 'other', type: 'dynamicToolCall', namespace: 'claude_code', tool: 'SendMessage', arguments: { recipient: 'someone-else', content: 'Unrelated' } },
  ]);
  assert.deepEqual(buildAgentMap(chat(record)).nodes[1].dispatches.map(dispatch => dispatch.tool), ['Agent', 'SendMessage']);
});

test('a history replacement during a map read cannot save or return the discarded turn', async t => {
  const f = fixture(t);
  let release;
  f.router.native.request = () => new Promise(resolve => { release = resolve; });
  const reading = f.router.request('engine/agents/read', { threadId: 'chat' });
  const edited = f.store.get('chat'); edited.turns = [];
  f.store.replaceIdleHistory(edited);
  release({ thread: { id: 'child', turns: [] } });
  await assert.rejects(reading, /history changed/i);
  assert.equal(new ConversationStore(f.dir).get('chat').turns.length, 0);
});

test('current reused-agent work excludes earlier task descendants and shows its followup prompt', () => {
  const first = row('codex', [spawn('initial', 'child', 'Inspect auth')]);
  const second = row('codex', [spawn('follow', 'child', 'Inspect CSS', { tool: 'followupTask' })]); second.turn.id = 'later'; second.turn.startedAt = 120;
  second.agentThreads = { '["turn:later","codex","child"]': { readAt: Date.now(), turns: [
    { id: 'c1', status: 'completed', startedAt: 102, result: 'Auth passed', items: [spawn('old', 'oldchild', 'Inspect old auth', { senderThreadId: 'child' })] },
    { id: 'c2', status: 'inProgress', startedAt: 121, items: [] },
  ] } };
  const graph = buildAgentMap(chat(first, second));
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[1].prompt, 'Inspect CSS');
});

test('Both repeated roles retain followups to agents spawned in an earlier run of the same turn', () => {
  const runs = ['r1', 'r2'].map((id, i) => ({ id, engine: 'codex', nativeSessionId: 'session', roleId: 'worker', stepId: 'step'+i, startedAt: (100 + i * 20) * 1000, completedAt: (110 + i * 20) * 1000 }));
  const record = row('both', [spawn('s', 'child', 'Inspect auth', { cdxRunId: 'r1' }), spawn('f', 'child', 'Inspect CSS', { cdxRunId: 'r2', tool: 'followupTask' })], { runs, workflow: { state: {} } });
  const graph = buildAgentMap(chat(record));
  const children = graph.nodes.filter(node => node.kind === 'subagent');
  assert.equal(children.length, 2);
  assert.equal(children[1].parentId, 'role:r2');
  assert.equal(children[1].prompt, 'Inspect CSS');
});

test('the real map route joins activity call IDs to native public dispatch records', async t => {
  const f = fixture(t), path = join(f.dir, 'native.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'response_item', timestamp: '2026-10-02T10:00:00Z', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'call', arguments: JSON.stringify({ task_name: 'inspect', message: 'Inspect permissions', fork_turns: 'none' }) } }) + '\n');
  const value = f.store.require('chat'); value.thread.path = path;
  f.store.putTurn('chat', row('codex', [{ id: 'call', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/inspect' }]).turn, { engine: 'codex' });
  f.router.native.request = async () => ({ thread: { id: 'child', turns: [] } });
  const graph = await f.router.request('engine/agents/read', { threadId: 'chat' });
  assert.equal(graph.nodes[1].prompt, 'Inspect permissions');
  assert.equal(graph.nodes[1].dispatches[0].arguments.fork_turns, 'none');
  assert.equal(new ConversationStore(f.dir).get('chat').turns[0].agentHistory['turn:turn'].dispatches.call.prompt, 'Inspect permissions');
});

test('a running followup cannot display the previous task outcome', () => {
  const first = row('codex', [spawn('initial', 'child', 'Inspect auth', { agentsStates: { child: { status: 'completed', message: 'Auth passed' } } })]);
  const second = row('codex', [spawn('follow', 'child', 'Inspect CSS', { tool: 'followupTask' })]); second.turn.id = 'later'; second.turn.startedAt = 120;
  const child = buildAgentMap(chat(first, second)).nodes[1];
  assert.equal(child.prompt, 'Inspect CSS');
  assert.equal(child.status, 'running');
  assert.equal(child.result, undefined);
});
