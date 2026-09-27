import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleRunner } from '../../runtime/agent-modes/orchestration/role-runner.mjs';

test('Claude roles preserve the engine slot, role options, and independent public IDs', async () => {
  const calls = [], events = [], permissions = [];
  const claudeAdapter = { start(options) { calls.push(options); options.onEvent({ type: 'session', sessionId: 'native-session' }); options.onEvent({ type: 'tool-start', id: 'same-id', name: 'Read', input: {} }); return { done: Promise.resolve(options.onPermission({ id: 'same-id', name: 'Read', signal: new AbortController().signal })).then(() => ({ status: 'completed', text: 'Done', nativeSessionId: 'native-session' })), interrupt: async () => {} }; } };
  const runner = new RoleRunner({ claudeAdapter });
  for (const runId of ['left', 'right']) await runner.start({ runId, engine: 'claude', model: 'claude-provider-deployment', cwd: '/repo', prompt: 'Review', instructions: 'Use read tools', access: 'read', outputSchema: { type: 'object' }, nativeOptions: { model: 'do-not-mix' }, onEvent: e => events.push(e), onPermission: p => { permissions.push(p); return { decision: 'decline' }; } }).done;
  assert.equal(calls[0].model, 'claude-provider-deployment');
  assert.equal(calls[0].access, 'read');
  assert.equal(calls[0].instructions, 'Use read tools');
  assert.deepEqual(events.filter(e => e.type === 'tool-start').map(e => e.id), ['left:same-id', 'right:same-id']);
  assert.deepEqual(permissions.map(p => p.id), ['left:same-id', 'right:same-id']);
  assert.equal(permissions[0].engine, 'claude');
  assert.equal(events[0].sessionId, 'native-session');
});

test('invalid engine, access or run ID cannot launch a native harness', () => {
  const runner = new RoleRunner({ claudeAdapter: { start() { assert.fail('launched'); } } });
  const base = { runId: 'role', engine: 'claude', access: 'read', prompt: '', cwd: '/repo' };
  for (const extra of [{ engine: 'other' }, { access: 'admin' }, { runId: '' }]) assert.throws(() => runner.start({ ...base, ...extra }), /Invalid/);
});

test('Claude default and absent selections resolve only in Claude without mutating the model slot', async () => {
  const models = [];
  const runner = new RoleRunner({ claudeAdapter: { start(options) { models.push(options.model); return { done: Promise.resolve({ status: 'completed' }), interrupt: async () => {} }; } } });
  for (const model of ['default', undefined, null, 'claude-exact-deployment']) {
    const options = { runId: 'role', engine: 'claude', access: 'read', model, cwd: '/repo', prompt: '' };
    await runner.start(options).done;
    assert.equal(options.model, model);
  }
  assert.deepEqual(models, [undefined, undefined, undefined, 'claude-exact-deployment']);
});
