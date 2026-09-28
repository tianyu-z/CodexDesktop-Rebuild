import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTemplate, resolveParameters, validateTaskPlan } from '../../runtime/agent-modes/templates/schema.mjs';
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_REVISIONS } from '../../runtime/agent-modes/templates/builtins.mjs';
import { TemplateStore } from '../../runtime/agent-modes/templates/store.mjs';

const clone = value => structuredClone(value);
const template = () => ({
  schemaVersion: 1, id: 'custom', name: 'Custom', description: 'Two independent answers',
  roles: {
    codex: { engine: 'codex', prompt: 'Answer independently.', access: 'read', session: 'reuse' },
    claude: { engine: 'claude', prompt: 'Answer independently.', access: 'read', session: 'reuse' },
  },
  parameters: {}, limits: { concurrency: 2, tasks: 8, rounds: 2 },
  steps: [
    { id: 'answers', type: 'parallel', steps: [
      { id: 'codex', type: 'run', role: 'codex', inputs: ['request', 'history'] },
      { id: 'claude', type: 'run', role: 'claude', inputs: ['request', 'history'] },
    ] },
    { id: 'summary', type: 'synthesize', role: 'claude', dependsOn: ['answers'], inputs: ['answers.codex', 'answers.claude'] },
  ],
  output: { sources: ['answers.codex', 'answers.claude', 'summary'], final: 'summary', format: 'markdown' },
});
const setup = t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-templates-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new TemplateStore(directory) };
};

test('builtins expose immutable Polly and Debby revisions with exactly two engine slots', t => {
  const { store } = setup(t);
  assert.deepEqual(store.list().map(item => item.id).sort(), ['debby', 'polly']);
  for (const builtin of BUILTIN_TEMPLATES) {
    const value = store.read(builtin.id);
    assert.equal(value.revision, builtin.revision);
    assert.equal(value.builtin, true);
    assert.match(value.contentHash, /^[a-f0-9]{64}$/);
    assert.deepEqual([...new Set(Object.values(value.roles).map(role => role.engine))].sort(), ['claude', 'codex']);
    assert.deepEqual(validateTemplate(value), value);
    assert.throws(() => store.save(value), /immutable|built.?in/i);
    assert.throws(() => store.remove(value.id), /immutable|built.?in/i);
  }
  assert.equal(store.read('debby').parameters.rounds.default, 2);
  assert.equal(store.read('debby').parameters.rounds.max, 5);
  assert.equal(store.read('polly').limits.concurrency, 2);
  assert.equal(store.read('polly').limits.tasks, 8);
  assert.equal(store.read('polly').limits.rounds, 2);
});

test('JSON and YAML roundtrip through import with metadata safe for editing and copying', t => {
  const { store } = setup(t);
  const saved = store.save(template());
  for (const format of ['json', 'yaml']) {
    const exported = store.export('custom', saved.revision, format);
    const other = setup(t).store;
    assert.deepEqual(other.import(exported), saved);
    assert.deepEqual(other.read('custom'), saved);
  }
  const copy = store.read('debby'); copy.id = 'my-debby';
  assert.equal(store.save(copy).builtin, false);
  assert.throws(() => store.export('custom', undefined, 'toml'), /format/);
});

test('saves are isolated immutable revisions and reject stale updates across store instances', t => {
  const { store, directory } = setup(t);
  const first = store.save(template());
  const stale = clone(first);
  first.name = 'Changed';
  const second = store.save(first);
  assert.equal(second.revision, 2);
  assert.notEqual(second.contentHash, first.contentHash);
  assert.equal(store.read('custom', 1).name, 'Custom');
  assert.equal(new TemplateStore(directory).read('custom').name, 'Changed');
  assert.throws(() => new TemplateStore(directory).save(stale), /revision.*conflict/i);
  second.roles.codex.engine = 'claude';
  assert.equal(store.read('custom').roles.codex.engine, 'codex');
  const unchanged = store.save(store.read('custom'));
  assert.equal(unchanged.revision, 3);
  assert.equal(unchanged.contentHash, store.read('custom', 2).contentHash);
});

test('deletion hides current templates but keeps history and monotonically increasing revisions', t => {
  const { store, directory } = setup(t);
  store.save(template());
  assert.equal(store.remove('custom'), true);
  assert.equal(store.remove('custom'), false);
  assert.equal(store.remove('missing'), false);
  assert.equal(store.read('custom'), null);
  assert.equal(store.read('custom', 1).name, 'Custom');
  assert.equal(store.read('missing'), null);
  assert.equal(store.read('polly', 2), null);
  assert.equal(store.list().length, 2);
  assert.equal(new TemplateStore(directory).save(template()).revision, 2);
});

test('gateway-owned storage recovers after restart without a stale template lock blocking edits', t => {
  const { directory, store } = setup(t);
  store.save(template());
  writeFileSync(join(directory, '.write-lock'), '');
  const restarted = new TemplateStore(directory);
  const edited = restarted.read('custom'); edited.name = 'After restart';
  assert.equal(restarted.save(edited).revision, 2);
  assert.equal(restarted.remove('custom'), true);
  assert.equal(restarted.read('custom', 2).name, 'After restart');
});

test('invalid IDs, revision paths and symlink escapes never touch outside storage', t => {
  const { store, directory } = setup(t);
  for (const id of ['../x', '/tmp/x', 'x/y', '..', '__proto__', 'constructor', 'A', 'x.json', 'x\\y']) {
    assert.throws(() => store.save({ ...template(), id }), /id/);
    assert.throws(() => store.read(id), /id/);
    assert.throws(() => store.remove(id), /id/);
  }
  for (const revision of ['../x', 0, -1, 1.1, Infinity]) assert.throws(() => store.read('custom', revision), /revision/);
  const outside = setup(t).directory;
  symlinkSync(outside, join(directory, 'custom'));
  assert.throws(() => store.save(template()), /symlink|symbolic/i);
  assert.deepEqual(readdirSync(outside), []);
});

test('malformed imports, executable tags, aliases and upstream fields fail with field paths', t => {
  const { store } = setup(t);
  for (const text of ['!!js/function function() {}', '!custom {}', 'a: &anchor {}\nb: *anchor', 'id: a\nid: b', '{"id":"a","id":"b"}', '---\nid: a\n---\nid: b']) {
    assert.throws(() => store.import(text), /\$|YAML|tag|alias|duplicate|document/i);
  }
  for (const key of ['spec_version', 'executor', 'tools', 'os_env', 'guardrails', 'spawn']) {
    assert.throws(() => store.import(JSON.stringify({ ...template(), [key]: {} })), new RegExp(`\\$\\.${key}`));
  }
});

test('validation fills safe defaults but rejects unknown and non-serializable fields', () => {
  const input = template(); delete input.limits; delete input.parameters;
  const normalized = validateTemplate(input);
  assert.deepEqual(normalized.limits, { concurrency: 2, tasks: 8, rounds: 2 });
  assert.deepEqual(normalized.parameters, {});
  assert.equal(normalized.revision, 1);
  for (const field of ['models', 'env', 'credentials', 'harness', 'approvalPolicy']) {
    const value = template(); value.roles.codex[field] = 'forbidden';
    assert.throws(() => validateTemplate(value), new RegExp(`roles.codex.${field}`));
  }
  const value = template(); value.steps[0].steps[0].execute = () => {};
  assert.throws(() => validateTemplate(value), /execute/);
});

test('explicit null is not a substitute for omitted defaults and constant-zero bodies are unreachable', () => {
  for (const field of ['revision', 'limits', 'parameters']) {
    const value = template(); value[field] = null;
    assert.throws(() => validateTemplate(value), new RegExp(field));
  }
  const value = template(); value.steps[0].dependsOn = null;
  assert.throws(() => validateTemplate(value), /dependsOn/);
  const unused = template();
  unused.steps = [
    { id: 'initial', type: 'run', role: 'claude', inputs: ['request'] },
    { id: 'never', type: 'repeat', dependsOn: ['initial'], count: 0, initial: { result: 'initial' },
      steps: [{ id: 'codex', type: 'run', role: 'codex', inputs: ['request'] }], yields: { result: 'codex' } },
  ];
  unused.output = { sources: ['never.result'], final: 'never.result', format: 'text' };
  assert.equal(validateTemplate(unused).schemaVersion, 2);
});

test('parameter values and all limit bounds are checked before execution', () => {
  const value = template();
  value.parameters = {
    rounds: { type: 'integer', default: 0, min: 0, max: 5 },
    temperature: { type: 'number', default: 0.5, min: 0, max: 1 },
    enabled: { type: 'boolean', default: true },
    label: { type: 'string', default: 'hello' },
  };
  assert.deepEqual(resolveParameters(value, { rounds: 2 }), { rounds: 2, temperature: 0.5, enabled: true, label: 'hello' });
  for (const bad of [{ rounds: 6 }, { rounds: -1 }, { rounds: 0.5 }, { rounds: '1' }, { enabled: 'true' }, { temperature: NaN }, { extra: 1 }]) {
    assert.throws(() => resolveParameters(value, bad), /parameters/);
  }
  for (const [name, bad] of [['concurrency', 5], ['tasks', 33], ['rounds', 11], ['tasks', 0]]) {
    const invalid = template(); invalid.limits[name] = bad;
    assert.throws(() => validateTemplate(invalid), new RegExp(`limits.${name}`));
  }
  value.parameters.rounds.default = 10;
  assert.throws(() => validateTemplate(value), /parameters.rounds.default/);
});

test('graph validation rejects duplicates, cycles, absent roles and undeclared result dependencies', () => {
  const cases = [
    [v => v.steps.push(clone(v.steps[0])), /steps\[2\].id.*duplicate/],
    [v => v.steps[0].dependsOn = ['summary'], /cycle/],
    [v => v.steps[1].dependsOn = ['missing'], /dependsOn.*missing/],
    [v => v.steps[0].steps[0].role = 'missing', /role.*missing/],
    [v => v.steps[1].inputs = ['answers.missing'], /inputs.*answers.missing/],
    [v => delete v.steps[1].dependsOn, /inputs.*depend/],
    [v => v.steps[0].steps[0].inputs.push('answers.claude'), /inputs/],
    [v => v.output.sources.push('missing'), /output.sources/],
    [v => v.output.final = 'missing', /output.final/],
    [v => v.steps[0].steps[0].inputs = ['previousRound.claude'], /previousRound/],
    [v => v.steps[0].steps[0].type = 'shell', /type/],
  ];
  for (const [change, expected] of cases) { const value = template(); change(value); assert.throws(() => validateTemplate(value), expected); }
});

test('repeat validates prior-round snapshots, bounded counts and zero-round output aliases', () => {
  const value = clone(BUILTIN_TEMPLATE_REVISIONS.find(item => item.id === 'debby' && item.revision === 1));
  const repeat = value.steps.find(step => step.type === 'repeat');
  assert.equal(repeat.count.parameter, 'rounds');
  assert.deepEqual(repeat.initial, { codex: 'answers.codex', claude: 'answers.claude' });
  assert.deepEqual(repeat.yields, { codex: 'codex', claude: 'claude' });
  assert.deepEqual(repeat.steps.map(step => step.inputs), [['request', 'previousRound.claude'], ['request', 'previousRound.codex']]);
  for (const [change, expected] of [
    [v => v.steps.find(s => s.type === 'repeat').count = 11, /count/],
    [v => v.steps.find(s => s.type === 'repeat').count = { parameter: 'missing' }, /count.parameter/],
    [v => v.parameters.rounds.type = 'number', /count.parameter/],
    [v => v.parameters.rounds.max = 10, /count/],
    [v => v.steps.find(s => s.type === 'repeat').yields.codex = 'missing', /yields.codex/],
    [v => delete v.steps.find(s => s.type === 'repeat').initial.codex, /initial|previousRound|aliases/],
    [v => v.steps.find(s => s.type === 'repeat').steps[0].inputs = ['previousRound.missing'], /inputs/],
  ]) { const invalid = clone(value); change(invalid); assert.throws(() => validateTemplate(invalid), expected); }
});

test('all bounded parameter references require scalar valid parameter IDs', () => {
  const cases = [
    ['debby', 'repeat', 'count', 'rounds'],
    ['polly', 'planTasks', 'maxTasks', 'task_count'],
    ['polly', 'crossReview', 'maxRepairs', 'repairs'],
  ];
  for (const [id, type, field, name] of cases) {
    const value = clone(BUILTIN_TEMPLATE_REVISIONS.find(item => item.id === id && item.revision === 1));
    const max = field === 'maxTasks' ? 8 : 2;
    value.parameters[name] = { type: 'integer', default: 1, min: 1, max };
    const step = value.steps.find(item => item.type === type);
    step[field] = { parameter: name };
    assert.doesNotThrow(() => validateTemplate(value));
    for (const invalid of [[name], { name }, 1, null, '', '../rounds', 'Rounds']) {
      step[field] = { parameter: invalid };
      assert.throws(() => validateTemplate(value), new RegExp(`${field}\\.parameter`));
    }
  }
});

test('Polly binds dynamic tasks to slots and enforces opposite-engine read-only review', () => {
  const value = clone(BUILTIN_TEMPLATES.find(item => item.id === 'polly'));
  const execute = value.steps.find(step => step.type === 'executeTasks');
  const review = value.steps.find(step => step.type === 'crossReview');
  assert.equal(value.roles[review.reviewers.codex].engine, 'claude');
  assert.equal(value.roles[review.reviewers.claude].engine, 'codex');
  assert.equal(execute.workspace, 'isolated');
  assert.equal(review.workspace, 'integration');
  const invalid = clone(value); invalid.steps.find(step => step.type === 'crossReview').reviewers.codex = review.reviewers.claude;
  assert.throws(() => validateTemplate(invalid), /reviewers.codex.*opposite/);
  const writable = clone(value); writable.roles[review.reviewers.codex].access = 'write';
  assert.throws(() => validateTemplate(writable), /reviewers.codex.*read/);
  const wrong = clone(value); wrong.steps.find(step => step.type === 'executeTasks').roles.codex = execute.roles.claude;
  assert.throws(() => validateTemplate(wrong), /roles.codex.*engine/);
});

test('custom scoped graphs can change flow including direct implementation cross-review', () => {
  const value = template();
  value.roles.codex.access = 'write';
  value.steps = [
    { id: 'plan', type: 'run', role: 'claude', inputs: ['request'] },
    { id: 'build', type: 'run', role: 'codex', inputs: ['plan'], dependsOn: ['plan'] },
    { id: 'review', type: 'crossReview', target: 'build', dependsOn: ['build'], reviewers: { codex: 'claude' }, maxRepairs: 2 },
    { id: 'summary', type: 'synthesize', role: 'claude', inputs: ['review'], dependsOn: ['review'] },
  ];
  value.output.sources = ['build', 'review', 'summary'];
  assert.equal(validateTemplate(value).steps[2].type, 'crossReview');
});

test('dynamic task plans validate bounded IDs, engine ownership, DAG and relative file scopes', () => {
  const tasks = { tasks: [
    { id: 'api', description: 'Implement API', engine: 'codex', purpose: 'implement', dependsOn: [], files: ['src/api.mjs'], acceptance: ['Tests pass'] },
    { id: 'ui', description: 'Explore UI', engine: 'claude', purpose: 'explore', dependsOn: ['api'], files: ['src/ui/**'], acceptance: ['Findings returned'] },
  ] };
  assert.deepEqual(validateTaskPlan(tasks, { maxTasks: 8 }), tasks);
  for (const change of [
    v => v.tasks.push(clone(v.tasks[0])),
    v => v.tasks[0].dependsOn.push('ui'),
    v => v.tasks[0].engine = 'both',
    v => v.tasks[0].files = ['../secret'],
    v => v.tasks[0].files = ['/absolute'],
    v => v.tasks[0].files = ['src/../../secret'],
    v => v.tasks[0].model = 'hidden-third-model',
  ]) { const invalid = clone(tasks); change(invalid); assert.throws(() => validateTaskPlan(invalid, { maxTasks: 8 }), /tasks/); }
  assert.throws(() => validateTaskPlan(tasks, { maxTasks: 1 }), /tasks/);
});

test('explicit dynamic review tasks must depend on opposite-engine work', () => {
  const task = { id: 'build', description: 'Implement', engine: 'codex', purpose: 'implement', dependsOn: [], files: ['src/**'], acceptance: ['Tests pass'] };
  const review = { ...task, id: 'review', purpose: 'review', engine: 'claude', dependsOn: ['build'] };
  assert.equal(validateTaskPlan({ tasks: [task, review] }).tasks[1].engine, 'claude');
  assert.throws(() => validateTaskPlan({ tasks: [task, { ...review, engine: 'codex' }] }), /tasks\[1\].engine.*opposite/);
  assert.throws(() => validateTaskPlan({ tasks: [task, { ...review, dependsOn: [] }] }), /tasks\[1\].dependsOn/);
});

test('tampered revisions are rejected and failed validation never replaces current data', t => {
  const { store, directory } = setup(t);
  const saved = store.save(template());
  const invalid = clone(saved); invalid.steps[1].inputs = ['missing'];
  assert.throws(() => store.save(invalid), /inputs/);
  assert.deepEqual(store.read('custom'), saved);
  const revisionFile = join(directory, 'custom', 'revisions', '1.json');
  const disk = JSON.parse(readFileSync(revisionFile, 'utf8')); disk.name = 'Tampered';
  writeFileSync(revisionFile, JSON.stringify(disk));
  assert.throws(() => store.read('custom', 1), /hash|integrity/i);
});

test('sparse arrays are rejected before save can replace a readable current revision', t => {
  const { store, directory } = setup(t);
  const saved = store.save(template());
  for (const field of ['inputs', 'dependsOn']) {
    const sparse = clone(saved);
    sparse.steps[1][field] = Array(1);
    assert.throws(() => store.save(sparse), new RegExp(`${field}\\[0\\].*sparse|${field}\\[0\\].*missing`));
    assert.deepEqual(store.read('custom'), saved);
    assert.deepEqual(new TemplateStore(directory).read('custom', 1), saved);
  }
  const sparse = clone(saved); sparse.output.sources = Array(1);
  assert.throws(() => store.save(sparse), /output.sources\[0\].*sparse|output.sources\[0\].*missing/);
  assert.deepEqual(readdirSync(join(directory, 'custom', 'revisions')), ['1.json']);
});

test('role models and same-engine graphs are saved as v2 while unextended v1 stays readable', t => {
  const { store } = setup(t), value = template();
  const old = store.save(value);
  assert.equal(old.schemaVersion, 1);
  old.roles.claude.engine = 'codex';
  old.roles.codex.model = 'deployment/a'; old.roles.claude.model = null;
  const saved = store.save(old);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.roles.codex.model, 'deployment/a');
  assert.equal(saved.roles.claude.model, null);
  assert.equal(store.read('custom', 1).schemaVersion, 1);
  assert.equal(store.read('custom', 1).roles.claude.engine, 'claude');
  assert.deepEqual(store.read('custom', 2), saved);
});

test('role overrides resolve independent engine, model and prompt without changing access or session', async () => {
  const { resolveRoleConfig } = await import('../../runtime/agent-modes/templates/schema.mjs');
  assert.equal(typeof resolveRoleConfig, 'function');
  const base = template(); base.roles.codex.model = 'template-model';
  const models = { codex: 'codex-default', claude: 'claude-default' };
  const overrides = { codex: { engine: 'claude', prompt: 'Custom perspective.' }, claude: { engine: 'codex', model: null } };
  const resolved = resolveRoleConfig(base, overrides, models);
  assert.equal(resolved.template.roles.codex.engine, 'claude');
  assert.equal(resolved.template.roles.codex.model, 'template-model');
  assert.equal(resolved.template.roles.codex.prompt, 'Custom perspective.');
  assert.equal(resolved.template.roles.claude.model, null);
  assert.equal(resolveRoleConfig(base, {}, models).template.roles.claude.model, 'claude-default');
  assert.equal(resolveRoleConfig(base, { codex: { model: 'explicit' } }, models).template.roles.codex.model, 'explicit');
  assert.deepEqual(resolved.roleOverrides, overrides);
  assert.equal(resolved.template.roles.codex.access, 'read');
  assert.equal(resolved.template.roles.codex.session, 'reuse');
  assert.equal(base.roles.codex.engine, 'codex');
  for (const invalid of [null, [], { missing: {} }, { codex: { access: 'write' } }, { codex: { session: 'reuse' } }, { codex: { engine: 'both' } }, { codex: { model: 'bad\n' } }, { codex: { prompt: '' } }, { codex: { prompt: 'x'.repeat(100001) } }]) {
    assert.throws(() => resolveRoleConfig(base, invalid, models), /roleOverrides/);
  }
});

test('Polly planner and summary allow overrides while worker and reviewer engine topology remains validated', async () => {
  const { resolveRoleConfig } = await import('../../runtime/agent-modes/templates/schema.mjs');
  assert.equal(typeof resolveRoleConfig, 'function');
  const base = BUILTIN_TEMPLATES.find(value => value.id === 'polly');
  const effective = resolveRoleConfig(base, { planner: { engine: 'codex', model: 'planner-model' }, summary: { model: 'summary-model', prompt: 'Summarize verified evidence.' } }, {}).template;
  assert.equal(effective.roles.planner.engine, 'codex'); assert.equal(effective.roles.summary.model, 'summary-model');
  assert.throws(() => resolveRoleConfig(base, { codex_worker: { engine: 'claude' } }, {}), /matching engine/);
  assert.throws(() => resolveRoleConfig(base, { claude_reviewer: { engine: 'codex' } }, {}), /opposite engine/);
});

test('Debby current revision has stable participants and host, and retains its old immutable revision', t => {
  const { store } = setup(t);
  const current = store.read('debby'), old = store.read('debby', 1);
  assert.equal(current.revision, 2); assert.equal(current.schemaVersion, 2);
  assert.deepEqual(Object.keys(current.roles), ['participant_a', 'participant_b', 'host']);
  assert.equal(current.roles.host.engine, 'claude');
  assert.equal(current.parameters.host_mode.default, 'per-round');
  assert.equal(current.steps[0].type, 'hostedDebate');
  assert.deepEqual(Object.keys(old.roles), ['codex', 'claude', 'moderator']);
  assert.equal(old.schemaVersion, 1); assert.equal(old.parameters.rounds.default, 0);
  assert.throws(() => resolveParameters(current, { host_mode: 'invented' }), /host_mode/);
  const writable = clone(current); writable.roles.host.access = 'write';
  assert.throws(() => validateTemplate(writable), /read/);
});
