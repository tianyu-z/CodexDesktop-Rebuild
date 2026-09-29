import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { WorkflowScheduler, roleBindingKey as bindingKey } from '../../runtime/agent-modes/orchestration/scheduler.mjs';
import { renderInputs } from '../../runtime/agent-modes/orchestration/inputs.mjs';
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_REVISIONS } from '../../runtime/agent-modes/templates/builtins.mjs';

const roleBindingKey = value => bindingKey({ ...value, requestedModel: Object.hasOwn(value.template.roles[value.roleId], 'model') ? value.template.roles[value.roleId].model : value.template.roles[value.roleId].engine === 'codex' ? 'codex-exact' : 'claude-deployment' });
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let n = 0; n < 80; n++) { if (predicate()) return; await tick(); } assert.fail('condition did not settle'); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const capturedImage = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } });
function harness() {
  const calls = [];
  let active = 0, peak = 0;
  return { calls, get active() { return active; }, get peak() { return peak; },
    start(options) {
      const finish = deferred(); active++; peak = Math.max(peak, active);
      const call = { ...options, complete(result = {}) { finish.resolve({ status: 'completed', text: `${options.stepId ?? options.roleId} result`, ...result }); },
        emit(event) { options.onEvent(event); }, permission(request = {}) { return options.onPermission({ id: `${options.runId}:approval`, method: 'approval', ...request }); } };
      calls.push(call);
      let stopped = false;
      const stop = async () => { if (!stopped) { stopped = true; finish.resolve({ status: 'interrupted', text: 'partial' }); } return await done; };
      const abort = () => { void stop(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      const done = finish.promise.finally(() => { active--; options.signal?.removeEventListener('abort', abort); });
      return { done, interrupt: stop };
    },
  };
}
const role = engine => ({ engine, access: 'read', session: 'fresh', prompt: `${engine} instructions` });
const template = () => ({ schemaVersion: 1, id: 'custom', revision: 3, name: 'Custom graph', description: '',
  roles: { c: role('codex'), a: role('claude') }, limits: { concurrency: 2, rounds: 3, tasks: 3 },
  steps: [{ id: 'left', type: 'run', role: 'c', inputs: ['request'] }, { id: 'right', type: 'run', role: 'a', inputs: ['request'] },
    { id: 'finish', type: 'synthesize', role: 'a', dependsOn: ['left', 'right'], inputs: ['left', 'right'] }],
  output: { sources: ['left', 'right', 'finish'], final: 'finish', format: 'markdown' } });
const options = extra => ({ runId: 'workflow', template: template(), models: { codex: 'codex-exact', claude: 'claude-deployment' },
  cwd: '/tmp/non-git', input: 'Original request', history: [{ seq: 1, engine: 'codex', text: 'Prior public answer' }], ...extra });

test('Claude binding options are scoped and frozen for fresh invocations, retries and recovery', async () => {
  const t = template(), claudeKey = roleBindingKey({ template: t, roleId: 'a', cwd: '/tmp/non-git' }), codexKey = roleBindingKey({ template: t, roleId: 'c', cwd: '/tmp/non-git' });
  const bindings = { [claudeKey]: { engine: 'claude', claudeOptions: { effort: 'high', thinking: { type: 'disabled' } } }, [codexKey]: { engine: 'codex', claudeOptions: { effort: 'low' } } };
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: t, bindings }));
  bindings[claudeKey].claudeOptions.effort = 'low';
  await until(() => runner.calls.length === 2);
  assert.equal(runner.calls[0].claudeOptions, undefined);
  assert.deepEqual(runner.calls[1].claudeOptions, { effort: 'high', thinking: { type: 'disabled' } });
  assert.equal(runner.calls[1].nativeSessionId, undefined, 'fresh native processes still inherit this role binding options');
  runner.calls[0].complete(); runner.calls[1].complete({ status: 'failed', settingsPatch: { claudeOptions: { effort: 'max' } } });
  await until(() => run.snapshot().status === 'blocked');
  assert.equal(run.snapshot().bindings[claudeKey].claudeOptions.effort, 'high');
  const saved = run.snapshot(), failed = saved.runs.find(row => row.status === 'failed');
  await run.interrupt();
  const restartedRunner = harness(), restarted = new WorkflowScheduler({ runner: restartedRunner }).start(options({ previousSnapshot: saved, retryRunId: failed.id, bindings: { [claudeKey]: { engine: 'claude', claudeOptions: { effort: 'low' } } } }));
  await until(() => restartedRunner.calls.length === 1);
  assert.deepEqual(restartedRunner.calls[0].claudeOptions, { effort: 'high', thinking: { type: 'disabled' } });
  await restarted.interrupt();
});

test('completed native session option changes merge only into their exact Claude role binding', async () => {
  const t = template(), claudeKey = roleBindingKey({ template: t, roleId: 'a', cwd: '/tmp/non-git' });
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: t, bindings: { [claudeKey]: { engine: 'claude', claudeOptions: { effort: 'high' } } } }));
  await until(() => runner.calls.length === 2);
  runner.calls[0].complete(); runner.calls[1].complete({ settingsPatch: { claudeOptions: { thinking: { type: 'disabled' } } } });
  await until(() => runner.calls.length === 3);
  assert.deepEqual(run.snapshot().bindings[claudeKey].claudeOptions, { effort: 'high', thinking: { type: 'disabled' } });
  assert.deepEqual(runner.calls[2].claudeOptions, { effort: 'high', thinking: { type: 'disabled' } });
  await finishRemaining(run, runner);
});
async function finishRemaining(run, runner) {
  for (let n = 0; n < 30 && !['completed', 'failed', 'interrupted'].includes(run.snapshot().status); n++) {
    runner.calls.forEach(call => call.complete()); await tick();
  }
  return await run.done;
}

test('request-consuming roles load immutable capture copies and retain only IDs across retries and restart', async () => {
  const inputCapture = { version: 1, id: 'a'.repeat(64) }, loads = [];
  const loadInputCapture = async capture => { loads.push(clone(capture)); return [{ type: 'text', text: 'Original request' }, capturedImage()]; };
  const runner = harness(), run = new WorkflowScheduler({ runner, loadInputCapture }).start(options({ inputCapture }));
  try {
    await until(() => runner.calls.length === 2);
    assert.deepEqual(runner.calls.map(call => call.inputContent), [[capturedImage()], [capturedImage()]]);
    runner.calls[0].inputContent[0].source.data = 'mutated runner copy';
    assert.deepEqual(runner.calls[1].inputContent, [capturedImage()]);
    runner.calls[0].complete(); runner.calls[1].complete({ status: 'failed', error: 'Retry with the same pixels' });
    await until(() => run.snapshot().status === 'blocked');
    const previousSnapshot = run.snapshot(), failed = previousSnapshot.runs.find(row => row.status === 'failed');
    assert.doesNotMatch(JSON.stringify(previousSnapshot), /iVBORw0KGgo/);
    assert.deepEqual(previousSnapshot.config.inputCapture, inputCapture);
    await run.interrupt();
    const nextRunner = harness(), next = new WorkflowScheduler({ runner: nextRunner, loadInputCapture }).start(options({ previousSnapshot, retryRunId: failed.id, inputCapture: { version: 1, id: 'b'.repeat(64) } }));
    try {
      await until(() => nextRunner.calls.length === 1);
      assert.deepEqual(nextRunner.calls[0].inputContent, [capturedImage()]);
      assert.deepEqual(loads.at(-1), inputCapture);
      nextRunner.calls[0].complete(); await until(() => nextRunner.calls.length === 2);
      assert.equal(nextRunner.calls[1].inputContent, undefined, 'A synthesis without request input must not acquire undeclared original attachments');
      assert.equal((await finishRemaining(next, nextRunner)).status, 'completed');
    } finally { await next.interrupt(); }
  } finally { await run.interrupt(); }
});

test('captured image steering reaches both harnesses and later roles without base64 in saved guidance', async () => {
  const capture = { version: 1, id: 'c'.repeat(64) }, sends = [], runner = harness(), start = runner.start;
  runner.start = function(options) { return { ...start.call(this, options), steer: async content => { sends.push({ roleId: options.roleId, content }); content[0].source.data = 'changed receiver'; } }; };
  const run = new WorkflowScheduler({ runner, loadInputCapture: async () => [capturedImage()] }).start(options());
  try {
    await until(() => runner.calls.length === 2);
    const receipt = await run.steer({ text: '', inputCapture: capture });
    assert.equal(receipt.accepted.length, 2);
    assert.equal(sends.length, 2);
    assert.deepEqual(run.snapshot().guidance[0].inputCapture, capture);
    assert.doesNotMatch(JSON.stringify(run.snapshot()), /iVBORw0KGgo/);
    runner.calls[0].complete(); runner.calls[1].complete();
    await until(() => runner.calls.length === 3);
    assert.deepEqual(runner.calls[2].inputContent, [capturedImage()]);
  } finally { await run.interrupt(); }
});

test('builtin Debby participants and host all receive the original captured images', async () => {
  const runner = harness(), selected = BUILTIN_TEMPLATES.find(row => row.id === 'debby');
  const run = new WorkflowScheduler({ runner, loadInputCapture: async () => [capturedImage()] }).start(options({ template: selected,
    parameters: { rounds: 0, host_mode: 'final-only' }, input: '', inputCapture: { version: 1, id: 'd'.repeat(64) } }));
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
  assert.deepEqual(runner.calls.map(call => call.roleId).sort(), ['host', 'participant_a', 'participant_b']);
  assert.ok(runner.calls.every(call => JSON.stringify(call.inputContent) === JSON.stringify([capturedImage()])));
});

test('image guidance arriving before a native handle starts is retained for that role', async () => {
  const pending = deferred(), runner = harness(), original = { version: 1, id: 'a'.repeat(64) }, followup = { version: 1, id: 'b'.repeat(64) };
  const run = new WorkflowScheduler({ runner, loadInputCapture: async capture => {
    if (capture.id === original.id) await pending.promise;
    return [capturedImage()];
  } }).start(options({ inputCapture: original }));
  try {
    await until(() => run.snapshot().runs.length === 2);
    const receipt = await run.steer({ text: '', inputCapture: followup });
    assert.equal(receipt.accepted.length, 0);
    pending.resolve(); await until(() => runner.calls.length === 2);
    assert.deepEqual(runner.calls.map(call => call.inputContent.length), [2, 2]);
  } finally { pending.resolve(); await run.interrupt(); }
});

for (const phase of ['role startup', 'steering']) test(`Stop releases a stalled image capture reload during ${phase}`, async () => {
  const pending = deferred(), entered = deferred(), runner = harness(), inputCapture = { version: 1, id: 'e'.repeat(64) };
  const run = new WorkflowScheduler({ runner, loadInputCapture: async () => { entered.resolve(); return await pending.promise; } })
    .start(options(phase === 'role startup' ? { inputCapture } : {}));
  let steering, outcome, stopped = false;
  try {
    if (phase === 'steering') {
      await until(() => runner.calls.length === 2);
      steering = run.steer({ text: '', inputCapture }).then(value => { outcome = { value }; }, error => { outcome = { error }; });
    }
    await entered.promise;
    const stopping = run.interrupt().then(() => { stopped = true; });
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(stopped, true, 'Stop must finish while the capture reader is blocked');
    if (steering) assert.match(outcome?.error?.message ?? 'steering still pending', /abort|interrupt/i);
    await stopping;
  } finally { pending.resolve([capturedImage()]); await run.interrupt(); await steering; }
  await tick();
  assert.equal(runner.calls.length, phase === 'role startup' ? 0 : 2);
  assert.equal(run.snapshot().guidance.length, 0);
});

test('write workflows finish preparation before any planner or sibling native run', async () => {
  const t = clone(BUILTIN_TEMPLATES.find(row => row.id === 'polly'));
  const runner = harness(), gate = deferred(); let prepared = false;
  const run = new WorkflowScheduler({ runner, operationsFactory: () => ({
    async prepare() { await gate.promise; prepared = true; },
  }) }).start(options({ template: t }));
  await tick(); await tick(); assert.equal(runner.calls.length, 0);
  gate.resolve(); await until(() => runner.calls.length === 1);
  assert.equal(prepared, true); assert.equal(runner.calls[0].roleId, 'planner');
  await run.interrupt();
});

test('preparation failure starts no native roles, while read-only workflows require no workspace provider', async () => {
  const t = template(); t.roles.c.access = 'write';
  const runner = harness(), failed = new WorkflowScheduler({ runner, operationsFactory: () => ({
    prepare() { throw new Error('NOT_GIT: existing repository required'); },
  }) }).start(options({ template: t }));
  assert.match((await failed.done).error, /NOT_GIT/); assert.equal(runner.calls.length, 0);
  const readRunner = harness(), readRun = new WorkflowScheduler({ runner: readRunner,
    operationsFactory() { throw new Error('Read-only workflow must not initialize Git'); },
  }).start(options());
  assert.equal((await finishRemaining(readRun, readRunner)).status, 'completed');
});

test('inputs label full public results and permit only exact reference keys', () => {
  const result = { id: 'r', engine: 'codex', roleId: 'answer', requestedModel: 'specific', text: 'Original', usage: { total: 7 }, structuredOutput: { fact: 4 } };
  const values = new Map([['request', 'USER UNIQUE'], ['history', [{ text: 'HISTORY UNIQUE' }]], ['source', result]]);
  const rendered = renderInputs(['request', 'history', 'source'], ref => values.get(ref));
  assert.match(rendered, /request/i); assert.match(rendered, /history/i); assert.match(rendered, /source/);
  assert.ok(rendered.includes(JSON.stringify(result, null, 2))); assert.equal(rendered.split('USER UNIQUE').length - 1, 1);
  assert.throws(() => renderInputs(['source.text'], ref => values.get(ref)), /reference|unavailable/i);
});

test('independent siblings run together; synthesis waits for both complete envelopes', async () => {
  const runner = harness(), snapshots = [], events = [];
  const run = new WorkflowScheduler({ runner, onEvent(event) { assert.ok(snapshots.at(-1).events.some(e => e.eventId === event.eventId)); events.push(event); } })
    .start(options({ onSnapshot: snapshot => snapshots.push(snapshot) }));
  await until(() => runner.calls.length === 2);
  assert.deepEqual(runner.calls.map(c => c.engine), ['codex', 'claude']);
  runner.calls[0].emit({ type: 'text-delta', delta: 'C' }); runner.calls[1].emit({ type: 'text-delta', delta: 'A' });
  runner.calls[0].complete({ text: 'Codex full', usage: { total: 7 } }); await tick(); assert.equal(runner.calls.length, 2);
  runner.calls[1].complete({ text: 'Claude full' }); await until(() => runner.calls.length === 3);
  assert.match(runner.calls[2].prompt, /Codex full/); assert.match(runner.calls[2].prompt, /"usage"/); assert.match(runner.calls[2].prompt, /"engine": "claude"/);
  runner.calls[2].complete({ text: 'Synthesis' }); const result = await run.done;
  assert.equal(result.status, 'completed'); assert.equal(result.outputs.final.text, 'Synthesis');
  assert.equal(result.outputs.sources.left.text, 'Codex full'); assert.deepEqual(events.map(e => e.seq), [...events.keys()].map(i => i + 1));
  assert.equal(new Set(events.map(e => e.eventId)).size, events.length);
});

test('the concurrency budget applies across nested groups and array order adds no dependency', async () => {
  const t = template(); t.limits.concurrency = 2;
  t.steps = [{ id: 'outer', type: 'parallel', steps: [
    { id: 'first', type: 'parallel', steps: [{ id: 'one', type: 'run', role: 'c', inputs: ['request'] }, { id: 'two', type: 'run', role: 'a', inputs: ['request'] }] },
    { id: 'second', type: 'parallel', steps: [{ id: 'three', type: 'run', role: 'c', inputs: ['request'] }, { id: 'four', type: 'run', role: 'a', inputs: ['request'] }] },
  ] }]; t.output = { sources: ['outer.first.one', 'outer.second.four'], final: 'outer.second.four', format: 'text' };
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: t }));
  await until(() => runner.calls.length === 2); assert.equal(runner.active, 2);
  runner.calls[0].complete(); await until(() => runner.calls.length === 3); assert.equal(runner.active, 2);
  const result = await finishRemaining(run, runner); assert.equal(result.status, 'completed'); assert.equal(runner.peak, 2);
});

test('round peers see the whole previous completed snapshot even after a faster peer finishes', async () => {
  const t = clone(BUILTIN_TEMPLATE_REVISIONS.find(t => t.id === 'debby' && t.revision === 1)); t.limits.concurrency = 1;
  const runner = harness(), selected = options({ template: t, parameters: { rounds: 2 } }), run = new WorkflowScheduler({ runner }).start(selected);
  for (const [index, text] of ['C0', 'A0', 'C1', 'A1', 'C2', 'A2', 'SUMMARY'].entries()) {
    await until(() => runner.calls.length === index + 1);
    const call = runner.calls[index];
    if (index === 2) assert.match(call.prompt, /A0/);
    if (index === 3) { assert.match(call.prompt, /C0/); assert.doesNotMatch(call.prompt, /C1/); }
    if (index === 4) assert.match(call.prompt, /A1/);
    if (index === 5) { assert.match(call.prompt, /C1/); assert.doesNotMatch(call.prompt, /C2/); }
    call.complete({ text });
  }
  const result = await run.done; assert.equal(result.outputs.sources['debate.codex'].text, 'C2');
  assert.deepEqual(run.snapshot().runs.map(r => r.round), [0, 0, 1, 1, 2, 2, 0]);
});

test('start snapshots selected slots, instructions, bounds and native options synchronously', async () => {
  const t = template(); t.steps[1].dependsOn = ['left'];
  t.parameters = { amount: { type: 'integer', default: 2, min: 1, max: 3 } }; t.steps[0].inputs.push('parameters.amount');
  const runner = harness(), input = options({ template: t, parameters: { amount: 3 }, nativeOptions: { codex: { effort: 'high' }, claude: { mode: 'native' } } });
  const run = new WorkflowScheduler({ runner }).start(input);
  input.models.claude = 'wrong'; input.models.codex = 'wrong'; input.nativeOptions.codex.effort = 'low'; input.parameters.amount = 1; t.roles.c.prompt = 'mutated';
  await until(() => runner.calls.length === 1); assert.equal(runner.calls[0].model, 'codex-exact'); assert.match(runner.calls[0].instructions, /codex instructions/); assert.match(runner.calls[0].prompt, /3/);
  assert.deepEqual(runner.calls[0].nativeOptions, { effort: 'high' });
  runner.calls[0].complete(); await until(() => runner.calls.length === 2); assert.equal(runner.calls[1].model, 'claude-deployment');
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
});

test('failure blocks dependents, retains completed siblings and retries the frozen descriptor', async () => {
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options());
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: 'Preserved success' }); runner.calls[1].complete({ status: 'failed', error: 'Transient' });
  await until(() => run.snapshot().status === 'blocked'); assert.equal(runner.calls.length, 2);
  let settled = false; run.done.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  const failed = run.snapshot().runs.find(r => r.status === 'failed'); assert.equal(run.retry(failed.id), true);
  await until(() => runner.calls.length === 3); assert.equal(runner.calls[2].prompt, runner.calls[1].prompt); assert.equal(runner.calls[2].model, runner.calls[1].model); assert.notEqual(runner.calls[2].runId, failed.id);
  runner.calls[2].complete({ text: 'Recovered' }); await until(() => runner.calls.length === 4); assert.match(runner.calls[3].prompt, /Preserved success/);
  assert.equal(run.retry(failed.id), false); assert.equal((await finishRemaining(run, runner)).status, 'completed');
  assert.deepEqual(run.snapshot().runs.filter(r => r.stepId === 'right').map(r => r.attempt), [1, 2]);
  assert.deepEqual(run.snapshot().runs.find(r => r.id === failed.id), failed);
});

test('global stop before scheduling never creates native calls and completes once', async () => {
  const runner = harness(), snapshots = [], run = new WorkflowScheduler({ runner }).start(options({ onSnapshot: s => snapshots.push(s) }));
  const stopped = run.interrupt(); assert.equal((await stopped).status, 'interrupted'); await run.interrupt();
  assert.equal(runner.calls.length, 0); assert.equal(snapshots.filter(s => s.status === 'interrupted').length, 1);
});

test('individual cancellation is retryable and stop aborts pending approval and waits for cleanup', async () => {
  const runner = harness(), permissionSignal = deferred();
  const run = new WorkflowScheduler({ runner, onPermission(request) { permissionSignal.resolve(request); return new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ decision: 'decline' }), { once: true })); } }).start(options());
  await until(() => runner.calls.length === 2); const leftId = run.snapshot().runs.find(r => r.engine === 'codex').id;
  await run.interrupt(leftId); await until(() => run.snapshot().status === 'blocked');
  const pending = runner.calls[1].permission(); const permission = await permissionSignal.promise;
  assert.equal(permission.runId, runner.calls[1].runId); assert.equal(permission.cwd, '/tmp/non-git');
  assert.equal(run.snapshot().runs.find(r => r.id === permission.runId).status, 'awaitingApproval');
  await run.interrupt(); await pending; assert.equal(permission.signal.aborted, true); assert.equal(runner.active, 0);
  assert.equal((await run.done).status, 'interrupted'); assert.equal(run.retry(leftId), false);
});

test('planner uses structured schema, validates bounds and never executes a malformed plan', async () => {
  const t = template(); t.steps = [{ id: 'plan', type: 'planTasks', role: 'a', inputs: ['request'], maxTasks: 1 },
    { id: 'work', type: 'executeTasks', dependsOn: ['plan'], plan: 'plan', roles: { codex: 'c', claude: 'a' }, workspace: 'isolated' }];
  t.output = { sources: ['plan.tasks', 'work.tasks'], final: 'work.tasks', format: 'json' };
  const runner = harness(), plans = [], run = new WorkflowScheduler({ runner, operationsFactory: context => ({ async executeTasks(step, frame) { plans.push(frame.resolve(step.plan)); return { tasks: ['executed'] }; } }) }).start(options({ template: t }));
  await until(() => runner.calls.length === 1); assert.equal(runner.calls[0].outputSchema.type, 'object');
  runner.calls[0].complete({ structuredOutput: { tasks: [] } }); await until(() => run.snapshot().status === 'blocked'); assert.equal(plans.length, 0);
  run.retry(run.snapshot().runs.at(-1).id); await until(() => runner.calls.length === 2);
  const task = { id: 'a', description: 'Read', engine: 'codex', purpose: 'explore', dependsOn: [], files: ['src/**'], acceptance: ['Explanation'] };
  runner.calls[1].complete({ structuredOutput: { tasks: [task] }, text: 'Planner original' });
  const result = await run.done; assert.deepEqual(result.outputs.sources['plan.tasks'], [task]); assert.equal(plans[0].text, 'Planner original'); assert.equal(plans[0].engine, 'claude');
  assert.deepEqual(result.outputs.final, ['executed']);
});

test('operation hooks share the same role budget and cannot broaden read access', async () => {
  const t = template(); t.roles.c.access = 'write';
  const runner = harness(); let context;
  const run = new WorkflowScheduler({ runner, operationsFactory: value => { context = value; return { run(step, frame) { return value.invoke({ roleId: step.role, stepId: frame.path, round: frame.round, prompt: 'Isolated task', cwd: '/tmp/isolated', purpose: 'task-a' }); } }; } }).start(options({ template: t }));
  await until(() => runner.calls.length === 2); assert.equal(runner.calls.find(c => c.engine === 'codex').cwd, '/tmp/isolated'); assert.equal(runner.peak, 2);
  await assert.rejects(context.invoke({ roleId: 'a', stepId: 'illegal', prompt: 'No', access: 'write' }), /access/i);
  context.checkpoint('artifact', { head: 'abc' }); assert.deepEqual(run.snapshot().checkpoints.artifact, { head: 'abc' });
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
});

test('reusable sessions are role/workspace scoped, serialized and acknowledged only through supplied sequence', async () => {
  const t = template(); t.roles.c.session = 'reuse'; t.roles.a.session = 'reuse';
  t.steps[0].inputs.push('history');
  t.steps.splice(1, 0, { id: 'second', type: 'run', role: 'c', inputs: ['request'] });
  const runner = harness(), events = [], selected = options({ template: t, throughSeq: 9, history: [{ seq: 9, text: 'New public history' }] });
  const key = roleBindingKey({ template: t, roleId: 'c', cwd: selected.cwd });
  selected.bindings = { [key]: { engine: 'codex', sessionId: 'existing-c', consumedSeq: 4 } };
  const run = new WorkflowScheduler({ runner, onEvent: e => events.push(e) }).start(selected);
  await until(() => runner.calls.length === 2); assert.equal(runner.calls.filter(c => c.engine === 'codex').length, 1);
  const first = runner.calls.find(c => c.engine === 'codex'); assert.equal(first.nativeSessionId, 'existing-c');
  first.emit({ type: 'session', sessionId: 'existing-c' }); first.emit({ type: 'input-acknowledged' });
  assert.equal(run.snapshot().bindings[key].consumedSeq, 9); assert.equal(events.find(e => e.type === 'session').runId, first.runId);
  first.complete({ nativeSessionId: 'existing-c' }); await until(() => runner.calls.length === 3);
  assert.equal(runner.calls[2].nativeSessionId, 'existing-c');
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
  const noCursor = new WorkflowScheduler({ runner: harness() }).start(options({ signal: AbortSignal.abort(), bindings: selected.bindings })); await noCursor.done;
  assert.equal(noCursor.snapshot().bindings[key].consumedSeq, 4);
});

test('restart retains results without native replay until an explicit retry resumes the suspended graph', async () => {
  const runner = harness(), first = new WorkflowScheduler({ runner }).start(options());
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: 'Saved codex' }); runner.calls[1].complete({ status: 'failed', error: 'Retry me' });
  await until(() => first.snapshot().status === 'blocked'); const previousSnapshot = first.snapshot(), failed = previousSnapshot.runs.find(r => r.status === 'failed');
  await first.interrupt();
  const nextRunner = harness(), restarted = new WorkflowScheduler({ runner: nextRunner }).start(options({ previousSnapshot, models: { codex: 'changed', claude: 'changed' } }));
  await tick(); assert.equal(nextRunner.calls.length, 0); assert.equal(restarted.snapshot().status, 'blocked');
  restarted.retry(failed.id); await until(() => nextRunner.calls.length === 1);
  assert.equal(nextRunner.calls[0].engine, 'claude'); assert.equal(nextRunner.calls[0].model, 'claude-deployment'); nextRunner.calls[0].complete({ text: 'Restarted' });
  await until(() => nextRunner.calls.length === 2); assert.match(nextRunner.calls[1].prompt, /Saved codex/); nextRunner.calls[1].complete();
  assert.equal((await restarted.done).status, 'completed'); assert.equal(restarted.snapshot().runs.length, 4);
});

test('persistence callback failures stop owned work and surface failed completion', async () => {
  const runner = harness(), run = new WorkflowScheduler({ runner, onEvent() { throw new Error('Persistence unavailable'); } }).start(options());
  await until(() => runner.calls.length === 2); runner.calls[0].emit({ type: 'text-delta', delta: 'message' });
  const result = await run.done; assert.equal(result.status, 'failed'); assert.match(result.error, /Persistence unavailable/); assert.equal(runner.active, 0);
});

test('stop waits for delayed native cleanup and retains session registration arriving during cancellation', async () => {
  const cleanup = deferred(), started = deferred(), events = [];
  const runner = { start(options) {
    const done = cleanup.promise.then(() => ({ status: 'interrupted', nativeSessionId: 'late-owned-thread' }));
    started.resolve(options);
    return { done, async interrupt() { options.onEvent({ type: 'session', sessionId: 'late-owned-thread' }); return await done; } };
  } };
  const t = template(); t.limits.concurrency = 1;
  const run = new WorkflowScheduler({ runner, onEvent: event => events.push(event) }).start(options({ template: t }));
  await started.promise; const stopping = run.interrupt(); let finished = false; stopping.then(() => { finished = true; }); await tick();
  assert.equal(finished, false); assert.equal(events.find(e => e.type === 'session').sessionId, 'late-owned-thread');
  cleanup.resolve(); assert.equal((await stopping).status, 'interrupted');
  assert.equal(run.snapshot().runs[0].nativeSessionId, 'late-owned-thread');
});

test('missing planner structured output is a retryable role failure despite valid-looking text', async () => {
  const t = template(); t.steps[0] = { id: 'left', type: 'planTasks', role: 'c', inputs: ['request'] };
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: t }));
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: '{"tasks":[]}' }); runner.calls[1].complete();
  await until(() => run.snapshot().status === 'blocked'); assert.match(run.snapshot().runs[0].error, /serializable|object/i);
  assert.equal(runner.calls.length, 2); await run.interrupt();
});

test('zero repeats export initial aliases and nested repeats shadow only their previousRound namespace', async () => {
  const t = template(); t.steps = [t.steps[0], t.steps[1],
    { id: 'zero', type: 'repeat', dependsOn: ['left', 'right'], count: 0, initial: { c: 'left', a: 'right' },
      steps: [{ id: 'unused', type: 'run', role: 'c', inputs: ['previousRound.a'] }], yields: { c: 'unused', a: 'unused' } },
    { id: 'loop', type: 'repeat', dependsOn: ['zero'], count: 2, initial: { c: 'zero.c' }, steps: [
      { id: 'inner', type: 'repeat', count: 1, initial: { a: 'previousRound.c' }, steps: [
        { id: 'answer', type: 'run', role: 'a', inputs: ['previousRound.a'] },
      ], yields: { a: 'answer' } },
      { id: 'next', type: 'run', role: 'c', dependsOn: ['inner'], inputs: ['previousRound.c', 'inner.a'] },
    ], yields: { c: 'next' } }];
  t.output = { sources: ['zero.c', 'zero.a', 'loop.c'], final: 'loop.c', format: 'text' };
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: t }));
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: 'C0' }); runner.calls[1].complete({ text: 'A0' });
  for (const [index, text] of ['A1', 'C1', 'A2', 'C2'].entries()) {
    await until(() => runner.calls.length === index + 3); const call = runner.calls[index + 2];
    if (index === 0) assert.match(call.prompt, /C0/);
    if (index === 1) { assert.match(call.prompt, /C0/); assert.match(call.prompt, /A1/); }
    if (index === 2) assert.match(call.prompt, /C1/);
    call.complete({ text });
  }
  const result = await run.done; assert.equal(result.outputs.sources['zero.c'].text, 'C0'); assert.equal(result.outputs.final.text, 'C2');
});

test('a saved unfinished role is suspended until retryRunId and uses its saved instructions', async () => {
  const runner = harness(), first = new WorkflowScheduler({ runner }).start(options());
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: 'Already completed' }); await tick();
  const previousSnapshot = first.snapshot(), failedId = previousSnapshot.runs.find(r => r.engine === 'claude').id;
  await first.interrupt();
  const nextRunner = harness(), next = new WorkflowScheduler({ runner: nextRunner }).start(options({ previousSnapshot, retryRunId: failedId }));
  await until(() => nextRunner.calls.length === 1); assert.equal(nextRunner.calls[0].instructions, runner.calls[1].instructions);
  assert.equal(next.snapshot().runs.find(r => r.id === failedId).status, 'interrupted');
  assert.equal((await finishRemaining(next, nextRunner)).status, 'completed');
});

test('fresh sessions never resume supplied bindings and missing throughSeq never advances the cursor', async () => {
  const t = template(), runner = harness(), key = roleBindingKey({ template: t, roleId: 'c', cwd: '/tmp/non-git' });
  const run = new WorkflowScheduler({ runner }).start(options({ template: t, bindings: { [key]: { engine: 'codex', sessionId: 'old', consumedSeq: 2 } } }));
  await until(() => runner.calls.length === 2); assert.equal(runner.calls[0].nativeSessionId, undefined);
  runner.calls[0].emit({ type: 'session', sessionId: 'new' }); runner.calls[0].emit({ type: 'input-acknowledged' });
  assert.equal(run.snapshot().bindings[key].consumedSeq, 2); await finishRemaining(run, runner);
});

test('terminal persistence failures are surfaced as failed completion', async () => {
  const runner = harness();
  const run = new WorkflowScheduler({ runner }).start(options({ onSnapshot(snapshot) { if (snapshot.status === 'completed') throw new Error('Final snapshot failed'); } }));
  const result = await finishRemaining(run, runner);
  assert.equal(result.status, 'failed'); assert.match(result.error, /Final snapshot failed/);
});

test('operation failures cancel unrelated in-flight work before waiting for graph cleanup', async () => {
  const t = template(); t.roles.c.access = 'write'; const failedOperation = deferred(), runner = harness();
  const run = new WorkflowScheduler({ runner, operationsFactory: () => ({ async run() { await failedOperation.promise; throw new Error('Workspace operation failed'); } }) }).start(options({ template: t }));
  await until(() => runner.calls.length === 1); failedOperation.resolve();
  await until(() => run.snapshot().status === 'failed');
  const result = await run.done; assert.match(result.error, /Workspace operation failed/); assert.equal(runner.active, 0);
});

test('validated planner results cannot overwrite native output or runtime provenance', async () => {
  const t = template(); t.roles.c.access = 'write'; const runner = harness();
  const run = new WorkflowScheduler({ runner, operationsFactory: context => ({
    run(step, frame) { return context.invoke({ roleId: step.role, stepId: frame.path, prompt: 'Task', cwd: '/tmp/isolated',
      validateResult: () => ({ text: 'Rewritten output', nativeSessionId: 'forged', engine: 'claude', requestedModel: 'other', tasks: ['validated'] }) }); },
  }) }).start(options({ template: t }));
  await until(() => runner.calls.length === 2); const codex = runner.calls.find(c => c.engine === 'codex'); codex.complete({ text: 'Actual original', nativeSessionId: 'real' });
  await finishRemaining(run, runner); const result = run.snapshot().outputs.sources.left;
  assert.equal(result.text, 'Actual original'); assert.equal(result.nativeSessionId, 'real'); assert.equal(result.engine, 'codex'); assert.deepEqual(result.tasks, ['validated']);
});

test('reused roles receive each public history row only after their acknowledged cursor, including queued siblings', async () => {
  const t = template(); t.roles.c.session = 'reuse'; t.steps[0].inputs.push('history');
  t.steps.splice(1, 0, { id: 'second', type: 'run', role: 'c', inputs: ['request', 'history'] });
  const runner = harness(), key = roleBindingKey({ template: t, roleId: 'c', cwd: '/tmp/non-git' });
  const run = new WorkflowScheduler({ runner }).start(options({ template: t, throughSeq: 2,
    history: [{ seq: 1, text: 'ACKNOWLEDGED HISTORY' }, { seq: 2, text: 'UNSEEN HISTORY' }],
    bindings: { [key]: { engine: 'codex', sessionId: 'reused', consumedSeq: 1 } },
  }));
  await until(() => runner.calls.length === 2); const first = runner.calls.find(c => c.engine === 'codex');
  assert.doesNotMatch(first.prompt, /ACKNOWLEDGED HISTORY/); assert.match(first.prompt, /UNSEEN HISTORY/);
  first.emit({ type: 'input-acknowledged' }); first.complete({ nativeSessionId: 'reused' });
  await until(() => runner.calls.length === 3); assert.doesNotMatch(runner.calls[2].prompt, /UNSEEN HISTORY|ACKNOWLEDGED HISTORY/);
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
});

test('recovery keeps the current persisted session binding and the largest acknowledged cursor', async () => {
  const t = template(); t.roles.a.session = 'reuse';
  const runner = harness(), first = new WorkflowScheduler({ runner }).start(options({ template: t }));
  await until(() => runner.calls.length === 2); runner.calls[0].complete(); runner.calls[1].emit({ type: 'session', sessionId: 'older-session' });
  runner.calls[1].complete({ status: 'failed', error: 'Retry' }); await until(() => first.snapshot().status === 'blocked');
  const previousSnapshot = first.snapshot(), failed = previousSnapshot.runs.find(r => r.status === 'failed'); await first.interrupt();
  const key = roleBindingKey({ template: t, roleId: 'a', cwd: '/tmp/non-git' });
  const nextRunner = harness(), recovered = new WorkflowScheduler({ runner: nextRunner }).start(options({ previousSnapshot, bindings: { [key]: { engine: 'claude', sessionId: 'current-session', consumedSeq: 10 } } }));
  assert.equal(recovered.snapshot().bindings[key].consumedSeq, 10); assert.equal(recovered.snapshot().bindings[key].sessionId, 'current-session');
  recovered.retry(failed.id); await until(() => nextRunner.calls.length === 1); assert.equal(nextRunner.calls[0].nativeSessionId, 'current-session'); await recovered.interrupt();
});

test('real store accepts every synchronous snapshot and retains one visible user request through retries', async t => {
  const { ConversationStore } = await import('../../runtime/agent-modes/store.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'scheduler-store-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory), selected = options();
  store.ensureThread({ id: 'chat', cwd: selected.cwd, model: 'codex-exact', turns: [] });
  store.beginWorkflow('chat', { id: selected.runId, turn: { id: 'turn', status: 'inProgress', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: selected.input }] }] },
    config: { mode: 'both', models: selected.models, template: selected.template, parameters: {} } });
  const runner = harness(), run = new WorkflowScheduler({ runner, onEvent(event) { store.appendWorkflowEvent('chat', selected.runId, event); } }).start({ ...selected,
    onSnapshot(snapshot) {
      snapshot.runs.forEach(roleRun => store.putWorkflowRun('chat', selected.runId, roleRun));
      for (const [key, binding] of Object.entries(snapshot.bindings)) store.setRoleBinding('chat', key, binding);
      store.setWorkflowState('chat', selected.runId, snapshot);
    },
  });
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: 'Saved' }); runner.calls[1].complete({ status: 'failed', error: 'Transient' });
  await until(() => run.snapshot().status === 'blocked'); run.retry(run.snapshot().runs.find(r => r.status === 'failed').id);
  await until(() => runner.calls.length === 3); assert.equal((await finishRemaining(run, runner)).status, 'completed');
  store.finishWorkflow('chat', selected.runId, 'completed');
  const record = store.get('chat'); assert.equal(record.turns.length, 1); assert.equal(record.turns[0].turn.items.filter(i => i.type === 'userMessage').length, 1);
  assert.deepEqual(record.turns[0].runs.map(r => r.status), ['completed', 'failed', 'completed', 'completed']);
  assert.equal(record.turns[0].workflow.events.length, run.snapshot().events.length);
});

test('permission callback rejection stops sibling work even when native catches and declines the request', async () => {
  const runner = harness();
  const run = new WorkflowScheduler({ runner, onPermission: async () => { throw new Error('Approval persistence failed'); } }).start(options());
  await until(() => runner.calls.length === 2);
  await runner.calls[0].permission().catch(() => ({ decision: 'decline' }));
  await until(() => run.snapshot().status === 'failed');
  const result = await run.done;
  assert.match(result.error, /Approval persistence failed/); assert.equal(runner.active, 0); assert.equal(runner.calls.length, 2);
});

test('a request-only acknowledgement cannot consume history needed by a later run of the same reusable role', async () => {
  const t = template(); t.roles.c.session = 'reuse';
  t.steps.splice(1, 0, { id: 'prior', type: 'run', role: 'c', dependsOn: ['left'], inputs: ['history'] });
  const runner = harness(), key = roleBindingKey({ template: t, roleId: 'c', cwd: '/tmp/non-git' });
  const run = new WorkflowScheduler({ runner }).start(options({ template: t, throughSeq: 1, history: [{ seq: 1, text: 'UNREAD PUBLIC HISTORY' }] }));
  await until(() => runner.calls.length === 2); const request = runner.calls.find(call => call.engine === 'codex');
  request.emit({ type: 'session', sessionId: 'reused' }); request.emit({ type: 'input-acknowledged' });
  assert.equal(run.snapshot().bindings[key].consumedSeq, 0);
  request.complete({ nativeSessionId: 'reused' }); await until(() => runner.calls.length >= 3);
  const history = runner.calls.find(call => call.stepId === 'prior'); assert.match(history.prompt, /UNREAD PUBLIC HISTORY/);
  history.emit({ type: 'input-acknowledged' }); assert.equal(run.snapshot().bindings[key].consumedSeq, 1);
  const descriptors = Object.values(run.snapshot().invocations);
  assert.equal(descriptors.find(d => d.stepId === 'left').acknowledgedHistorySeq, undefined);
  assert.equal(descriptors.find(d => d.stepId === 'prior').acknowledgedHistorySeq, 1);
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
});

test('history acknowledgement is bounded by the supplied cursor and frozen represented history', async () => {
  const t = template(); t.roles.c.session = 'reuse'; t.steps[0].inputs = ['history'];
  const runner = harness(), key = roleBindingKey({ template: t, roleId: 'c', cwd: '/tmp/non-git' });
  const run = new WorkflowScheduler({ runner }).start(options({ template: t, throughSeq: 8, history: [{ seq: 3, text: 'Represented history' }, { seq: 10, text: 'Beyond supplied cursor' }] }));
  await until(() => runner.calls.length === 2); runner.calls[0].emit({ type: 'session', sessionId: 'history-session' }); runner.calls[0].emit({ type: 'input-acknowledged' });
  assert.equal(run.snapshot().bindings[key].consumedSeq, 3);
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
});

test('verbatim operation prompts cannot acknowledge the shared history cursor without explicit inputValues', async () => {
  const t = template(); t.roles.c = { ...t.roles.c, access: 'write', session: 'reuse' }; const runner = harness();
  const run = new WorkflowScheduler({ runner, operationsFactory: context => ({ run(step, frame) { return context.invoke({ roleId: step.role, stepId: frame.path, prompt: 'Only this task', cwd: '/tmp/isolated' }); } }) })
    .start(options({ template: t, throughSeq: 7, history: [{ seq: 7, text: 'Undelivered context' }] }));
  await until(() => runner.calls.length === 2); const task = runner.calls.find(call => call.engine === 'codex');
  task.emit({ type: 'session', sessionId: 'task-session' }); task.emit({ type: 'input-acknowledged' });
  const key = roleBindingKey({ template: t, roleId: 'c', cwd: '/tmp/isolated' }); assert.equal(run.snapshot().bindings[key].consumedSeq, 0);
  assert.equal((await finishRemaining(run, runner)).status, 'completed');
});

test('explicit resume reconstructs a crash boundary after completed roles without replaying those roles', async () => {
  const runner = harness(); let boundary;
  const first = new WorkflowScheduler({ runner }).start(options({ onSnapshot(snapshot) {
    if (!boundary && snapshot.runs.length === 2 && snapshot.runs.every(run => run.status === 'completed')) boundary = snapshot;
  } }));
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: 'Completed left' }); runner.calls[1].complete({ text: 'Completed right' });
  await until(() => boundary !== undefined); await first.interrupt();
  assert.equal(boundary.outputs, undefined);
  const suspendedRunner = harness(), suspended = new WorkflowScheduler({ runner: suspendedRunner }).start(options({ previousSnapshot: boundary }));
  await tick(); assert.equal(suspendedRunner.calls.length, 0); assert.equal(suspended.snapshot().status, 'blocked'); await suspended.interrupt();
  const nextRunner = harness(), resumed = new WorkflowScheduler({ runner: nextRunner }).start(options({ previousSnapshot: boundary, resume: true }));
  await until(() => nextRunner.calls.length === 1); assert.equal(nextRunner.calls[0].stepId, 'finish');
  assert.match(nextRunner.calls[0].prompt, /Completed left/); assert.match(nextRunner.calls[0].prompt, /Completed right/);
  nextRunner.calls[0].complete({ text: 'Resumed synthesis' });
  const result = await resumed.done; assert.equal(result.status, 'completed'); assert.equal(result.outputs.final.text, 'Resumed synthesis');
  assert.equal(result.runs.length, 3); assert.deepEqual(result.runs.slice(0, 2), boundary.runs);
});

test('explicit resume retries preparation after a zero-role operation failure', async () => {
  const t = template(); t.roles.c.access = 'write'; t.steps[1].dependsOn = ['left'];
  const runner = harness(), first = new WorkflowScheduler({ runner, operationsFactory: () => { throw new Error('Preparation unavailable'); } }).start(options({ template: t }));
  const previousSnapshot = await first.done; assert.equal(previousSnapshot.status, 'failed'); assert.equal(previousSnapshot.runs.length, 0); assert.equal(runner.calls.length, 0);
  const nextRunner = harness(), resumed = new WorkflowScheduler({ runner: nextRunner, operationsFactory: context => ({ run(step, frame) {
    return context.invoke({ roleId: step.role, stepId: frame.path, round: frame.round, prompt: 'Prepared task', cwd: '/tmp/isolated' });
  } }) }).start(options({ previousSnapshot, resume: true }));
  await until(() => nextRunner.calls.length === 1); assert.equal(nextRunner.calls[0].stepId, 'left');
  assert.equal((await finishRemaining(resumed, nextRunner)).status, 'completed');
});

test('resume without a chosen retry rejects unsuccessful roles before callbacks or native work', async () => {
  const runner = harness(), first = new WorkflowScheduler({ runner }).start(options());
  await until(() => runner.calls.length === 2); runner.calls[0].complete(); runner.calls[1].complete({ status: 'failed', error: 'Choose this retry' });
  await until(() => first.snapshot().status === 'blocked'); const previousSnapshot = first.snapshot(); await first.interrupt();
  let snapshots = 0;
  const nextRunner = harness(); assert.throws(() => new WorkflowScheduler({ runner: nextRunner }).start(options({ previousSnapshot, resume: true, onSnapshot() { snapshots++; } })), /retryRunId|explicit.*retry/i);
  assert.equal(snapshots, 0); assert.equal(nextRunner.calls.length, 0);
});

test('same-engine roles retain independent sessions and freeze per-role models and prompts for retries', async () => {
  const t = template(); t.roles.c.session = 'reuse'; t.roles.a.session = 'reuse';
  const runner = harness(), selected = options({ template: t, roleOverrides: { c: { model: 'shared-model' }, a: { engine: 'codex', model: 'shared-model', prompt: 'Other independent perspective.' } } });
  const run = new WorkflowScheduler({ runner }).start(selected);
  selected.roleOverrides.a.model = 'mutated';
  await until(() => runner.calls.length === 2);
  assert.deepEqual(runner.calls.map(call => [call.roleId, call.engine, call.model]), [['c', 'codex', 'shared-model'], ['a', 'codex', 'shared-model']]);
  assert.ok(runner.calls.every(call => !call.nativeSessionId));
  runner.calls[0].emit({ type: 'session', sessionId: 'session-c' });
  runner.calls[1].emit({ type: 'session', sessionId: 'session-a' });
  runner.calls[0].complete({ text: 'Independent C' }); runner.calls[1].complete({ status: 'failed', error: 'retry' });
  await until(() => run.snapshot().status === 'blocked');
  const failed = run.snapshot().runs.find(row => row.status === 'failed');
  assert.equal(run.retry(failed.id), true); await until(() => runner.calls.length === 3);
  assert.equal(runner.calls[2].nativeSessionId, 'session-a'); assert.equal(runner.calls[2].model, 'shared-model');
  assert.equal(runner.calls[2].instructions, 'Other independent perspective.');
  const result = await finishRemaining(run, runner);
  assert.equal(result.status, 'completed');
  assert.equal(Object.keys(result.bindings).length, 2);
  assert.deepEqual(Object.values(result.bindings).map(value => value.sessionId).sort(), ['session-a', 'session-c']);
});

test('a changed role engine, effective model or prompt changes its reusable binding identity', () => {
  const t = template(); t.roles.c.model = 'one';
  const initial = roleBindingKey({ template: t, roleId: 'c', cwd: '/tmp' });
  for (const change of [role => role.engine = 'claude', role => role.model = 'two', role => role.prompt = 'New instructions']) {
    const changed = clone(t); change(changed.roles.c);
    assert.notEqual(roleBindingKey({ template: changed, roleId: 'c', cwd: '/tmp' }), initial);
  }
});

const hostedTemplate = () => ({ schemaVersion: 2, id: 'hosted', revision: 1, name: 'Hosted', description: '',
  roles: { participant_a: { ...role('codex'), session: 'reuse' }, participant_b: { ...role('claude'), session: 'reuse' }, host: role('claude') },
  parameters: { rounds: { type: 'integer', default: 2, min: 0, max: 5 }, host_mode: { type: 'string', default: 'per-round', enum: ['per-round', 'final-only'] } },
  limits: { concurrency: 2, tasks: 8, rounds: 5 },
  steps: [
    { id: 'debate', type: 'hostedDebate', participants: { participant_a: 'participant_a', participant_b: 'participant_b' }, host: 'host', inputs: ['request', 'history'], count: { parameter: 'rounds' }, mode: { parameter: 'host_mode' } },
    { id: 'summary', type: 'synthesize', dependsOn: ['debate'], role: 'host', inputs: ['request', 'debate.sources', 'debate.assessments'] },
  ], output: { sources: ['debate.participant_a', 'debate.participant_b', 'debate.sources', 'debate.assessments', 'summary'], final: 'summary', format: 'markdown' } });

test('host assesses independent answers and ends early only on a validated structured decision', async () => {
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: hostedTemplate() }));
  await until(() => runner.calls.length === 2);
  assert.ok(runner.calls.every(call => call.round === 0 && !/previousRound/.test(call.prompt)));
  runner.calls[0].complete({ text: 'A initial' }); await tick(); assert.equal(runner.calls.length, 2);
  runner.calls[1].complete({ text: 'B initial' }); await until(() => runner.calls.length === 3);
  const assessment = runner.calls[2];
  assert.equal(assessment.roleId, 'host'); assert.deepEqual(assessment.outputSchema.required, ['continue', 'guidance']);
  assert.match(assessment.prompt, /A initial/); assert.match(assessment.prompt, /B initial/);
  assessment.complete({ structuredOutput: { continue: false, guidance: 'Evidence is sufficient.' }, text: 'Assessment artifact' });
  await until(() => runner.calls.length === 4);
  assert.equal(runner.calls[3].stepId, 'summary');
  assert.match(runner.calls[3].prompt, /A initial/); assert.match(runner.calls[3].prompt, /Assessment artifact/);
  runner.calls[3].complete({ text: 'Final synthesis' });
  const result = await run.done; assert.equal(result.status, 'completed');
  assert.equal(result.outputs.sources['debate.sources'].length, 2);
  assert.equal(result.outputs.sources['debate.assessments'][0].decision.continue, false);
});

test('host guidance uses fixed prior-round answers, reassesses each round and obeys the hard limit', async () => {
  const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: hostedTemplate(), parameters: { rounds: 1 } }));
  await until(() => runner.calls.length === 2); runner.calls[0].complete({ text: 'A0' }); runner.calls[1].complete({ text: 'B0' });
  await until(() => runner.calls.length === 3); runner.calls[2].complete({ structuredOutput: { continue: true, guidance: 'Check the disputed estimate.' } });
  await until(() => runner.calls.length === 5);
  const [a, b] = runner.calls.slice(3);
  assert.match(a.prompt, /B0/); assert.match(b.prompt, /A0/);
  assert.match(a.prompt, /Check the disputed estimate/); assert.match(b.prompt, /Check the disputed estimate/);
  a.complete({ text: 'A1' }); await tick(); assert.doesNotMatch(b.prompt, /A1/);
  b.complete({ text: 'B1' }); await until(() => runner.calls.length === 6);
  runner.calls[5].complete({ structuredOutput: { continue: true, guidance: 'Would like another round.' } });
  await until(() => runner.calls.length === 7); assert.equal(runner.calls[6].stepId, 'summary');
  for (const text of ['A0', 'B0', 'A1', 'B1']) assert.ok(runner.calls[6].prompt.includes(text));
  runner.calls[6].complete(); const result = await run.done;
  assert.equal(result.status, 'completed'); assert.equal(result.outputs.sources['debate.sources'].length, 4);
  assert.equal(result.outputs.sources['debate.assessments'].length, 2);
  assert.ok(result.runs.every(row => row.round <= 1));
});

test('malformed host decisions block, survive restart and retry the same frozen assessment', async () => {
  const runner = harness(), selected = options({ template: hostedTemplate(), roleOverrides: { host: { engine: 'codex', model: 'host-frozen', prompt: 'Host frozen instructions.' } } });
  const run = new WorkflowScheduler({ runner }).start(selected);
  await until(() => runner.calls.length === 2); runner.calls.forEach((call, i) => call.complete({ text: `Initial ${i}` }));
  await until(() => runner.calls.length === 3); runner.calls[2].complete({ text: 'We agree', structuredOutput: { continue: 'false', guidance: 'Unsupported' } });
  await until(() => run.snapshot().status === 'blocked');
  const failed = run.snapshot().runs.find(row => row.status === 'failed'); assert.match(failed.error, /continue/);
  const previousSnapshot = run.snapshot(); await run.interrupt();
  const nextRunner = harness(), restarted = new WorkflowScheduler({ runner: nextRunner }).start({ ...selected, previousSnapshot, roleOverrides: { host: { engine: 'claude', model: 'changed' } }, retryRunId: failed.id });
  await until(() => nextRunner.calls.length === 1);
  assert.equal(nextRunner.calls[0].prompt, runner.calls[2].prompt);
  assert.equal(nextRunner.calls[0].model, 'host-frozen'); assert.equal(nextRunner.calls[0].engine, 'codex');
  assert.deepEqual(nextRunner.calls[0].outputSchema, runner.calls[2].outputSchema);
  nextRunner.calls[0].complete({ structuredOutput: { continue: false, guidance: '' } });
  await until(() => nextRunner.calls.length === 2); nextRunner.calls[1].complete();
  const result = await restarted.done;
  assert.equal(result.status, 'completed'); assert.equal(result.runs.filter(row => row.roleId.startsWith('participant')).length, 2);
  assert.deepEqual(result.runs.filter(row => row.stepId === failed.stepId).map(row => row.status), ['failed', 'completed']);
});

test('final-only debate runs fixed rounds without assessments and zero rounds preserves both originals', async () => {
  for (const rounds of [0, 2]) {
    const runner = harness(), run = new WorkflowScheduler({ runner }).start(options({ template: hostedTemplate(), parameters: { rounds, host_mode: 'final-only' } }));
    const result = await finishRemaining(run, runner);
    assert.equal(result.status, 'completed'); assert.equal(runner.calls.length, 3 + 2 * rounds);
    assert.ok(runner.calls.every(call => call.outputSchema === undefined));
    assert.equal(result.outputs.sources['debate.sources'].length, 2 + 2 * rounds);
    assert.deepEqual(result.outputs.sources['debate.assessments'], []);
  }
});

test('stopping a guided host round retains answers and explicit recovery retries only the stopped assessment', async () => {
  const runner = harness(), selected = options({ template: hostedTemplate(), parameters: { rounds: 0 } });
  const run = new WorkflowScheduler({ runner }).start(selected);
  await until(() => runner.calls.length === 2); runner.calls.forEach(call => call.complete());
  await until(() => runner.calls.length === 3); runner.calls[2].emit({ type: 'text-delta', delta: 'Partial assessment' });
  await run.interrupt(); const previousSnapshot = run.snapshot();
  assert.equal(previousSnapshot.status, 'interrupted');
  assert.equal(previousSnapshot.runs[2].status, 'interrupted');
  assert.equal(previousSnapshot.runs.filter(row => row.status === 'completed').length, 2);
  const nextRunner = harness(), restored = new WorkflowScheduler({ runner: nextRunner }).start({ ...selected, previousSnapshot, retryRunId: previousSnapshot.runs[2].id });
  await until(() => nextRunner.calls.length === 1); assert.equal(nextRunner.calls[0].roleId, 'host');
  nextRunner.calls[0].complete({ structuredOutput: { continue: true, guidance: 'No rounds remain.' } });
  await until(() => nextRunner.calls.length === 2); assert.equal(nextRunner.calls[1].stepId, 'summary');
  nextRunner.calls[1].complete(); const result = await restored.done;
  assert.equal(result.status, 'completed'); assert.equal(result.runs.filter(row => row.roleId.startsWith('participant')).length, 2);
});


// Persisted v1 recovery shape from before configured role binding identities.
// Deliberately derives the historical key independently of roleBindingKey.
function legacyRecoverySnapshot() {
  const t = template(); t.roles.c.session = 'reuse'; t.steps[0].inputs.push('history');
  const original = options({ template: t, throughSeq: 2, history: [{ seq: 1, text: 'ALREADY IN LEGACY SESSION' }, { seq: 2, text: 'PENDING PUBLIC HISTORY' }] });
  const oldKey = `${t.id}@${t.revision}/c/${createHash('sha256').update(JSON.stringify([original.cwd, 'default'])).digest('hex')}`;
  const inputs = { request: original.input, history: [original.history[1]] };
  const descriptor = { roleId: 'c', stepId: 'left', round: 0, engine: 'codex', prompt: renderInputs(Object.keys(inputs), ref => inputs[ref]),
    cwd: original.cwd, access: 'read', instructions: t.roles.c.prompt, requestedModel: original.models.codex, nativeOptions: {}, purpose: 'default', inputValues: inputs, acknowledgedHistorySeq: 2 };
  const failed = { id: 'legacy-failed', engine: 'codex', roleId: 'c', stepId: 'left', attempt: 1, round: 0, status: 'failed', requestedModel: original.models.codex, cwd: original.cwd, text: 'Partial', error: 'Try again' };
  const completed = { id: 'legacy-completed', engine: 'claude', roleId: 'a', stepId: 'right', attempt: 1, round: 0, status: 'completed', requestedModel: original.models.claude, cwd: original.cwd, text: 'Keep sibling answer' };
  const snapshot = { version: 1, id: original.runId, status: 'blocked', config: { ...original, parameters: {}, nativeOptions: {} }, runs: [failed, completed], events: [],
    bindings: { [oldKey]: { engine: 'codex', sessionId: 'legacy-native-session', consumedSeq: 1 } },
    invocations: { [JSON.stringify(['left', 'c', 0])]: descriptor }, checkpoints: {},
    cache: { steps: { right: completed }, roles: { [JSON.stringify(['right', 'a', 0])]: completed } } };
  return { original, oldKey, descriptor, snapshot };
}

test('legacy failed role recovery resumes its old-key native session with the frozen filtered prompt', async () => {
  const { original, oldKey, descriptor, snapshot } = legacyRecoverySnapshot();
  const runner = harness(), run = new WorkflowScheduler({ runner }).start({ ...original, previousSnapshot: snapshot, retryRunId: 'legacy-failed',
    roleOverrides: { c: { engine: 'claude', model: 'new-selection', prompt: 'Changed selection' } },
    bindings: { [oldKey]: { engine: 'codex', sessionId: 'legacy-current-session', consumedSeq: 2 } },
  });
  await until(() => runner.calls.length === 1);
  const retried = runner.calls[0];
  assert.equal(retried.nativeSessionId, 'legacy-current-session');
  assert.equal(retried.prompt, descriptor.prompt); assert.doesNotMatch(retried.prompt, /ALREADY IN LEGACY SESSION/);
  assert.match(retried.prompt, /PENDING PUBLIC HISTORY/); assert.equal(retried.model, 'codex-exact');
  assert.equal(retried.instructions, original.template.roles.c.prompt);
  const configuredKey = bindingKey({ template: run.snapshot().config.template, roleId: 'c', cwd: original.cwd });
  assert.notEqual(configuredKey, oldKey);
  assert.equal(run.snapshot().bindings[configuredKey].consumedSeq, 2);
  retried.complete({ status: 'failed', error: 'One more retry' }); await until(() => run.snapshot().status === 'blocked');
  const converted = run.snapshot(), retry = converted.runs.at(-1); await run.interrupt();
  const nextRunner = harness(), next = new WorkflowScheduler({ runner: nextRunner }).start({ ...original, previousSnapshot: converted, retryRunId: retry.id });
  await until(() => nextRunner.calls.length === 1); assert.equal(nextRunner.calls[0].nativeSessionId, 'legacy-current-session');
  assert.equal(nextRunner.calls[0].prompt, descriptor.prompt);
  assert.equal((await finishRemaining(next, nextRunner)).status, 'completed');
});

test('legacy bindings are never adopted by new turns with changed role configuration', async () => {
  const { original, snapshot } = legacyRecoverySnapshot();
  for (const override of [{ engine: 'claude' }, { model: 'new-model' }, { prompt: 'New role instructions' }]) {
    const runner = harness(), run = new WorkflowScheduler({ runner }).start({ ...original, runId: 'new-workflow', bindings: snapshot.bindings, roleOverrides: { c: override } });
    await until(() => runner.calls.length === 2);
    const call = runner.calls.find(call => call.roleId === 'c');
    assert.equal(call.nativeSessionId, undefined); assert.match(call.prompt, /ALREADY IN LEGACY SESSION/);
    assert.equal((await finishRemaining(run, runner)).status, 'completed');
  }
});

test('workflow steering reaches live roles and is persisted for later synthesis and recovery', async () => {
  const runner = harness(), sends = [], start = runner.start;
  runner.start = function(options) { const handle = start.call(this, options); return { ...handle, steer: async text => { sends.push({ roleId: options.roleId, text }); } }; };
  const run = new WorkflowScheduler({ runner }).start(options()); await until(() => runner.calls.length === 2);
  assert.equal(typeof run.steer, 'function');
  await run.steer('Use the new constraint');
  assert.deepEqual(sends.map(x => x.roleId).sort(), ['a', 'c']);
  assert.equal(run.snapshot().guidance[0].text, 'Use the new constraint');
  runner.calls.slice(0, 2).forEach(call => call.complete()); await until(() => runner.calls.length === 3);
  assert.match(runner.calls[2].prompt, /Use the new constraint/);
  await run.interrupt(); const saved = run.snapshot(), failed = saved.runs.at(-1);
  const resumedRunner = harness();
  const resumed = new WorkflowScheduler({ runner: resumedRunner }).start(options({ previousSnapshot: saved, retryRunId: failed.id }));
  await until(() => resumedRunner.calls.length === 1);
  assert.match(resumedRunner.calls[0].prompt, /Use the new constraint/);
  assert.equal((await finishRemaining(resumed, resumedRunner)).status, 'completed');
  await assert.rejects(run.steer('Too late'), /interrupt|ended/);
});

test('workflow steering reports partial delivery instead of duplicating accepted input on retry', async () => {
  const runner = harness(), start = runner.start;
  runner.start = function(options) { return { ...start.call(this, options), steer: async () => { if (options.engine === 'claude') throw Error('Native turn ended'); } }; };
  const run = new WorkflowScheduler({ runner }).start(options()); await until(() => runner.calls.length === 2);
  assert.equal(typeof run.steer, 'function');
  const receipt = await run.steer('Important follow-up');
  assert.equal(receipt.accepted.length, 1); assert.equal(receipt.failures[0].roleId, 'a');
  assert.equal(run.snapshot().guidance.length, 1);
  await run.interrupt();
});
