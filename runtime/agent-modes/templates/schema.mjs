import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 2;
export const DEFAULT_LIMITS = Object.freeze({ concurrency: 2, tasks: 8, rounds: 2 });
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const RESERVED = new Set(['constructor', 'prototype', '__proto__', 'request', 'history', 'parameters', 'previousRound']);
const ENGINES = ['codex', 'claude'];
const own = (object, key) => Object.hasOwn(object, key);

export class TemplateValidationError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = 'TemplateValidationError'; this.path = path; }
}
const fail = (path, message) => { throw new TemplateValidationError(path, message); };
export function validateId(value, path = '$.id') {
  if (typeof value !== 'string' || !ID.test(value) || RESERVED.has(value)) fail(path, 'expected a lowercase ID (letters, numbers, _ or -), not a path or reserved name');
  return value;
}
export function validateRevision(value, path = '$.revision') {
  integer(value, path, 1, Number.MAX_SAFE_INTEGER); return value;
}
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain object');
}
function fields(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field; only the application template schema is supported (Omnigent executor/tools/environment fields are not supported)');
}
function string(value, path, { empty = false, max = 100000 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail(path, `expected ${empty ? 'a' : 'a non-empty'} string of at most ${max} characters`);
}
function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `expected an integer between ${min} and ${max}`);
}
function choice(value, values, path) { if (!values.includes(value)) fail(path, `expected one of: ${values.join(', ')}`); }
export function validateModel(value, path = '$.model') {
  if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,255}$/.test(value))) fail(path, 'expected null or a valid model identifier');
  return value;
}
export function validateRoleOverrides(value, roles) {
  json(value, '$.roleOverrides'); object(value, '$.roleOverrides');
  if (Object.keys(value).length > 64) fail('$.roleOverrides', 'at most 64 role overrides are supported');
  for (const [id, override] of Object.entries(value)) {
    const path = `$.roleOverrides.${id}`; validateId(id, path);
    if (roles && !own(roles, id)) fail(path, 'unknown role');
    fields(override, ['engine', 'model', 'prompt'], path);
    if (own(override, 'engine')) choice(override.engine, ENGINES, `${path}.engine`);
    if (own(override, 'model')) validateModel(override.model, `${path}.model`);
    if (own(override, 'prompt')) string(override.prompt, `${path}.prompt`);
  }
  return structuredClone(value);
}
/** Resolve role choices once; effective roles are safe to snapshot and retry. */
export function resolveRoleConfig(input, overrides = {}, models = {}) {
  const template = validateTemplate(input);
  const roleOverrides = validateRoleOverrides(overrides, template.roles);
  fields(models, ENGINES, '$.models');
  for (const [engine, model] of Object.entries(models)) validateModel(model, `$.models.${engine}`);
  for (const [id, role] of Object.entries(template.roles)) {
    const override = roleOverrides[id] ?? {};
    const engine = override.engine ?? role.engine;
    template.roles[id] = { ...role, ...override, model: own(override, 'model') ? override.model : own(role, 'model') ? role.model : models[engine] ?? null };
  }
  return { template: validateTemplate(template), roleOverrides };
}
function array(value, path, { min = 0, max = 256 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `expected an array with ${min}–${max} entries`);
}
function json(value, path = '$', seen = new Set(), depth = 0) {
  if (depth > 64) fail(path, 'maximum data nesting exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') fail(path, 'expected serializable JSON data');
  if (seen.has(value)) fail(path, 'cyclic data is not supported');
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!own(value, index)) fail(`${path}[${index}]`, 'sparse arrays are not serializable template data');
    }
  } else object(value, path);
  seen.add(value);
  for (const [key, item] of Object.entries(value)) json(item, `${path}${Array.isArray(value) ? `[${key}]` : `.${key}`}`, seen, depth + 1);
  seen.delete(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function templateContentHash(template) {
  const { revision, contentHash, builtin, ...content } = template;
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}
function parameterValue(definition, value, path) {
  if (definition.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail(path, 'expected an integer');
  } else if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  } else if (typeof value !== definition.type) fail(path, `expected ${definition.type}`);
  if (typeof value === 'number') {
    if (value < definition.min || value > definition.max) fail(path, `expected a value between ${definition.min} and ${definition.max}`);
  }
  if (typeof value === 'string') string(value, path, { empty: true, max: 10000 });
  if (definition.enum && !definition.enum.includes(value)) fail(path, `expected one of: ${definition.enum.join(', ')}`);
}
function parameters(value) {
  object(value, '$.parameters');
  if (Object.keys(value).length > 32) fail('$.parameters', 'at most 32 parameters are supported');
  for (const [name, definition] of Object.entries(value)) {
    const path = `$.parameters.${name}`; validateId(name, path);
    fields(definition, ['type', 'default', 'min', 'max', 'description', 'enum'], path);
    choice(definition.type, ['integer', 'number', 'boolean', 'string'], `${path}.type`);
    if (own(definition, 'description')) string(definition.description, `${path}.description`, { empty: true, max: 2000 });
    if (['integer', 'number'].includes(definition.type)) {
      for (const bound of ['min', 'max']) {
        if (typeof definition[bound] !== 'number' || !Number.isFinite(definition[bound]) || (definition.type === 'integer' && !Number.isSafeInteger(definition[bound]))) fail(`${path}.${bound}`, 'numeric parameters require finite bounds of the declared type');
      }
      if (definition.min > definition.max) fail(`${path}.max`, 'must be greater than or equal to min');
    } else if (own(definition, 'min') || own(definition, 'max')) fail(path, 'min/max are only valid for numeric parameters');
    if (own(definition, 'enum')) {
      if (definition.type !== 'string') fail(`${path}.enum`, 'only string parameter choices are supported');
      array(definition.enum, `${path}.enum`, { min: 1, max: 32 });
      definition.enum.forEach((value, i) => string(value, `${path}.enum[${i}]`, { max: 10000 }));
      if (new Set(definition.enum).size !== definition.enum.length) fail(`${path}.enum`, 'duplicate choices');
    }
    parameterValue(definition, definition.default, `${path}.default`);
  }
}
export function resolveParameters(template, values = {}) {
  const normalized = validateTemplate(template);
  object(values, '$.parameters');
  for (const key of Object.keys(values)) if (!own(normalized.parameters, key)) fail(`$.parameters.${key}`, 'unknown parameter');
  return Object.fromEntries(Object.entries(normalized.parameters).map(([name, definition]) => {
    const value = own(values, name) ? values[name] : definition.default;
    parameterValue(definition, value, `$.parameters.${name}`);
    return [name, value];
  }));
}
function bound(value, path, min, max, template) {
  if (typeof value === 'number') { integer(value, path, min, max); return value; }
  fields(value, ['parameter'], path);
  validateId(value.parameter, `${path}.parameter`);
  const definition = template.parameters[value.parameter];
  if (!definition || definition.type !== 'integer') fail(`${path}.parameter`, `unknown or non-integer parameter ${String(value.parameter)}`);
  if (definition.min < min || definition.max > max) fail(path, `parameter bounds must fit ${min}–${max}`);
  return definition.max;
}
function roleRef(value, path, template) {
  if (typeof value !== 'string' || !own(template.roles, value)) fail(path, `unknown role ${String(value)}`);
  return template.roles[value];
}
function roleMap(value, path, template, { opposite = false, read = false, both = false } = {}) {
  fields(value, ENGINES, path);
  if (!Object.keys(value).length) fail(path, 'at least one engine role is required');
  if (both && ENGINES.some(engine => !own(value, engine))) fail(path, 'both engine slots are required');
  for (const [engine, name] of Object.entries(value)) {
    const role = roleRef(name, `${path}.${engine}`, template);
    if (role.engine !== (opposite ? ENGINES.find(item => item !== engine) : engine)) fail(`${path}.${engine}`, `role must use the ${opposite ? 'opposite' : 'matching'} engine`);
    if (read && role.access !== 'read') fail(`${path}.${engine}`, 'reviewer must have read access');
  }
}
const STEP_FIELDS = {
  run: ['role', 'inputs', 'prompt'],
  synthesize: ['role', 'inputs', 'prompt'],
  parallel: ['steps'],
  repeat: ['count', 'initial', 'steps', 'yields'],
  planTasks: ['role', 'inputs', 'prompt', 'maxTasks'],
  executeTasks: ['plan', 'roles', 'workspace'],
  crossReview: ['target', 'reviewers', 'maxRepairs', 'workspace'],
  hostedDebate: ['participants', 'host', 'inputs', 'count', 'mode'],
};
const HOST_MODES = ['per-round', 'final-only'];
function hostMode(value, path, template) {
  if (typeof value === 'string') return choice(value, HOST_MODES, path);
  fields(value, ['parameter'], path); validateId(value.parameter, `${path}.parameter`);
  const definition = template.parameters[value.parameter];
  if (!definition || definition.type !== 'string' || !definition.enum || definition.enum.some(mode => !HOST_MODES.includes(mode))) fail(path, 'host mode parameter must have per-round/final-only string choices');
}
function normalizeScope(steps, path, template, state, depth = 0) {
  array(steps, path, { min: 1, max: 128 });
  if (depth > 8) fail(path, 'maximum graph nesting is 8');
  const ids = new Set();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index], p = `${path}[${index}]`; object(step, p);
    choice(step.type, Object.keys(STEP_FIELDS), `${p}.type`);
    fields(step, ['id', 'type', 'dependsOn', ...STEP_FIELDS[step.type]], p);
    validateId(step.id, `${p}.id`);
    if (ids.has(step.id)) fail(`${p}.id`, `duplicate ID ${step.id}`);
    ids.add(step.id);
    if (++state.nodes > 256) fail(path, 'maximum graph size is 256 steps');
    if (!own(step, 'dependsOn')) step.dependsOn = [];
    array(step.dependsOn, `${p}.dependsOn`);
    for (const [i, id] of step.dependsOn.entries()) validateId(id, `${p}.dependsOn[${i}]`);
    if (new Set(step.dependsOn).size !== step.dependsOn.length) fail(`${p}.dependsOn`, 'duplicate dependency');
    if (['run', 'synthesize', 'planTasks'].includes(step.type)) {
      const role = roleRef(step.role, `${p}.role`, template);
      array(step.inputs, `${p}.inputs`, { min: 1 });
      if (own(step, 'prompt')) string(step.prompt, `${p}.prompt`);
      if (step.type !== 'run' && role.access !== 'read') fail(`${p}.role`, `${step.type} requires a read-only role`);
    }
    if (step.type === 'planTasks') {
      if (!own(step, 'maxTasks')) step.maxTasks = template.limits.tasks;
      bound(step.maxTasks, `${p}.maxTasks`, 1, template.limits.tasks, template);
    }
    if (step.type === 'hostedDebate') {
      template.schemaVersion = SCHEMA_VERSION;
      object(step.participants, `${p}.participants`);
      if (Object.keys(step.participants).length !== 2) fail(`${p}.participants`, 'exactly two independent participant roles are required');
      for (const [alias, id] of Object.entries(step.participants)) {
        validateId(alias, `${p}.participants.${alias}`);
        if (['sources', 'assessments'].includes(alias)) fail(`${p}.participants.${alias}`, 'reserved debate output name');
        if (roleRef(id, `${p}.participants.${alias}`, template).access !== 'read') fail(`${p}.participants.${alias}`, 'debate requires read-only roles');
      }
      if (new Set([...Object.values(step.participants), step.host]).size !== 3) fail(`${p}.participants`, 'participants and host require distinct roles');
      if (roleRef(step.host, `${p}.host`, template).access !== 'read') fail(`${p}.host`, 'host requires read-only access');
      array(step.inputs, `${p}.inputs`, { min: 1 });
      bound(step.count, `${p}.count`, 0, template.limits.rounds, template);
      if (!own(step, 'mode')) step.mode = 'per-round';
      hostMode(step.mode, `${p}.mode`, template);
    }
    if (step.type === 'executeTasks') {
      roleMap(step.roles, `${p}.roles`, template, { both: true });
      choice(step.workspace, ['isolated'], `${p}.workspace`);
    }
    if (step.type === 'crossReview') {
      roleMap(step.reviewers, `${p}.reviewers`, template, { opposite: true, read: true });
      if (!own(step, 'maxRepairs')) step.maxRepairs = Math.min(2, template.limits.rounds);
      bound(step.maxRepairs, `${p}.maxRepairs`, 0, template.limits.rounds, template);
      if (own(step, 'workspace')) choice(step.workspace, ['integration'], `${p}.workspace`);
    }
    if (step.type === 'repeat') {
      bound(step.count, `${p}.count`, 0, template.limits.rounds, template);
      for (const key of ['initial', 'yields']) {
        object(step[key], `${p}.${key}`);
        if (!Object.keys(step[key]).length || Object.keys(step[key]).length > 64) fail(`${p}.${key}`, 'expected 1–64 output aliases');
        for (const alias of Object.keys(step[key])) validateId(alias, `${p}.${key}.${alias}`);
      }
      if (Object.keys(step.initial).sort().join() !== Object.keys(step.yields).sort().join()) fail(`${p}.initial`, 'initial and yields must declare identical aliases (including for zero rounds)');
    }
    if (step.steps) normalizeScope(step.steps, `${p}.steps`, template, state, depth + 1);
    else if (['parallel', 'repeat'].includes(step.type)) fail(`${p}.steps`, 'nested steps are required');
  }
}
function dependencies(steps, path) {
  const map = new Map(steps.map((step, i) => [step.id, { step, path: `${path}[${i}]` }]));
  const visiting = new Set(), done = new Map();
  function visit(id) {
    if (visiting.has(id)) fail(path, `dependency cycle involving ${id}`);
    if (done.has(id)) return done.get(id);
    visiting.add(id); const all = new Set(), node = map.get(id);
    for (const [i, dependency] of node.step.dependsOn.entries()) {
      if (!map.has(dependency)) fail(`${node.path}.dependsOn[${i}]`, `unknown dependency ${dependency}`);
      all.add(dependency); for (const prior of visit(dependency)) all.add(prior);
    }
    visiting.delete(id); done.set(id, all); return all;
  }
  for (const id of map.keys()) visit(id);
  return done;
}
function exportsFor(step, template) {
  const info = { type: step.type, step };
  if (step.role) info.engines = [template.roles[step.role].engine];
  if (step.type === 'executeTasks') info.engines = [...ENGINES];
  const refs = new Map([['', info]]);
  if (step.type === 'parallel') {
    for (const child of step.steps) for (const [suffix, meta] of exportsFor(child, template)) refs.set(`${child.id}${suffix ? `.${suffix}` : ''}`, meta);
  }
  if (step.type === 'repeat') for (const alias of Object.keys(step.yields)) refs.set(alias, { type: 'value' });
  if (step.type === 'hostedDebate') for (const alias of [...Object.keys(step.participants), 'sources', 'assessments']) refs.set(alias, { type: 'value' });
  if (['planTasks', 'executeTasks', 'crossReview'].includes(step.type)) refs.set('tasks', { type: 'value' });
  if (step.type === 'crossReview') {
    refs.set('reviews', { type: 'value' });
    if (step.workspace === 'integration') refs.set('integration', { type: 'value' });
  }
  return refs;
}
function ref(value, path, available) {
  if (typeof value !== 'string' || !available.has(value)) fail(path, `unknown or unavailable reference ${String(value)}; result inputs require a completed dependency (previousRound is only available inside repeat)`);
  return available.get(value);
}
function checkScope(steps, path, template, outer, engines, reachable = true) {
  const closure = dependencies(steps, path);
  const all = new Map();
  for (const step of steps) for (const [suffix, info] of exportsFor(step, template)) all.set(`${step.id}${suffix ? `.${suffix}` : ''}`, info);
  for (const [index, step] of steps.entries()) {
    const p = `${path}[${index}]`, available = new Map(outer);
    if ([...outer.keys()].some(key => key === step.id || key.startsWith(`${step.id}.`))) fail(`${p}.id`, 'local ID shadows a visible outer reference');
    for (const dependency of closure.get(step.id)) for (const [key, info] of all) if (key === dependency || key.startsWith(`${dependency}.`)) available.set(key, info);
    if (step.inputs) step.inputs.forEach((input, i) => ref(input, `${p}.inputs[${i}]`, available));
    if (step.role && reachable) engines.add(template.roles[step.role].engine);
    if (step.type === 'hostedDebate' && reachable) for (const role of [...Object.values(step.participants), step.host]) engines.add(template.roles[role].engine);
    if (step.type === 'executeTasks') {
      if (ref(step.plan, `${p}.plan`, available).type !== 'planTasks') fail(`${p}.plan`, 'must reference a planTasks result');
      if (reachable) for (const engine of ENGINES) engines.add(engine);
    }
    if (step.type === 'crossReview') {
      const target = ref(step.target, `${p}.target`, available);
      if (!['run', 'executeTasks'].includes(target.type)) fail(`${p}.target`, 'must reference a run or executeTasks result');
      for (const engine of target.engines) {
        if (!own(step.reviewers, engine)) fail(`${p}.reviewers.${engine}`, 'an opposite-engine reviewer is required for every target engine');
        if (reachable) engines.add(template.roles[step.reviewers[engine]].engine);
      }
      if (target.type === 'executeTasks' && step.workspace !== 'integration') fail(`${p}.workspace`, 'executeTasks reviews require an integration workspace');
      if (target.type === 'run' && step.workspace) fail(`${p}.workspace`, 'integration is only supported for executeTasks targets');
    }
    if (step.type === 'parallel') checkScope(step.steps, `${p}.steps`, template, available, engines, reachable);
    if (step.type === 'repeat') {
      // Previous-round values are immutable snapshots, never sibling outputs from this iteration.
      const nested = new Map(available);
      for (const key of [...nested.keys()]) if (key.startsWith('previousRound.')) nested.delete(key);
      for (const [alias, initial] of Object.entries(step.initial)) {
        ref(initial, `${p}.initial.${alias}`, available);
        nested.set(`previousRound.${alias}`, { type: 'value' });
      }
      const canRun = bound(step.count, `${p}.count`, 0, template.limits.rounds, template) > 0;
      const local = checkScope(step.steps, `${p}.steps`, template, nested, engines, reachable && canRun);
      for (const [alias, output] of Object.entries(step.yields)) ref(output, `${p}.yields.${alias}`, local);
    }
  }
  return all;
}

/** Validate and normalize without mutating the caller. No model or filesystem work occurs. */
export function validateTemplate(input) {
  json(input);
  fields(input, ['schemaVersion', 'id', 'revision', 'name', 'description', 'roles', 'parameters', 'limits', 'steps', 'output', 'builtin', 'contentHash'], '$');
  const value = structuredClone(input);
  if (![1, SCHEMA_VERSION].includes(value.schemaVersion)) fail('$.schemaVersion', `unsupported schema; expected 1 or ${SCHEMA_VERSION}`);
  validateId(value.id);
  if (!own(value, 'revision')) value.revision = 1;
  validateRevision(value.revision);
  string(value.name, '$.name', { max: 200 });
  string(value.description, '$.description', { empty: true, max: 5000 });
  if (own(value, 'builtin') && typeof value.builtin !== 'boolean') fail('$.builtin', 'expected a boolean');
  if (own(value, 'contentHash') && (typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash))) fail('$.contentHash', 'expected a SHA-256 hex digest');
  value.builtin ??= false;
  if (!own(value, 'limits')) value.limits = {};
  fields(value.limits, ['concurrency', 'tasks', 'rounds'], '$.limits');
  value.limits = { ...DEFAULT_LIMITS, ...value.limits };
  integer(value.limits.concurrency, '$.limits.concurrency', 1, 4);
  integer(value.limits.tasks, '$.limits.tasks', 1, 32);
  integer(value.limits.rounds, '$.limits.rounds', 0, 10);
  if (!own(value, 'parameters')) value.parameters = {};
  parameters(value.parameters);
  if (Object.values(value.parameters).some(parameter => own(parameter, 'enum'))) value.schemaVersion = SCHEMA_VERSION;
  object(value.roles, '$.roles');
  if (!Object.keys(value.roles).length || Object.keys(value.roles).length > 64) fail('$.roles', 'expected 1–64 roles');
  for (const [id, role] of Object.entries(value.roles)) {
    const path = `$.roles.${id}`; validateId(id, path);
    fields(role, ['engine', 'model', 'prompt', 'access', 'session'], path);
    choice(role.engine, ENGINES, `${path}.engine`);
    if (own(role, 'model')) { validateModel(role.model, `${path}.model`); value.schemaVersion = SCHEMA_VERSION; }
    string(role.prompt, `${path}.prompt`);
    choice(role.access, ['read', 'write'], `${path}.access`);
    choice(role.session, ['reuse', 'fresh'], `${path}.session`);
  }
  normalizeScope(value.steps, '$.steps', value, { nodes: 0 });
  const global = new Map([['request', { type: 'input' }], ['history', { type: 'input' }]]);
  for (const name of Object.keys(value.parameters)) global.set(`parameters.${name}`, { type: 'parameter' });
  const engines = new Set();
  const outputs = checkScope(value.steps, '$.steps', value, global, engines);
  if (engines.size < 2) value.schemaVersion = SCHEMA_VERSION;
  fields(value.output, ['sources', 'final', 'format'], '$.output');
  array(value.output.sources, '$.output.sources', { min: 1 });
  value.output.sources.forEach((output, i) => ref(output, `$.output.sources[${i}]`, outputs));
  ref(value.output.final, '$.output.final', outputs);
  if (!value.output.sources.includes(value.output.final)) fail('$.output.final', 'final must also appear in output.sources');
  choice(value.output.format, ['markdown', 'text', 'json'], '$.output.format');
  value.contentHash = templateContentHash(value);
  return value;
}

export function validateHostDecision(input) {
  json(input, '$.hostDecision'); fields(input, ['continue', 'guidance'], '$.hostDecision');
  if (typeof input.continue !== 'boolean') fail('$.hostDecision.continue', 'expected an explicit boolean decision');
  string(input.guidance, '$.hostDecision.guidance', { empty: true, max: 10000 });
  return structuredClone(input);
}

/** Planner output schema; schedulers must call this before scheduling dynamic work. */
export function validateTaskPlan(input, { maxTasks = DEFAULT_LIMITS.tasks } = {}) {
  json(input); fields(input, ['tasks'], '$'); integer(maxTasks, '$.maxTasks', 1, 32);
  array(input.tasks, '$.tasks', { min: 1, max: maxTasks });
  const value = structuredClone(input), ids = new Set();
  for (const [i, task] of value.tasks.entries()) {
    const p = `$.tasks[${i}]`;
    fields(task, ['id', 'description', 'engine', 'purpose', 'dependsOn', 'files', 'acceptance'], p);
    validateId(task.id, `${p}.id`);
    if (ids.has(task.id)) fail(`${p}.id`, `duplicate ID ${task.id}`);
    ids.add(task.id);
    string(task.description, `${p}.description`);
    choice(task.engine, ENGINES, `${p}.engine`);
    choice(task.purpose, ['implement', 'review', 'explore'], `${p}.purpose`);
    array(task.dependsOn, `${p}.dependsOn`);
    task.dependsOn.forEach((id, n) => validateId(id, `${p}.dependsOn[${n}]`));
    if (new Set(task.dependsOn).size !== task.dependsOn.length) fail(`${p}.dependsOn`, 'duplicate dependency');
    array(task.files, `${p}.files`, { min: 1, max: 128 });
    task.files.forEach((file, n) => {
      string(file, `${p}.files[${n}]`, { max: 4096 });
      if (file.startsWith('/') || file.includes('\\') || file.includes('\0') || file.includes(':') || file.split('/').some(part => !part || part === '.' || part === '..')) fail(`${p}.files[${n}]`, 'expected a relative POSIX file scope without traversal');
    });
    array(task.acceptance, `${p}.acceptance`, { min: 1, max: 32 });
    task.acceptance.forEach((criterion, n) => string(criterion, `${p}.acceptance[${n}]`, { max: 10000 }));
  }
  dependencies(value.tasks, '$.tasks');
  const tasksById = new Map(value.tasks.map(task => [task.id, task]));
  for (const [i, task] of value.tasks.entries()) {
    if (task.purpose !== 'review') continue;
    if (!task.dependsOn.length) fail(`$.tasks[${i}].dependsOn`, 'review tasks require explicit target dependencies');
    if (task.dependsOn.some(id => tasksById.get(id).engine === task.engine)) fail(`$.tasks[${i}].engine`, 'review must use the opposite engine from every target dependency');
  }
  return value;
}
