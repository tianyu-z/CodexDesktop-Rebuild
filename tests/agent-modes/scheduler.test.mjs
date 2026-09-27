import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkflowScheduler, roleBindingKey } from '../../runtime/agent-modes/orchestration/scheduler.mjs';
import { renderInputs } from '../../runtime/agent-modes/orchestration/inputs.mjs';
import { BUILTIN_TEMPLATES } from '../../runtime/agent-modes/templates/builtins.mjs';

const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let n = 0; n < 80; n++) { if (predicate()) return; await tick(); } assert.fail('condition did not settle'); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
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
async function finishRemaining(run, runner) {
  for (let n = 0; n < 30 && !['completed', 'failed', 'interrupted'].includes(run.snapshot().status); n++) {
    runner.calls.forEach(call => call.complete()); await tick();
  }
  return await run.done;
}

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
  const t = clone(BUILTIN_TEMPLATES.find(t => t.id === 'debby')); t.limits.concurrency = 1;
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
  t.steps.splice(1, 0, { id: 'second', type: 'run', role: 'c', inputs: ['request'] });
  const runner = harness(), events = [], selected = options({ template: t, throughSeq: 9 });
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
