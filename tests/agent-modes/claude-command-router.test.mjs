import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { TemplateStore } from '../../runtime/agent-modes/templates/store.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';
import { roleBindingKey } from '../../runtime/agent-modes/orchestration/scheduler.mjs';
import { publicHistory } from '../../runtime/agent-modes/handoff.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, mode = 'claude') {
  const dir = mkdtempSync(join(tmpdir(), 'claude-commands-router-')), calls = [], runs = [], events = [];
  const thread = { id: 'chat', cwd: dir, turns: [], status: { type: 'idle' } };
  const store = new ConversationStore(join(dir, 'store')), templates = new TemplateStore(join(dir, 'templates'));
  const native = { async request(method, params) { calls.push({ method, params }); return method.startsWith('thread/') && ['start', 'read', 'resume'].includes(method.split('/')[1]) ? { thread: structuredClone(thread) } : {}; } };
  const adapter = {
    async listCommands(options) { calls.push({ method: 'claude-commands', params: options }); return { commands: ['clear', 'model', 'context', 'team:review'].map(name => ({ name, builtin: true, origin: 'builtin', execution: 'native' })) }; },
    start(options) { let finish; const run = { options, done: new Promise(resolve => { finish = resolve; }), interrupt: async () => finish({ status: 'interrupted' }), finish }; runs.push(run); return run; },
  };
  const router = new EngineRouter({ store, templates, native, adapter, emit: event => events.push(event), workflowFactory: () => { throw Error('A slash command must not launch a workflow'); } });
  t.after(async () => { await router.close(); rmSync(dir, { force: true, recursive: true }); });
  await router.request('thread/start', { engineMode: mode, cwd: dir, template: { id: 'debby', revision: 2, parameters: {} } });
  return { dir, store, templates, router, calls, runs, events };
}
async function submit(f, text, extra = {}) { const response = await f.router.request('turn/start', { threadId: 'chat', input: [{ type: 'text', text }], ...extra }); await tick(); return response; }

for (const name of ['tasks', 'copy', 'resume', 'permissions', 'rename']) {
  test(`native skill /${name} is not intercepted by an app command`, async t => {
    const f = await fixture(t);
    f.router.adapter.listCommands = async () => ({ commands: [{ name, origin: 'skill', execution: 'native' }] });
    const command = await f.router.claudeCommands.prepare('chat', { input: [{ type: 'text', text: `/${name} fixture` }] });
    assert.equal(command.command.execution, 'native');
    assert.equal(command.command.input, `/${name} fixture`);
    assert.equal(command.command.settingsPatch, undefined);
  });
}

test('native commands neither promote unseen history to instructions nor consume its handoff cursor', async t => {
  const f = await fixture(t);
  f.store.putTurn('chat', { id: 'unseen', status: 'completed', items: [{ id: 'history', type: 'agentMessage', text: 'UNTRUSTED HISTORY MARKER' }] }, { engine: 'codex' });
  await submit(f, '/team:review');
  assert.doesNotMatch(f.runs[0].options.instructions ?? '', /UNTRUSTED HISTORY MARKER/);
  assert.equal(f.runs[0].options.prompt, '/team:review');
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'command-session', text: 'Review completed' }); await tick();
  assert.equal(f.store.get('chat').bindings.claude.consumedSeq, 0);
  await submit(f, 'Continue');
  assert.match(f.runs[1].options.prompt, /UNTRUSTED HISTORY MARKER/);
  f.runs[1].finish({ status: 'completed' }); await tick();
});

test('concurrent resumes cannot assign one native transcript to two chats', async t => {
  const f = await fixture(t), sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.store.ensureThread({ id: 'second', cwd: f.dir, turns: [] }, { mode: 'claude' });
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'resume', origin: 'app', execution: 'local' }] });
  let release, requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  f.router.claudeCommands.sessionApi = { listSessions: async () => { requests++; await pending; return [{ sessionId }]; } };
  await Promise.all(['chat', 'second'].map(threadId => f.router.request('turn/start', { threadId, input: [{ type: 'text', text: `/resume ${sessionId}` }] })));
  while (requests < 2) await tick();
  release();
  await Promise.all([...f.router.runs.values()].map(run => run.done));
  const chats = ['chat', 'second'].map(id => f.store.get(id));
  assert.equal(chats.filter(chat => chat.bindings.claude.sessionId === sessionId).length, 1);
  assert.deepEqual(chats.map(chat => chat.turns.at(-1).turn.status).sort(), ['completed', 'failed']);
});

test('resume reservations survive listing and release on failed binding or interruption', async t => {
  const f = await fixture(t), sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.store.ensureThread({ id: 'second', cwd: f.dir, turns: [] }, { mode: 'claude' });
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'resume', origin: 'app', execution: 'local' }] });
  f.router.claudeCommands.sessionApi = { listSessions: async () => [{ sessionId }] };
  const prepare = id => f.router.claudeCommands.prepare(id, { input: [{ type: 'text', text: `/resume ${sessionId}` }] });
  const first = await prepare('chat'), second = await prepare('second');
  const selected = await f.router.claudeCommands.local('chat', first);
  await assert.rejects(f.router.claudeCommands.local('second', second), /owned|reserved/);
  assert.throws(() => f.router.claudeCommands.finish('chat', first, selected, 999), /turn was not found/);
  const controller = new AbortController();
  await f.router.claudeCommands.local('second', second, { signal: controller.signal });
  controller.abort();
  await f.router.claudeCommands.local('chat', first);
  f.router.claudeCommands.release(first);
});

test('interrupting session listing settles promptly and cannot reserve a late result', async t => {
  const f = await fixture(t), sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'resume', origin: 'app', execution: 'local' }] });
  f.router.claudeCommands.sessionApi = { listSessions: () => pending };
  const context = await f.router.claudeCommands.prepare('chat', { input: [{ type: 'text', text: `/resume ${sessionId}` }] });
  const controller = new AbortController();
  const selected = f.router.claudeCommands.local('chat', context, { signal: controller.signal });
  controller.abort();
  await assert.rejects(selected, { name: 'AbortError' });
  release([{ sessionId }]); await tick();
  assert.equal(f.store.get('chat').bindings.claude.sessionId, null);
  assert.equal(f.router.claudeCommands.reservations.size, 0);
});

test('an ordinary result cannot assign a session reserved by a pending resume', async t => {
  const f = await fixture(t), sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.store.ensureThread({ id: 'second', cwd: f.dir, turns: [] }, { mode: 'claude' });
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'resume', origin: 'app', execution: 'local' }] });
  f.router.claudeCommands.sessionApi = { listSessions: async () => [{ sessionId }] };
  const context = await f.router.claudeCommands.prepare('chat', { input: [{ type: 'text', text: `/resume ${sessionId}` }] });
  await f.router.claudeCommands.local('chat', context);
  await f.router.request('turn/start', { threadId: 'second', input: [{ type: 'text', text: 'Continue native work' }] }); await tick();
  const done = [...f.router.runs.values()][0].done;
  f.runs[0].finish({ status: 'completed', nativeSessionId: sessionId });
  await done;
  assert.equal(f.store.get('second').bindings.claude.sessionId, null);
  assert.equal(f.store.get('second').turns.at(-1).turn.status, 'failed');
  f.router.claudeCommands.release(context);
});

test('copy skips Codex output in mixed history even when the role ID matches', async t => {
  const f = await fixture(t);
  f.store.putTurn('chat', { id: 'mixed', status: 'completed', items: [
    { id: 'claude', type: 'agentMessage', text: 'Claude answer', cdxEngineSource: 'claude', cdxRoleId: 'worker' },
    { id: 'codex', type: 'agentMessage', text: 'Codex answer', cdxEngineSource: 'codex', cdxRoleId: 'worker' },
  ] }, { engine: 'both' });
  assert.equal(f.router.claudeCommands.lastResponse('chat', {}), 'Claude answer');
  assert.equal(f.router.claudeCommands.lastResponse('chat', { roleId: 'worker' }), 'Claude answer');
});

for (const originalSessionId of [null, 'existing-native-session']) {
  test(`failed unacknowledged command restores ${originalSessionId ? 'the existing session' : 'no resume'} on the next start`, async t => {
    const f = await fixture(t);
    if (originalSessionId) f.store.setBinding('chat', 'claude', { sessionId: originalSessionId });
    await submit(f, '/context');
    const firstDone = [...f.router.runs.values()][0].done;
    f.runs[0].options.onEvent({ type: 'session', sessionId: 'transient-init-session' });
    assert.equal(f.store.get('chat').bindings.claude.sessionId, 'transient-init-session');
    f.runs[0].finish({ status: 'failed', error: 'Native context accounting timed out.', nativeSessionId: 'transient-init-session', sessionIdToRestore: originalSessionId });
    await firstDone;
    assert.equal(f.store.get('chat').bindings.claude.sessionId, originalSessionId);
    await submit(f, '/model');
    assert.equal(f.runs[1].options.nativeSessionId, originalSessionId);
    f.runs[1].finish({ status: 'completed', nativeSessionId: 'durable-session', localCommand: 'model' }); await tick();
    assert.equal(f.store.get('chat').bindings.claude.sessionId, 'durable-session');
  });
}

async function taskFixture(t, { roleAccess = 'write', access = 'read' } = {}) {
  const f = await fixture(t, 'both'), cwd = join(f.dir, 'task');
  mkdirSync(cwd);
  const template = f.templates.save({ schemaVersion: 2, id: 'task-command', name: 'Task command', description: '',
    roles: { worker: { engine: 'claude', model: 'sonnet', access: roleAccess, session: 'fresh', prompt: 'Worker instructions' } },
    steps: [{ id: 'work', type: 'run', role: 'worker', inputs: ['request'] }], output: { sources: ['work'], final: 'work', format: 'text' } });
  await f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'both', template: { id: template.id, revision: template.revision, parameters: {} }, claudeCommandTarget: 'worker' });
  const selection = f.router.workflow.selection({}, f.store.get('chat'));
  f.store.beginWorkflow('chat', { id: 'workflow', turn: { id: 'task-turn', status: 'inProgress', items: [] },
    config: { mode: 'both', ...selection, models: selection.models } });
  const descriptor = { roleId: 'worker', stepId: 'explore', round: 0, access, purpose: 'task', instructions: 'Explore the assigned files only.', cwd };
  f.store.putWorkflowRun('chat', 'workflow', { id: 'task-run', roleId: 'worker', stepId: 'explore', round: 0, attempt: 1, engine: 'claude',
    requestedModel: 'sonnet', permissionMode: 'default', status: 'completed', nativeSessionId: 'task-session', cwd });
  f.store.setWorkflowState('chat', 'workflow', { invocations: { explore: descriptor } });
  const key = roleBindingKey({ template: selection.template, roleId: 'worker', cwd, purpose: 'task' });
  f.store.setRoleBinding('chat', key, { engine: 'claude', sessionId: 'task-session', consumedSeq: 0 });
  f.store.finishWorkflow('chat', 'workflow', 'completed');
  return { ...f, cwd, key, descriptor };
}

test('commands restore a task invocation read ceiling and instructions', async t => {
  const f = await taskFixture(t);
  await submit(f, '/team:review');
  const run = f.runs[0];
  assert.equal(run.options.nativeSessionId, 'task-session');
  assert.equal(run.options.cwd, f.cwd);
  assert.equal(run.options.access, 'read');
  assert.match(run.options.instructions, /^Explore the assigned files only\./);
  run.finish({ status: 'completed', nativeSessionId: 'task-session', localCommand: 'context' }); await tick();
});

test('the current role ceiling still caps a restored task invocation', async t => {
  const f = await taskFixture(t, { roleAccess: 'read', access: 'write' });
  await submit(f, '/team:review');
  assert.equal(f.runs[0].options.access, 'read');
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'task-session', localCommand: 'context' }); await tick();
});

test('native model changes atomically move the source session over an existing destination binding', async t => {
  const f = await fixture(t, 'both');
  await f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'both', roleOverrides: { participant_b: { engine: 'claude', model: 'sonnet' } }, claudeCommandTarget: 'participant_b' });
  const keyFor = model => roleBindingKey({ template: f.router.workflow.selection({ roleOverrides: { participant_b: { engine: 'claude', model } } }, f.store.get('chat')).template, roleId: 'participant_b', cwd: f.dir });
  const sourceKey = keyFor('sonnet'), destinationKey = keyFor('opus');
  f.store.putTurn('chat', { id: 'old', status: 'completed', items: [] }, { engine: 'claude' });
  const source = { engine: 'claude', sessionId: 'source-session', consumedSeq: 0, actualPermissionMode: 'plan' };
  f.store.setRoleBinding('chat', sourceKey, source);
  f.store.setRoleBinding('chat', destinationKey, { engine: 'claude', sessionId: 'old-destination-session', consumedSeq: 1, actualPermissionMode: 'default' });
  f.store.setBinding('chat', 'claude', { sessionId: 'unrelated-single-session', consumedSeq: 0 });
  await submit(f, '/model opus');
  const snapshots = [], save = f.store.save.bind(f.store);
  f.store.save = value => { save(value); snapshots.push(JSON.parse(readFileSync(f.store.path('chat'), 'utf8'))); };
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'source-session', localCommand: 'model', settingsPatch: { model: 'opus' } }); await tick();
  f.store.save = save;
  const current = f.store.get('chat');
  assert.equal(current.turns.at(-1).turn.status, 'completed', current.turns.at(-1).turn.error?.message);
  assert.equal(current.roleOverrides.participant_b.model, 'opus');
  assert.equal(current.roleBindings[sourceKey], undefined);
  assert.equal(current.roleBindings[destinationKey].sessionId, source.sessionId);
  assert.equal(current.roleBindings[destinationKey].consumedSeq, source.consumedSeq);
  assert.equal(current.roleBindings[destinationKey].actualPermissionMode, source.actualPermissionMode);
  assert.equal(current.bindings.claude.sessionId, 'unrelated-single-session');
  for (const snapshot of snapshots.filter(value => value.roleOverrides.participant_b.model === 'opus')) {
    assert.equal(snapshot.roleBindings[sourceKey], undefined, 'The new selection must never be saved beside its old source binding.');
    assert.equal(snapshot.roleBindings[destinationKey].sessionId, source.sessionId);
    assert.equal(snapshot.roleBindings[destinationKey].consumedSeq, source.consumedSeq);
  }
  assert.equal(f.router.state('chat').busy, false);
  assert.equal(f.router.runs.size, 0);
  await submit(f, '/context');
  assert.equal(f.runs[1].options.nativeSessionId, source.sessionId);
  f.runs[1].finish({ status: 'completed', nativeSessionId: source.sessionId, localCommand: 'context' }); await tick();
});

test('a task session keeps its workspace and read ceiling after a native model change', async t => {
  const f = await taskFixture(t);
  await submit(f, '/model opus');
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'task-session', localCommand: 'model', settingsPatch: { model: 'opus' } }); await tick();
  await submit(f, '/team:review');
  const run = f.runs[1];
  assert.equal(run.options.nativeSessionId, 'task-session');
  assert.equal(run.options.model, 'opus');
  assert.equal(run.options.cwd, f.cwd);
  assert.equal(run.options.access, 'read');
  assert.match(run.options.instructions, /^Explore the assigned files only\./);
  run.finish({ status: 'completed', nativeSessionId: 'task-session', localCommand: 'context' }); await tick();
});

test('Claude command catalog follows authoritative chat cwd and explicit refresh', async t => {
  const f = await fixture(t);
  const result = await f.router.request('engine/claude/commands', { threadId: 'chat', cwd: '/wrong', refresh: true });
  assert.equal(result.commands.length, 4);
  assert.equal(f.calls.at(-1).params.cwd, f.dir);
  assert.equal(f.calls.at(-1).params.refresh, true);
});

test('native command stays exact after other-engine history and local output does not consume unseen context', async t => {
  const f = await fixture(t);
  f.store.putTurn('chat', { id: 'old', status: 'completed', items: [{ type: 'agentMessage', id: 'old-msg', text: 'Existing Codex context' }] }, { engine: 'codex', runId: 'old' });
  await submit(f, '/context');
  assert.equal(f.runs[0].options.prompt, '/context');
  assert.equal(f.runs[0].options.command.name, 'context');
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'claude', text: 'Context usage', localCommand: 'context' }); await tick();
  assert.equal(f.store.get('chat').bindings.claude.consumedSeq, 0);
  await submit(f, 'Continue');
  assert.match(f.runs[1].options.prompt, /Existing Codex context/);
  f.runs[1].finish({ status: 'completed' }); await tick();
});

test('clear advances only the target context watermark and preserves visible history', async t => {
  const f = await fixture(t);
  f.store.putTurn('chat', { id: 'old', status: 'completed', items: [{ type: 'agentMessage', id: 'old-msg', text: 'Do not reimport me' }] }, { engine: 'codex', runId: 'old' });
  await submit(f, '/clear');
  f.runs[0].options.onEvent({ type: 'session', sessionId: 'fresh-claude' });
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'fresh-claude', contextReset: true, localCommand: 'clear' }); await tick();
  assert.equal(f.store.get('chat').turns.length, 2);
  await submit(f, 'Hello');
  assert.equal(f.runs[1].options.prompt, 'Hello');
  assert.equal(f.runs[1].options.nativeSessionId, 'fresh-claude');
  f.runs[1].finish({ status: 'completed' }); await tick();
});

test('multi-agent command resumes selected Claude role and changes no other binding', async t => {
  const f = await fixture(t, 'both');
  await f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'both', roleOverrides: { participant_a: { engine: 'claude', model: 'opus' }, participant_b: { engine: 'claude', model: 'sonnet' } }, claudeCommandTarget: 'participant_b' });
  const selected = f.router.workflow.selection({}, f.store.get('chat'));
  const key = roleBindingKey({ template: selected.template, roleId: 'participant_b', cwd: f.dir });
  f.store.setRoleBinding('chat', key, { engine: 'claude', sessionId: 'participant-b-session', consumedSeq: 0 });
  await submit(f, '/model opus');
  const run = f.runs[0];
  assert.equal(run.options.nativeSessionId, 'participant-b-session');
  assert.equal(run.options.access, 'read');
  assert.equal(run.options.model, 'sonnet');
  assert.equal(run.options.prompt, '/model opus');
  run.finish({ status: 'completed', nativeSessionId: 'participant-b-session', localCommand: 'model', settingsPatch: { model: 'opus' } }); await tick();
  const current = f.store.get('chat');
  assert.equal(current.mode, 'both');
  assert.equal(current.claudeCommandTarget, 'participant_b');
  assert.equal(current.roleOverrides.participant_b.model, 'opus');
  assert.equal(current.bindings.claude.sessionId, null);
});

test('unknown commands and Codex role targets fail before any native run', async t => {
  const f = await fixture(t, 'both');
  await assert.rejects(submit(f, '/unknown-command'), /Unknown Claude command/);
  await assert.rejects(f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'both', claudeCommandTarget: 'participant_a' }), /Claude role/);
  assert.equal(f.runs.length, 0);
});

test('a native Plan exit in an ordinary turn persists for the next turn', async t => {
  const f = await fixture(t);
  await f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'claude', claudePermissionMode: 'plan' });
  await submit(f, 'Make a plan');
  f.runs[0].finish({ status: 'completed', nativeSessionId: 'claude-session', settingsPatch: { permissionMode: 'default' } }); await tick();
  await submit(f, 'Continue');
  assert.equal(f.runs[1].options.permissionMode, 'default');
  f.runs[1].finish({ status: 'completed' }); await tick();
});

test('resume lists native sessions in the selected workspace and resumes only an explicitly selected one', async t => {
  const f = await fixture(t), id = '12345678-1234-4234-8234-123456789012';
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'resume', origin: 'app', execution: 'local' }] });
  f.router.claudeCommands.sessionApi = { listSessions: async options => { assert.equal(options.dir, f.dir); return [{ sessionId: id, summary: 'Earlier native chat' }]; } };
  await submit(f, '/resume'); await tick();
  assert.match(f.store.get('chat').turns.at(-1).turn.items.at(-1).text, /Earlier native chat/);
  await submit(f, `/resume ${id}`); await tick();
  assert.equal(f.store.get('chat').bindings.claude.sessionId, id);
  assert.equal(f.runs.length, 0);
});

test('copy queues a client action exactly once and never reports copy before a client handles it', async t => {
  const f = await fixture(t);
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'copy', origin: 'app', execution: 'local' }] });
  f.store.putTurn('chat', { id: 'answer', status: 'completed', items: [{ type: 'agentMessage', id: 'answer-msg', text: 'Copy this answer' }] }, { engine: 'claude', runId: 'answer' });
  await submit(f, '/copy'); await tick();
  const [action] = f.router.state('chat').claudeClientActions;
  assert.equal(action.type, 'copy');
  const claimed = await f.router.request('engine/claude/client-action/claim', { threadId: 'chat', actionId: action.id });
  assert.equal(claimed.action.text, 'Copy this answer');
  assert.equal((await f.router.request('engine/claude/client-action/claim', { threadId: 'chat', actionId: action.id })).action, null);
});

test('busy Claude commands use the live handle and stay outside the main turn context', async t => {
  const f = await fixture(t);
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'status', origin: 'app', execution: 'control' }] });
  const started = await submit(f, 'Main work'), controls = [];
  f.runs[0].control = async command => { controls.push(command); return { text: 'Native running status' }; };
  const response = await f.router.request('turn/steer', { threadId: 'chat', expectedTurnId: started.turn.id, input: [{ type: 'text', text: '/status' }] });
  assert.equal(response.turnId, started.turn.id);
  assert.equal(controls[0].name, 'status');
  assert.equal(f.store.get('chat').turns.length, 1);
  assert.equal(f.router.state('chat').busy, true);
  assert.match(f.store.get('chat').turns[0].turn.items.at(-1).text, /Native running status/);
  assert.doesNotMatch(publicHistory(f.store.get('chat')), /Native running status|\/status/);
  assert.equal(f.runs.length, 1);
  await assert.rejects(f.router.request('turn/steer', { threadId: 'chat', expectedTurnId: 'wrong', input: [{ type: 'text', text: '/status' }] }), /ownership/);
  await assert.rejects(submit(f, '/clear'), /Stop.*command/);
  f.runs[0].finish({ status: 'completed' }); await tick();
});

test('live workflow commands require one active run of the selected Claude role', async t => {
  const f = await fixture(t, 'both'), controls = [];
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'tasks', origin: 'app', execution: 'local' }] });
  await f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'both', roleOverrides: { participant_a: { engine: 'claude' }, participant_b: { engine: 'claude' } } });
  const selected = f.router.workflow.selection({}, f.store.get('chat'));
  const turn = { id: 'active-debate', status: 'inProgress', items: [] };
  f.store.beginWorkflow('chat', { id: 'active-workflow', turn, config: { mode: 'both', models: selected.models, template: selected.template, parameters: {}, cwd: f.dir } });
  const row = f.store.require('chat').turns.at(-1);
  row.runs = [{ id: 'debater-a', roleId: 'participant_a', stepId: 'debate', engine: 'claude', cwd: f.dir, status: 'running' }, { id: 'debater-b', roleId: 'participant_b', stepId: 'debate', engine: 'claude', cwd: f.dir, status: 'running' }];
  f.router.workflow.active.set('active-workflow', { id: 'active-workflow', threadId: 'chat', turn, controller: new AbortController(), handle: { control: async (runId, command) => { controls.push({ runId, command }); return { text: 'Selected native tasks' }; } } });
  await f.router.request('engine/claude/target/set', { threadId: 'chat', claudeCommandTarget: 'participant_b' });
  assert.equal(f.store.get('chat').claudeCommandTarget, 'participant_b');
  assert.equal(f.store.get('chat').turns.at(-1).runs.filter(run => run.roleId === 'participant_b' && run.status === 'running').length, 1);
  await f.router.request('turn/steer', { threadId: 'chat', expectedTurnId: turn.id, input: [{ type: 'text', text: '/tasks' }] });
  assert.equal(controls[0].runId, 'debater-b');
  assert.equal(row.turn.items.at(-1).cdxRoleId, 'participant_b');
  assert.equal(row.turn.items.at(-1).cdxRunId, 'debater-b');
  assert.equal(row.turn.items.at(-1).cdxStepId, 'debate');
  row.runs[1].text = 'Selected native tasks';
  assert.match(publicHistory(f.store.get('chat')), /Selected native tasks/);
  row.runs.push({ ...row.runs[1], id: 'debater-b-2' });
  await assert.rejects(f.router.request('engine/claude/control', { threadId: 'chat', command: '/tasks' }), /multiple active/);
  await f.router.request('engine/claude/target/set', { threadId: 'chat', claudeCommandTarget: 'participant_b', runId: 'debater-b-2' });
  await f.router.request('engine/claude/control', { threadId: 'chat', command: '/tasks' });
  assert.equal(controls.at(-1).runId, 'debater-b-2');
  f.router.workflow.active.delete('active-workflow'); f.store.require('chat').activeRun = null;
});

test('live controls cannot target another role while a standalone role command owns the query', async t => {
  const f = await fixture(t, 'both'), controls = [];
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'status', origin: 'app', execution: 'control' }, { name: 'team:review', origin: 'skill', execution: 'native' }] });
  await f.router.request('engine/mode/set', { threadId: 'chat', engineMode: 'both', roleOverrides: { participant_a: { engine: 'claude' }, participant_b: { engine: 'claude' } }, claudeCommandTarget: 'participant_a' });
  await submit(f, '/team:review');
  f.runs[0].control = async command => { controls.push(command); return { text: 'Owned status' }; };
  await assert.rejects(f.router.request('engine/claude/control', { threadId: 'chat', command: '/status', target: 'participant_b' }), /not running|ownership/i);
  await assert.rejects(f.router.request('engine/claude/control', { threadId: 'chat', command: '/status', target: 'participant_a', runId: 'wrong' }), /ownership/i);
  assert.equal(controls.length, 0);
  await f.router.request('engine/claude/control', { threadId: 'chat', command: '/status', target: 'participant_a' });
  assert.equal(controls.length, 1);
  f.runs[0].finish({ status: 'completed' }); await tick();
});

test('native task snapshots persist through completion and remain readable by /tasks', async t => {
  const f = await fixture(t);
  f.router.adapter.listCommands = async () => ({ commands: [{ name: 'tasks', origin: 'app', execution: 'local' }] });
  await submit(f, 'Main work');
  f.runs[0].options.onEvent({ type: 'native-tasks', nativeTasks: [{ id: 'native-task', description: 'Background check', status: 'running' }] });
  assert.equal(f.store.get('chat').turns[0].runs[0].nativeTasks[0].status, 'running');
  f.runs[0].finish({ status: 'completed', nativeTasks: [{ id: 'native-task', description: 'Background check', status: 'process-ended', processEnded: true, lastStatus: 'running' }] }); await tick();
  await submit(f, '/tasks'); await tick();
  const text = f.store.get('chat').turns.at(-1).turn.items.at(-1).text;
  assert.match(text, /Background check.*process-ended/);
  assert.doesNotMatch(text, /\[object Object\]/);
});
