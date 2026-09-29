import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ClaudeAdapter } from '../../runtime/agent-modes/claude-adapter.mjs';
import { WorkflowScheduler } from '../../runtime/agent-modes/orchestration/scheduler.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 4000 }, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const terminal = { type: 'result', subtype: 'success', is_error: false, result: 'Main result', num_turns: 1 };

function fixture(methods = {}, extra = {}) {
  const observed = { calls: 0, controls: [], closed: false }, events = [], queued = [], waiters = [];
  const push = value => waiters.length ? waiters.shift()({ done: false, value }) : queued.push(value);
  const adapter = new ClaudeAdapter({ environment: () => ({}), queryImpl: request => {
    observed.calls++;
    observed.input = request.prompt[Symbol.asyncIterator]().next();
    return {
      async initializationResult() { observed.initialized = true; return {}; },
      async getStatus() { observed.controls.push('status'); return { sections: [{ title: 'Session', rows: [{ label: 'Status', value: 'working' }] }] }; },
      async listPermissionRules() { observed.controls.push('permissions'); return { state: { rules: [{ behavior: 'allow', rule: 'Read(*)' }] } }; },
      next() { return queued.length ? Promise.resolve({ done: false, value: queued.shift() }) : observed.closed ? Promise.resolve({ done: true }) : new Promise(resolve => waiters.push(resolve)); },
      close() { observed.closed = true; for (const resolve of waiters.splice(0)) resolve({ done: true }); },
      async return() { return { done: true }; }, async interrupt() {},
      ...methods,
    };
  } });
  const run = adapter.start({ cwd: '/tmp', prompt: 'Main request', onEvent: event => events.push(event), ...extra });
  return { run, observed, events, push };
}

test('live inspections reuse the active query, await startup and do not alter model output', async () => {
  const { run, observed, events, push } = fixture();
  assert.equal(typeof run.control, 'function');
  const replies = await Promise.all([run.control({ name: 'status', args: '' }), run.control({ name: 'permissions' })]);
  assert.match(replies[0].text, /working/); assert.match(replies[1].text, /Read/);
  assert.equal(observed.initialized, true); assert.equal(observed.calls, 1); assert.equal(observed.closed, false);
  assert.equal((await observed.input).value.message.content, 'Main request');
  assert.deepEqual(events, []);
  push(terminal);
  assert.equal((await run.done).text, 'Main result');
  assert.deepEqual(events.filter(event => event.type === 'message-completed').map(event => event.text), ['Main result']);
  await assert.rejects(run.control({ name: 'status' }), /active|ended|closed/i);
});

test('live controls enforce a narrow canonical command allowlist before invoking native methods', async () => {
  const { run, observed } = fixture();
  assert.equal(typeof run.control, 'function');
  for (const command of [{ name: 'clear' }, { name: 'model', args: 'sonnet' }, { name: 'permissions', args: 'bypassPermissions' }, { name: 'status', args: 'anything' }, { name: 'tasks', args: 'stop' }, { name: 'btw', args: '' }, { name: 'status', args: 123 }, { control: 'status' }, null]) {
    await assert.rejects(run.control(command), /command|argument|question|active/i);
  }
  assert.deepEqual(observed.controls, []);
  await run.interrupt();
});

test('live task stop reaches only an observed task in its selected adapter process', async () => {
  const stopped = [], left = fixture({ stopTask: async id => stopped.push(id) }), right = fixture({ stopTask: async () => assert.fail('wrong native worker') });
  left.push({ type: 'system', subtype: 'task_started', task_id: 'owned-task', description: 'Review' });
  await tick();
  await assert.rejects(right.run.control({ name: 'tasks', args: 'stop owned-task' }), /observed/);
  assert.match((await left.run.control({ name: 'tasks', args: 'stop owned-task' })).text, /stop requested/);
  assert.deepEqual(stopped, ['owned-task']);
  left.push({ type: 'system', subtype: 'task_notification', task_id: 'owned-task', status: 'stopped' });
  await tick();
  await assert.rejects(left.run.control({ name: 'tasks', args: 'stop owned-task' }), /active/);
  await Promise.all([left.run.interrupt(), right.run.interrupt()]);
});

test('cancelling a side question cancels only its control request and releases signal listeners', async () => {
  const entered = deferred(), pending = deferred();
  let sideSignal;
  const { run, observed, push } = fixture({ askSideQuestion(question, options) { assert.equal(question, 'What changed?'); sideSignal = options.signal; entered.resolve(); return pending.promise; } });
  assert.equal(typeof run.control, 'function');
  const controller = new AbortController();
  const control = run.control({ name: 'btw', args: 'What changed?' }, { signal: controller.signal });
  const rejected = assert.rejects(control, error => error.name === 'AbortError');
  await entered.promise; controller.abort(); await rejected;
  assert.equal(sideSignal.aborted, true); assert.equal(observed.closed, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  pending.resolve({ response: 'Late side answer' });
  push(terminal); assert.equal((await run.done).status, 'completed');
});

test('ending the main process rejects in-flight live controls and cannot leak a late response', async () => {
  const entered = deferred(), pending = deferred();
  const { run, events } = fixture({ getStatus() { entered.resolve(); return pending.promise; } });
  assert.equal(typeof run.control, 'function');
  const rejected = assert.rejects(run.control({ name: 'status' }), /active|ended|closed|abort/i);
  await entered.promise; assert.equal((await run.interrupt()).status, 'interrupted'); await rejected;
  pending.resolve({ state: 'Late state' }); await tick();
  assert.equal(events.some(event => event.type === 'message-completed'), false);
});

test('an already-cancelled control makes no native calls while the main query remains usable', async () => {
  let initializations = 0;
  const { run, observed, push } = fixture({ initializationResult: async () => { initializations++; return {}; } });
  await run.control({ name: 'status' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run.control({ name: 'status' }, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(initializations, 1); assert.deepEqual(observed.controls, ['status']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  push(terminal); assert.equal((await run.done).status, 'completed');
});

test('a live control waiting for startup rejects when its owner is stopped before query creation', async () => {
  const environment = deferred(); let calls = 0;
  const adapter = new ClaudeAdapter({ environment: () => environment.promise, queryImpl() { calls++; throw Error('Must not create a query'); } });
  const run = adapter.start({ cwd: '/tmp', prompt: 'Main request' });
  const rejected = assert.rejects(run.control({ name: 'status' }), /abort|ended/i);
  await tick(); assert.equal((await run.interrupt()).status, 'interrupted'); await rejected;
  environment.resolve({}); await tick(); assert.equal(calls, 0);
});

test('native tasks track background membership, progress and completion without becoming model text', async () => {
  const { run, events, push } = fixture();
  assert.equal(typeof run.control, 'function');
  await run.control({ name: 'status' });
  const task = (subtype, data) => push({ type: 'system', subtype, ...data });
  task('task_started', { task_id: 'one', task_type: 'local_agent', description: 'Review', is_backgrounded: true, prompt: 'Private task prompt' });
  task('background_tasks_changed', { tasks: [{ task_id: 'one', task_type: 'local_agent', description: 'Review' }, { task_id: 'two', task_type: 'local_bash', description: 'Watch', ambient: true }] });
  task('task_progress', { task_id: 'one', description: 'Review', summary: 'Checking files', usage: { total_tokens: 12, tool_uses: 2, duration_ms: 100 }, last_tool_name: 'Read' });
  task('task_updated', { task_id: 'one', patch: { description: 'Updated review', status: 'paused', is_backgrounded: true } });
  await tick();
  const live = await run.control({ name: 'tasks' });
  assert.equal(live.nativeTasks.length, 2); assert.match(live.text, /Updated review/);
  assert.equal(live.nativeTasks.find(row => row.id === 'one').status, 'paused');
  assert.equal(live.nativeTasks.find(row => row.id === 'one').summary, 'Checking files');
  assert.equal(live.nativeTasks.find(row => row.id === 'two').ambient, true);
  assert.doesNotMatch(JSON.stringify(live), /Private task prompt/);
  live.nativeTasks[0].description = 'Caller mutation';
  assert.notEqual((await run.control({ name: 'tasks' })).nativeTasks[0].description, 'Caller mutation');
  task('background_tasks_changed', { tasks: [] });
  task('task_notification', { task_id: 'one', status: 'completed', summary: 'Review finished', output_file: '/tmp/task-output' });
  await tick();
  const finished = await run.control({ name: 'tasks' });
  assert.equal(finished.nativeTasks.find(row => row.id === 'one').status, 'completed');
  assert.equal(finished.nativeTasks.find(row => row.id === 'two').status, 'unknown');
  assert.equal(events.some(event => ['text-delta', 'message-completed', 'input-acknowledged'].includes(event.type)), false);
  assert.ok(events.some(event => event.type === 'native-tasks'));
  push(terminal); const summary = await run.done;
  assert.equal(summary.nativeTasks.find(row => row.id === 'one').status, 'completed');
  assert.equal(summary.nativeTasks.find(row => row.id === 'two').status, 'process-ended');
  assert.ok(summary.nativeTasks.every(row => row.processEnded === true));
  assert.equal(summary.text, 'Main result');
});

test('task state starts empty in a new process even when resuming the same native session', async () => {
  const { run, push } = fixture({}, { nativeSessionId: 'same-session' });
  assert.equal(typeof run.control, 'function');
  assert.deepEqual((await run.control({ name: 'tasks' })).nativeTasks, []);
  push(terminal); assert.deepEqual((await run.done).nativeTasks, []);
});

test('scheduler exposes controls only for a live owned Claude run and preserves task snapshots', async () => {
  const calls = [], controls = [];
  const role = engine => ({ engine, access: 'read', session: 'fresh', prompt: 'Instructions' });
  const template = { schemaVersion: 1, id: 'live-controls', revision: 1, name: 'Live controls', description: '', roles: { c: role('codex'), a: role('claude') }, limits: { concurrency: 2, rounds: 1, tasks: 2 }, steps: [{ id: 'c', type: 'run', role: 'c', inputs: ['request'] }, { id: 'a', type: 'run', role: 'a', inputs: ['request'] }], output: { sources: ['c', 'a'], final: 'a', format: 'text' } };
  const runner = { start(options) { const finished = deferred(); calls.push({ options, finished }); return { done: finished.promise, interrupt: async () => finished.resolve({ status: 'interrupted' }), control: async (command, extra) => { controls.push({ id: options.runId, command, extra }); return { text: 'Side result' }; } }; } };
  const run = new WorkflowScheduler({ runner }).start({ runId: 'workflow', template, cwd: '/tmp', input: 'Request', models: {} });
  assert.equal(typeof run.control, 'function');
  while (calls.length < 2) await tick();
  const claude = calls.find(call => call.options.engine === 'claude'), codex = calls.find(call => call.options.engine === 'codex');
  const signal = new AbortController().signal;
  assert.equal((await run.control(claude.options.runId, { name: 'status' }, { signal })).text, 'Side result');
  assert.equal(controls[0].id, claude.options.runId); assert.equal(controls[0].extra.signal, signal);
  await assert.rejects(run.control(codex.options.runId, { name: 'status' }), /Claude/i);
  await assert.rejects(run.control('not-owned', { name: 'status' }), /active|owned/i);
  assert.equal(run.snapshot().events.length, 0);
  const nativeTasks = [{ id: 'task', description: 'Review', status: 'running' }];
  claude.options.onEvent({ type: 'native-tasks', nativeTasks });
  assert.deepEqual(run.snapshot().runs.find(row => row.id === claude.options.runId).nativeTasks, nativeTasks);
  claude.finished.resolve({ status: 'completed', text: 'Main Claude result', nativeTasks: [{ ...nativeTasks[0], status: 'process-ended', processEnded: true }] });
  codex.finished.resolve({ status: 'completed', text: 'Main Codex result' });
  const result = await run.done;
  assert.equal(result.outputs.final.text, 'Main Claude result');
  assert.equal(run.snapshot().runs.find(row => row.id === claude.options.runId).nativeTasks[0].processEnded, true);
  await assert.rejects(run.control(claude.options.runId, { name: 'status' }), /active|ended|owned/i);
});
