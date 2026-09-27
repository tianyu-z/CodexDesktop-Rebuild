import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, assertEngine, assertMode } from '../../runtime/agent-modes/store.mjs';

const metadata = { id: 'chat', cwd: '/tmp/project', model: 'codex-selected', turns: [] };
const inputTurn = id => ({ id, status: 'inProgress', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Compare these approaches' }] }] });
const config = () => ({ mode: 'both', models: { codex: 'codex-selected', claude: 'claude-selected' },
  template: { id: 'debby', revision: 1, contentHash: 'a'.repeat(64), roles: {} }, parameters: { rounds: 1 } });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-store-'));
  const store = new ConversationStore(directory); store.ensureThread(metadata);
  return { directory, store };
}
function start(store, id = 'workflow', turnId = 'both-turn') {
  return store.beginWorkflow('chat', { id, turn: inputTurn(turnId), config: config() });
}
const roleRun = (id = 'codex-run', engine = 'codex') => ({ id, engine, roleId: engine, stepId: `answers.${engine}`, attempt: 1, round: 0, status: 'running', requestedModel: `${engine}-selected` });

test('mode and harness validation are separate; v2 stores one canonical active turn', () => {
  assert.doesNotThrow(() => assertMode('both'));
  assert.throws(() => assertEngine('both'), /engine|harness/i);
  const { store } = setup();
  assert.equal(store.get('chat').schemaVersion, 2);
  store.beginRun('chat', { id: 'legacy', engine: 'claude', turnId: 'single' });
  assert.equal(store.get('chat').activeRun.id, 'legacy');
  assert.equal(store.get('chat').activeTurn.id, 'legacy');
  const disk = JSON.parse(readFileSync(store.path('chat'), 'utf8'));
  assert.equal(disk.activeTurn.id, 'legacy');
  assert.equal(Object.hasOwn(disk, 'activeRun'), false);
});

test('v1 migration backs up the exact original and retains single-engine history and bindings', () => {
  const { store, directory } = setup();
  const old = store.get('chat'); old.schemaVersion = 1;
  delete old.activeTurn; delete old.roleBindings; delete old.nextEventSeq;
  old.activeRun = null; old.mode = 'claude'; old.bindings.claude = { sessionId: 'native-claude', consumedSeq: 1 };
  old.turns = [{ seq: 1, engine: 'claude', runId: 'r', runs: [{ id: 'r', engine: 'claude' }], turn: { id: 't', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'retained' }] } }];
  old.nextSeq = 2;
  const original = JSON.stringify(old); writeFileSync(store.path('chat'), original);
  const migrated = new ConversationStore(directory);
  const record = migrated.get('chat');
  assert.equal(record.schemaVersion, 2); assert.equal(record.mode, 'claude');
  assert.equal(record.bindings.claude.sessionId, 'native-claude');
  assert.equal(record.turns[0].turn.items[0].text, 'retained');
  const backups = readdirSync(join(directory, 'v1-backups'));
  assert.equal(backups.length, 1); assert.equal(readFileSync(join(directory, 'v1-backups', backups[0]), 'utf8'), original);
  new ConversationStore(directory);
  assert.equal(readdirSync(join(directory, 'v1-backups')).length, 1);
});

test('workflow creation freezes configuration and exclusively owns one visible user turn', () => {
  const { store } = setup(), selected = config();
  store.beginWorkflow('chat', { id: 'workflow', turn: inputTurn('both-turn'), config: selected });
  selected.models.codex = 'changed'; selected.parameters.rounds = 8;
  const record = store.get('chat'), row = record.turns[0];
  assert.equal(record.activeTurn.mode, 'both'); assert.equal(record.mode, 'both');
  assert.equal(row.engine, 'both'); assert.equal(row.runs.length, 0);
  assert.equal(row.workflow.config.models.codex, 'codex-selected');
  assert.equal(row.workflow.config.parameters.rounds, 1);
  assert.throws(() => start(store, 'other', 'other-turn'), /active/i);
  assert.throws(() => store.beginRun('chat', { id: 'legacy', engine: 'codex' }), /active/i);
  assert.throws(() => store.setMode('chat', 'claude'), /active/i);
});

test('concurrent role records preserve engine, role and attempt ownership', () => {
  const { store } = setup(); start(store);
  store.putWorkflowRun('chat', 'workflow', roleRun());
  store.putWorkflowRun('chat', 'workflow', roleRun('claude-run', 'claude'));
  store.putWorkflowRun('chat', 'workflow', { ...roleRun(), status: 'completed', text: 'C' });
  assert.equal(store.get('chat').turns[0].runs.length, 2);
  assert.throws(() => store.putWorkflowRun('chat', 'workflow', { ...roleRun(), engine: 'claude' }), /ownership/i);
  assert.throws(() => store.putWorkflowRun('chat', 'workflow', { ...roleRun(), roleId: 'other' }), /ownership/i);
  assert.throws(() => store.putWorkflowRun('chat', 'workflow', { ...roleRun(), attempt: 2 }), /ownership/i);
  assert.throws(() => store.putWorkflowRun('chat', 'wrong', roleRun('other')), /ownership/i);
});

test('interleaved public events persist in chat order and deduplicate within each run', () => {
  const { store, directory } = setup(); start(store);
  store.putWorkflowRun('chat', 'workflow', roleRun()); store.putWorkflowRun('chat', 'workflow', roleRun('claude-run', 'claude'));
  const event = { eventId: 'native-1', runId: 'codex-run', engine: 'codex', type: 'text-delta', delta: 'C' };
  assert.equal(store.appendWorkflowEvent('chat', 'workflow', event).seq, 1);
  assert.equal(store.appendWorkflowEvent('chat', 'workflow', { ...event, runId: 'claude-run', engine: 'claude', delta: 'A' }).seq, 2);
  assert.equal(store.appendWorkflowEvent('chat', 'workflow', event).seq, 1);
  assert.throws(() => store.appendWorkflowEvent('chat', 'workflow', { ...event, eventId: 'bad', engine: 'claude' }), /ownership/i);
  const recovered = new ConversationStore(directory).get('chat');
  assert.deepEqual(recovered.turns[0].workflow.events.map(e => e.delta), ['C', 'A']);
  assert.equal(recovered.nextEventSeq, 3);
});

test('role bindings retain independent acknowledged context and reject backward cursors', () => {
  const { store, directory } = setup();
  store.setRoleBinding('chat', 'debby@1/codex', { engine: 'codex', sessionId: 'codex-child', consumedSeq: 2 });
  store.setRoleBinding('chat', 'debby@1/claude', { engine: 'claude', sessionId: 'claude-child', consumedSeq: 1 });
  assert.throws(() => store.setRoleBinding('chat', 'debby@1/codex', { consumedSeq: 1 }), /monoton/i);
  assert.throws(() => store.setRoleBinding('chat', 'debby@1/codex', { engine: 'claude' }), /ownership/i);
  assert.throws(() => store.setRoleBinding('chat', '__proto__', { engine: 'codex', sessionId: 'bad' }), /key/i);
  const value = new ConversationStore(directory).get('chat');
  assert.equal(value.roleBindings['debby@1/codex'].sessionId, 'codex-child');
  assert.equal(value.roleBindings['debby@1/claude'].consumedSeq, 1);
  assert.equal(value.bindings.codex.sessionId, 'chat');
});

test('restart interrupts only unfinished roles and keeps immutable config/results without replay', () => {
  const { store, directory } = setup(); start(store);
  store.putWorkflowRun('chat', 'workflow', { ...roleRun(), status: 'completed', text: 'Codex result' });
  store.putWorkflowRun('chat', 'workflow', { ...roleRun('claude-run', 'claude'), status: 'awaitingApproval', text: 'partial' });
  const record = new ConversationStore(directory).get('chat');
  assert.equal(record.activeTurn, null); assert.equal(record.activeRun, null);
  assert.equal(record.turns[0].turn.status, 'interrupted');
  assert.equal(record.turns[0].workflow.status, 'interrupted');
  assert.deepEqual(record.turns[0].runs.map(r => r.status), ['completed', 'interrupted']);
  assert.equal(record.turns[0].runs[0].text, 'Codex result');
  assert.equal(record.turns[0].workflow.config.template.revision, 1);
});

test('finish requires settled roles; later events cannot mutate a finished workflow', () => {
  const { store } = setup(); start(store);
  store.putWorkflowRun('chat', 'workflow', roleRun());
  assert.throws(() => store.finishWorkflow('chat', 'workflow', 'completed'), /active|settled/i);
  store.putWorkflowRun('chat', 'workflow', { ...roleRun(), status: 'completed' });
  store.finishWorkflow('chat', 'workflow', 'completed');
  assert.equal(store.get('chat').activeTurn, null);
  assert.equal(store.get('chat').turns[0].turn.status, 'completed');
  assert.throws(() => store.appendWorkflowEvent('chat', 'workflow', { eventId: 'late', runId: 'codex-run', engine: 'codex', type: 'text-delta', delta: 'bad' }), /ownership|active/i);
  store.setMode('chat', 'claude');
  assert.equal(store.get('chat').turns[0].engine, 'both');
});

test('a successful retry supersedes the failed attempt without losing its history', () => {
  const { store } = setup(); start(store);
  store.putWorkflowRun('chat', 'workflow', { ...roleRun(), status: 'failed', error: 'temporary' });
  store.putWorkflowRun('chat', 'workflow', { ...roleRun('retry'), attempt: 2, status: 'completed', text: 'recovered' });
  store.finishWorkflow('chat', 'workflow', 'completed');
  assert.deepEqual(store.get('chat').turns[0].runs.map(run => run.status), ['failed', 'completed']);
  assert.equal(store.get('chat').turns[0].turn.status, 'completed');
});

test('duplicate role attempts and invalid selections cannot change saved state', () => {
  const { store } = setup();
  assert.throws(() => store.setMode('chat', 'both', { model: 'misrouted' }), /engine/);
  assert.equal(store.get('chat').mode, 'codex');
  start(store); store.putWorkflowRun('chat', 'workflow', roleRun());
  assert.throws(() => store.putWorkflowRun('chat', 'workflow', roleRun('duplicate')), /attempt|ownership/i);
  assert.equal(store.get('chat').turns[0].runs.length, 1);
});

test('dual model and template selections persist without native hydration overwriting them', () => {
  const { store, directory } = setup();
  const models = { codex: 'codex-custom', claude: 'claude-custom' };
  const template = { id: 'debby', revision: 1, parameters: { rounds: 0 } };
  store.setMode('chat', 'both', { models, template });
  models.codex = 'mutated'; template.parameters.rounds = 3;
  store.mergeNativeThread({ ...metadata, model: 'native-stale' });
  const value = new ConversationStore(directory).get('chat');
  assert.equal(value.models.codex, 'codex-custom');
  assert.equal(value.models.claude, 'claude-custom');
  assert.equal(value.template.parameters.rounds, 0);
  assert.throws(() => store.setMode('chat', 'both', { models: { other: 'bad' } }), /model/i);
  assert.equal(store.get('chat').models.codex, 'codex-custom');
});

test('workflow completion advances visible chat recency', () => {
  const { store } = setup(); start(store);
  store.finishWorkflow('chat', 'workflow', 'completed');
  const value = store.get('chat');
  assert.ok(value.thread.updatedAt >= value.turns[0].turn.completedAt);
  assert.ok(value.thread.recencyAt >= value.thread.updatedAt);
});

test('model selections reject trailing whitespace before mutating the chat', () => {
  const { store } = setup();
  const before = store.get('chat');
  assert.throws(() => store.setMode('chat', 'both', { models: { claude: 'opus\n' } }), /model/i);
  assert.deepEqual(store.get('chat'), before);
  const invalid = config(); invalid.models.codex = 'codex\n';
  assert.throws(() => store.beginWorkflow('chat', { id: 'bad', turn: inputTurn('bad'), config: invalid }), /model/i);
  assert.deepEqual(store.get('chat'), before);
});
