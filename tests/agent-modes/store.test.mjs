import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';

const thread = (id = 'thread-one') => ({ id, cwd: '/tmp/project', model: 'codex-test',
  modelProvider: 'openai', preview: '', createdAt: 10, updatedAt: 10,
  status: { type: 'idle' }, turns: [] });
const turn = (id, text) => ({ id, status: 'completed', items: [
  { type: 'agentMessage', id: `${id}-message`, text },
] });
const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-modes-store-'));
  return { directory, store: new ConversationStore(directory) };
};

test('mixed history and independent native bindings survive restart', () => {
  const { store, directory } = setup();
  store.ensureThread(thread());
  store.putTurn('thread-one', turn('t1', 'Codex result'), { engine: 'codex' });
  store.setMode('thread-one', 'claude');
  store.setBinding('thread-one', 'claude', { sessionId: 'claude-native', consumedSeq: 1 });
  store.putTurn('thread-one', turn('t2', 'Claude result'), { engine: 'claude', runId: 'r2' });
  const restored = new ConversationStore(directory).get('thread-one');
  assert.equal(restored.mode, 'claude');
  assert.equal(restored.bindings.codex.sessionId, 'thread-one');
  assert.equal(restored.bindings.claude.sessionId, 'claude-native');
  assert.deepEqual(restored.turns.map(t => t.engine), ['codex', 'claude']);
  assert.deepEqual(restored.turns.map(t => t.seq), [1, 2]);
});

test('native history refresh cannot erase or duplicate Claude turns', () => {
  const { store } = setup();
  store.ensureThread({ ...thread(), turns: [turn('t1', 'first')] });
  store.putTurn('thread-one', turn('t2', 'second'), { engine: 'claude' });
  store.mergeNativeThread({ ...thread(), turns: [turn('t1', 'first'), turn('t3', 'third')] });
  store.mergeNativeThread({ ...thread(), turns: [turn('t1', 'first'), turn('t3', 'third')] });
  assert.deepEqual(store.get('thread-one').turns.map(t => t.turn.id), ['t1', 't2', 't3']);
  assert.equal(store.get('thread-one').turns[1].turn.items[0].text, 'second');
});

test('only an idle conversation can change modes, including Both', () => {
  const { store } = setup();
  store.ensureThread(thread());
  assert.equal(store.setMode('thread-one', 'both').mode, 'both');
  assert.throws(() => store.setMode('thread-one', 'unknown'), /mode/i);
  store.beginRun('thread-one', { id: 'r1', turnId: 't1', engine: 'claude' });
  assert.throws(() => store.setMode('thread-one', 'claude'), /active|running/i);
  assert.throws(() => store.beginRun('thread-one', { id: 'r2', turnId: 't2', engine: 'codex' }), /active|running/i);
  assert.throws(() => store.finishRun('thread-one', 'r-other'), /run/i);
  store.finishRun('thread-one', 'r1');
  assert.equal(store.setMode('thread-one', 'claude').mode, 'claude');
});

test('run ownership survives updates and cannot be relabelled', () => {
  const { store } = setup();
  store.ensureThread(thread());
  store.putTurn('thread-one', { ...turn('t1', ''), status: 'inProgress' }, { engine: 'claude', runId: 'run-a' });
  store.putTurn('thread-one', turn('t1', 'complete'), { engine: 'claude', runId: 'run-a' });
  assert.equal(store.get('thread-one').turns.length, 1);
  assert.throws(() => store.putTurn('thread-one', turn('t1', 'wrong'), { engine: 'codex' }), /engine|ownership/i);
});

test('per-engine model choice and two conversations are isolated', () => {
  const { store } = setup();
  store.ensureThread(thread('a')); store.ensureThread(thread('b'));
  store.setMode('a', 'claude', { model: 'sonnet' });
  store.setMode('b', 'codex', { model: 'codex-b' });
  assert.equal(store.get('a').models.codex, 'codex-test');
  assert.equal(store.get('a').models.claude, 'sonnet');
  assert.equal(store.get('b').mode, 'codex');
  assert.equal(store.get('b').models.codex, 'codex-b');
});

test('restarting marks interrupted runs and does not replay execution', () => {
  const { store, directory } = setup();
  store.ensureThread(thread());
  store.putTurn('thread-one', { ...turn('t1', 'partial'), status: 'inProgress' }, { engine: 'claude', runId: 'r1' });
  store.beginRun('thread-one', { id: 'r1', turnId: 't1', engine: 'claude' });
  const restored = new ConversationStore(directory).get('thread-one');
  assert.equal(restored.activeRun, null);
  assert.equal(restored.turns[0].turn.status, 'interrupted');
  assert.equal(restored.turns[0].turn.items[0].text, 'partial');
});

test('caller mutation and path-like IDs cannot corrupt persistence', () => {
  const { store, directory } = setup();
  store.ensureThread(thread('../outside'));
  const snapshot = store.get('../outside'); snapshot.mode = 'both';
  assert.equal(store.get('../outside').mode, 'codex');
  assert.equal(readdirSync(directory).filter(f => f.endsWith('.json')).length, 1);
  assert.equal(JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')).id, '../outside');
});

test('hard restart recovers acknowledged public input without replaying handoff', () => {
  const { store, directory } = setup(); store.ensureThread(thread());
  store.putTurn('thread-one', turn('old', 'native fact'), { engine: 'codex' });
  const current = store.putTurn('thread-one', { ...turn('new', 'partial Claude reply'), status: 'inProgress' }, { engine: 'claude' });
  store.setBinding('thread-one', 'claude', { sessionId: 'native-claude' });
  store.beginRun('thread-one', { id: 'run', turnId: 'new', engine: 'claude', acknowledgedSeq: current.seq });
  const recovered = new ConversationStore(directory).get('thread-one');
  assert.equal(recovered.activeRun, null);assert.equal(recovered.bindings.claude.consumedSeq, current.seq);
});

test('native history cannot downgrade a terminal turn to an in-progress snapshot', () => {
  const { store } = setup(); store.ensureThread(thread());
  store.putTurn('thread-one', turn('done', 'final answer'), { engine: 'codex' });
  store.mergeNativeThread({ ...thread(), turns: [{ ...turn('done', 'partial'), status: 'inProgress' }] });
  const saved = store.get('thread-one').turns[0].turn;
  assert.equal(saved.status, 'completed');
  assert.equal(saved.items[0].text, 'final answer');
});
