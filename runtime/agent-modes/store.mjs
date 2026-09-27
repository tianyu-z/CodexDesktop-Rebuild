import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const clone = value => structuredClone(value);
const engines = new Set(['codex', 'claude']);
export function assertEngine(mode) {
  if (!engines.has(mode)) throw new Error(`Unknown native engine: ${mode}`);
}
export function assertMode(mode) {
  if (mode !== 'both' && !engines.has(mode)) throw new Error(`Unknown engine mode: ${mode}`);
}
const terminalRuns = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'blocked']);
const runStates = new Set(['queued', 'preparing', 'running', 'awaitingApproval', ...terminalRuns]);
const terminalTurns = new Set(['completed', 'failed', 'interrupted']);
const roleAttemptKey = run => JSON.stringify([run.stepId, run.roleId, run.round]);
function latestAttempts(runs) {
  const latest = new Map();
  for (const run of runs) {
    const key = roleAttemptKey(run);
    if ((latest.get(key)?.attempt ?? 0) < run.attempt) latest.set(key, run);
  }
  return [...latest.values()];
}
const requiredId = (value, label) => { if (typeof value !== 'string' || !value || value.length > 1024) throw new Error(`${label} is required.`); };
function selectedModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models) || Object.keys(models).some(key => !engines.has(key))) throw new Error('Invalid model selection.');
  for (const model of Object.values(models)) if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,255}$/.test(model))) throw new Error('Invalid model identifier.');
  return clone(models);
}
function selectedTemplate(template) {
  if (template === null) return null;
  if (!template || typeof template !== 'object' || Array.isArray(template) || Object.keys(template).some(key => !['id', 'revision', 'parameters'].includes(key))) throw new Error('Invalid template selection.');
  requiredId(template.id, 'Template ID');
  if (!Number.isSafeInteger(template.revision) || template.revision < 1) throw new Error('Invalid template revision.');
  if (!template.parameters || typeof template.parameters !== 'object' || Array.isArray(template.parameters)) throw new Error('Invalid template parameters.');
  return clone(template);
}
function legacyAlias(value) {
  value.activeTurn ??= value.activeRun ?? null;
  delete value.activeRun;
  // Keep existing single-engine router callers working while disk has one owner.
  Object.defineProperty(value, 'activeRun', { enumerable: true, configurable: true,
    get() { return this.activeTurn; }, set(run) { this.activeTurn = run; } });
  return value;
}

/** One gateway owns a store directory. Each snapshot is replaced atomically. */
export class ConversationStore {
  constructor(directory) {
    this.directory = directory;
    this.records = new Map();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const original = readFileSync(join(directory, file), 'utf8');
      const value = JSON.parse(original);
      if (![1, 2].includes(value.schemaVersion) || typeof value.id !== 'string' || !Array.isArray(value.turns)) {
        throw new Error(`Unsupported conversation data: ${file}`);
      }
      const migrating = value.schemaVersion === 1;
      if (migrating) {
        const backups = join(directory, 'v1-backups');
        mkdirSync(backups, { recursive: true, mode: 0o700 });
        writeFileSync(join(backups, `${file}.${randomUUID()}.json`), original, { flag: 'wx', mode: 0o600 });
        value.schemaVersion = 2;
      }
      value.roleBindings ??= {};
      value.nextEventSeq ??= 1;
      legacyAlias(value);
      this.records.set(value.id, value);
      if (value.activeTurn) {
        const record = value.turns.find(row => row.turn.id === value.activeTurn.turnId);
        if (record?.turn.status === 'inProgress') record.turn.status = 'interrupted';
        if (record?.workflow) {
          record.workflow.status = 'interrupted';
          for (const run of record.runs) if (!terminalRuns.has(run.status)) run.status = 'interrupted';
        }
        const binding = value.bindings[value.activeTurn.engine];
        const acknowledged = value.activeTurn.acknowledgedSeq;
        if (binding?.sessionId && Number.isInteger(acknowledged) && acknowledged > binding.consumedSeq && acknowledged < value.nextSeq) binding.consumedSeq = acknowledged;
        value.activeTurn = null;
        this.save(value);
      } else if (migrating) this.save(value);
    }
  }

  path(id) { return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`); }
  remove(id) {
    this.records.delete(id);
    for (const path of [this.path(id), this.path(id).replace(/\.json$/, '.history.txt')]) {
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  get(id) { return this.records.has(id) ? clone(this.records.get(id)) : null; }
  list() { return [...this.records.values()].map(clone); }
  require(id) {
    const value = this.records.get(id);
    if (!value) throw new Error(`Unknown conversation: ${id}`);
    return value;
  }
  save(value) {
    const path = this.path(value.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const { activeRun, ...persistent } = value;
    writeFileSync(temporary, JSON.stringify(persistent), { mode: 0o600 });
    renameSync(temporary, path);
  }

  ensureThread(thread, { mode = 'codex' } = {}) {
    if (typeof thread?.id !== 'string' || !thread.id) throw new Error('Thread id is required.');
    if (!this.records.has(thread.id)) {
      assertMode(mode);
      const { turns = [], ...metadata } = thread;
      this.records.set(thread.id, legacyAlias({
        schemaVersion: 2, id: thread.id, mode, cwd: thread.cwd,
        thread: clone(metadata), models: { codex: thread.model ?? null, claude: 'default' },
        bindings: {
          codex: { sessionId: thread.id, consumedSeq: 0 },
          claude: { sessionId: null, consumedSeq: 0 },
        },
        nextSeq: 1, nextEventSeq: 1, turns: [], activeTurn: null, roleBindings: {},
      }));
    }
    return this.mergeNativeThread(thread);
  }

  mergeNativeThread(thread) {
    if (!this.records.has(thread.id)) return this.ensureThread(thread);
    const value = this.require(thread.id);
    const { turns = [], ...metadata } = thread;
    value.thread = { ...value.thread, ...clone(metadata), preview: metadata.preview || value.thread.preview, updatedAt: Math.max(metadata.updatedAt ?? 0, value.thread.updatedAt ?? 0), recencyAt: Math.max(metadata.recencyAt ?? 0, value.thread.recencyAt ?? 0) };
    value.cwd = thread.cwd ?? value.cwd;
    if (value.mode !== 'both' && !value.explicitModels?.codex && thread.model && !thread.model.startsWith('claude-code/')) value.models.codex = thread.model;
    for (const turn of turns) {
      const existing = value.turns.find(row => row.turn.id === turn.id);
      if (existing && existing.turn.status !== 'inProgress' && turn.status === 'inProgress') continue;
      this.putTurn(thread.id, turn, { engine: 'codex', save: false });
    }
    this.save(value);
    return clone(value);
  }

  setMode(id, mode, { model, models, template } = {}) {
    assertMode(mode);
    if (model) assertEngine(mode);
    const nextModels = models === undefined ? null : selectedModels(models);
    const nextTemplate = template === undefined ? undefined : selectedTemplate(template);
    const value = this.require(id);
    if (value.activeRun) throw new Error('Finish or interrupt the active run before switching engines.');
    value.mode = mode;
    if (model) { value.models[mode] = model; value.explicitModels = { ...value.explicitModels, [mode]: true }; }
    if (nextModels) {
      value.models = { ...value.models, ...nextModels };
      value.explicitModels = { ...value.explicitModels, ...Object.fromEntries(Object.keys(nextModels).map(engine => [engine, true])) };
    }
    if (nextTemplate !== undefined) value.template = nextTemplate;
    this.save(value);
    return clone(value);
  }

  setBinding(id, engine, patch) {
    assertEngine(engine);
    const value = this.require(id);
    const previous = value.bindings[engine];
    if (patch.consumedSeq != null && (!Number.isInteger(patch.consumedSeq) || patch.consumedSeq < previous.consumedSeq)) {
      throw new Error('Context cursor must advance monotonically.');
    }
    value.bindings[engine] = { ...previous, ...clone(patch) };
    this.save(value);
  }

  beginRun(id, run) {
    assertEngine(run.engine);
    const value = this.require(id);
    if (value.activeRun) throw new Error('A run is already active in this conversation.');
    value.activeRun = clone(run);
    this.save(value);
  }

  finishRun(id, runId) {
    const value = this.require(id);
    if (value.activeRun?.id !== runId || !engines.has(value.activeRun.engine)) throw new Error('Run ownership mismatch.');
    value.activeRun = null;
    this.save(value);
  }

  putTurn(id, turn, { engine, runId = turn.id, save = true } = {}) {
    assertMode(engine);
    const value = this.require(id);
    let record = value.turns.find(row => row.turn.id === turn.id);
    if (record) {
      if (record.engine !== engine) throw new Error('Turn engine ownership mismatch.');
      record.turn = clone(turn);
    } else {
      record = { seq: value.nextSeq++, engine, runId, turn: clone(turn),
        runs: engine === 'both' ? [] : [{ id: runId, engine, nativeTurnId: turn.id }] };
      value.turns.push(record);
    }
    value.thread.updatedAt = Math.max(value.thread.updatedAt ?? 0, turn.startedAt ?? 0, turn.completedAt ?? 0);
    value.thread.recencyAt = Math.max(value.thread.recencyAt ?? 0, value.thread.updatedAt);
    const user = turn.items?.find(item => item.type === 'userMessage');
    if (!value.thread.preview && user) {
      value.thread.preview = user.content?.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 250) ?? '';
    }
    if (save) this.save(value);
    return clone(record);
  }

  beginWorkflow(id, { id: workflowId, turn, config }) {
    const value = this.require(id);
    if (value.activeTurn) throw new Error('A turn is already active in this conversation.');
    requiredId(workflowId, 'Workflow ID'); requiredId(turn?.id, 'Turn ID');
    if (value.turns.some(row => row.turn.id === turn.id || row.workflow?.id === workflowId)) throw new Error('Workflow/turn ID already exists.');
    if (config?.mode !== 'both' || !config.models || !config.template) throw new Error('Both-engine execution configuration is required.');
    const frozen = clone(config);
    JSON.stringify(frozen);
    const models = selectedModels(frozen.models);
    const template = selectedTemplate({ id: frozen.template.id, revision: frozen.template.revision, parameters: frozen.parameters ?? {} });
    this.putTurn(id, turn, { engine: 'both', runId: workflowId, save: false });
    const row = value.turns.at(-1);
    row.workflow = { id: workflowId, status: 'running', config: frozen, events: [], state: null };
    value.mode = 'both';
    value.models = { ...value.models, ...models };
    value.explicitModels = { ...value.explicitModels, ...Object.fromEntries(Object.keys(models).map(engine => [engine, true])) };
    value.template = template;
    value.activeTurn = { id: workflowId, turnId: turn.id, mode: 'both' };
    this.save(value);
    return clone(row);
  }

  workflowRecord(id, workflowId, { active = true } = {}) {
    const value = this.require(id);
    const row = value.turns.find(row => row.workflow?.id === workflowId);
    if (!row || (active && value.activeTurn?.id !== workflowId)) throw new Error('Workflow ownership mismatch: no matching active turn.');
    return { value, row };
  }

  putWorkflowRun(id, workflowId, run) {
    const { value, row } = this.workflowRecord(id, workflowId);
    requiredId(run?.id, 'Run ID'); requiredId(run.roleId, 'Role ID'); requiredId(run.stepId, 'Step ID');
    assertEngine(run.engine);
    if (!Number.isSafeInteger(run.attempt) || run.attempt < 1 || !Number.isSafeInteger(run.round) || run.round < 0 || !runStates.has(run.status)) throw new Error('Invalid role run attempt, round or state.');
    const expectedModel = row.workflow.config.models[run.engine];
    if (run.requestedModel != null && expectedModel != null && run.requestedModel !== expectedModel) throw new Error('Run model ownership mismatch.');
    const role = row.workflow.config.template.roles?.[run.roleId];
    if (role && role.engine !== run.engine) throw new Error('Role engine ownership mismatch.');
    const index = row.runs.findIndex(current => current.id === run.id);
    const previousAttempts = row.runs.filter(previous => roleAttemptKey(previous) === roleAttemptKey(run));
    if (previousAttempts.some(previous => previous.engine !== run.engine || previous.requestedModel !== run.requestedModel)) throw new Error('Retry engine/model ownership mismatch.');
    if (index < 0 && row.runs.some(previous => roleAttemptKey(previous) === roleAttemptKey(run) && previous.attempt >= run.attempt)) throw new Error('Duplicate or stale role attempt.');
    if (index >= 0) {
      const previous = row.runs[index];
      if (['engine', 'roleId', 'stepId', 'attempt', 'round', 'requestedModel'].some(key => previous[key] !== run[key])) throw new Error('Run ownership mismatch.');
      if (terminalRuns.has(previous.status) && !isDeepStrictEqual(previous, run)) throw new Error('A settled run is immutable; create a new attempt.');
    }
    const snapshot = clone(run);
    if (index < 0) row.runs.push(snapshot); else row.runs[index] = snapshot;
    this.save(value);
    return clone(snapshot);
  }

  appendWorkflowEvent(id, workflowId, event) {
    const { value, row } = this.workflowRecord(id, workflowId);
    requiredId(event?.eventId, 'Event ID'); requiredId(event.runId, 'Run ID');
    const run = row.runs.find(run => run.id === event.runId);
    if (!run || event.engine !== run.engine) throw new Error('Event run/engine ownership mismatch.');
    const existing = row.workflow.events.find(item => item.eventId === event.eventId && item.runId === event.runId);
    if (existing) return clone(existing);
    const stored = { ...clone(event), seq: value.nextEventSeq++ };
    row.workflow.events.push(stored);
    this.save(value);
    return clone(stored);
  }

  setWorkflowState(id, workflowId, state) {
    const { value, row } = this.workflowRecord(id, workflowId);
    row.workflow.state = clone(state);
    this.save(value);
  }

  setRoleBinding(id, key, patch) {
    if (typeof key !== 'string' || !key || key.length > 1024 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid role binding key.');
    const value = this.require(id), previous = Object.hasOwn(value.roleBindings, key) ? value.roleBindings[key] : null;
    const engine = patch.engine ?? previous?.engine; assertEngine(engine);
    if (previous && engine !== previous.engine) throw new Error('Role binding engine ownership mismatch.');
    if (Object.hasOwn(patch, 'consumedSeq') && (!Number.isSafeInteger(patch.consumedSeq) || patch.consumedSeq < (previous?.consumedSeq ?? 0))) throw new Error('Context cursor must advance monotonically.');
    value.roleBindings[key] = { consumedSeq: 0, ...previous, ...clone(patch), engine };
    this.save(value);
  }

  finishWorkflow(id, workflowId, status, { error } = {}) {
    const { value, row } = this.workflowRecord(id, workflowId);
    if (!terminalTurns.has(status)) throw new Error('Invalid workflow terminal status.');
    if (row.runs.some(run => !terminalRuns.has(run.status))) throw new Error('Wait until all active roles are settled.');
    if (status === 'completed' && latestAttempts(row.runs).some(run => run.status !== 'completed')) throw new Error('A workflow with unsuccessful roles cannot complete successfully.');
    row.workflow.status = status; row.turn.status = status;
    row.turn.completedAt = Math.floor(Date.now() / 1000);
    if (Number.isFinite(row.turn.startedAt)) row.turn.durationMs = Math.max(0, row.turn.completedAt - row.turn.startedAt) * 1000;
    value.thread.updatedAt = Math.max(value.thread.updatedAt ?? 0, row.turn.completedAt);
    value.thread.recencyAt = Math.max(value.thread.recencyAt ?? 0, value.thread.updatedAt);
    if (error) row.turn.error = { message: String(error) };
    value.activeTurn = null;
    this.save(value);
    return clone(row);
  }
}
