import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';
import { TemplateStore } from '../../runtime/agent-modes/templates/store.mjs';
import { roleBindingKey } from '../../runtime/agent-modes/orchestration/scheduler.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const turn = (id, text) => ({ id, status: 'completed', items: [
  { id: `${id}:user`, type: 'userMessage', content: [{ type: 'text', text }] },
  { id: `${id}:answer`, type: 'agentMessage', text: `Answer: ${text}` },
] });
function fixture(t, engines = ['claude', 'claude', 'claude']) {
  const dir = mkdtempSync(join(tmpdir(), 'history-edit-'));
  const store = new ConversationStore(dir), calls = [], events = [], runs = [], nativeThreads = new Map();
  const rows = engines.map((engine, i) => ({ engine, turn: turn(`turn-${i}`, `MARKER-${i}`) }));
  const source = { id: 'source', cwd: dir, historyMode: 'paginated', turns: rows.filter(row => row.engine === 'codex').map(row => row.turn), status: { type: 'idle' }, createdAt: 1, updatedAt: 1 };
  nativeThreads.set(source.id, structuredClone(source));
  store.ensureThread({ ...source, turns: [] }, { mode: engines.at(-1), claudePermissionMode: 'plan' });
  for (const row of rows) store.putTurn(source.id, row.turn, { engine: row.engine });
  store.setBinding(source.id, 'claude', { sessionId: 'original-claude-session', consumedSeq: rows.length });
  store.setBinding(source.id, 'codex', { consumedSeq: Math.max(0, ...rows.map((row, i) => row.engine === 'codex' ? i + 1 : 0)) });
  store.require(source.id).nativeMaterialized = true;
  store.require(source.id).models.claude = 'claude-opus-4-6';
  store.save(store.require(source.id));
  let counter = 0;
  const native = { async request(method, params) {
    calls.push({ method, params: structuredClone(params) });
    const thread = nativeThreads.get(params.threadId);
    if (method === 'thread/read' || method === 'thread/resume') return { thread: structuredClone(thread), model: 'codex-test' };
    if (method === 'thread/turns/list') return { data: structuredClone(thread.turns), nextCursor: null };
    if (method === 'thread/fork') {
      const end = params.lastTurnId ? thread.turns.findIndex(row => row.id === params.lastTurnId) + 1 : thread.turns.length;
      assert.ok(!params.lastTurnId || end > 0, 'Synthetic Claude turn IDs must never reach native fork');
      const fork = { ...structuredClone(thread), id: `fork-${++counter}`, forkedFromId: thread.id, turns: thread.turns.slice(0, end).map((row, i) => ({ ...structuredClone(row), id: `fork-${counter}-native-${i}` })) };
      nativeThreads.set(fork.id, fork);
      return { thread: { ...structuredClone(fork), turns: [] }, model: 'codex-test', cwd: dir };
    }
    if (method === 'thread/revert' || method === 'thread/rollback') {
      const end = method === 'thread/revert' ? thread.turns.findIndex(row => row.id === params.beforeTurnId) : thread.turns.length - params.numTurns;
      assert.ok(end >= 0, 'Native history boundary must belong to Codex');
      thread.turns = thread.turns.slice(0, end);
      return { thread: structuredClone(thread) };
    }
    if (method === 'turn/start') return { turn: { ...turn('new-codex', params.input.map(x => x.text).join('\n')), status: 'inProgress' } };
    return {};
  } };
  const adapter = { start(options) {
    let finish; const done = new Promise(resolve => { finish = resolve; });
    const run = { options, done, finish, interrupt: async () => finish({ status: 'interrupted' }) };
    runs.push(run); return run;
  } };
  const router = new EngineRouter({ store, native, adapter, emit: event => events.push(event) });
  t.after(async () => { await router.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, router, native, nativeThreads, calls, events, runs, dir };
}

test('editing Claude history snapshots the old version and resumes only the retained prefix', async t => {
  const f = fixture(t);
  const snapshot = await f.router.request('thread/fork', { threadId: 'source', excludeTurns: true });
  assert.equal(snapshot.engineState.engineMode, 'claude');
  assert.equal(snapshot.engineState.claudePermissionMode, 'plan');
  assert.equal(snapshot.engineState.models.claude, 'claude-opus-4-6');
  assert.equal(f.store.get(snapshot.thread.id).bindings.claude.sessionId, null);
  assert.equal(f.store.get('source').bindings.claude.sessionId, 'original-claude-session');
  const reverted = await f.router.request('thread/rollback', { threadId: 'source', numTurns: 2 });
  assert.deepEqual(reverted.thread.turns.map(x => x.id), ['turn-0']);
  assert.equal(f.calls.filter(x => ['thread/rollback', 'thread/revert'].includes(x.method)).length, 0);
  await f.router.request('turn/start', { threadId: 'source', input: [{ type: 'text', text: 'EDITED' }] }); await tick();
  assert.equal(f.runs[0].options.nativeSessionId, null);
  assert.match(f.runs[0].options.prompt, /MARKER-0/);
  assert.doesNotMatch(f.runs[0].options.prompt, /MARKER-[12]/);
  assert.match(f.runs[0].options.prompt, /EDITED/);
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'new-claude-session' }); await tick();
  const old = await f.router.request('thread/resume', { threadId: snapshot.thread.id, excludeTurns: false });
  assert.deepEqual(old.thread.turns.map(x => x.id), ['turn-0', 'turn-1', 'turn-2']);
  const reopened = new ConversationStore(f.dir);
  assert.equal(reopened.get('source').bindings.claude.sessionId, 'new-claude-session');
  assert.equal(reopened.get(snapshot.thread.id).bindings.claude.sessionId, null);
});

test('revert accepts a Claude boundary and only truncates the native Codex suffix', async t => {
  const f = fixture(t, ['codex', 'claude', 'codex', 'claude']);
  await f.router.request('thread/revert', { threadId: 'source', beforeTurnId: 'turn-1' });
  assert.deepEqual(f.calls.filter(x => x.method === 'thread/revert').map(x => x.params), [{ threadId: 'source', beforeTurnId: 'turn-2' }]);
  assert.deepEqual(f.store.get('source').turns.map(x => x.turn.id), ['turn-0']);
  // Late notifications and a stale native snapshot must not resurrect the tail.
  f.router.nativeNotification({ method: 'turn/completed', params: { threadId: 'source', turn: turn('turn-2', 'REMOVED') } });
  f.nativeThreads.get('source').turns.push(turn('turn-2', 'REMOVED'));
  const read = await f.router.request('thread/read', { threadId: 'source', includeTurns: true });
  assert.deepEqual(read.thread.turns.map(x => x.id), ['turn-0']);
});

test('rolling back past a Codex handoff sends retained Claude context to Codex again', async t => {
  const f = fixture(t, ['codex', 'claude', 'codex']);
  await f.router.request('thread/rollback', { threadId: 'source', numTurns: 1 });
  await f.router.request('turn/start', { threadId: 'source', input: [{ type: 'text', text: 'CONTINUE' }] });
  const input = f.calls.find(x => x.method === 'turn/start').params.input;
  assert.match(input[0].text, /MARKER-1/);
  assert.doesNotMatch(input[0].text, /MARKER-2/);
});

test('fork through a Claude turn maps native IDs and keeps the public turn order', async t => {
  const f = fixture(t, ['codex', 'claude', 'codex']);
  const fork = await f.router.request('thread/fork', { threadId: 'source', lastTurnId: 'turn-1', excludeTurns: false });
  assert.deepEqual(fork.thread.turns.map(x => x.id), ['fork-1-native-0', 'turn-1']);
  assert.deepEqual(fork.thread.turns.map(x => x.cdxEngineSource), ['codex', 'claude']);
  assert.equal(f.calls.find(x => x.method === 'thread/fork').params.lastTurnId, 'turn-0');
  assert.equal(f.store.get(fork.thread.id).bindings.codex.consumedSeq, 1);
  const read = await f.router.request('thread/read', { threadId: fork.thread.id, includeTurns: true });
  assert.deepEqual(read.thread.turns.map(x => x.id), ['fork-1-native-0', 'turn-1']);
});

test('fork through a prefix with no Codex turns excludes every later native turn', async t => {
  const f = fixture(t, ['claude', 'codex']);
  const fork = await f.router.request('thread/fork', { threadId: 'source', lastTurnId: 'turn-0' });
  assert.deepEqual(fork.thread.turns.map(x => x.id), ['turn-0']);
  assert.equal(f.nativeThreads.get(fork.thread.id).turns.length, 0);
  assert.equal(f.nativeThreads.get('source').turns.length, 1);
});

test('editing the first Claude message resets context and clears pending client actions', async t => {
  const f = fixture(t); const chat = f.store.require('source');
  chat.claudeClientActions = [{ id: 'stale-copy', type: 'copy', text: 'MARKER-2' }]; f.store.save(chat);
  await f.router.request('thread/rollback', { threadId: 'source', numTurns: 3 });
  assert.equal(f.store.get('source').turns.length, 0);
  assert.equal(f.store.get('source').claudeClientActions.length, 0);
  assert.equal(f.store.get('source').bindings.claude.consumedSeq, 0);
  assert.equal(f.store.get('source').claudePermissionMode, 'plan');
  await f.router.request('turn/start', { threadId: 'source', input: [{ type: 'text', text: 'NEW FIRST' }] }); await tick();
  assert.equal(f.runs[0].options.prompt, 'NEW FIRST');
});

test('invalid boundaries and active runs reject before changing native or public history', async t => {
  const f = fixture(t), before = f.store.get('source');
  for (const numTurns of [0, -1, 1.5, 4, '1']) await assert.rejects(f.router.request('thread/rollback', { threadId: 'source', numTurns }), /turn|count|boundary/i);
  await assert.rejects(f.router.request('thread/revert', { threadId: 'source', beforeTurnId: 'missing' }), /turn|boundary/i);
  await assert.rejects(f.router.request('thread/fork', { threadId: 'source', lastTurnId: 'missing' }), /turn|boundary/i);
  assert.deepEqual(f.store.get('source'), before);
  f.store.beginRun('source', { id: 'active', engine: 'claude', turnId: 'turn-2' });
  for (const method of ['thread/fork', 'thread/rollback', 'thread/revert']) await assert.rejects(f.router.request(method, { threadId: 'source', numTurns: 1, beforeTurnId: 'turn-2' }), /active|progress/i);
  assert.equal(f.calls.filter(x => ['thread/fork', 'thread/rollback', 'thread/revert'].includes(x.method)).length, 0);
  f.store.finishRun('source', 'active');
});

test('native rollback failure preserves the entire editable conversation', async t => {
  const f = fixture(t, ['claude', 'codex']), before = f.store.get('source');
  const request = f.native.request;
  f.native.request = async (method, params) => { if (method === 'thread/revert') throw Error('native disk failure'); return request(method, params); };
  await assert.rejects(f.router.request('thread/rollback', { threadId: 'source', numTurns: 1 }), /native disk failure/);
  assert.deepEqual(f.store.get('source'), before);
});

test('forked and edited workflow histories cannot recover old Claude role sessions', async t => {
  const f = fixture(t, ['both', 'claude']);
  f.router.workflow.templates = new TemplateStore(join(f.dir, 'templates'));
  f.router.workflow.factory = () => { throw Error('Historical snapshots must not launch old workflows'); };
  f.store.setMode('source', 'both', { template: { id: 'debby', revision: 2, parameters: {} }, roleOverrides: { participant_a: { engine: 'claude', model: 'haiku' }, host: { permissionMode: 'plan' } } });
  const chat = f.store.require('source'), selected = f.router.workflow.selection({}, chat);
  const key = roleBindingKey({ template: selected.template, roleId: 'host', cwd: chat.cwd });
  chat.roleBindings[key] = { engine: 'claude', sessionId: 'shared-host-session', consumedSeq: 2 };
  chat.turns[0].workflow = { id: 'old-workflow', config: { template: selected.template }, state: { bindings: structuredClone(chat.roleBindings) } };
  chat.turns[0].runs = [{ id: 'host-run', roleId: 'host', stepId: 'summary', round: 0, engine: 'claude', requestedModel: selected.template.roles.host.model, nativeSessionId: 'shared-host-session', status: 'failed' }];
  f.store.save(chat);
  const fork = await f.router.request('thread/fork', { threadId: 'source' });
  for (const threadId of ['source', fork.thread.id]) {
    if (threadId === 'source') await f.router.request('thread/rollback', { threadId, numTurns: 1 });
    assert.deepEqual(f.store.get(threadId).roleBindings, {});
    assert.deepEqual(f.store.get(threadId).turns[0].workflow.state.bindings, {});
    assert.equal(f.router.claudeCommands.context(threadId).binding?.sessionId ?? null, null);
    assert.equal(f.store.get(threadId).roleOverrides.participant_a.engine, 'claude');
    assert.equal(f.store.get(threadId).roleOverrides.host.permissionMode, 'plan');
    await assert.rejects(f.router.workflow.retry(threadId, 'turn-0', 'host-run'), /history snapshot/i);
  }
});

test('fork rejects a different workspace or native path before creating any version', async t => {
  const f = fixture(t);
  await assert.rejects(f.router.request('thread/fork', { threadId: 'source', cwd: tmpdir() }), /same workspace/i);
  await assert.rejects(f.router.request('thread/fork', { threadId: 'source', path: '/unrelated.jsonl' }), /conversation ID/);
  assert.equal(f.calls.length, 0);
});

test('long handoffs reference immutable history files shared safely across versions', async t => {
  const f = fixture(t, ['claude']);
  const chat = f.store.require('source');
  chat.turns[0].turn.items[1].text = 'BEFORE-FORK '.repeat(6500); f.store.save(chat);
  const handoff = f.router.handoff('source', 'codex');
  const path = handoff.text.match(/Full public history: ([^\]]+)/)?.[1];
  assert.ok(path);
  const original = readFileSync(path, 'utf8');
  f.store.putTurn('source', turn('source-only', 'ONLY-IN-SOURCE-AFTER-FORK'), { engine: 'claude' });
  f.router.handoff('source', 'codex');
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /ONLY-IN-SOURCE-AFTER-FORK/);
});

test('an interrupted immutable history write is repaired before reusing its reference', async t => {
  const f = fixture(t, ['claude']);
  const chat = f.store.require('source'); chat.turns[0].turn.items[1].text = 'FULL-HISTORY '.repeat(6500); f.store.save(chat);
  const path = f.router.handoff('source', 'codex').text.match(/Full public history: ([^\]]+)/)[1];
  const original = readFileSync(path, 'utf8'); writeFileSync(path, 'partial');
  f.router.handoff('source', 'codex');
  assert.ok(readFileSync(path, 'utf8') === original, 'A partial immutable file must be repaired');
});

test('legacy mutable history references detach native Codex context when forking', async t => {
  const f = fixture(t, ['claude', 'codex']);
  const path = f.store.path('source').replace(/\.json$/, '.history.txt');
  writeFileSync(path, 'OLD-HISTORY');
  const raw = f.nativeThreads.get('source').turns[0];
  raw.items[0].content[0].text = `Full public history: ${path}\nOriginal request`;
  const row = f.store.require('source').turns[1]; row.originalInput = [{ type: 'text', text: 'Original request' }]; f.store.save(f.store.require('source'));
  const fork = await f.router.request('thread/fork', { threadId: 'source' });
  assert.equal(f.nativeThreads.get(fork.thread.id).turns.length, 0);
  const snapshot = f.store.get(fork.thread.id);
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.bindings.codex.consumedSeq, 0);
  await f.router.request('turn/start', { threadId: fork.thread.id, input: [{ type: 'text', text: 'CONTINUE' }] });
  const input = f.calls.find(x => x.method === 'turn/start').params.input[0].text;
  assert.match(input, /MARKER-0/); assert.match(input, /Original request/); assert.doesNotMatch(input, /\.history\.txt/);
});

test('an interrupted post-revert save recovers durable edit intent before another run', async t => {
  const f = fixture(t, ['claude', 'codex', 'claude']), originalSave = f.store.save.bind(f.store);
  let armed = false;
  const request = f.native.request;
  f.native.request = async (method, params) => { const result = await request(method, params); if (method === 'thread/revert') armed = true; return result; };
  f.store.save = value => { if (armed) throw Error('disk unavailable'); originalSave(value); };
  await assert.rejects(f.router.request('thread/rollback', { threadId: 'source', numTurns: 2 }), /disk unavailable/);
  assert.equal(f.nativeThreads.get('source').turns.length, 0);
  f.store.save = originalSave;
  const recoveredStore = new ConversationStore(f.dir);
  const recovered = new EngineRouter({ store: recoveredStore, native: f.native, adapter: f.router.adapter, emit() {} });
  try {
    await recovered.request('turn/start', { threadId: 'source', input: [{ type: 'text', text: 'AFTER-RECOVERY' }] }); await tick();
    const input = f.runs.at(-1).options.prompt;
    assert.match(input, /MARKER-0/); assert.doesNotMatch(input, /MARKER-[12]/);
    assert.equal(recoveredStore.get('source').turns.length, 2);
  } finally { await recovered.close(); }
});

test('a lost native revert response still completes the edit after verified recovery', async t => {
  const f = fixture(t, ['claude', 'codex']), request = f.native.request;
  f.native.request = async (method, params) => { const result = await request(method, params); if (method === 'thread/revert') throw Error('response lost'); return result; };
  const edited = await f.router.request('thread/rollback', { threadId: 'source', numTurns: 1 });
  assert.deepEqual(edited.thread.turns.map(turn => turn.id), ['turn-0']);
  assert.equal(f.store.get('source').pendingHistoryEdit, undefined);
});

test('failed snapshot creation never silently falls back to destructive editing', async () => {
  const source = readFileSync(new URL('../../scripts/assets/cdx-branch.js', import.meta.url), 'utf8').replace(/export default[^;]+;/, '');
  const context = { console, localStorage: { getItem() { return null; }, setItem() {} } };
  runInNewContext(source, context);
  await assert.rejects(context.__cdxBranch.beforeEdit({ threadId: 'source', turnId: 'turn-1', fork: async () => { throw Error('snapshot unavailable'); } }), /snapshot unavailable/);
});
