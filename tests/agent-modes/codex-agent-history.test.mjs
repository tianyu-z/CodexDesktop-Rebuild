import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexAgentHistory } from '../../runtime/agent-modes/codex-agent-history.mjs';

const row = (type, payload, timestamp = '2026-10-02T12:00:00.125Z') => ({ type, payload, timestamp });
const call = (call_id, name, args, namespace = 'collaboration') => row('response_item', { type: 'function_call', namespace, name, call_id, arguments: JSON.stringify(args) });
const context = (turn_id, model = 'gpt-6-sol') => row('turn_context', { turn_id, model, summary: 'Hidden context reasoning', approval_policy: 'private configuration' });
const usage = (total, last = total) => row('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total, reasoning_output_tokens: 8 }, last_token_usage: { total_tokens: last } }, rate_limits: { private: 'secret account fields' } });
async function fixture(t, rows = [], tail = '') {
  const dir = await mkdtemp(join(tmpdir(), 'codex-agent-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'native.jsonl');
  await writeFile(path, rows.map(value => JSON.stringify(value) + '\n').join('') + tail);
  return { path, dir };
}

test('reads only exact public collaboration dispatches joined by native call IDs', async t => {
  const args = { task_name: 'review', message: 'Inspect the exact implementation.\nReport findings.', model: 'gpt-6-sol', fork_turns: 'none' };
  const { path } = await fixture(t, [
    row('response_item', { type: 'reasoning', summary: 'Hidden chain of thought' }),
    call('selected', 'spawn_agent', args),
    call('other', 'spawn_agent', { message: 'Other task' }),
    call('foreign', 'spawn_agent', { message: 'Secret other namespace' }, 'functions'),
    call('exec', 'exec_command', { cmd: 'private command' }),
    row('response_item', { type: 'message', role: 'assistant', content: [{ text: 'Secret response text' }] }),
    row('response_item', { type: 'function_call_output', call_id: 'selected', output: 'Secret raw tool output' }),
  ]);
  const result = await readCodexAgentHistory(path, { callIds: ['selected', 'foreign', 'exec'] });
  assert.deepEqual(result, { dispatches: { selected: { tool: 'spawn_agent', arguments: args, prompt: args.message, startedAt: Date.parse('2026-10-02T12:00:00.125Z') } }, warnings: [] });
  assert.doesNotMatch(JSON.stringify(result), /Hidden|Secret|private/);
});

test('supports the public collaboration allowlist and exact prompt fields without inferred content', async t => {
  const names = ['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'wait_agent', 'list_agents'];
  const rows = names.map((name, index) => call(`call-${index}`, name, index === 0 ? { prompt: 'Exact prompt' } : { target: 'worker' }));
  rows[1].timestamp = 'invalid timestamp';
  rows.push(row('response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'missing-namespace', arguments: '{}' }));
  rows.push(row('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'invalid-args', arguments: 'not JSON' }));
  rows.push(row('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'array-args', arguments: '[]' }));
  const { path } = await fixture(t, rows);
  const result = await readCodexAgentHistory(path);
  assert.deepEqual(Object.keys(result.dispatches), names.map((_, index) => `call-${index}`));
  assert.deepEqual(Object.values(result.dispatches).map(value => value.tool), names);
  assert.equal(result.dispatches['call-0'].prompt, 'Exact prompt');
  assert.equal(Object.hasOwn(result.dispatches['call-1'], 'prompt'), false);
  assert.equal(Object.hasOwn(result.dispatches['call-1'], 'startedAt'), false);
  assert.deepEqual((await readCodexAgentHistory(path, { callIds: [] })).dispatches, {});
});

test('turn metrics use exact models and cumulative usage deltas without charging earlier turns', async t => {
  const { path } = await fixture(t, [context('before', 'gpt-6-astra'), usage(100), context('selected'), usage(130, 30), usage(130, 30), usage(170, 40), context('after', 'gpt-6-astra'), usage(220, 50)]);
  assert.deepEqual(await readCodexAgentHistory(path, { turnIds: ['selected'] }), { dispatches: {}, warnings: [], model: 'gpt-6-sol', tokenCount: 70 });
  const multiple = await readCodexAgentHistory(path, { turnIds: ['before', 'selected'] });
  assert.equal(multiple.model, undefined, 'mixed models have no single actual model');
  assert.equal(multiple.tokenCount, 170);
  const unscoped = await readCodexAgentHistory(path);
  assert.equal(unscoped.model, undefined);
  assert.equal(unscoped.tokenCount, undefined);
});

test('omits metrics when selected turns, model evidence, or a usage baseline are ambiguous', async t => {
  const { path } = await fixture(t, [context('selected'), usage(500, 40), usage(530, 30)]);
  assert.equal((await readCodexAgentHistory(path, { turnIds: ['selected'] })).tokenCount, undefined);
  assert.equal((await readCodexAgentHistory(path, { turnIds: ['selected', 'missing'] })).model, undefined);
  await writeFile(path, [context('selected'), usage(50), usage(20), context('selected', 'gpt-6-astra')].map(value => JSON.stringify(value) + '\n').join(''));
  const reset = await readCodexAgentHistory(path, { turnIds: ['selected'] });
  assert.equal(reset.tokenCount, undefined);
  assert.equal(reset.model, undefined);
});

test('turn boundary events cannot charge another turn before its context arrives', async t => {
  const { path } = await fixture(t, [
    context('selected'), usage(20),
    row('event_msg', { type: 'task_complete', turn_id: 'selected' }), usage(20),
    row('event_msg', { type: 'task_started', turn_id: 'other' }), usage(60, 40),
    context('other', 'gpt-6-astra'), usage(80, 20),
  ]);
  const result = await readCodexAgentHistory(path, { turnIds: ['selected'] });
  assert.equal(result.tokenCount, 20);
  assert.equal(result.model, 'gpt-6-sol');
});

test('turn states retain only explicit lifecycle evidence and native timestamps', async t => {
  const { path } = await fixture(t, [
    row('event_msg', { type: 'task_started', turn_id: 'done', started_at: 1_790_942_400 }),
    row('event_msg', { type: 'task_complete', turn_id: 'done', started_at: 1_790_942_400, completed_at: 1_790_942_405, duration_ms: 5_000, last_agent_message: 'Hidden final response' }),
    row('event_msg', { type: 'task_started', turn_id: 'stopped' }, '2026-10-02T12:00:06.125Z'),
    row('event_msg', { type: 'turn_aborted', turn_id: 'stopped', reason: 'Secret reason detail' }, '2026-10-02T12:00:07.125Z'),
    row('event_msg', { type: 'task_started', turn_id: 'ongoing' }, '2026-10-02T12:00:08.125Z'),
    context('context-only'),
    row('event_msg', { type: 'task_complete', last_agent_message: 'No explicit turn ID' }),
  ]);
  const result = await readCodexAgentHistory(path);
  assert.deepEqual(result.turnStates, {
    done: { status: 'completed', startedAt: 1_790_942_400_000, completedAt: 1_790_942_405_000 },
    stopped: { status: 'interrupted', startedAt: Date.parse('2026-10-02T12:00:06.125Z'), completedAt: Date.parse('2026-10-02T12:00:07.125Z') },
    ongoing: { status: 'running', startedAt: Date.parse('2026-10-02T12:00:08.125Z') },
  });
  assert.doesNotMatch(JSON.stringify(result), /Hidden final|Secret reason|No explicit/);
  const selected = await readCodexAgentHistory(path, { turnIds: ['ongoing'] });
  assert.deepEqual(selected.turnStates, { ongoing: result.turnStates.ongoing });
  assert.equal((await readCodexAgentHistory(path, { turnIds: [] })).turnStates, undefined);
});

test('a terminal lifecycle record can provide state without inventing a start time', async t => {
  const { path } = await fixture(t, [row('event_msg', { type: 'turn_aborted', turn_id: 'stopped' }, 'invalid date')]);
  assert.deepEqual((await readCodexAgentHistory(path)).turnStates, { stopped: { status: 'interrupted' } });
});

test('skips an incomplete final JSONL row and tolerates only missing files', async t => {
  const { path, dir } = await fixture(t, [call('complete', 'spawn_agent', { message: 'Recorded' })], '{"type":"response_item","payload":');
  assert.deepEqual(Object.keys((await readCodexAgentHistory(path)).dispatches), ['complete']);
  assert.deepEqual(await readCodexAgentHistory(join(dir, 'missing.jsonl')), { dispatches: {}, warnings: [] });
  await assert.rejects(readCodexAgentHistory(dir));
  await writeFile(path, '{ invalid complete JSON }\n');
  await assert.rejects(readCodexAgentHistory(path), /Invalid JSON/);
});

test('bounds large native histories and reports truncation without exposing trailing data', async t => {
  const { path } = await fixture(t, [context('selected'), usage(20), call('early', 'spawn_agent', { message: 'Recorded' })]);
  const file = await open(path, 'r+');
  try {
    await file.truncate(33 * 1024 * 1024);
    await file.write(JSON.stringify(call('late', 'spawn_agent', { message: 'Beyond cap' })) + '\n', 33 * 1024 * 1024, 'utf8');
  } finally { await file.close(); }
  const result = await readCodexAgentHistory(path, { turnIds: ['selected'] });
  assert.deepEqual(Object.keys(result.dispatches), ['early']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /limit|truncat/i);
  assert.equal(result.model, undefined);
  assert.equal(result.tokenCount, undefined);
});

test('bounds record processing even when native history contains many tiny lines', async t => {
  const { path } = await fixture(t);
  await writeFile(path, '\n'.repeat(100_001) + JSON.stringify(call('late', 'spawn_agent', { message: 'Beyond work limit' })) + '\n');
  const result = await readCodexAgentHistory(path);
  assert.deepEqual(result.dispatches, {});
  assert.equal(result.warnings.length, 1);
});

test('native call IDs cannot alter the dispatch dictionary prototype', async t => {
  const { path } = await fixture(t, [call('__proto__', 'spawn_agent', { message: 'Literal call ID' })]);
  const result = await readCodexAgentHistory(path);
  assert.equal(Object.hasOwn(result.dispatches, '__proto__'), true);
  assert.equal(result.dispatches.__proto__.prompt, 'Literal call ID');
  assert.equal(Object.getPrototypeOf(result.dispatches), Object.prototype);
});
