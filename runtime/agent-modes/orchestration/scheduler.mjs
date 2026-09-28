import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { resolveParameters, resolveRoleConfig, validateHostDecision, validateTaskPlan } from '../templates/schema.mjs';
import { renderInputs } from './inputs.mjs';
import { assertClaudePermissionMode } from '../claude-permissions.mjs';
import { assertClaudeLiveCommand } from '../claude-commands.mjs';

const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const frozen = value => freeze(clone(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const errorText = error => error instanceof Error ? error.message : String(error);
const settled = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'blocked']);
const resultFields = new Set(['id', 'engine', 'roleId', 'stepId', 'attempt', 'round', 'status', 'requestedModel', 'permissionMode', 'actualPermissionMode', 'cwd', 'text', 'structuredOutput', 'nativeSessionId', 'actualModel', 'usage', 'error', 'nativeTasks']);
const stoppedError = () => new Error('Workflow interrupted.');
const roleKey = ({ stepId, roleId, round = 0 }) => JSON.stringify([stepId, roleId, round]);
const bound = (value, parameters) => typeof value === 'number' ? value : parameters[value.parameter];
const needsWorkspace = (steps, template, parameters) => steps.some(step =>
  step.type === 'executeTasks' || (step.type === 'run' && template.roles[step.role].access === 'write') ||
  (step.type === 'parallel' && needsWorkspace(step.steps, template, parameters)) ||
  (step.type === 'repeat' && bound(step.count, parameters) > 0 && needsWorkspace(step.steps, template, parameters)));

/** Stable across turns, distinct across revisions, roles, workspaces and task purposes. */
export function roleBindingKey({ template, roleId, cwd, purpose = 'default', requestedModel = template.roles[roleId]?.model ?? null }) {
  const role = template.roles[roleId];
  const scope = createHash('sha256').update(JSON.stringify([cwd, purpose, role?.engine, requestedModel, role?.prompt])).digest('hex');
  return `${template.id}@${template.revision ?? 1}/${roleId}/${scope}`;
}

export function hostDecisionSchema() {
  return { type: 'object', additionalProperties: false, required: ['continue', 'guidance'], properties: {
    continue: { type: 'boolean' }, guidance: { type: 'string', maxLength: 10000 },
  } };
}

export function taskPlanSchema(maxTasks) {
  return {
    type: 'object', additionalProperties: false, required: ['tasks'], properties: {
      tasks: { type: 'array', minItems: 1, maxItems: maxTasks, items: {
        type: 'object', additionalProperties: false, required: ['id', 'description', 'engine', 'purpose', 'dependsOn', 'files', 'acceptance'],
        properties: { id: { type: 'string' }, description: { type: 'string' }, engine: { enum: ['codex', 'claude'] },
          purpose: { enum: ['implement', 'review', 'explore'] }, dependsOn: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } }, acceptance: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } } },
      } },
    },
  };
}

/** Transport/store agnostic interpreter for the validated template graph. */
export class WorkflowScheduler {
  constructor({ runner, workspaces, operationsFactory, onEvent, onPermission } = {}) {
    if (!runner || typeof runner.start !== 'function') throw new TypeError('A native role runner is required.');
    Object.assign(this, { runner, workspaces, operationsFactory, onEvent, onPermission });
  }

  start(options) {
    return new WorkflowExecution(this, options).handle;
  }
}

class WorkflowExecution {
  constructor(owner, supplied) {
    this.owner = owner;
    if (typeof supplied.runId !== 'string' || !supplied.runId) throw new TypeError('A workflow run ID is required.');
    const previous = supplied.previousSnapshot ? clone(supplied.previousSnapshot) : null;
    if (previous && previous.id !== supplied.runId) throw new Error('Workflow recovery ID does not match the saved snapshot.');
    // Snapshot all caller-owned execution data before scheduling even one microtask.
    const data = previous?.config ?? { runId: supplied.runId, template: supplied.template, roleOverrides: supplied.roleOverrides ?? {}, parameters: supplied.parameters ?? {}, models: supplied.models ?? {},
      nativeOptions: supplied.nativeOptions ?? {}, cwd: supplied.cwd, input: supplied.input ?? '', history: supplied.history ?? [], ...(supplied.throughSeq !== undefined ? { throughSeq: supplied.throughSeq } : {}) };
    const { template, roleOverrides } = resolveRoleConfig(data.template, data.roleOverrides ?? {}, data.models);
    const parameters = resolveParameters(template, data.parameters);
    if (typeof data.cwd !== 'string' || !isAbsolute(data.cwd)) throw new TypeError('Workflow requires an absolute working directory.');
    if (!data.models || typeof data.models !== 'object' || Array.isArray(data.models) || Object.keys(data.models).some(key => !['codex', 'claude'].includes(key))) throw new TypeError('Invalid workflow model slots.');
    this.options = frozen({ ...data, runId: supplied.runId, template, roleOverrides, parameters });
    this.onSnapshot = supplied.onSnapshot;
    this.controller = new AbortController(); this.completed = deferred(); this.activation = deferred();
    this.active = new Map(); this.waiters = new Map(); this.retries = new Set(); this.blockers = new Set(); this.jobs = new Map(); this.bindingJobs = new Map();
    this.pending = []; this.locks = new Set(); this.nativeCount = 0; this.stopping = false; this.terminal = false; this.callbackError = null;
    this.state = {
      version: 1, id: supplied.runId, status: previous ? 'blocked' : 'running', config: clone(this.options),
      runs: previous?.runs ?? [], events: previous?.events ?? [], bindings: clone(previous?.bindings ?? {}),
      cache: previous?.cache ?? { steps: {}, roles: {} }, invocations: previous?.invocations ?? {}, checkpoints: previous?.checkpoints ?? {},
      guidance: previous?.guidance ?? [],
      ...(previous?.outputs ? { outputs: previous.outputs } : {}),
    };
    for (const [key, value] of Object.entries(supplied.bindings ?? {})) {
      const saved = this.state.bindings[key];
      this.state.bindings[key] = { ...saved, ...clone(value), consumedSeq: Math.max(saved?.consumedSeq ?? 0, value.consumedSeq ?? 0) };
    }
    if (previous && data.template.schemaVersion === 1 && !Object.hasOwn(data, 'roleOverrides') &&
      Object.values(data.template.roles).every(role => !Object.hasOwn(role, 'model'))) this.migrateLegacyBindings();
    this.seq = this.state.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
    for (const run of this.state.runs) {
      if (!settled.has(run.status)) run.status = 'interrupted';
      if (run.status === 'completed') this.state.cache.roles[roleKey(run)] ??= clone(run);
    }
    for (const run of this.latestRuns()) if (run.status !== 'completed') this.blockers.add(run.id);
    if (previous && supplied.resume === true && supplied.retryRunId === undefined && this.blockers.size) throw new Error('An unsuccessful role requires an explicit retryRunId before this workflow can resume.');
    if (previous && supplied.resume === true && !this.blockers.size) this.activated = true;
    this.handle = { done: this.completed.promise, interrupt: id => this.interrupt(id), retry: id => this.retry(id), snapshot: () => clone(this.state), control: (id, command, options) => this.control(id, command, options), steer: text => this.steer(text) };
    this.abortListener = () => { this.stop(); };
    supplied.signal?.addEventListener('abort', this.abortListener, { once: true });
    this.externalSignal = supplied.signal;
    this.notify();
    if (supplied.signal?.aborted) this.stop();
    if (!previous) this.activation.resolve();
    else if (supplied.retryRunId !== undefined && !this.retry(supplied.retryRunId)) this.fatal(new Error('The saved role run is not retryable.'));
    else if (supplied.resume === true) this.activation.resolve();
    // The returned handle is available to stop before native scheduling starts.
    void Promise.resolve().then(() => this.execute());
  }

  migrateLegacyBindings() {
    // Only an original v1 recovery config proves what the old unconfigured
    // key meant. A new turn cannot infer that identity from a binding alone.
    // Copy before the first snapshot upgrades config, since saved invocation
    // prompts may already exclude history held only by this native session.
    for (const descriptor of Object.values(this.state.invocations)) {
      const role = this.options.template.roles[descriptor.roleId];
      if (role?.session !== 'reuse' || role.engine !== descriptor.engine || role.model !== (descriptor.requestedModel ?? null)) continue;
      const scope = createHash('sha256').update(JSON.stringify([descriptor.cwd, descriptor.purpose ?? 'default'])).digest('hex');
      const legacyKey = `${this.options.template.id}@${this.options.template.revision ?? 1}/${descriptor.roleId}/${scope}`;
      const legacy = this.state.bindings[legacyKey];
      const key = roleBindingKey({ template: this.options.template, ...descriptor });
      if (legacy?.engine === role.engine && !Object.hasOwn(this.state.bindings, key)) this.state.bindings[key] = clone(legacy);
    }
  }

  latestRuns() { const runs = new Map(); for (const run of this.state.runs) if ((runs.get(roleKey(run))?.attempt ?? 0) < run.attempt) runs.set(roleKey(run), run); return [...runs.values()]; }
  alive() { if (this.stopping) throw stoppedError(); }
  async steer(text) {
    this.alive();
    if (this.terminal) throw new Error('Workflow ended. Send the prompt as a new turn.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Steering requires a nonempty text prompt.');
    // Save before fan-out so recovery and roles waiting for a concurrency slot
    // see the same user guidance. Completed roles are never replayed.
    const guidance = { id: randomUUID(), text, deliveries: [] };
    this.state.guidance.push(guidance); this.notify(); this.alive();
    const targets = [...this.active.entries()].filter(([, active]) => active.handle && !active.controller.signal.aborted);
    const receipt = { accepted: [], failures: [] };
    await Promise.all(targets.map(async ([id, active]) => {
      const run = this.state.runs.find(run => run.id === id);
      try {
        if (typeof active.handle.steer !== 'function') throw new Error('Native role does not support live steering.');
        await active.handle.steer(text);
        receipt.accepted.push(id); guidance.deliveries.push({ runId: id, status: 'accepted' });
      } catch (error) {
        const failure = { runId: id, roleId: run.roleId, error: errorText(error) };
        receipt.failures.push(failure); guidance.deliveries.push({ ...failure, status: 'failed' });
      }
    }));
    this.notify();
    return receipt;
  }
  notify() {
    if (!this.terminal && !this.stopping) this.state.status = this.blockers.size ? 'blocked' : this.state.status === 'blocked' && !this.activated ? 'blocked' : 'running';
    if (this.callbackError) return;
    try { this.onSnapshot?.(clone(this.state)); } catch (error) { this.fatal(error); }
  }
  fatal(error) { this.callbackError ??= errorText(error); this.stop(); }
  stop() {
    if (this.terminal || this.stopping) return;
    this.stopping = true; this.state.status = 'stopping'; this.controller.abort(); this.activation.resolve();
    for (const active of this.active.values()) { active.controller.abort(); this.cancelNative(active); }
    for (const waiter of this.waiters.values()) waiter.resolve();
    this.pump(); this.notify();
  }
  cancelNative(active) {
    if (!active.handle || active.interruption) return;
    active.interruption = Promise.resolve().then(() => active.handle.interrupt?.()).catch(error => { this.callbackError ??= `Native cleanup failed: ${errorText(error)}`; });
  }
  interrupt(id) {
    if (id === undefined) { this.stop(); return this.completed.promise; }
    const active = this.active.get(id);
    if (!active) return Promise.resolve(false);
    active.controller.abort(); this.cancelNative(active); this.pump();
    return active.finished.promise.then(() => true);
  }
  async control(id, command, options) {
    const selected = assertClaudeLiveCommand(command);
    const active = this.active.get(id), run = this.state.runs.find(run => run.id === id);
    if (this.stopping || this.terminal || !active || active.controller.signal.aborted || !['running', 'awaitingApproval'].includes(run?.status)) throw new Error('Claude control requires an active owned role run.');
    if (run.engine !== 'claude' || typeof active.handle?.control !== 'function') throw new Error('Live controls require a Claude role with an updated native adapter.');
    return active.handle.control(selected, options);
  }
  retry(id) {
    if (this.terminal || this.stopping || !this.blockers.has(id)) return false;
    const run = this.state.runs.find(run => run.id === id);
    if (!run || !settled.has(run.status) || run.status === 'completed' || this.latestRuns().find(latest => roleKey(latest) === roleKey(run))?.id !== id) return false;
    if (!this.state.invocations[roleKey(run)]) return false;
    this.blockers.delete(id); this.retries.add(id); this.activated = true; this.activation.resolve();
    this.waiters.get(id)?.resolve(); this.notify(); return true;
  }

  async execute() {
    let error;
    try {
      await this.activation.promise; this.alive(); this.activated = true;
      if (needsWorkspace(this.options.template.steps, this.options.template, this.options.parameters)) {
        const operations = await this.operations(); this.alive();
        await operations?.prepare?.(); this.alive();
      }
      const globals = new Map([['request', this.options.input], ['history', this.options.history]]);
      for (const [key, value] of Object.entries(this.options.parameters)) globals.set(`parameters.${key}`, value);
      const results = await this.scope(this.options.template.steps, '', globals, 0);
      this.alive();
      this.state.outputs = { sources: Object.fromEntries(this.options.template.output.sources.map(ref => [ref, clone(results.get(ref))])),
        final: clone(results.get(this.options.template.output.final)), format: this.options.template.output.format };
    } catch (failure) { if (!this.stopping) { error = errorText(failure); this.stop(); } }
    // Hooks and native runs own cleanup. scope waits all branches before rejecting.
    await Promise.allSettled([...this.jobs.values()]);
    for (const active of this.active.values()) await active.finished.promise;
    this.externalSignal?.removeEventListener('abort', this.abortListener);
    this.terminal = true;
    this.state.status = this.callbackError || this.executionError || error ? 'failed' : this.stopping ? 'interrupted' : 'completed';
    if (this.callbackError || this.executionError || error) this.state.error = this.callbackError ?? this.executionError ?? error;
    this.notify();
    // The final persistence call itself may fail after the terminal state was
    // computed. Preserve that failure in the lifecycle result as well.
    if (this.callbackError) { this.state.status = 'failed'; this.state.error = this.callbackError; }
    this.completed.resolve(clone(this.state));
  }

  async scope(steps, prefix, outer, round) {
    const nodes = new Map(steps.map(step => [step.id, step])), jobs = new Map(), results = new Map();
    const schedule = id => {
      if (jobs.has(id)) return jobs.get(id);
      const step = nodes.get(id);
      const job = (async () => {
        const dependencies = await Promise.all(step.dependsOn.map(schedule)); this.alive();
        const available = new Map(outer);
        for (const exports of dependencies) for (const [name, value] of exports) available.set(name, value);
        const path = prefix ? `${prefix}.${id}` : id;
        const value = await this.step(step, path, available, round);
        const exports = this.exports(step, value);
        // A completed dependency exposes its transitive dependencies too.
        for (const entries of dependencies) for (const [name, result] of entries) if (!exports.has(name)) exports.set(name, result);
        for (const [name, result] of this.exports(step, value)) results.set(name, result);
        return exports;
      })().catch(error => {
        // A structural/workspace failure must stop other branches immediately;
        // waiting for the whole scope first could strand a retry or native run.
        if (!this.stopping) { this.executionError = errorText(error); this.stop(); }
        throw error;
      });
      jobs.set(id, job); return job;
    };
    const outcomes = await Promise.allSettled(steps.map(step => schedule(step.id)));
    const failed = outcomes.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results;
  }
  exports(step, result, prefix = step.id) {
    const exports = new Map([[prefix, result]]);
    if (step.type === 'parallel') for (const child of step.steps) for (const [name, value] of this.exports(child, result[child.id], `${prefix}.${child.id}`)) exports.set(name, value);
    if (step.type === 'repeat') for (const alias of Object.keys(step.yields)) exports.set(`${prefix}.${alias}`, result[alias]);
    if (step.type === 'hostedDebate') for (const alias of [...Object.keys(step.participants), 'sources', 'assessments']) exports.set(`${prefix}.${alias}`, result[alias]);
    if (['planTasks', 'executeTasks', 'crossReview'].includes(step.type)) exports.set(`${prefix}.tasks`, result.tasks);
    if (step.type === 'crossReview') { exports.set(`${prefix}.reviews`, result.reviews); if (step.workspace) exports.set(`${prefix}.integration`, result.integration); }
    return exports;
  }
  async step(step, path, available, round) {
    if (Object.hasOwn(this.state.cache.steps, path)) return clone(this.state.cache.steps[path]);
    this.alive();
    const resolve = reference => {
      if (!available.has(reference)) throw new Error(`Unavailable input reference: ${reference}`);
      return frozen(available.get(reference));
    };
    let result;
    if (step.type === 'parallel') {
      const nested = await this.scope(step.steps, path, available, round);
      result = Object.fromEntries(step.steps.map(child => [child.id, nested.get(child.id)]));
    } else if (step.type === 'hostedDebate') {
      result = await this.hostedDebate(step, path, resolve);
    } else if (step.type === 'repeat') {
      let previous = Object.fromEntries(Object.entries(step.initial).map(([alias, ref]) => [alias, resolve(ref)]));
      for (let iteration = 1; iteration <= bound(step.count, this.options.parameters); iteration++) {
        this.alive(); const nested = new Map(available);
        for (const key of [...nested.keys()]) if (key.startsWith('previousRound.')) nested.delete(key);
        for (const [alias, value] of Object.entries(previous)) nested.set(`previousRound.${alias}`, frozen(value));
        const completed = await this.scope(step.steps, `${path}.$round${iteration}`, nested, iteration);
        previous = Object.fromEntries(Object.entries(step.yields).map(([alias, ref]) => [alias, frozen(completed.get(ref))]));
      }
      result = previous;
    } else if (['executeTasks', 'crossReview'].includes(step.type) || (step.type === 'run' && this.options.template.roles[step.role].access === 'write')) {
      const operations = await this.operations(); this.alive();
      if (typeof operations?.[step.type] !== 'function') throw new Error(`Workflow operation ${step.type} is unavailable.`);
      const resolvedStep = clone(step);
      if (resolvedStep.maxRepairs !== undefined) resolvedStep.maxRepairs = bound(resolvedStep.maxRepairs, this.options.parameters);
      const frame = { path, round, resolve, ...(step.inputs ? { inputs: frozen(Object.fromEntries(step.inputs.map(ref => [ref, resolve(ref)]))) } : {}) };
      result = await operations[step.type](freeze(resolvedStep), frame);
      if (result === undefined) throw new Error(`Workflow operation ${step.type} returned no result.`);
    } else {
      const maxTasks = step.type === 'planTasks' ? bound(step.maxTasks, this.options.parameters) : undefined;
      result = await this.invoke({ roleId: step.role, stepId: path, round, prompt: renderInputs(step.inputs, resolve),
        inputValues: Object.fromEntries(step.inputs.map(ref => [ref, resolve(ref)])),
        ...(step.prompt ? { instructions: `${this.options.template.roles[step.role].prompt}\n\n${step.prompt}` } : {}),
        ...(maxTasks !== undefined ? { outputSchema: taskPlanSchema(maxTasks), validateResult: result => validateTaskPlan(result.structuredOutput, { maxTasks }) } : {}),
      });
    }
    this.alive(); this.state.cache.steps[path] = clone(result); this.notify(); return clone(result);
  }
  async hostedDebate(step, path, resolve) {
    const participants = Object.entries(step.participants), sources = [], assessments = [];
    const inputs = frozen(Object.fromEntries(step.inputs.map(ref => [ref, resolve(ref)])));
    const limit = bound(step.count, this.options.parameters);
    const mode = typeof step.mode === 'string' ? step.mode : this.options.parameters[step.mode.parameter];
    const invoke = (roleId, stepId, round, inputValues, extras = {}) => this.invoke({ roleId, stepId, round,
      prompt: renderInputs(Object.keys(inputValues), ref => inputValues[ref]), inputValues, ...extras });
    let previous, guidance;
    for (let round = 0; round <= limit; round++) {
      this.alive();
      // Both peers receive the same immutable completed-round snapshot. The
      // normal role cache makes restart/retry replay this loop without work.
      const roundInputs = round === 0 ? inputs : frozen({
        ...Object.fromEntries(Object.entries(inputs).filter(([name]) => name !== 'history')),
        previousRound: previous, ...(guidance === undefined ? {} : { hostGuidance: guidance }),
      });
      const outcomes = await Promise.allSettled(participants.map(async ([alias, roleId]) => [alias,
        await invoke(roleId, `${path}.${round === 0 ? 'answers' : `$round${round}`}.${alias}`, round, roundInputs,
          round === 0 ? {} : { instructions: `${this.options.template.roles[roleId].prompt}\n\nCritique the fixed previous-round answers and respond to host guidance when supplied. Return your updated complete answer.` }),
      ]));
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      if (failure) throw failure.reason;
      previous = frozen(Object.fromEntries(outcomes.map(outcome => outcome.value)));
      sources.push(...Object.values(previous));
      if (mode === 'per-round') {
        const assessment = await invoke(step.host, `${path}.$assessment${round}`, round,
          frozen({ ...Object.fromEntries(Object.entries(inputs).filter(([name]) => name !== 'history')), answers: previous, sources, assessments, roundsRemaining: limit - round }), {
            instructions: `${this.options.template.roles[step.host].prompt}\n\nAssess whether another critique round would materially improve these answers. Return only JSON {"continue":boolean,"guidance":string}. Use false only when further critique is unnecessary; missing evidence is never agreement. The runtime enforces the remaining round limit.`,
            outputSchema: hostDecisionSchema(), validateResult: result => ({ decision: validateHostDecision(result.structuredOutput) }),
          });
        assessments.push(frozen(assessment));
        guidance = assessment.decision.guidance;
        if (!assessment.decision.continue) break;
      }
    }
    return { ...previous, sources, assessments };
  }
  operations() {
    if (!this.operationPromise) {
      if (typeof this.owner.operationsFactory !== 'function') throw new Error('Isolated workspace operations are unavailable for this template.');
      this.operationPromise = Promise.resolve(this.owner.operationsFactory({ invoke: descriptor => this.invoke(descriptor), options: this.options,
        workspaces: this.owner.workspaces, signal: this.controller.signal,
        fail: error => { this.executionError ??= errorText(error); this.stop(); },
        getInvocation: run => {
          const descriptor = this.state.invocations[roleKey(run)];
          return descriptor === undefined ? undefined : frozen(descriptor);
        },
        checkpoint: (key, value) => { this.alive(); if (typeof key !== 'string' || !key || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Invalid checkpoint key.'); this.state.checkpoints[key] = clone(value); this.notify(); },
        getCheckpoint: key => clone(this.state.checkpoints[key]), notifySnapshot: () => this.notify(),
      }));
    }
    return this.operationPromise;
  }

  async invoke(input) {
    this.alive();
    const role = this.options.template.roles[input.roleId];
    if (!role) throw new Error(`Unknown workflow role: ${input.roleId}`);
    if (typeof input.stepId !== 'string' || !input.stepId || typeof input.prompt !== 'string') throw new TypeError('Role invocation requires a step ID and prompt.');
    const access = input.access ?? role.access;
    if (!['read', 'write'].includes(access) || (role.access === 'read' && access !== 'read')) throw new Error('Role access cannot exceed the declared access ceiling.');
    const round = input.round ?? 0;
    if (!Number.isSafeInteger(round) || round < 0) throw new TypeError('Role round must be a nonnegative integer.');
    const cwd = input.cwd ?? this.options.cwd;
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('Role working directory must be absolute.');
    const key = roleKey({ ...input, round });
    if (Object.hasOwn(this.state.cache.roles, key)) return clone(this.state.cache.roles[key]);
    if (this.jobs.has(key)) return clone(await this.jobs.get(key));
    const slots = this.options.nativeOptions;
    const nativeOptions = Object.hasOwn(slots, 'codex') || Object.hasOwn(slots, 'claude') ? slots[role.engine] ?? {} : slots;
    const proposed = frozen({ roleId: input.roleId, stepId: input.stepId, round, engine: role.engine,
      prompt: input.prompt, cwd, access, instructions: input.instructions ?? role.prompt, requestedModel: role.model, nativeOptions,
      ...(role.engine === 'claude' ? { permissionMode: role.permissionMode } : {}),
      purpose: input.purpose ?? 'default', ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(input.inputValues === undefined ? {} : { inputValues: input.inputValues }),
    });
    const bindingKey = role.session === 'reuse' ? this.binding(proposed).key : null;
    const predecessor = bindingKey ? this.bindingJobs.get(bindingKey) : null;
    const job = (async () => {
      // Freeze the actual prompt after the preceding owner of this reusable
      // session has acknowledged its history. This also covers ready siblings.
      if (predecessor) await predecessor;
      this.alive();
      let descriptor = this.state.invocations[key];
      if (!descriptor) {
        const values = clone(proposed.inputValues);
        if (values && Array.isArray(values.history) && bindingKey) {
          const consumedSeq = this.state.bindings[bindingKey]?.consumedSeq ?? 0;
          values.history = values.history.filter(row => !Number.isSafeInteger(row?.seq) || row.seq > consumedSeq);
        }
        let acknowledgedHistorySeq;
        if (Array.isArray(values?.history) && Number.isSafeInteger(this.options.throughSeq) && this.options.throughSeq >= 0) {
          for (const row of values.history) {
            if (Number.isSafeInteger(row?.seq) && row.seq >= 0 && row.seq <= this.options.throughSeq) acknowledgedHistorySeq = Math.max(acknowledgedHistorySeq ?? 0, row.seq);
          }
        }
        descriptor = frozen({ ...proposed, ...(values ? { prompt: renderInputs(Object.keys(values), ref => values[ref]), inputValues: values } : {}),
          ...(acknowledgedHistorySeq === undefined ? {} : { acknowledgedHistorySeq }) });
        this.state.invocations[key] = clone(descriptor); this.notify();
      }
      // Older snapshots predate per-role modes and ran Claude with default.
      if (descriptor.engine === 'claude' && descriptor.permissionMode === undefined) descriptor = { ...descriptor, permissionMode: 'default' };
      return await this.invokeUntilSuccess(key, frozen(descriptor), input.validateResult);
    })();
    this.jobs.set(key, job);
    if (bindingKey) this.bindingJobs.set(bindingKey, job);
    return clone(await job);
  }
  async invokeUntilSuccess(key, descriptor, validateResult) {
    let previous = this.latestRuns().find(run => roleKey(run) === key);
    while (true) {
      this.alive();
      if (previous && previous.status !== 'completed') {
        if (!this.retries.delete(previous.id)) {
          const waiting = deferred(); this.waiters.set(previous.id, waiting);
          this.blockers.add(previous.id); this.notify();
          if (!this.retries.delete(previous.id)) await waiting.promise;
          this.waiters.delete(previous.id); this.retries.delete(previous.id); this.alive();
        }
      }
      const run = await this.attempt(descriptor, (previous?.attempt ?? 0) + 1, validateResult);
      if (run.status === 'completed') { this.state.cache.roles[key] = clone(run); this.notify(); return run; }
      previous = run;
    }
  }
  binding(descriptor) {
    const key = roleBindingKey({ template: this.options.template, ...descriptor });
    return { key, value: this.state.bindings[key] };
  }
  locksFor(descriptor) {
    if (this.options.template.roles[descriptor.roleId].session !== 'reuse') return [];
    const { key, value } = this.binding(descriptor);
    return [`binding:${key}`, ...(value?.sessionId ? [`session:${descriptor.engine}:${value.sessionId}`] : [])];
  }
  acquire(descriptor, signal) {
    const ready = deferred(); this.pending.push({ descriptor, signal, ...ready }); this.pump(); return ready.promise;
  }
  pump() {
    for (let index = 0; index < this.pending.length;) {
      const item = this.pending[index];
      if (this.stopping || item.signal.aborted) { this.pending.splice(index, 1); item.reject(stoppedError()); continue; }
      const locks = this.locksFor(item.descriptor);
      if (this.nativeCount >= this.options.template.limits.concurrency || locks.some(key => this.locks.has(key))) { index++; continue; }
      this.pending.splice(index, 1); this.nativeCount++; locks.forEach(key => this.locks.add(key));
      let released = false;
      item.resolve(() => { if (released) return; released = true; this.nativeCount--; locks.forEach(key => this.locks.delete(key)); this.pump(); });
    }
  }

  async attempt(descriptor, attempt, validateResult) {
    const { engine, roleId, stepId, round, requestedModel, cwd } = descriptor;
    const run = { id: randomUUID(), engine, roleId, stepId, attempt, round, status: 'queued', requestedModel, cwd,
      ...(engine === 'claude' ? { permissionMode: descriptor.permissionMode } : {}) };
    const active = { controller: new AbortController(), handle: null, finished: deferred(), permissions: new Set(), acknowledged: false };
    this.state.runs.push(run); this.active.set(run.id, active); this.notify();
    let release, summary;
    try {
      this.alive(); release = await this.acquire(descriptor, active.controller.signal); this.alive();
      if (active.controller.signal.aborted) throw stoppedError();
      run.status = 'running'; this.notify(); this.alive();
      const binding = this.binding(descriptor);
      const role = this.options.template.roles[roleId];
      if (binding.value && binding.value.engine !== engine) throw new Error('Native session binding engine does not match this role.');
      const guidance = this.state.guidance.map(entry => entry.text);
      active.handle = this.owner.runner.start({ ...clone(descriptor),
        ...(guidance.length ? { prompt: `${descriptor.prompt}\n\n[Additional user guidance]\n${guidance.join('\n\n')}` } : {}),
        runId: run.id, model: requestedModel,
        ...(role.session === 'reuse' && binding.value?.sessionId ? { nativeSessionId: binding.value.sessionId } : {}),
        signal: active.controller.signal,
        onEvent: event => this.nativeEvent(run, active, descriptor, event),
        onPermission: request => this.permission(run, active, request),
      });
      if (this.stopping || active.controller.signal.aborted) this.cancelNative(active);
      summary = await active.handle.done;
      if (active.interruption) await active.interruption;
      if (!summary || typeof summary !== 'object') throw new Error('Native role returned no result.');
      if (summary.nativeSessionId && summary.nativeSessionId !== run.nativeSessionId) this.nativeEvent(run, active, descriptor, { type: 'session', sessionId: summary.nativeSessionId });
      summary = clone(summary);
      if (active.controller.signal.aborted) summary.status = 'interrupted';
      if (summary.status === 'completed' && validateResult) {
        const validated = await validateResult(frozen(summary));
        for (const [key, value] of Object.entries(validated ?? {})) if (!resultFields.has(key)) summary[key] = clone(value);
      }
    } catch (error) {
      summary = { ...(summary ?? {}), status: this.stopping || active.controller.signal.aborted ? 'interrupted' : 'failed', error: errorText(error) };
    } finally {
      for (const permission of active.permissions) permission.abort();
      release?.();
    }
    const status = summary.status === 'completed' ? 'completed' : ['interrupted', 'cancelled'].includes(summary.status) ? summary.status : 'failed';
    // Runtime attribution cannot be overwritten by native/operation output.
    const { status: ignoredStatus, id: ignoredId, engine: ignoredEngine, roleId: ignoredRole, stepId: ignoredStep, attempt: ignoredAttempt, round: ignoredRound,
      requestedModel: ignoredModel, permissionMode: ignoredPermissionMode, cwd: ignoredCwd, ...publicResult } = summary;
    Object.assign(run, publicResult, { status });
    if (status !== 'completed' && !this.stopping) this.blockers.add(run.id);
    this.notify();
    this.emit(run, { type: 'result', ...clone(publicResult), status });
    this.active.delete(run.id); active.finished.resolve();
    return clone(run);
  }
  nativeEvent(run, active, descriptor, event) {
    if (this.terminal || settled.has(run.status)) return;
    // Only the scheduler's validated terminal result is published as completion.
    if (event.type === 'result') return;
    if (event.type === 'native-tasks' && run.engine === 'claude' && Array.isArray(event.nativeTasks)) run.nativeTasks = clone(event.nativeTasks);
    if (run.engine === 'claude' && event.type === 'permission-mode') run.actualPermissionMode = assertClaudePermissionMode(event.actualMode);
    if (event.type === 'session' && typeof event.sessionId === 'string' && event.sessionId) {
      run.nativeSessionId = event.sessionId;
      const { key, value } = this.binding(descriptor);
      this.state.bindings[key] = { ...value, engine: run.engine, sessionId: event.sessionId, consumedSeq: value?.consumedSeq ?? 0 };
    }
    if (event.type === 'input-acknowledged') active.acknowledged = true;
    if (active.acknowledged && Number.isSafeInteger(descriptor.acknowledgedHistorySeq) && descriptor.acknowledgedHistorySeq >= 0) {
      const { value } = this.binding(descriptor);
      if (value?.sessionId) value.consumedSeq = Math.max(value.consumedSeq ?? 0, descriptor.acknowledgedHistorySeq);
    }
    if (event.type === 'text-delta' && typeof event.delta === 'string') run.text = (run.text ?? '') + event.delta;
    this.emit(run, event);
  }
  emit(run, event) {
    const enriched = { ...clone(event), eventId: `${run.id}:${++this.seq}`, seq: this.seq, runId: run.id,
      engine: run.engine, roleId: run.roleId, stepId: run.stepId, attempt: run.attempt, round: run.round };
    this.state.events.push(enriched); this.notify();
    if (this.callbackError) return;
    try { this.owner.onEvent?.(clone(enriched)); } catch (error) { this.fatal(error); }
  }
  async permission(run, active, request) {
    const controller = new AbortController(); active.permissions.add(controller);
    const abort = () => controller.abort();
    active.controller.signal.addEventListener('abort', abort, { once: true }); request.signal?.addEventListener('abort', abort, { once: true });
    if (this.stopping || active.controller.signal.aborted || request.signal?.aborted) controller.abort();
    const cancelled = deferred(); controller.signal.addEventListener('abort', () => cancelled.resolve(undefined), { once: true });
    try {
      if (controller.signal.aborted) return undefined;
      run.status = 'awaitingApproval'; this.notify();
      return await Promise.race([cancelled.promise, Promise.resolve().then(() => {
        if (controller.signal.aborted) return undefined;
        return this.owner.onPermission?.({ ...request, runId: run.id, engine: run.engine, roleId: run.roleId, stepId: run.stepId,
          attempt: run.attempt, round: run.round, cwd: run.cwd, signal: controller.signal });
      })]);
    } catch (error) {
      // Native harnesses may catch a handler error and continue after denying
      // one request. A failed approval callback must stop the whole workflow.
      this.fatal(error);
      return undefined;
    } finally {
      active.permissions.delete(controller); active.controller.signal.removeEventListener('abort', abort); request.signal?.removeEventListener('abort', abort);
      if (run.status === 'awaitingApproval' && !active.permissions.size) { run.status = 'running'; this.notify(); }
    }
  }
}
