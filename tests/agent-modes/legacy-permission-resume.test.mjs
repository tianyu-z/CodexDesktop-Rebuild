import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';

const full = { approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' } };
const line = payload => JSON.stringify({ type: 'turn_context', payload }) + '\n';
function fixture(t, contents = line(full), loaded = []) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-permission-resume-'));
  const path = join(root, 'sessions', '2026', '09', '30', 'rollout.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  const database = new DatabaseSync(join(root, 'state_5.sqlite'));
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, sandbox_policy TEXT, approval_mode TEXT)');
  database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('legacy', path, JSON.stringify({ type: 'disabled' }), 'never');
  const thread = { id: 'legacy', cwd: root, path, turns: [], status: { type: 'idle' } };
  const calls = [];
  const native = { async request(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'thread/loaded/list') return { data: loaded, nextCursor: null };
    return { thread };
  } };
  const router = new EngineRouter({ store: new ConversationStore(join(root, 'store')), native, adapter: {}, emit() {} });
  t.after(async () => { await router.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return { router, calls, path, native, database };
}

test('cold resume migrates the latest legacy Full access selection before native defaults are applied', async t => {
  const f = fixture(t);
  const params = { threadId: 'legacy', excludeTurns: true, permissions: null, sandbox: null, approvalPolicy: null };
  await f.router.request('thread/resume', params);
  const request = f.calls.find(call => call.method === 'thread/resume').params;
  assert.equal(request.permissions, ':danger-full-access');
  assert.equal(request.approvalPolicy, 'never');
  assert.equal(request.approvalsReviewer, 'user');
  assert.equal(request.sandbox, undefined);
  assert.equal(params.permissions, null, 'Do not mutate the caller request');
});

test('already loaded threads retain their live selection even when the last turn was Full access', async t => {
  const f = fixture(t, line(full), ['legacy']);
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
  assert.equal(f.calls.some(call => call.method === 'thread/read'), false);
});

test('a thread loaded during the history read retains its live selection', async t => {
  const f = fixture(t);
  const request = f.native.request.bind(f.native);
  let lists = 0;
  f.native.request = (method, params) => method === 'thread/loaded/list' && ++lists === 2
    ? Promise.resolve({ data: ['legacy'], nextCursor: null }) : request(method, params);
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
});

for (const reviewer of ['auto_review', 'guardian_subagent']) test(`retains the approval reviewer ${reviewer}`, async t => {
  const f = fixture(t, line({ ...full, approvals_reviewer: reviewer }));
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.approvalsReviewer, reviewer);
});

test('unsupported native state schema leaves permissions untouched', async t => {
  const f = fixture(t);
  f.database.exec('DROP TABLE threads');
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
});

test('an incomplete latest record cannot authorize restoration from older metadata', async t => {
  const f = fixture(t, line(full) + '{"type":"turn_context","payload":');
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
});

test('a newer persisted restrictive setting takes precedence over a legacy Full access turn', async t => {
  const f = fixture(t);
  f.database.prepare('UPDATE threads SET sandbox_policy=?, approval_mode=?').run(JSON.stringify({ type: 'managed', file_system: { type: 'restricted' } }), 'on-request');
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
});

test('native state must agree with the rollout path and approval policy', async t => {
  const f = fixture(t);
  f.database.prepare('UPDATE threads SET approval_mode=?').run('on-request');
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
  f.database.prepare('UPDATE threads SET rollout_path=?, approval_mode=?').run('/different/rollout.jsonl', 'never');
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
});

for (const overrides of [
  { permissions: ':workspace' }, { sandbox: 'read-only' }, { approvalPolicy: 'on-request' },
  { config: { sandbox_mode: 'workspace-write' } }, { config: { permissions: { profile: 'locked' } } },
  { config: { profile: 'locked' } }, { history: [] },
]) test(`explicit resume selection is authoritative: ${JSON.stringify(overrides)}`, async t => {
  const f = fixture(t);
  const params = { threadId: 'legacy', ...overrides };
  await f.router.request('thread/resume', params);
  assert.deepEqual(f.calls.at(-1).params, params);
});

for (const latest of [
  { ...full, sandbox_policy: { type: 'workspace-write' }, permission_profile: { type: 'managed' } },
  { ...full, active_permission_profile: { id: ':workspace' } },
  { ...full, active_permission_profile: { id: 'custom-full-access' } },
  { ...full, permission_profile: { type: 'managed' } },
]) test(`never reuse an older Full access turn: ${JSON.stringify(latest)}`, async t => {
  const f = fixture(t, line(full) + line(latest));
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
});

test('scans backwards over large outputs without treating quoted turn_context text as metadata', async t => {
  const output = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) + line({ ...full, active_permission_profile: { id: ':workspace' } }) } }) + '\n';
  const f = fixture(t, line(full) + output);
  await f.router.request('thread/resume', { threadId: 'legacy', config: { 'features.code_mode_host': true } });
  assert.equal(f.calls.at(-1).params.permissions, ':danger-full-access');
});

test('unavailable rollout and unsupported loaded-thread discovery leave native behavior intact', async t => {
  const f = fixture(t);
  rmSync(f.path);
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
  const request = f.native.request.bind(f.native);
  f.native.request = (method, params) => method === 'thread/loaded/list' ? Promise.reject(new Error('Method not found')) : request(method, params);
  await f.router.request('thread/resume', { threadId: 'legacy' });
  assert.equal(f.calls.at(-1).params.permissions, undefined);
});
