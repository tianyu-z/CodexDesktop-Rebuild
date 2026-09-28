import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../runtime/agent-modes/claude-adapter.mjs';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { resolveRoleConfig, validateRoleOverrides, validateTemplate } from '../../runtime/agent-modes/templates/schema.mjs';
import { WorkflowScheduler } from '../../runtime/agent-modes/orchestration/scheduler.mjs';
import { RoleRunner } from '../../runtime/agent-modes/orchestration/role-runner.mjs';

const modes = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
const invalidModes = [null, '', 'manual', 'never', 'DEFAULT', '--permission-mode=auto', {}, 1];
const tick = () => new Promise(resolve => setImmediate(resolve));
const template = () => ({ schemaVersion: 2, id: 'permissions', revision: 1, name: 'Permissions', description: '',
  roles: Object.fromEntries([['first', 'claude'], ['second', 'claude'], ['native', 'codex']].map(([id, engine]) => [id, { engine, access: 'read', session: 'fresh', prompt: id }])),
  steps: ['first', 'second', 'native'].map(role => ({ id: role, type: 'run', role, inputs: ['request'] })),
  output: { sources: ['first', 'second', 'native'], final: 'second', format: 'text' } });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-permissions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  store.ensureThread({ id: 'chat', cwd: directory, turns: [] });
  return { directory, store };
}
function adapterRun(permissionMode, extra = {}) {
  const observed = { events: [] };
  const adapter = new ClaudeAdapter({ environment: () => ({}), queryImpl(request) {
    observed.request = request;
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'session', permissionMode: extra.nativeMode ?? permissionMode };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Done' };
    })();
    stream.close = () => {};
    return stream;
  } });
  return { observed, run: adapter.start({ cwd: '/tmp', prompt: 'test', permissionMode, onEvent: event => observed.events.push(event), ...extra }) };
}

test('all six native permission modes reach the SDK with bypass consent only for bypass', async () => {
  for (const permissionMode of modes) {
    const { observed, run } = adapterRun(permissionMode);
    assert.equal((await run.done).status, 'completed');
    assert.equal(observed.request.options.permissionMode, permissionMode);
    assert.equal(observed.request.options.allowDangerouslySkipPermissions, permissionMode === 'bypassPermissions' ? true : undefined);
  }
});

test('invalid native permission modes fail before provider resolution or SDK startup', async () => {
  for (const permissionMode of invalidModes) {
    const { observed, run } = adapterRun(permissionMode);
    const result = await run.done;
    assert.equal(result.status, 'failed');
    assert.match(result.error, /permission mode/i);
    assert.equal(observed.request, undefined);
  }
});

test('bypass keeps the read-role native tool, MCP, and hook ceiling', async () => {
  const { observed, run } = adapterRun('bypassPermissions', { access: 'read', onPermission: async () => ({ decision: 'accept' }) });
  await run.done;
  const options = observed.request.options;
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settings, { disableAllHooks: true });
});

test('native-reported mode stays distinct from the requested permission selection', async () => {
  const { observed, run } = adapterRun('auto', { nativeMode: 'default' });
  const result = await run.done;
  assert.equal(result.actualPermissionMode, 'default');
  assert.ok(observed.events.some(event => event.type === 'permission-mode' && event.requestedMode === 'auto' && event.actualMode === 'default'));
});

test('conversation permission selection defaults, persists, and rejects invalid values without mutation', t => {
  const { directory, store } = fixture(t);
  assert.equal(store.get('chat').claudePermissionMode, 'default');
  for (const claudePermissionMode of modes) {
    store.setMode('chat', 'claude', { claudePermissionMode });
    assert.equal(new ConversationStore(directory).get('chat').claudePermissionMode, claudePermissionMode);
  }
  const before = store.get('chat');
  for (const claudePermissionMode of invalidModes) {
    assert.throws(() => store.setMode('chat', 'codex', { claudePermissionMode }), /permission mode/i);
    assert.deepEqual(store.get('chat'), before);
  }
  const old = JSON.parse(readFileSync(store.path('chat'), 'utf8'));
  delete old.claudePermissionMode;
  writeFileSync(store.path('chat'), JSON.stringify(old));
  assert.equal(new ConversationStore(directory).get('chat').claudePermissionMode, 'default');
});

test('Claude roles resolve independent native modes and retain inactive Codex selections', () => {
  const input = template(); input.roles.first.permissionMode = 'acceptEdits';
  const overrides = { second: { permissionMode: 'bypassPermissions' }, native: { permissionMode: 'auto' } };
  const resolved = resolveRoleConfig(input, overrides);
  assert.equal(resolved.template.roles.first.permissionMode, 'acceptEdits');
  assert.equal(resolved.template.roles.second.permissionMode, 'bypassPermissions');
  assert.deepEqual(resolved.roleOverrides, overrides);
  assert.equal(resolveRoleConfig(template()).template.roles.first.permissionMode, 'default');
  for (const permissionMode of invalidModes) {
    assert.throws(() => validateRoleOverrides({ first: { permissionMode } }), /permission/i);
    const invalid = template(); invalid.roles.first.permissionMode = permissionMode;
    assert.throws(() => validateTemplate(invalid), /permission/i);
  }
});

test('workflow store validates frozen permission ownership before mutating role attempts', t => {
  const { store } = fixture(t);
  const effective = resolveRoleConfig(template(), { first: { permissionMode: 'auto' } }, {});
  const config = { mode: 'both', ...effective, models: {}, claudePermissionMode: 'plan', parameters: {} };
  store.beginWorkflow('chat', { id: 'workflow', turn: { id: 'turn', status: 'inProgress', items: [] }, config });
  const run = { id: 'run', roleId: 'first', engine: 'claude', stepId: 'first', attempt: 1, round: 0, status: 'failed', requestedModel: null, permissionMode: 'auto' };
  store.putWorkflowRun('chat', 'workflow', run);
  const before = store.get('chat');
  assert.throws(() => store.putWorkflowRun('chat', 'workflow', { ...run, id: 'retry', attempt: 2, permissionMode: 'bypassPermissions' }), /permission.*ownership/i);
  assert.deepEqual(store.get('chat'), before);
});

test('workflow permission choices are frozen per role and reused after retry and restart', async t => {
  const calls = [];
  const runner = { start(options) {
    calls.push(options);
    return { done: Promise.resolve({ status: calls.length === 1 ? 'failed' : 'completed', text: 'result', actualPermissionMode: 'default' }), interrupt: async () => {} };
  } };
  const overrides = { first: { permissionMode: 'auto' }, second: { permissionMode: 'bypassPermissions' }, native: { permissionMode: 'acceptEdits' } };
  const run = new WorkflowScheduler({ runner }).start({ runId: 'workflow', cwd: '/tmp', template: template(), roleOverrides: overrides, models: {}, input: 'test' });
  t.after(() => run.interrupt());
  overrides.first.permissionMode = 'plan';
  for (let n = 0; n < 10 && !run.snapshot().runs.some(row => row.status === 'failed'); n++) await tick();
  const failed = run.snapshot().runs.find(row => row.status === 'failed');
  assert.ok(failed);
  assert.equal(calls.find(row => row.roleId === 'first').permissionMode, 'auto');
  assert.equal(calls.find(row => row.roleId === 'second').permissionMode, 'bypassPermissions');
  assert.equal(calls.find(row => row.engine === 'codex').permissionMode, undefined);
  assert.equal(failed.permissionMode, 'auto');
  await run.interrupt();
  const resumed = new WorkflowScheduler({ runner }).start({ runId: 'workflow', previousSnapshot: run.snapshot(), retryRunId: failed.id });
  t.after(() => resumed.interrupt());
  assert.equal((await resumed.done).status, 'completed');
  assert.equal(calls.filter(row => row.roleId === 'first').at(-1).permissionMode, 'auto');
  assert.equal(resumed.snapshot().runs.filter(row => row.roleId === 'first').at(-1).actualPermissionMode, 'default');
});

test('real Claude role pipeline persists native-reported permissions while a run remains active', async t => {
  const { store, directory } = fixture(t), nativeOptions = [], completions = [];
  const input = template(); input.roles.native.engine = 'claude';
  const effective = resolveRoleConfig(input, { first: { permissionMode: 'auto' }, second: { permissionMode: 'bypassPermissions' } }, {});
  const config = { mode: 'both', ...effective, models: {}, parameters: {}, cwd: directory, input: 'test' };
  store.beginWorkflow('chat', { id: 'workflow', turn: { id: 'turn', status: 'inProgress', items: [] }, config });
  const adapter = new ClaudeAdapter({ environment: () => ({}), queryImpl({ options }) {
    nativeOptions.push(options);
    let finish; const waiting = new Promise(resolve => { finish = resolve; }); completions.push(finish);
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', permissionMode: 'default' };
      await waiting;
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Done' };
    })();
    stream.interrupt = async () => finish(); stream.close = () => finish();
    return stream;
  } });
  const run = new WorkflowScheduler({ runner: new RoleRunner({ claudeAdapter: adapter }) }).start({ ...config, runId: 'workflow', onSnapshot(snapshot) {
    for (const child of snapshot.runs) store.putWorkflowRun('chat', 'workflow', child);
  } });
  t.after(() => run.interrupt());
  for (let n = 0; n < 10 && nativeOptions.length < 2; n++) await tick();
  const first = store.get('chat').turns[0].runs.find(row => row.roleId === 'first');
  assert.equal(first.status, 'running');
  assert.equal(first.permissionMode, 'auto');
  assert.equal(first.actualPermissionMode, 'default');
  assert.deepEqual(nativeOptions.map(options => options.permissionMode), ['auto', 'bypassPermissions']);
  for (let n = 0; n < 10 && run.snapshot().status !== 'completed'; n++) { completions.forEach(finish => finish()); await tick(); }
  assert.equal((await run.done).status, 'completed');
  assert.equal(nativeOptions.at(-1).permissionMode, 'default');
  for (const options of nativeOptions) assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob']);
});
