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

test('Claude role runner passes a detached validated session-options snapshot', async () => {
  const claudeOptions = { effort: 'high', thinking: { type: 'disabled' } }, calls = [];
  const runner = new RoleRunner({ claudeAdapter: { start(options) { calls.push(options); return { done: Promise.resolve({ status: 'completed' }) }; } } });
  await runner.start({ runId: 'role', engine: 'claude', access: 'read', prompt: 'Review', cwd: '/repo', claudeOptions }).done;
  claudeOptions.thinking.type = 'enabled';
  assert.deepEqual(calls[0].claudeOptions, { effort: 'high', thinking: { type: 'disabled' } });
  assert.throws(() => runner.start({ runId: 'role', engine: 'claude', access: 'read', prompt: 'Review', cwd: '/repo', claudeOptions: { env: { KEY: 'secret' } } }), /Unsupported/);
  assert.equal(calls.length, 1);
});

test('remote Codex compatibility args apply only to read roles without relaxing native policies', async () => {
  const launches = [], requests = [], responses = [];
  const codexReadArgs = ['--enable', 'use_legacy_landlock', 'app-server'];
  const runner = new RoleRunner({ codexCommand: '/remote/codex', codexReadArgs, nativeClientFactory: options => {
    launches.push(options);
    return { request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: 'remote-session' }, sandbox: { type: 'readOnly', networkAccess: false } };
      if (method === 'turn/start') {
        options.onRequest({ id: 'escalation', method: 'item/commandExecution/requestApproval', params: { threadId: 'remote-session' } });
        return { turn: { id: 'remote-turn', status: 'completed', items: [] } };
      }
      return {};
    }, notify: () => {}, respond: message => responses.push(message), close: async () => {} };
  } });
  codexReadArgs[0] = '--invalid-mutation';
  const result = await runner.start({ engine: 'codex', runId: 'remote-role', cwd: '/remote/workspace', prompt: 'Read only', access: 'read',
    nativeOptions: { args: ['--dangerously-bypass-approvals-and-sandbox'], sandbox: 'danger-full-access' },
    onPermission: () => assert.fail('Read-role escalation reached user permission handler') }).done;
  assert.equal(result.status, 'completed');
  assert.equal(launches[0].command, '/remote/codex');
  assert.deepEqual(launches[0].args, ['--enable', 'use_legacy_landlock', 'app-server']);
  assert.equal(requests.find(row => row.method === 'thread/start').params.sandbox, 'read-only');
  assert.deepEqual(requests.find(row => row.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(responses, [{ id: 'escalation', result: { decision: 'decline' } }]);
  for (const [sandbox, sandboxPolicy] of [['workspace-write', { type: 'workspaceWrite', writableRoots: [], networkAccess: false }], ['danger-full-access', { type: 'dangerFullAccess' }]]) {
    requests.length = 0;
    const result = await runner.start({ engine: 'codex', runId: 'write-role', cwd: '/remote/workspace', prompt: 'Write', access: 'write', nativeOptions: { sandbox, sandboxPolicy } }).done;
    assert.equal(result.status, 'completed');
    assert.deepEqual(launches.at(-1).args, ['app-server'], 'Write roles retain the native backend');
    assert.equal(requests.find(row => row.method === 'thread/start').params.sandbox, sandbox);
    assert.deepEqual(requests.find(row => row.method === 'turn/start').params.sandboxPolicy, sandboxPolicy);
  }
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

test('generated Claude role prompts cannot become slash commands while native attachments remain enabled', async () => {
  const calls = [];
  const runner = new RoleRunner({ claudeAdapter: { start(options) { calls.push(options); return { done: Promise.resolve({ status: 'completed' }), interrupt: async () => {} }; } } });
  for (const prompt of ['/clear', '  /config model=sonnet', '/custom:skill arbitrary input', 'Normal instructions']) {
    const options = { runId: 'role', engine: 'claude', access: 'read', cwd: '/repo', prompt };
    await runner.start(options).done;
    assert.equal(calls.at(-1).prompt, `[Workflow role input]\n${prompt}`);
    assert.equal(options.prompt, prompt);
    assert.notEqual(calls.at(-1).verbatimPrompts, true);
  }
});

test('Claude workflow roles receive explicit captured image blocks alongside their generated prompt', async () => {
  const calls = [], image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } };
  const runner = new RoleRunner({ claudeAdapter: { start(options) { calls.push(options); return { done: Promise.resolve({ status: 'completed' }) }; } } });
  const options = { runId: 'role', engine: 'claude', access: 'read', cwd: '/repo', prompt: 'Review the original request', inputContent: [image] };
  await runner.start(options).done;
  assert.deepEqual(calls[0].content, [{ type: 'text', text: '[Workflow role input]\nReview the original request' }, image]);
  calls[0].content[1].source.data = 'another runner mutation';
  assert.notEqual(image.source.data, 'another runner mutation');
});
