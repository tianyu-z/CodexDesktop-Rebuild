import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { TemplateStore } from '../../runtime/agent-modes/templates/store.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const selected = { engineMode: 'both', engineModels: { codex: 'codex-x', claude: 'claude-y' }, template: { id: 'debby', revision: 1, parameters: { rounds: 1 } } };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dual-router-')), events = [], calls = [], workflows = [];
  const store = new ConversationStore(join(dir, 'conversations')), templates = new TemplateStore(join(dir, 'templates'));
  const thread = { id: 'chat', cwd: dir, turns: [], status: { type: 'idle' } };
  const native = { async request(method, params) { calls.push({ method, params });
    if (['thread/start', 'thread/read', 'thread/resume'].includes(method)) return { thread: structuredClone(thread), model: 'native-old' };
    if (method === 'thread/list') return { data: [{ ...thread }, { id: 'child' }], nextCursor: null };
    if (method.includes('/list')) return { data: [], nextCursor: null };
    return {};
  } };
  const adapter = { listModels: async () => [], close: async () => {} };
  const workflowFactory = callbacks => ({ start(options) {
    let resolve; const done = new Promise(r => { resolve = r; });
    const { onSnapshot, signal, ...config } = options;
    const record = { options, callbacks, state: { id: options.runId, status: 'running', config, runs: [], bindings: {}, events: [] }, interrupted: [], retried: [] };
    record.publish = () => options.onSnapshot(structuredClone(record.state));
    record.finish = status => { record.state.status = status; for (const run of record.state.runs) if (['running', 'awaitingApproval'].includes(run.status)) run.status = status === 'completed' ? 'completed' : 'interrupted'; record.publish(); resolve({ status }); };
    const handle = { done, snapshot: () => structuredClone(record.state), interrupt: async runId => { record.interrupted.push(runId ?? 'whole'); if (!runId) record.finish('interrupted'); }, retry: runId => { record.retried.push(runId); } };
    record.handle = handle; workflows.push(record); record.publish(); return handle;
  } });
  const router = new EngineRouter({ store, native, adapter, emit: message => events.push(message), templates, workflowFactory });
  t.after(async () => { await router.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, templates, thread, native, calls, events, workflows, router };
}
async function started(f) {
  await f.router.request('thread/start', { ...structuredClone(selected), cwd: f.dir, model: 'native-start', agentMode: 'guardian-approvals' });
  const result = await f.router.request('turn/start', { ...structuredClone(selected), threadId: 'chat', model: 'codex-current', effort: 'high', input: [{ type: 'text', text: 'Compare' }] });
  await tick(); return result;
}
const roles = () => ['codex', 'claude'].map(engine => ({ id: `${engine}-run`, roleId: engine, stepId: `answers.${engine}`, round: 0, attempt: 1, status: 'running', engine, requestedModel: engine === 'codex' ? 'codex-current' : 'claude-y', cwd: '/fixture' }));

test('both capabilities and template APIs are local and backed by versioned storage', async t => {
  const f = fixture(t);
  assert.equal((await f.router.request('engine/capabilities')).bothAvailable, true);
  const list = await f.router.request('engine/templates/list');
  assert.deepEqual(list.templates.map(row => row.id).sort(), ['debby', 'polly']);
  const text = (await f.router.request('engine/templates/export', { id: 'debby', format: 'json' })).text;
  const template = JSON.parse(text); template.id = 'mine'; template.name = 'Mine';
  const saved = await f.router.request('engine/templates/save', { template });
  assert.equal(saved.template.id, 'mine');
  assert.equal((await f.router.request('engine/templates/read', { id: 'mine' })).template.name, 'Mine');
  assert.equal((await f.router.request('engine/templates/delete', { id: 'mine' })).deleted, true);
  assert.equal((await f.router.request('engine/capabilities', { hostId: 'remote-ssh:x' })).bothAvailable, false);
});

test('both creates one public turn with a frozen template, exact two models and native policy', async t => {
  const f = fixture(t), { turn } = await started(f), w = f.workflows[0];
  assert.ok(w);
  assert.equal(w.options.models.codex, 'codex-current'); assert.equal(w.options.models.claude, 'claude-y');
  assert.equal(w.options.nativeOptions.effort, 'high'); assert.equal(w.options.template.id, 'debby');
  assert.equal(w.options.parameters.rounds, 1);
  assert.equal(f.calls.filter(row => row.method === 'turn/start').length, 0);
  assert.equal(f.calls.filter(row => row.method === 'thread/resume').length, 0, 'A fresh loaded thread has no rollout to resume before its first injection');
  const wire = f.calls.find(row => row.method === 'thread/start').params;
  assert.equal(wire.engineMode, undefined); assert.equal(wire.engineModels, undefined); assert.equal(wire.template, undefined);
  assert.equal(wire.agentMode, 'guardian-approvals');
  assert.equal(f.store.get('chat').turns.length, 1);
  assert.equal(f.store.get('chat').activeTurn.turnId, turn.id);
  await assert.rejects(f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'claude' }), /active|finish/i);
  w.finish('completed'); await tick();
  assert.equal(f.store.get('chat').activeTurn, null);
});

test('invalid both configuration and attachments fail before starting work or native threads', async t => {
  const f = fixture(t);
  await assert.rejects(f.router.request('thread/start', { ...selected, template: { id: 'missing', revision: 1, parameters: {} }, cwd: f.dir }), /template/i);
  assert.equal(f.calls.length, 0);
  await f.router.request('thread/start', { ...selected, cwd: f.dir });
  await assert.rejects(f.router.request('turn/start', { threadId: 'chat', input: [{ type: 'image', url: 'x' }] }), /attachment|input/i);
  assert.equal(f.store.get('chat').activeTurn, null);
  assert.equal(f.workflows.length, 0);
});

test('interleaved role events persist before notification with exact source on history reads', async t => {
  const f = fixture(t), { turn } = await started(f), w = f.workflows[0];
  w.state.runs = roles(); w.publish();
  for (const [index, role] of w.state.runs.entries()) w.callbacks.onEvent({ type: 'message-completed', id: `${role.id}:message`, eventId: `e${index}`, runId: role.id, engine: role.engine, roleId: role.roleId, text: `${role.engine} answer` });
  const row = f.store.get('chat').turns[0];
  assert.deepEqual(row.turn.items.slice(1).map(item => item.cdxEngineSource), ['codex', 'claude']);
  assert.equal(row.workflow.events.length, 2);
  const result = await f.router.request('engine/runs/read', { threadId: 'chat', turnId: turn.id });
  assert.equal(result.workflows[0].runs.length, 2);
  assert.equal(result.workflows[0].isLatestTurn, true);
  const history = await f.router.request('thread/read', { threadId: 'chat', includeTurns: true });
  assert.equal(history.thread.turns[0].items[1].cdxEngineSource, 'codex');
});

test('native child sessions are hidden from sidebar before and after public chat deletion', async t => {
  const f = fixture(t); await started(f); const w = f.workflows[0]; w.state.runs = roles(); w.publish();
  w.callbacks.onEvent({ type: 'session', sessionId: 'child', eventId: 'session', runId: 'codex-run', engine: 'codex', roleId: 'codex' });
  assert.deepEqual((await f.router.request('thread/list')).data.map(row => row.id), ['chat']);
  const before = f.events.length; f.router.nativeNotification({ method: 'thread/started', params: { thread: { id: 'child' } } });
  assert.equal(f.events.length, before);
  w.finish('completed'); await tick(); await f.router.request('thread/delete', { threadId: 'chat' });
  assert.deepEqual((await f.router.request('thread/list')).data.map(row => row.id), ['chat']);
});

test('role stop and whole-turn stop are correctly scoped and preserve stored partial outputs', async t => {
  const f = fixture(t), { turn } = await started(f), w = f.workflows[0]; w.state.runs = roles(); w.publish();
  await assert.rejects(f.router.request('engine/runs/interrupt', { threadId: 'chat', turnId: 'wrong', runId: 'codex-run' }), /ownership/i);
  await f.router.request('engine/runs/interrupt', { threadId: 'chat', turnId: turn.id, runId: 'codex-run' });
  assert.deepEqual(w.interrupted, ['codex-run']);
  await f.router.request('turn/interrupt', { threadId: 'chat', turnId: turn.id });
  assert.deepEqual(w.interrupted, ['codex-run', 'whole']);
  assert.equal(f.store.get('chat').activeTurn, null);
  assert.equal(f.store.get('chat').turns[0].turn.status, 'interrupted');
});

test('run APIs reject a non-local host before reading or mutating a local workflow', async t => {
  const f = fixture(t), { turn } = await started(f), w = f.workflows[0];
  w.state.runs = roles(); w.publish();
  const count = f.calls.length;
  for (const method of ['engine/runs/read', 'engine/runs/interrupt', 'engine/runs/retry']) {
    await assert.rejects(f.router.request(method, { hostId: 'remote-ssh:fixture', threadId: 'chat', turnId: turn.id, runId: 'codex-run' }), /local/i);
  }
  assert.deepEqual(w.interrupted, []); assert.deepEqual(w.retried, []);
  assert.equal(f.calls.length, count); assert.equal(f.store.get('chat').activeTurn.turnId, turn.id);
});

test('native approval results route only to the correct workflow role', async t => {
  const f = fixture(t), { turn } = await started(f), w = f.workflows[0]; w.state.runs = roles(); w.publish();
  const controller = new AbortController();
  const pending = w.callbacks.onPermission({ runId: 'codex-run', engine: 'codex', roleId: 'codex', cwd: f.dir, id: 'native-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'child', turnId: 'native-turn', itemId: 'native-item', command: 'check' }, signal: controller.signal });
  const card = f.events.at(-1);
  assert.equal(card.params.threadId, 'chat'); assert.equal(card.params.turnId, turn.id); assert.equal(card.params.cdxRunId, 'codex-run');
  assert.equal(f.router.respond({ id: card.id, result: { decision: 'accept' } }), true);
  assert.deepEqual(await pending, { decision: 'accept' });
  assert.equal(f.router.respond({ id: card.id, result: { decision: 'accept' } }), true);
  const cancelled = w.callbacks.onPermission({ runId: 'claude-run', engine: 'claude', roleId: 'claude', cwd: f.dir, id: 'cc', name: 'Bash', input: { command: 'check' }, signal: controller.signal });
  controller.abort(); assert.equal((await cancelled).decision, 'decline');
});

test('duplicate public deltas are stored and rendered only once', async t => {
  const f = fixture(t); await started(f); const w = f.workflows[0]; w.state.runs = roles(); w.publish();
  const event = { type: 'text-delta', id: 'message', eventId: 'delta-1', runId: 'codex-run', roleId: 'codex', engine: 'codex', delta: 'once' };
  w.callbacks.onEvent(event); w.callbacks.onEvent(event);
  assert.equal(f.store.get('chat').turns[0].turn.items.at(-1).text, 'once');
});

test('sidebar pagination fills past internal-only pages without losing public cursors', async t => {
  const f = fixture(t); f.router.workflow.registerInternal('child');
  const request = f.native.request;
  f.native.request = async (method, params) => method !== 'thread/list' ? request(method, params) : params.cursor
    ? { data: [{ id: 'public-later' }], nextCursor: 'after-public' }
    : { data: [{ id: 'child' }], nextCursor: 'after-child' };
  const result = await f.router.request('thread/list', { limit: 1 });
  assert.deepEqual(result.data.map(row => row.id), ['public-later']);
  assert.equal(result.nextCursor, 'after-public');
});

test('search filters persisted internal ownership using nested thread IDs and preserves public snippets', async t => {
  const f = fixture(t); f.router.workflow.registerInternal('child');
  const publicHit = { thread: { id: 'user-chat', name: 'Original user request: an ordinary user title' }, snippet: { text: 'public match', ranges: [{ start: 0, end: 6 }] } };
  f.native.request = async () => ({ data: [{ thread: { id: 'child' }, snippet: { text: 'private role prompt' } }, publicHit], nextCursor: null });
  const restarted = new EngineRouter({ store: f.store, native: f.native, adapter: f.router.adapter, emit: () => {}, templates: f.templates, workflowFactory: () => {} });
  const result = await restarted.request('thread/search', { searchTerm: 'request', limit: 20 });
  assert.deepEqual(result.data, [publicHit]);
  assert.equal(result.nextCursor, null);
  assert.ok(restarted.workflow.internal.has('child'));
});

test('search pagination fills past private pages and retains search filters and the public cursor', async t => {
  const f = fixture(t); f.router.workflow.registerInternal('child');
  const requests = [], publicHit = { thread: { id: 'public-later' }, snippet: { text: 'matching answer' } };
  f.native.request = async (method, params) => {
    requests.push({ method, params });
    return params.cursor === 'after-second-child' ? { data: [publicHit], nextCursor: 'after-public' }
      : { data: [{ thread: { id: 'child' }, snippet: { text: 'private' } }], nextCursor: params.cursor ? 'after-second-child' : 'after-first-child' };
  };
  const filters = { limit: 1, searchTerm: 'answer', archived: false, sortKey: 'updated_at', sourceKinds: ['vscode'] };
  const result = await f.router.request('thread/search', filters);
  assert.deepEqual(result.data, [publicHit]);
  assert.equal(result.nextCursor, 'after-public');
  assert.deepEqual(requests.map(({ method, params }) => ({ method, ...params })), [
    { method: 'thread/search', ...filters },
    { method: 'thread/search', ...filters, cursor: 'after-first-child' },
    { method: 'thread/search', ...filters, cursor: 'after-second-child' },
  ]);
});

test('explicit retry reopens the latest interrupted workflow using its frozen configuration', async t => {
  const f = fixture(t), { turn } = await started(f), w = f.workflows[0];
  w.state.runs = roles(); w.publish(); w.finish('interrupted'); await tick();
  await f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'claude', engineModel: 'later-choice' });
  await f.router.request('engine/runs/retry', { threadId: 'chat', turnId: turn.id, runId: 'codex-run' }); await tick();
  assert.equal(f.workflows.length, 2);
  assert.equal(f.workflows[1].options.retryRunId, 'codex-run');
  assert.equal(f.workflows[1].options.models.claude, 'claude-y');
  assert.equal(f.store.get('chat').models.claude, 'claude-y');
  assert.equal(f.store.get('chat').turns.length, 1);
});

test('real Debby scheduler persists all five roles in one turn with independent models', async t => {
  const { WorkflowScheduler } = await import('../../runtime/agent-modes/orchestration/scheduler.mjs');
  const f = fixture(t), launched = [];
  f.router.workflow.factory = callbacks => new WorkflowScheduler({ ...callbacks, runner: { start(options) {
    launched.push(options);
    const done = Promise.resolve().then(() => {
      options.onEvent({ type: 'session', sessionId: options.nativeSessionId ?? `native-${options.roleId}` });
      options.onEvent({ type: 'input-acknowledged' });
      options.onEvent({ type: 'message-completed', id: `${options.runId}:message`, text: `${options.engine} result` });
      return { status: 'completed', text: `${options.engine} result`, nativeSessionId: options.nativeSessionId ?? `native-${options.roleId}` };
    });
    return { done, interrupt: () => done };
  } } });
  const { turn } = await started(f);
  for (let i = 0; i < 100 && f.store.get('chat').activeTurn; i++) await tick();
  const row = f.store.get('chat').turns[0];
  assert.equal(row.turn.status, 'completed', row.turn.error?.message);
  assert.equal(row.turn.id, turn.id); assert.equal(launched.length, 5);
  assert.equal(row.runs.length, 5); assert.equal(row.workflow.status, 'completed');
  assert.equal(row.turn.items.filter(item => item.type === 'userMessage').length, 1);
  assert.ok(launched.filter(run => run.engine === 'codex').every(run => run.model === 'codex-current'));
  assert.ok(launched.filter(run => run.engine === 'claude').every(run => run.model === 'claude-y'));
});

test('a failed native role keeps its sibling and retries inside the same public turn', async t => {
  const { WorkflowScheduler } = await import('../../runtime/agent-modes/orchestration/scheduler.mjs');
  const f = fixture(t); let failedOnce = false; const launched = [];
  f.router.workflow.factory = callbacks => { const scheduler = new WorkflowScheduler({ ...callbacks, runner: { start(options) {
    launched.push(options);
    const status = options.engine === 'claude' && !failedOnce ? (failedOnce = true, 'failed') : 'completed';
    const done = Promise.resolve({ status, text: `${options.engine} ${status}`, ...(status === 'failed' ? { error: 'Transient provider failure' } : {}) });
    return { done, interrupt: () => done };
  } } }); return scheduler; };
  const { turn } = await started(f);
  for (let i = 0; i < 100 && f.store.get('chat').turns[0].workflow.status !== 'blocked'; i++) await tick();
  let row = f.store.get('chat').turns[0]; const failed = row.runs.find(run => run.status === 'failed');
  assert.ok(failed); assert.equal(row.runs.find(run => run.engine === 'codex').status, 'completed');
  assert.equal(f.store.get('chat').activeTurn.turnId, turn.id);
  await f.router.request('engine/runs/retry', { threadId: 'chat', turnId: turn.id, runId: failed.id });
  for (let i = 0; i < 100 && f.store.get('chat').activeTurn; i++) await tick();
  row = f.store.get('chat').turns[0];
  assert.equal(row.turn.status, 'completed', row.turn.error?.message);
  assert.equal(row.runs.length, 6); assert.equal(row.runs[1].status, 'failed');
  assert.equal(row.turn.items.filter(item => item.type === 'userMessage').length, 1);
  assert.equal(launched.filter(options => options.stepId === 'answers.codex').length, 1);
});

test('explicit workflow continuation resumes between roles without requiring a failed attempt', async t => {
  const f = fixture(t), { turn } = await started(f), w = f.workflows[0];
  w.state.runs = [{ ...roles()[0], status: 'completed', text: 'kept' }]; w.publish(); w.finish('interrupted'); await tick();
  await f.router.request('engine/runs/retry', { threadId: 'chat', turnId: turn.id }); await tick();
  assert.equal(f.workflows[1].options.resume, true);
  assert.equal(f.workflows[1].options.previousSnapshot.runs[0].text, 'kept');
  assert.equal(f.store.get('chat').turns.length, 1);
});

test('workflow reads mark historical turns ineligible after a newer public turn', async t => {
  const f = fixture(t), { turn } = await started(f), first = f.workflows[0];
  first.finish('interrupted'); await tick();
  const next = await f.router.request('turn/start', { threadId: 'chat', input: [{ type: 'text', text: 'New request' }] });
  await tick();
  const result = await f.router.request('engine/runs/read', { threadId: 'chat' });
  assert.deepEqual(result.workflows.map(row => [row.turnId, row.isLatestTurn]), [[turn.id, false], [next.turn.id, true]]);
  const historical = await f.router.request('engine/runs/read', { threadId: 'chat', turnId: turn.id });
  assert.equal(historical.workflows[0].isLatestTurn, false);
});

test('continuing after immediate stop starts the frozen workflow when no scheduler snapshot exists yet', async t => {
  const { WorkflowScheduler } = await import('../../runtime/agent-modes/orchestration/scheduler.mjs');
  const f = fixture(t), calls = [];
  f.router.workflow.factory = callbacks => new WorkflowScheduler({ ...callbacks, runner: { start(options) {
    calls.push(options); const done = Promise.resolve({ status: 'completed', text: 'result' });
    return { done, interrupt: () => done };
  } } });
  await f.router.request('thread/start', { ...selected, cwd: f.dir });
  const { turn } = await f.router.request('turn/start', { threadId: 'chat', input: [{ type: 'text', text: 'Start and stop immediately' }] });
  await f.router.request('turn/interrupt', { threadId: 'chat', turnId: turn.id });
  assert.equal(f.store.get('chat').turns[0].workflow.state, null); assert.equal(calls.length, 0);
  // The public thread exists on disk after restart, but its native session has
  // not been loaded. Native inject_items requires an explicit resume first.
  let loaded = false;
  const request = f.native.request;
  f.native.request = async (method, params) => {
    if (method === 'thread/resume') loaded = true;
    if (method === 'thread/inject_items' && !loaded) throw new Error('thread not found: chat');
    return request(method, params);
  };
  await f.router.request('engine/runs/retry', { threadId: 'chat', turnId: turn.id });
  for (let i = 0; i < 100 && f.store.get('chat').activeTurn; i++) await tick();
  const row = f.store.get('chat').turns[0];
  assert.equal(row.turn.status, 'completed', row.turn.error?.message);
  assert.equal(calls.length, 5); assert.equal(f.store.get('chat').turns.length, 1);
  assert.equal(loaded, true);
  assert.ok(calls.filter(call => call.engine === 'claude').every(call => call.model === selected.engineModels.claude));
});
