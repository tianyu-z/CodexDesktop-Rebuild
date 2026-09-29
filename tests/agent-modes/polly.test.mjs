import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPollyOperations } from '../../runtime/agent-modes/orchestration/polly.mjs';
import { GitWorkspaceManager } from '../../runtime/agent-modes/workspaces/manager.mjs';
import { BUILTIN_TEMPLATES } from '../../runtime/agent-modes/templates/builtins.mjs';
import { WorkflowScheduler } from '../../runtime/agent-modes/orchestration/scheduler.mjs';
import { captureClaudeInput, readClaudeInputCapture } from '../../runtime/agent-modes/claude-input.mjs';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout;
const task = (id, engine = 'codex', extra = {}) => ({ id, engine, purpose: 'implement', description: `Implement ${id}`, files: [`${id}.txt`], acceptance: [`${id} is correct`], dependsOn: [], ...extra });
const executeStep = { id: 'implementation', type: 'executeTasks', plan: 'plan', roles: { codex: 'codex_worker', claude: 'claude_worker' }, workspace: 'isolated' };
const reviewStep = { id: 'review', type: 'crossReview', target: 'implementation', reviewers: { codex: 'claude_reviewer', claude: 'codex_reviewer' }, maxRepairs: 2, workspace: 'integration' };
const frame = (path, value, inputs) => ({ path, round: 0, resolve: () => value, ...(inputs ? { inputs } : {}) });
const passed = { passed: true, issues: [] };
const verified = { passed: true, checks: [{ description: 'Fixture check', status: 'passed' }], issues: [] };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) {
  // These tests create real Git snapshots; a seven-second polling budget is
  // too short when the desktop and release build are exercising the same disk.
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) { if (predicate()) return; await tick(); }
  assert.fail('Condition did not settle within 60 seconds');
}

async function fixture(t, responder, { subdirectory = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'polly-')); t.after(async () => { await exec('chmod', ['-R', 'u+w', root]); await rm(root, { recursive: true, force: true }); });
  const repo = join(root, 'repo'); await mkdir(repo); await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'baseline.txt'), 'baseline\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'base');
  const cwd = join(repo, subdirectory); await mkdir(cwd, { recursive: true });
  const checkpoints = new Map(), calls = [], workspaces = new GitWorkspaceManager(join(root, 'artifacts'));
  const options = { runId: 'fixture', cwd, template: BUILTIN_TEMPLATES.find(value => value.id === 'polly'), models: { codex: 'selected-codex', claude: 'selected-claude' }, parameters: {}, input: 'Implement requested files', history: [{ seq: 1, text: 'Prior public context' }] };
  const invoke = async descriptor => {
    calls.push(descriptor);
    const role = options.template.roles[descriptor.roleId];
    const native = { id: `run-${calls.length}`, status: 'completed', text: 'Reported result', engine: role.engine, roleId: descriptor.roleId, requestedModel: options.models[role.engine], cwd: descriptor.cwd, ...await responder(descriptor, { calls, repo, options }) };
    return { ...native, ...await descriptor.validateResult?.(native) };
  };
  const factory = () => createPollyOperations({ invoke, options, workspaces, signal: new AbortController().signal, checkpoint: (key, value) => checkpoints.set(key, structuredClone(value)), getCheckpoint: key => structuredClone(checkpoints.get(key)), notifySnapshot() {} });
  return { root, repo, cwd, options, workspaces, calls, checkpoints, invoke, responder, factory, operations: factory() };
}

test('isolated tasks carry exact direct dependency artifacts and opposite-engine reviews apply verified work', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') {
      const contract = d.inputValues.task;
      if (contract.id === 'child') assert.equal(await readFile(join(d.cwd, 'parent.txt'), 'utf8'), 'parent\n');
      await writeFile(join(d.cwd, `${contract.id}.txt`), `${contract.id}\n`);
    }
    if (d.purpose === 'cross-review') return { structuredOutput: passed };
    if (d.purpose === 'integration-check') return { structuredOutput: verified };
    return {};
  });
  const plan = { tasks: [task('child', 'claude', { dependsOn: ['parent'] }), task('parent')] };
  const result = await f.operations.executeTasks(executeStep, frame('implementation', plan));
  assert.equal(await readFile(join(f.repo, 'baseline.txt'), 'utf8'), 'baseline\n');
  await assert.rejects(readFile(join(f.repo, 'parent.txt')), { code: 'ENOENT' });
  const child = result.tasks.find(entry => entry.task.id === 'child');
  assert.deepEqual(child.workspace.dependencies.map(value => value.id), ['parent']);
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', result));
  assert.equal(reviewed.integration.application.status, 'applied');
  assert.equal(await readFile(join(f.repo, 'child.txt'), 'utf8'), 'child\n');
  for (const call of f.calls.filter(call => call.purpose === 'cross-review')) {
    assert.equal(call.access, 'read');
    assert.notEqual(f.options.template.roles[call.roleId].engine, call.inputValues.target.implementerEngine);
    assert.ok(!JSON.stringify(call.inputValues).includes('"workspace":'));
  }
  const check = f.calls.find(call => call.purpose === 'integration-check');
  assert.equal(check.access, 'write');
  assert.equal(reviewed.integration.checks[0].kind, 'model-reported');
});

test('task reviews use assigned acceptance while integration reviews cover every task and final checks', async t => {
  const plan = { tasks: [task('left'), task('right', 'claude')] };
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') {
      const id = d.inputValues.task.id;
      await writeFile(join(d.cwd, `${id}.txt`), id === 'left' && !d.inputValues.repair ? 'bug' : 'correct');
    } else if (d.purpose === 'integration-check') return { structuredOutput: verified };
    else if (d.purpose === 'cross-review') {
      const { target } = d.inputValues;
      assert.ok(['task', 'integration'].includes(target.phase));
      if (target.phase === 'task') {
        assert.deepEqual(target.scope.taskIds, [target.task.id]);
        assert.deepEqual(target.scope.acceptance, target.task.acceptance);
        assert.equal(d.inputValues.request, undefined);
        assert.equal(d.inputValues.workflowContext.request, f.options.input);
        assert.match(d.instructions, /assigned task contract/);
        assert.match(d.instructions, /absence.*not.*defect/i);
        const sibling = target.task.id === 'left' ? 'right' : 'left';
        await assert.rejects(readFile(join(d.cwd, `${sibling}.txt`)), { code: 'ENOENT' });
        if (await readFile(join(d.cwd, `${target.task.id}.txt`), 'utf8') === 'bug') return { structuredOutput: { passed: false, issues: [{ message: 'The assigned task contains a real bug', path: 'left.txt' }] } };
      } else {
        assert.deepEqual(target.scope.taskIds, ['left', 'right']);
        assert.deepEqual(target.scope.acceptance, plan.tasks.flatMap(task => task.acceptance));
        assert.deepEqual(target.tasks.map(entry => entry.task.id), ['left', 'right']);
        assert.equal(target.task, undefined);
        assert.equal(d.inputValues.request, f.options.input);
        assert.equal(target.snapshot.checks[0].kind, 'model-reported');
        assert.match(d.instructions, /combined.*all.*acceptance/i);
        for (const id of ['left', 'right']) assert.equal(await readFile(join(d.cwd, `${id}.txt`), 'utf8'), 'correct');
      }
      return { structuredOutput: passed };
    }
  });
  f.options.input = 'Create left.txt and right.txt, then run the final integrated checks.';
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', plan));
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.status, 'completed');
  assert.equal(f.calls.filter(call => call.purpose === 'task' && call.inputValues.repair).length, 1);
  assert.deepEqual(reviewed.reviews.map(review => review.reviewPhase), ['task', 'task', 'task', 'integration']);
});

test('direct write results retain artifacts and direct review never applies them', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'direct-write') await writeFile(join(d.cwd, 'direct.txt'), 'retained\n');
    else return { structuredOutput: passed };
  });
  const result = await f.operations.run({ id: 'write', type: 'run', role: 'codex_worker', inputs: ['request', 'history'] }, frame('write', null, { request: 'Write direct.txt', history: f.options.history }));
  assert.equal(result.artifact.files[0], 'direct.txt');
  assert.deepEqual(f.calls[0].inputValues.history, f.options.history);
  const reviewed = await f.operations.crossReview({ ...reviewStep, target: 'write', workspace: undefined }, frame('review', result));
  assert.equal(reviewed.status, 'completed'); assert.equal(reviewed.integration, undefined);
  await assert.rejects(readFile(join(f.repo, 'direct.txt')), { code: 'ENOENT' });
});

for (const access of ['read', 'write']) test(`direct ${access} review and repair preserve the original step instructions and resolved parameters`, async t => {
  let sourceCalls = 0;
  const token = 'RESOLVED_PARAMETER_TOKEN';
  const f = await fixture(t, async d => {
    if (d.roleId === 'source') {
      assert.match(d.instructions, /STEP ONLY CONTRACT/);
      assert.equal(d.inputValues['parameters.token'], token);
      const text = ++sourceCalls === 1 ? 'wrong' : token;
      if (access === 'write') await writeFile(join(d.cwd, 'marker.txt'), text);
      return { text };
    }
    const contract = d.inputValues.target.sourceContract;
    assert.ok(contract);
    assert.match(contract.instructions, /STEP ONLY CONTRACT/);
    assert.equal(contract.inputValues['parameters.token'], token);
    assert.equal(contract.access, access);
    assert.equal(contract.nativeOptions, undefined); assert.equal(contract.cwd, undefined);
    const actual = access === 'write' ? await readFile(join(d.cwd, 'marker.txt'), 'utf8') : d.inputValues.target.result.text;
    return { structuredOutput: actual === token ? passed : { passed: false, issues: [{ message: 'The result does not match the original parameter contract' }] } };
  });
  f.options.template = { schemaVersion: 1, id: `direct-${access}`, name: 'Direct contract', description: '',
    roles: { source: { engine: 'codex', access, session: 'fresh', prompt: 'Follow the supplied assignment.' }, reviewer: { engine: 'claude', access: 'read', session: 'fresh', prompt: 'Review the supplied assignment.' } },
    parameters: { token: { type: 'string', default: token } }, limits: { concurrency: 2, tasks: 2, rounds: 1 },
    steps: [{ id: 'source', type: 'run', role: 'source', inputs: ['parameters.token'], prompt: 'STEP ONLY CONTRACT: produce exactly the supplied parameter token.' },
      { id: 'review', type: 'crossReview', target: 'source', dependsOn: ['source'], reviewers: { codex: 'reviewer' }, maxRepairs: 1 }],
    output: { sources: ['source', 'review'], final: 'review', format: 'json' } };
  const run = scheduler(f).start(f.options);
  await until(() => ['completed', 'failed', 'interrupted', 'blocked'].includes(run.snapshot().status));
  if (run.snapshot().status === 'blocked') await run.interrupt();
  const result = await run.done;
  assert.equal(result.status, 'completed'); assert.equal(sourceCalls, 2);
  assert.equal(result.outputs.final.tasks[0].result.text, token);
  const sources = f.calls.filter(call => call.roleId === 'source');
  assert.equal(sources[1].instructions, sources[0].instructions);
  assert.equal(sources[1].access, access); assert.equal(sources[1].cwd, sources[0].cwd);
  assert.equal(sources[1].model, sources[0].model);
  await assert.rejects(readFile(join(f.repo, 'marker.txt')), { code: 'ENOENT' });
});

test('preparation freezes the baseline before planning and reuses it after recovery', async t => {
  const f = await fixture(t, async () => ({}));
  const first = await f.operations.prepare();
  await writeFile(join(f.repo, 'baseline.txt'), 'later user edit\n');
  assert.deepEqual(await f.factory().prepare(), first);
  const result = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('inspect', 'codex', { purpose: 'explore' })] }));
  assert.equal(await readFile(join(result.tasks[0].workspace.cwd, 'baseline.txt'), 'utf8'), 'baseline\n');
});

test('overlapping writes serialize while an independent file scope runs concurrently', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async d => {
    if (d.inputValues.task.id === 'a') await gate;
    await writeFile(join(d.cwd, d.inputValues.task.files[0]), 'result');
  });
  const running = f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a', 'codex', { files: ['shared.txt'] }), task('b', 'claude', { files: ['shared.txt'] }), task('c')] }));
  await until(() => ['a', 'c'].every(id => f.calls.some(call => call.inputValues.task.id === id)));
  const before = f.calls.map(call => call.inputValues.task.id); release();
  await running;
  assert.deepEqual(before.sort(), ['a', 'c']);
});

test('extended glob scopes serialize against matching concrete file scopes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async d => {
    if (d.inputValues.task.id === 'a') await gate;
    await mkdir(join(d.cwd, 'src'), { recursive: true });
    await writeFile(join(d.cwd, d.inputValues.task.id === 'c' ? 'c.txt' : 'src/shared.txt'), 'result');
  });
  const requested = [], original = f.workspaces.task.bind(f.workspaces);
  t.mock.method(f.workspaces, 'task', (base, args) => { requested.push(args.id); return original(base, args); });
  const running = f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a', 'codex', { files: ['src/@(shared|other).txt'] }), task('b', 'claude', { files: ['src/shared.txt'] }), task('c')] }));
  await until(() => f.calls.some(call => call.inputValues.task.id === 'c'));
  const before = [...requested]; release();
  await running;
  assert.deepEqual(before.sort(), ['a', 'c']);
});

test('overlapping ownership dependencies compose before a task joins both declared predecessors', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') {
      const id = d.inputValues.task.id;
      if (id === 'a') await writeFile(join(d.cwd, 'shared.txt'), d.inputValues.repair ? 'good' : 'bad');
      else if (id === 'b') {
        const before = await readFile(join(d.cwd, 'shared.txt'), 'utf8').catch(() => '');
        await writeFile(join(d.cwd, 'shared.txt'), `${before}+b`);
      } else await writeFile(join(d.cwd, 'c.txt'), await readFile(join(d.cwd, 'shared.txt'), 'utf8'));
    } else if (d.purpose === 'cross-review') {
      const value = await readFile(join(d.cwd, 'shared.txt'), 'utf8');
      return { structuredOutput: value.startsWith('bad') ? { passed: false, issues: [{ message: 'The first task needs correction' }] } : passed };
    } else if (d.purpose === 'integration-check') return { structuredOutput: verified };
  });
  const plan = { tasks: [task('c', 'codex', { dependsOn: ['a', 'b'] }), task('b', 'claude', { files: ['shared.txt'] }), task('a', 'codex', { files: ['shared.txt'] })] }, original = structuredClone(plan);
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', plan));
  const b = executed.tasks.find(entry => entry.task.id === 'b');
  assert.deepEqual(b.task.dependsOn, []);
  assert.deepEqual(b.effectiveDependsOn, ['a']);
  assert.deepEqual(b.dependencyReasons, [{ id: 'a', reason: 'overlapping-write-scopes' }]);
  assert.deepEqual(b.workspace.dependencies.map(value => value.id), ['a']);
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.status, 'completed');
  assert.equal(await readFile(join(f.repo, 'c.txt'), 'utf8'), 'good+b');
  assert.deepEqual(plan, original);
  assert.equal(f.calls.filter(call => call.purpose === 'task' && call.inputValues.task.id === 'b').length, 2);
  assert.equal(f.calls.filter(call => call.purpose === 'task' && call.inputValues.task.id === 'c').length, 2);
  assert.deepEqual(reviewed.tasks.find(entry => entry.task.id === 'b').effectiveDependsOn, ['a']);
});

test('ownership edges respect an existing reversed dependency order without adding a cycle', async t => {
  const f = await fixture(t, async d => {
    const previous = await readFile(join(d.cwd, 'shared.txt'), 'utf8').catch(() => '');
    await writeFile(join(d.cwd, 'shared.txt'), `${previous}${d.inputValues.task.id}`);
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a', 'codex', { dependsOn: ['b'], files: ['shared.txt'] }), task('b', 'claude', { files: ['shared.txt'] })] }));
  const a = executed.tasks.find(entry => entry.task.id === 'a'), b = executed.tasks.find(entry => entry.task.id === 'b');
  assert.deepEqual(a.effectiveDependsOn, ['b']); assert.deepEqual(b.effectiveDependsOn, []);
  assert.deepEqual(a.dependencyReasons, []);
  assert.equal(await readFile(join(a.workspace.cwd, 'shared.txt'), 'utf8'), 'ba');
});

test('a repaired predecessor rebuilds dependents against the new snapshot before review', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') {
      const id = d.inputValues.task.id;
      const text = id === 'parent' ? d.inputValues.repair ? 'good\n' : 'bad\n' : await readFile(join(d.cwd, 'parent.txt'), 'utf8');
      await writeFile(join(d.cwd, `${id}.txt`), text);
    } else if (d.purpose === 'cross-review') {
      const value = await readFile(join(d.cwd, 'parent.txt'), 'utf8');
      return { structuredOutput: value === 'bad\n' ? { passed: false, issues: [{ message: 'Parent must be good', path: 'parent.txt' }] } : passed };
    } else if (d.purpose === 'integration-check') return { structuredOutput: verified };
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('parent'), task('child', 'claude', { dependsOn: ['parent'] })] }));
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.status, 'completed');
  assert.equal(await readFile(join(f.repo, 'child.txt'), 'utf8'), 'good\n');
  assert.equal(f.calls.filter(call => call.purpose === 'task' && call.inputValues.task.id === 'child').length, 2);
  const repair = f.calls.find(call => call.inputValues.repair);
  assert.equal(repair.roleId, 'codex_worker');
  assert.notEqual(repair.stepId, f.calls[0].stepId);
  const parent = reviewed.tasks.find(entry => entry.task.id === 'parent');
  const child = reviewed.tasks.find(entry => entry.task.id === 'child');
  assert.equal(child.artifact.dependencies.find(value => value.id === 'parent').head, parent.artifact.head);
});

test('zero repairs records a rejected review without applying any files', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'rejected');
    else return { structuredOutput: { passed: false, issues: [{ message: 'Needs correction' }] } };
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  const reviewed = await f.operations.crossReview({ ...reviewStep, maxRepairs: 0 }, frame('review', executed));
  assert.equal(reviewed.status, 'blocked'); assert.equal(reviewed.reviews.length, 1);
  assert.equal(f.calls.length, 2);
  await assert.rejects(readFile(join(f.repo, 'a.txt')), { code: 'ENOENT' });
});

test('read-only task purposes remain read-only and never invoke integration or application', async t => {
  const f = await fixture(t, async d => d.purpose === 'cross-review' ? { structuredOutput: passed } : {});
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a', 'codex', { purpose: 'explore' }), task('b', 'claude', { purpose: 'review', dependsOn: ['a'] })] }));
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.integration.status, 'not-applicable');
  assert.ok(f.calls.every(call => call.access === 'read'));
});

test('scope violations and malformed review verdicts fail inside native validation', async t => {
  let removeEscape = false;
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') {
      if (removeEscape) await rm(join(d.cwd, 'escaped.txt'), { force: true });
      else await writeFile(join(d.cwd, 'escaped.txt'), 'outside scope');
      await writeFile(join(d.cwd, 'a.txt'), 'inside');
    } else return { structuredOutput: { passed: true, issues: [], extra: 'invalid' } };
  }, { subdirectory: 'src' });
  await assert.rejects(f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] })), /file scope/);
  assert.equal(typeof f.calls[0].validateResult, 'function');
  removeEscape = true;
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  assert.deepEqual(executed.tasks[0].artifact.files, ['src/a.txt']);
  await assert.rejects(f.operations.crossReview(reviewStep, frame('review', executed)), /structured review verdict/);
});

test('conflicts are repaired by the conflicting task engine, frozen, reviewed and checked before apply', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'shared.txt'), `${d.inputValues.task.id}\n`);
    else if (d.purpose === 'integration-repair') { await writeFile(join(d.cwd, 'shared.txt'), 'resolved\n'); await git(d.cwd, 'add', 'shared.txt'); }
    else if (d.purpose === 'cross-review') return { structuredOutput: passed };
    else if (d.purpose === 'integration-check') { assert.equal(await readFile(join(d.cwd, 'shared.txt'), 'utf8'), 'resolved\n'); return { structuredOutput: verified }; }
  });
  // Saved independent artifacts can still require genuine conflict repair even
  // after new plans receive ownership dependencies before execution.
  const base = await f.operations.prepare(), tasks = [];
  for (const contract of [task('a', 'codex', { files: ['shared.txt'] }), task('b', 'claude', { files: ['shared.txt'] })]) {
    const workspace = await f.workspaces.task(base, { id: contract.id, dependsOn: [], dependencies: [] });
    await writeFile(join(workspace.cwd, 'shared.txt'), `${contract.id}\n`);
    const artifact = await f.workspaces.freeze(workspace, { acceptance: contract.acceptance });
    const roleId = executeStep.roles[contract.engine];
    tasks.push({ task: contract, engine: contract.engine, roleId, workspace, artifact, result: { id: `saved-${contract.id}`, engine: contract.engine, roleId, status: 'completed', text: 'Saved independent result' } });
  }
  const executed = { type: 'executeTasks', status: 'completed', base, roles: executeStep.roles, tasks };
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.status, 'completed');
  assert.equal(f.calls.find(call => call.purpose === 'integration-repair').roleId, 'claude_worker');
  assert.equal(await readFile(join(f.repo, 'shared.txt'), 'utf8'), 'resolved\n');
  assert.equal(reviewed.integration.repairs.length, 1);
  assert.equal(reviewed.reviews.at(-1).artifactHash, reviewed.integration.artifact.hash);
});

test('integration check edits receive a fresh fixed review and bounded rejected-check repair', async t => {
  let repaired = false, sawFinal = false;
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'initial\n');
    else if (d.purpose === 'integration-check') {
      await writeFile(join(d.cwd, 'a.txt'), repaired ? 'checked good\n' : 'checked bad\n');
      return { structuredOutput: repaired ? verified : { passed: false, checks: [{ description: 'Fixture check', status: 'failed' }], issues: [{ message: 'Fix the integrated output' }] } };
    } else if (d.purpose === 'integration-repair') { repaired = true; await writeFile(join(d.cwd, 'a.txt'), 'repaired\n'); }
    else if (d.purpose === 'cross-review') {
      if (await readFile(join(d.cwd, 'a.txt'), 'utf8') === 'checked good\n') sawFinal = true;
      return { structuredOutput: passed };
    }
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.status, 'completed'); assert.equal(sawFinal, true);
  assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'checked good\n');
  assert.equal(reviewed.integration.repairs.length, 1);
  assert.equal(new Set(f.calls.map(call => call.stepId)).size, f.calls.length);
});

test('integration repair exhaustion retains all evidence without applying', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'implementation\n');
    else if (d.purpose === 'cross-review') return { structuredOutput: passed };
    else if (d.purpose === 'integration-check') return { structuredOutput: { passed: false, checks: [{ description: 'Still fails', status: 'failed' }], issues: [{ message: 'Unresolved failure' }] } };
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  const reviewed = await f.operations.crossReview({ ...reviewStep, maxRepairs: 1 }, frame('review', executed));
  assert.equal(reviewed.status, 'blocked'); assert.equal(reviewed.integration.repairs.length, 1);
  assert.equal(f.calls.filter(call => call.purpose === 'integration-check').length, 2);
  await assert.rejects(readFile(join(f.repo, 'a.txt')), { code: 'ENOENT' });
});

test('a later user edit blocks application while retaining the verified artifact', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'generated\n');
    else if (d.purpose === 'cross-review') return { structuredOutput: passed };
    else if (d.purpose === 'integration-check') return { structuredOutput: verified };
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  await writeFile(join(f.repo, 'a.txt'), 'later user edit\n');
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.integration.application.status, 'blocked');
  assert.equal(reviewed.integration.application.code, 'BASELINE_CHANGED');
  assert.equal(reviewed.integration.artifact.status, 'integrated');
  assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'later user edit\n');
});

test('repeated reviews reuse the exact artifact application receipt without overwriting later user edits', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'generated');
    else if (d.purpose === 'cross-review') return { structuredOutput: passed };
    else if (d.purpose === 'integration-check') return { structuredOutput: verified };
  });
  let applications = 0; const apply = f.workspaces.apply.bind(f.workspaces);
  t.mock.method(f.workspaces, 'apply', (...args) => { applications++; return apply(...args); });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  const first = await f.operations.crossReview(reviewStep, frame('first-review', executed));
  await writeFile(join(f.repo, 'a.txt'), 'later user edit');
  const second = await f.factory().crossReview(reviewStep, frame('second-review', executed));
  assert.equal(second.status, 'completed'); assert.equal(applications, 1);
  assert.equal(first.integration.application.reused, false); assert.equal(second.integration.application.reused, true);
  assert.deepEqual({ ...second.integration.application, reused: false }, first.integration.application);
  assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'later user edit');
});

test('direct writes permit hidden project files in their retained artifact', async t => {
  const f = await fixture(t, async d => { await writeFile(join(d.cwd, '.gitignore'), '*.generated\n'); });
  const result = await f.operations.run({ id: 'write', type: 'run', role: 'codex_worker' }, frame('write', null, { request: 'Write .gitignore' }));
  assert.deepEqual(result.artifact.files, ['.gitignore']);
});

function scheduler(f, extra = {}) {
  return new WorkflowScheduler({ ...extra, workspaces: f.workspaces, operationsFactory: createPollyOperations, runner: {
    start(descriptor) {
      f.calls.push(descriptor);
      let stop; const interrupted = new Promise(resolve => { stop = () => resolve({ status: 'interrupted' }); });
      descriptor.signal.addEventListener('abort', stop, { once: true });
      const done = Promise.race([interrupted, Promise.resolve().then(() => f.responder(descriptor, f)).then(value => ({ status: 'completed', text: 'Native result', ...value }))]).finally(() => descriptor.signal.removeEventListener('abort', stop));
      return { done, interrupt: async () => { stop(); await done; } };
    },
  } });
}

test('Polly workers and opposite-engine reviews retain the captured objective image after its source changes', async t => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  let source;
  const f = await fixture(t, async d => {
    assert.equal(d.inputContent?.[0]?.source.data, data, `${d.roleId}/${d.purpose} must receive the original objective image`);
    if (d.roleId === 'planner') {
      await writeFile(source, 'Changed after planner started');
      return { structuredOutput: { tasks: [task('left', 'codex', { purpose: 'explore' }), task('right', 'claude', { purpose: 'explore' })] } };
    }
    if (d.purpose === 'cross-review') return { structuredOutput: passed };
    if (d.purpose === 'integration-check') return { structuredOutput: verified };
  });
  source = join(f.root, 'objective.png'); await writeFile(source, Buffer.from(data, 'base64'));
  f.options.inputCapture = await captureClaudeInput([{ type: 'text', text: f.options.input }, { type: 'localImage', path: source }], { directory: f.root });
  const run = scheduler(f, { loadInputCapture: (capture, { signal }) => readClaudeInputCapture(capture, { directory: f.root, signal }) }).start(f.options);
  try {
    await until(() => ['completed', 'failed', 'blocked'].includes(run.snapshot().status));
    assert.equal(run.snapshot().status, 'completed', JSON.stringify(run.snapshot().runs.filter(row => row.status !== 'completed')));
    assert.ok(f.calls.some(call => call.roleId === 'codex_worker'));
    assert.ok(f.calls.some(call => call.roleId === 'claude_worker'));
    assert.ok(f.calls.some(call => call.roleId === 'codex_reviewer'));
    assert.ok(f.calls.some(call => call.roleId === 'claude_reviewer'));
    assert.doesNotMatch(JSON.stringify(run.snapshot()), /iVBORw0KGgo/);
  } finally { await run.interrupt(); }
});

test('scope and review validation failures are individually retryable in the scheduler', async t => {
  let writes = 0, reviewCount = 0;
  const f = await fixture(t, async d => {
    if (d.roleId === 'planner') return { structuredOutput: { tasks: [task('a')] } };
    if (d.purpose === 'task') {
      if (++writes === 1) await writeFile(join(d.cwd, 'outside.txt'), 'outside');
      else await rm(join(d.cwd, 'outside.txt'));
      await writeFile(join(d.cwd, 'a.txt'), 'valid');
    } else if (d.purpose === 'cross-review') return { structuredOutput: ++reviewCount === 1 ? { passed: 'yes', issues: [] } : passed };
    else if (d.purpose === 'integration-check') return { structuredOutput: verified };
  });
  const run = scheduler(f).start(f.options);
  await until(() => run.snapshot().status === 'blocked');
  const failedTask = run.snapshot().runs.find(value => value.status === 'failed'); assert.match(failedTask.error, /file scope/);
  assert.equal(run.retry(failedTask.id), true);
  await until(() => run.snapshot().runs.some(value => value.status === 'failed' && value.id !== failedTask.id));
  const failedReview = run.snapshot().runs.find(value => value.status === 'failed' && value.id !== failedTask.id); assert.match(failedReview.error, /structured review verdict/);
  assert.equal(run.retry(failedReview.id), true);
  assert.equal((await run.done).status, 'completed');
  assert.equal(writes, 2);
  assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'valid');
  assert.ok(f.calls.every(call => call.model === f.options.models[call.engine]));
});

test('native output schemas require every property and nullable optionals normalize to the public contract', async t => {
  const strict = schema => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object') assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties).sort());
    for (const value of Object.values(schema)) { if (Array.isArray(value)) value.forEach(strict); else strict(value); }
  };
  let reviews = 0;
  const f = await fixture(t, async d => {
    if (d.outputSchema) strict(d.outputSchema);
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'result');
    else if (d.purpose === 'cross-review') return { structuredOutput: ++reviews === 1 ? { passed: false, issues: [{ message: 'Recheck the result', path: null }] } : passed };
    else if (d.purpose === 'integration-check') return { structuredOutput: { ...verified, checks: [{ description: 'Fixture check', status: 'passed', details: null }] } };
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  const reviewed = await f.operations.crossReview(reviewStep, frame('review', executed));
  assert.equal(reviewed.status, 'completed');
  assert.deepEqual(reviewed.reviews[0].verdict.issues, [{ message: 'Recheck the result' }]);
  assert.deepEqual(reviewed.integration.verification.verification.checks, [{ description: 'Fixture check', status: 'passed' }]);
});

test('concrete passing checks allow documented non-applicable checks while required omissions still block review', async t => {
  let report, rejectRequired = false;
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'exact bytes');
    else if (d.purpose === 'integration-check') return { structuredOutput: report };
    else if (d.purpose === 'cross-review') {
      if (d.inputValues.target.phase === 'integration') {
        assert.match(d.instructions, /required.*(?:skipped|not.run)/i);
        if (rejectRequired) return { structuredOutput: { passed: false, issues: [{ message: 'A required acceptance check was skipped' }] } };
      }
      return { structuredOutput: passed };
    }
  });
  const executed = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('a')] }));
  const skipped = { description: 'Project test suite', status: 'not-run', details: 'No project test configuration or documentation exists.' };
  for (const [index, checks] of [[], [skipped], [...verified.checks, { description: 'Required test', status: 'failed' }]].entries()) {
    report = { passed: true, checks, issues: [] };
    await assert.rejects(f.operations.crossReview(reviewStep, frame(`invalid-${index}`, executed)), /Passing integration requires/);
  }
  report = { passed: true, checks: [...verified.checks, skipped], issues: [] }; rejectRequired = true;
  const blocked = await f.operations.crossReview({ ...reviewStep, maxRepairs: 0 }, frame('required-omission', executed));
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.integration.application.status, 'not-applied');
  rejectRequired = false;
  const reviewed = await f.operations.crossReview(reviewStep, frame('non-applicable', executed));
  assert.equal(reviewed.status, 'completed');
  assert.deepEqual(reviewed.integration.verification.verification.checks[1], skipped);
  assert.deepEqual(reviewed.integration.checks[0].checks[1], skipped);
});

test('recovery reuses successful task artifacts and retries the same immutable review workspace', async t => {
  let malformed = true;
  const f = await fixture(t, async d => {
    if (d.roleId === 'planner') return { structuredOutput: { tasks: [task('a')] } };
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'a.txt'), 'persisted');
    else if (d.purpose === 'cross-review') return { structuredOutput: malformed ? {} : passed };
    else if (d.purpose === 'integration-check') return { structuredOutput: verified };
  });
  const first = scheduler(f).start(f.options);
  await until(() => first.snapshot().status === 'blocked');
  const failed = first.snapshot().runs.find(value => value.status === 'failed'), reviewCwd = f.calls.at(-1).cwd;
  await first.interrupt(); const previousSnapshot = first.snapshot(); malformed = false;
  const resumed = scheduler(f).start({ ...f.options, previousSnapshot, retryRunId: failed.id });
  assert.equal((await resumed.done).status, 'completed');
  assert.equal(f.calls.filter(call => call.purpose === 'task').length, 1);
  assert.equal(f.calls.filter(call => call.purpose === 'cross-review')[1].cwd, reviewCwd);
  assert.deepEqual(resumed.snapshot().checkpoints['polly:base'], previousSnapshot.checkpoints['polly:base']);
});

test('structural workspace failure stops a sibling blocked for native retry and awaits cleanup', async t => {
  const f = await fixture(t, async d => d.roleId === 'planner' ? { structuredOutput: { tasks: [task('a'), task('b', 'claude')] } } : { status: 'failed', error: 'Retry needed' });
  const original = f.workspaces.task.bind(f.workspaces); let run;
  t.mock.method(f.workspaces, 'task', async (base, args) => {
    if (args.id === 'a') { await until(() => run.snapshot().status === 'blocked'); throw new Error('Workspace creation failed'); }
    return original(base, args);
  });
  run = scheduler(f).start(f.options);
  try { await until(() => ['failed', 'completed', 'interrupted'].includes(run.snapshot().status)); }
  finally { if (!['failed', 'completed', 'interrupted'].includes(run.snapshot().status)) await run.interrupt(); }
  const result = await run.done;
  assert.equal(result.status, 'failed'); assert.match(result.error, /Workspace creation failed/);
});

test('whole-turn stop retains isolated in-progress edits and never applies them', async t => {
  const f = await fixture(t, async d => {
    if (d.roleId === 'planner') return { structuredOutput: { tasks: [task('a')] } };
    if (d.purpose === 'task') { await writeFile(join(d.cwd, 'a.txt'), 'partial'); return new Promise(() => {}); }
  });
  const run = scheduler(f).start(f.options);
  await until(() => f.calls.some(call => call.purpose === 'task'));
  const cwd = f.calls.at(-1).cwd; await tick(); await run.interrupt();
  assert.equal((await run.done).status, 'interrupted');
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'partial');
  await assert.rejects(readFile(join(f.repo, 'a.txt')), { code: 'ENOENT' });
});

test('immutable workspace evidence records the configured role model independently of engine defaults', async t => {
  const f = await fixture(t, async d => {
    if (d.purpose === 'task') await writeFile(join(d.cwd, 'role-model.txt'), 'verified\n');
    return {};
  });
  f.options.template = structuredClone(f.options.template);
  f.options.template.roles.codex_worker.model = 'independent-worker-model';
  const result = await f.operations.executeTasks(executeStep, frame('implementation', { tasks: [task('role-model')] }));
  assert.equal(result.tasks[0].artifact.checks[0].requestedModel, 'independent-worker-model');
});
