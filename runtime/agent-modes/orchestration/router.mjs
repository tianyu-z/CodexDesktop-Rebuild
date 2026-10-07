import { randomUUID } from 'node:crypto';
import { updateClaudeProgress, applyClaudeThinking } from '../claude-progress.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveParameters, resolveRoleConfig } from '../templates/schema.mjs';
import { assertClaudeModel } from '../claude-models.mjs';
import { CLAUDE_PERMISSION_MODES } from '../claude-permissions.mjs';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_PERMISSION_MODE } from '../claude-defaults.mjs';
import { createClaudeInteraction } from '../claude-interactions.mjs';
import { publicHistory, writeHistorySnapshot } from '../handoff.mjs';
import { claudeInputText, captureClaudeInput, readClaudeInputCapture } from '../claude-input.mjs';
import { presentItem, presentTurn, toolItem } from '../codex-events.mjs';

const clone = value => structuredClone(value);
const now = () => Math.floor(Date.now() / 1000);
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'blocked']);
const messageOf = error => error instanceof Error ? error.message : String(error);
const deny = request => {
  if (request.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (request.method === 'mcpServer/elicitation/request') return { action: 'decline' };
  if (request.method === 'item/tool/requestUserInput') return { answers: {} };
  if (['execCommandApproval', 'applyPatchApproval'].includes(request.method)) return { decision: 'denied' };
  return { decision: 'decline' };
};
async function abortable(promise, signal) {
  if (signal.aborted) throw new Error('Workflow interrupted.');
  let abort;
  try { return await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(new Error('Workflow interrupted.')); signal.addEventListener('abort', abort, { once: true }); })]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Transport and persistence for one public turn containing several native roles. */
export class WorkflowRouter {
  constructor(router, { templates, workflowFactory } = {}) {
    this.router = router; this.store = router.store; this.templates = templates; this.factory = workflowFactory;
    this.active = new Map(); this.approvals = new Map();
    this.registryPath = join(this.store.directory, 'internal-native-threads.json');
    this.internal = new Set(existsSync(this.registryPath) ? JSON.parse(readFileSync(this.registryPath, 'utf8')) : []);
    for (const chat of this.store.list()) for (const row of chat.turns) if (row.engine === 'both') for (const run of row.runs) if (run.engine === 'codex' && run.nativeSessionId) this.internal.add(run.nativeSessionId);
  }
  get available() { return !!this.templates && typeof this.factory === 'function'; }
  assertAvailable(params = {}) {
    if (!this.available || (!this.router.remote && params.hostId && params.hostId !== 'local')) throw new Error('Collaborative workflows require the selected host gateway; remote requests cannot run on the local gateway.');
  }
  registerInternal(id) {
    if (typeof id !== 'string' || !id || this.internal.has(id)) return;
    this.internal.add(id);
    const temp = `${this.registryPath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.internal]), { mode: 0o600 }); renameSync(temp, this.registryPath);
  }
  selection(params, current, { nativeModel = false } = {}) {
    this.assertAvailable(params);
    const supplied = params.engineModels;
    if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(key => !['codex', 'claude'].includes(key)))) throw new Error('Invalid engine model selection.');
    const models = { codex: null, claude: DEFAULT_CLAUDE_MODEL, ...current?.models, ...supplied };
    const resolved = params.collaborationMode?.settings?.model ?? params.model;
    if (nativeModel && resolved != null) models.codex = resolved;
    for (const model of Object.values(models)) if (model !== null) assertClaudeModel(model);
    const selected = params.template ?? current?.template ?? { id: 'polly', revision: 1, parameters: {} };
    if (!selected || typeof selected !== 'object' || Array.isArray(selected) || Object.keys(selected).some(key => !['id', 'revision', 'parameters'].includes(key))) throw new Error('Invalid template selection.');
    const template = this.templates.read(selected.id, selected.revision);
    if (!template) throw new Error(`Template not found: ${selected.id}`);
    const parameters = resolveParameters(template, selected.parameters ?? {});
    const sameTemplate = current?.template?.id === template.id && current?.template?.revision === template.revision;
    const overrides = params.roleOverrides === undefined ? (sameTemplate ? current?.roleOverrides ?? {} : {}) : params.roleOverrides;
    const effective = resolveRoleConfig(template, overrides, models, { claudePermissionMode: params.claudePermissionMode ?? current?.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE });
    return { models: clone(models), ...effective, parameters, selected: { id: template.id, revision: template.revision, parameters } };
  }
  templateRequest(method, params) {
    this.assertAvailable(params);
    switch (method) {
      case 'engine/templates/list': return { templates: this.templates.list() };
      case 'engine/templates/read': return { template: this.templates.read(params.id, params.revision) };
      case 'engine/templates/save': return { template: this.templates.save(params.template) };
      case 'engine/templates/delete': return { deleted: this.templates.remove(params.id) };
      case 'engine/templates/import': return { template: this.templates.import(params.text) };
      case 'engine/templates/export': return { text: this.templates.export(params.id, params.revision, params.format) };
      default: throw new Error(`Unknown template operation: ${method}`);
    }
  }
  read(id, turnId) {
    const chat = this.store.get(id);
    const latestTurnId = chat?.turns.at(-1)?.turn.id;
    return { workflows: (chat?.turns ?? []).filter(row => row.workflow && (!turnId || row.turn.id === turnId)).map(row => ({ turnId: row.turn.id, isLatestTurn: row.turn.id === latestTurnId, workflowId: row.workflow.id, status: row.workflow.status, config: row.workflow.config,
      runs: row.runs.map(child => {
        const activity = !terminal.has(child.status) && this.active.get(row.workflow.id)?.claudeProgress.get(child.id);
        return activity ? { ...child, activity: { ...activity, runId: child.id, turnId: row.turn.id } } : child;
      }), state: row.workflow.state })) };
  }
  progress(id) {
    const chat = this.store.has(id) ? this.store.require(id) : null, owner = this.active.get(chat?.activeTurn?.id);
    if (!owner || owner.controller.signal.aborted) return [];
    const row = chat.turns.find(row => row.workflow?.id === owner.id);
    return (row?.runs ?? []).filter(child => child.engine === 'claude' && !terminal.has(child.status) && owner.claudeProgress.has(child.id))
      .map(child => ({ runId: child.id, roleId: child.roleId, turnId: row.turn.id, activity: { ...owner.claudeProgress.get(child.id), runId: child.id, turnId: row.turn.id } }));
  }
  async start(id, params) {
    this.router.assertOpen();
    if (params.outputSchema || params.toolOutput) throw new Error('Output schema and tool continuations are controlled by the selected workflow template.');
    const publicInput = clone(params.input), input = claudeInputText(publicInput), chat = this.store.get(id);
    if (!statSync(chat.cwd).isDirectory()) throw new Error('Workflow workspace is not a directory.');
    const selected = this.selection(params, chat, { nativeModel: true });
    const idRun = `workflow:${randomUUID()}`, turnId = `workflow-turn:${randomUUID()}`;
    const turn = { id: turnId, status: 'inProgress', startedAt: now(), error: null, items: [{ id: `user:${randomUUID()}`, type: 'userMessage', content: publicInput, ...(params.clientUserMessageId ? { clientId: params.clientUserMessageId } : {}) }] };
    const nativeKeys = ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxPolicy', 'permissions', 'serviceTier', 'modelProvider', 'effort'];
    const nativeOptions = Object.fromEntries(nativeKeys.filter(key => params[key] !== undefined).map(key => [key, clone(params[key])]));
    nativeOptions.cwd = chat.cwd;
    nativeOptions.effort = params.collaborationMode?.settings?.reasoning_effort ?? nativeOptions.effort;
    const fullHistory = publicHistory(chat), historyPath = writeHistorySnapshot(this.store.directory, fullHistory);
    const history = chat.turns.map(row => ({ seq: row.seq, text: publicHistory({ turns: [row] }) }));
    let length = fullHistory.length, omitted = false;
    while (history.length > 1 && length > 60000) { length -= history.shift().text.length; omitted = true; }
    if (history[0] && (omitted || history[0].text.length > 60000)) history[0].text = `[Earlier public history: ${historyPath}]\n${history[0].text.slice(-60000)}`;
    const config = { mode: 'both', models: selected.models, roleOverrides: selected.roleOverrides, template: selected.template, parameters: selected.parameters,
      claudePermissionMode: params.claudePermissionMode === undefined ? chat.claudePermissionMode : params.claudePermissionMode,
      claudeWorkflowOptions: clone(chat.claudeWorkflowOptions ?? {}),
      nativeOptions, cwd: chat.cwd, input, history, throughSeq: chat.nextSeq - 1 };
    this.store.beginWorkflow(id, { id: idRun, turn, config });
    this.launch(id, idRun, turn, config);
    return { turn: presentTurn(turn, 'both'), engineState: this.router.state(id) };
  }
  launch(id, workflowId, turn, config, recovery = {}) {
    const run = { id: workflowId, threadId: id, turn: clone(turn), controller: new AbortController(), handle: null, claudeProgress: new Map() };
    this.active.set(workflowId, run);
    run.done = new Promise(resolve => setImmediate(resolve)).then(async () => {
      this.router.notify('thread/status/changed', { threadId: id, status: { type: 'active', activeFlags: [] } });
      this.router.notify('turn/started', { threadId: id, turn: presentTurn(run.turn, 'both') });
      let result, crashed = false;
      try {
        if (run.controller.signal.aborted) throw new Error('Workflow interrupted before startup.');
        const publicInput = run.turn.items.find(item => item.type === 'userMessage')?.content;
        if (!config.inputCapture && publicInput?.some(item => ['image', 'localImage'].includes(item.type))) {
          const inputCapture = await this.router.prepareInput(signal => captureClaudeInput(publicInput, { directory: this.store.directory, signal }), run.controller.signal);
          config = { ...config, inputCapture };
          const { value, row } = this.store.workflowRecord(id, workflowId);
          row.workflow.config = clone(config); this.store.save(value);
        }
        const chat = this.store.get(id);
        if (!chat.nativeMaterialized && !chat.turns.some(row => row.engine === 'codex')) {
          const inject = () => abortable(this.router.native.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }] }), run.controller.signal);
          try { await inject(); }
          catch (error) {
            // A restarted gateway can know the durable public ID without loading
            // its session. Fresh sessions, conversely, have no rollout to resume.
            if (!/thread not found/i.test(messageOf(error))) throw error;
            await abortable(this.router.native.request('thread/resume', { threadId: id, excludeTurns: true }), run.controller.signal);
            await inject();
          }
          const current = this.store.require(id); current.nativeMaterialized = true; this.store.save(current);
          if (!current.thread.name && config.input.trim()) await abortable(this.router.native.request('thread/name/set', { threadId: id, name: config.input.trim().slice(0, 80) }), run.controller.signal);
        }
        if (run.controller.signal.aborted || this.router.closed) throw new Error('Workflow interrupted before startup.');
        const scheduler = this.factory({ onEvent: event => this.event(run, event), onPermission: request => this.permission(run, request),
          loadInputCapture: (capture, { signal } = {}) => readClaudeInputCapture(capture, { directory: this.store.directory, signal }) });
        run.handle = scheduler.start({ ...clone(config), runId: workflowId, bindings: this.store.get(id).roleBindings, signal: run.controller.signal, onSnapshot: snapshot => this.snapshot(run, snapshot), ...recovery });
        result = await run.handle.done;
      } catch (error) { crashed = true; result = { status: run.controller.signal.aborted ? 'interrupted' : 'failed', error: messageOf(error) }; }
      this.cancelApprovals(workflowId);
      // If construction or a persistence callback failed, stop all owned children
      // before releasing this public turn's exclusive ownership.
      if (crashed && run.handle) await Promise.resolve(run.handle.interrupt()).catch(() => {});
      const row = this.store.workflowRecord(id, workflowId).row;
      for (const child of row.runs) if (!terminal.has(child.status)) this.store.putWorkflowRun(id, workflowId, { ...child, status: result.status === 'failed' ? 'failed' : 'interrupted' });
      const status = ['completed', 'failed', 'interrupted'].includes(result.status) ? result.status : 'failed';
      const finished = this.store.batch(id, () => {
        const finished = this.store.finishWorkflow(id, workflowId, status, { error: result.error });
        const chat = this.store.require(id);
        // Runs are stored in execution order. Only completed explicit native
        // transitions update future selections; initialization fallback and
        // unsuccessful runs do not change the frozen workflow or its retries.
        for (const child of finished.runs) {
          const permissionMode = child.settingsPatch?.permissionMode;
          if (child.status !== 'completed' || child.engine !== 'claude' ||
            finished.workflow.config.template.roles[child.roleId]?.engine !== 'claude' || !CLAUDE_PERMISSION_MODES.includes(permissionMode)) continue;
          chat.roleOverrides[child.roleId] = { ...chat.roleOverrides[child.roleId], permissionMode };
        }
        this.store.save(chat);
        return finished;
      });
      this.active.delete(workflowId);
      this.router.notify('turn/completed', { threadId: id, turn: presentTurn(finished.turn, 'both') });
      this.router.notify('thread/status/changed', { threadId: id, status: { type: 'idle' } });
    });
    return run;
  }
  snapshot(run, snapshot) {
    if (this.store.get(run.threadId)?.activeTurn?.id !== run.id) return;
    this.store.batch(run.threadId, () => {
      for (const child of snapshot.runs ?? []) {
        this.store.putWorkflowRun(run.threadId, run.id, child);
        if (child.engine === 'codex' && child.nativeSessionId) this.registerInternal(child.nativeSessionId);
      }
      for (const [key, binding] of Object.entries(snapshot.bindings ?? {})) this.store.setRoleBinding(run.threadId, key, binding);
      this.store.setWorkflowState(run.threadId, run.id, snapshot);
      const { value, row } = this.store.workflowRecord(run.threadId, run.id);
      row.workflow.status = snapshot.status; this.store.save(value);
    });
  }
  event(run, event) {
    if (!this.store.has(run.threadId) || this.store.require(run.threadId).activeTurn?.id !== run.id) return;
    if (event.engine === 'claude' && ['activity', 'token-usage'].includes(event.type)) {
      const child = this.store.workflowRecord(run.threadId, run.id).row.runs.find(child => child.id === event.runId);
      if (!child || child.engine !== 'claude' || terminal.has(child.status) || run.controller.signal.aborted) return;
      // Do not persist counters or put a snapshot in the workflow event log.
      const { eventId, seq, runId, engine, roleId, stepId, round, ...progress } = event;
      run.claudeProgress.set(child.id, updateClaudeProgress(run.claudeProgress.get(child.id), progress));
      return;
    }
    const history = this.store.workflowRecord(run.threadId, run.id).row.workflow.events;
    if (history.some(previous => previous.eventId === event.eventId && previous.runId === event.runId)) return;
    const notifications = [];
    const notify = (method, params) => notifications.push([method, params]);
    this.store.batch(run.threadId, () => {
      this.store.appendWorkflowEvent(run.threadId, run.id, event);
      if (event.type === 'agent-model') {
        const { value, row } = this.store.workflowRecord(run.threadId, run.id);
        (row.agentModels ??= {})[event.parentToolUseId] = event.model; this.store.save(value);
      }
      if (event.type === 'session' && event.engine === 'codex') this.registerInternal(event.sessionId);
      const source = { cdxEngineSource: event.engine, cdxRunId: event.runId, cdxRoleId: event.roleId, cdxStepId: event.stepId };
      const id = run.threadId, turn = run.turn;
      const update = (item, complete) => {
        item = { ...item, ...source };
        const index = turn.items.findIndex(current => current.id === item.id);
        if (index < 0) turn.items.push(item); else turn.items[index] = item;
        this.store.putTurn(id, turn, { engine: 'both', runId: run.id });
        if (index < 0) notify('item/started', { threadId: id, turnId: turn.id, item: presentItem(item, 'both') });
        if (complete) notify('item/completed', { threadId: id, turnId: turn.id, item: presentItem(item, 'both') });
      };
      applyClaudeThinking(event, { turn, update, threadId: id, source, notify, save: () => this.store.putTurn(id, turn, { engine: 'both', runId: run.id }) });
      if (event.type === 'message-start') update({ id: event.id, type: 'agentMessage', text: '', phase: 'commentary' }, false);
      if (event.type === 'message-completed') update({ id: event.id, type: 'agentMessage', text: event.text, phase: event.nativeItem?.phase ?? 'final_answer' }, true);
      if (event.type === 'text-delta') {
        let item = turn.items.find(item => item.id === event.id);
        if (!item) { update({ id: event.id, type: 'agentMessage', text: '', phase: 'commentary' }, false); item = turn.items.at(-1); }
        item.text += event.delta; this.store.putTurn(id, turn, { engine: 'both', runId: run.id });
        notify('item/agentMessage/delta', { threadId: id, turnId: turn.id, itemId: event.id, delta: event.delta, ...source });
      }
      if (['tool-start', 'tool-completed'].includes(event.type)) update(event.nativeItem ? { ...event.nativeItem, id: event.id } : toolItem(event, this.store.get(id).turns.find(row => row.workflow?.id === run.id)?.runs.find(child => child.id === event.runId)?.cwd ?? this.store.get(id).cwd), event.type === 'tool-completed');
    });
    // A failed snapshot must never be advertised as durable public output.
    for (const [method, params] of notifications) this.router.notify(method, params);
  }
  permission(run, request) {
    const child = this.store.get(run.threadId)?.turns.find(row => row.workflow?.id === run.id)?.runs.find(child => child.id === request.runId);
    if (!child || child.engine !== request.engine || terminal.has(child.status) || run.controller.signal.aborted || request.signal?.aborted) return Promise.resolve(deny(request));
    let interaction;
    if (request.engine === 'claude') {
      try { interaction = createClaudeInteraction(request); }
      catch (error) { return Promise.resolve({ decision: 'decline', message: messageOf(error) }); }
    }
    const id = `workflow-approval:${randomUUID()}`;
    return new Promise(resolve => {
      const finish = result => {
        if (!this.approvals.delete(id)) return;
        request.signal?.removeEventListener('abort', cancel); run.controller.signal.removeEventListener('abort', cancel);
        this.router.notify('serverRequest/resolved', { threadId: run.threadId, requestId: id }); resolve(result);
      };
      const cancel = () => finish(deny(request));
      this.approvals.set(id, { run, request, finish, interaction });
      request.signal?.addEventListener('abort', cancel, { once: true }); run.controller.signal.addEventListener('abort', cancel, { once: true });
      const base = { threadId: run.threadId, turnId: run.turn.id, itemId: request.id, cdxRunId: child.id, cdxRoleId: child.roleId, cdxEngineSource: child.engine };
      if (request.engine === 'codex') this.router.emit({ id, method: request.method, params: { ...request.params, ...base, itemId: request.params?.itemId ? `${child.id}:${request.params.itemId}` : request.id, reason: `${child.engine} · ${child.roleId}${request.params?.reason ? `: ${request.params.reason}` : ''}` } });
      else this.router.emit({ id, method: interaction.method, params: { ...base, ...interaction.params } });
    });
  }
  respond(message) {
    const pending = this.approvals.get(message.id);
    if (!pending) return typeof message.id === 'string' && message.id.startsWith('workflow-approval:');
    const { request, run } = pending;
    const child = this.store.get(run.threadId)?.turns.find(row => row.workflow?.id === run.id)?.runs.find(child => child.id === request.runId);
    if (!child || child.engine !== request.engine || terminal.has(child.status) || run.controller.signal.aborted || request.signal?.aborted || message.error) { pending.finish(deny(request)); return true; }
    if (request.engine === 'codex') pending.finish(message.result ?? deny(request));
    else pending.finish(pending.interaction.respond(message.result));
    return true;
  }
  cancelApprovals(workflowId, roleId) { for (const pending of this.approvals.values()) if (pending.run.id === workflowId && (!roleId || pending.request.runId === roleId)) pending.finish(deny(pending.request)); }
  async interrupt(id, turnId, roleId) {
    const current = this.store.get(id)?.activeTurn, run = this.active.get(current?.id);
    if (!run || run.turn.id !== turnId) throw new Error('Workflow turn ownership mismatch.');
    if (roleId && !this.store.workflowRecord(id, run.id).row.runs.some(child => child.id === roleId)) throw new Error('Role ownership mismatch.');
    this.cancelApprovals(run.id, roleId);
    if (!roleId) run.controller.abort();
    await run.handle?.interrupt(roleId);
    if (!roleId) await run.done;
    return {};
  }
  async retry(id, turnId, roleId) {
    const chat = this.store.get(id), row = chat?.turns.find(row => row.turn.id === turnId && row.workflow);
    if (!row) throw new Error('Workflow turn ownership mismatch.');
    if (row.historyDetached) throw new Error('This workflow is a history snapshot. Send a new message to run it again.');
    const latest = new Map();
    const key = child => JSON.stringify([child.stepId, child.roleId, child.round]);
    for (const run of row.runs) if ((latest.get(key(run))?.attempt ?? 0) < run.attempt) latest.set(key(run), run);
    const child = row?.runs.find(run => run.id === roleId);
    if (roleId !== undefined && (!child || !['failed', 'interrupted', 'cancelled', 'blocked'].includes(child.status) || latest.get(key(child))?.id !== roleId)) throw new Error('Only the latest unsuccessful owned role can be retried.');
    if (roleId === undefined && [...latest.values()].some(run => run.status !== 'completed')) throw new Error('Choose an unsuccessful role to retry before continuing the workflow.');
    const active = this.active.get(row.workflow.id);
    if (active) {
      if (roleId === undefined || !active.handle || active.handle.retry(roleId) === false) throw new Error('This role attempt is not waiting for retry.');
      return {};
    }
    this.assertAvailable();
    this.store.resumeWorkflow(id, row.workflow.id);
    // Stop/materialization failure can precede the scheduler's first snapshot.
    // Resume that zero-role workflow from its frozen config, without inventing
    // an incomplete recovery snapshot that lacks the scheduler ID and caches.
    const recovery = row.workflow.state ? { previousSnapshot: { ...row.workflow.state, runs: row.runs } } : {};
    this.launch(id, row.workflow.id, this.store.workflowRecord(id, row.workflow.id).row.turn, row.workflow.config, { ...recovery, ...(roleId === undefined ? { resume: true } : { retryRunId: roleId }) });
    return {};
  }
  async close() { await Promise.all([...this.active.values()].map(run => this.interrupt(run.threadId, run.turn.id))); }
}
