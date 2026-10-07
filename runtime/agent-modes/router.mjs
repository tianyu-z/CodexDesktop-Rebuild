import { randomUUID } from 'node:crypto';
import { updateClaudeProgress, applyClaudeThinking } from './claude-progress.mjs';
import { writeFileSync, statSync, realpathSync } from 'node:fs';
import { assertMode } from './store.mjs';
import { WorkflowRouter } from './orchestration/router.mjs';
import { buildHandoff, publicHistory, writeHistorySnapshot } from './handoff.mjs';
import { claudeInputText, claudeInputContent, isClaudeCommandInput } from './claude-input.mjs';
import { page, presentItem, presentTurn, toolItem } from './codex-events.mjs';
import { assertClaudeModel } from './claude-models.mjs';
import { assertClaudePermissionMode } from './claude-permissions.mjs';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CLAUDE_PERMISSION_MODE } from './claude-defaults.mjs';
import { normalizeClaudeSessionOptions } from './claude-native-controls.mjs';
import { createClaudeInteraction } from './claude-interactions.mjs';
import { ClaudeCommandRouter } from './claude-command-router.mjs';
import { liveClaudeControl } from './claude-live-controls.mjs';
import { steerManagedTurn } from './steering.mjs';
import { validateRoleOverrides } from './templates/schema.mjs';
import { editManagedHistory, recoverHistoryEdit } from './history.mjs';
import { restoreLegacyResumePermissions } from './legacy-permission-resume.mjs';
import { prepareClaudeEffort } from './claude-effort-selection.mjs';
import { readAgentMap } from './agent-map.mjs';

const now = () => Math.floor(Date.now() / 1000);
const messageOf = error => error instanceof Error ? error.message : String(error);
const nativeParams = params => { const { engineMode, engineModel, engineModels, template, roleOverrides, claudePermissionMode, claudeActualPermissionMode, claudeCommandTarget, claudeEffort, skipAutoTitleGeneration, ...rest } = params; return rest; };
const deny = () => ({ decision: 'decline' });

export class EngineRouter {
  constructor({ store, native, adapter, emit, templates, workflowFactory }) {
    Object.assign(this, { store, native, adapter, emit });
    this.runs = new Map(); this.approvals = new Map(); this.locks = new Map(); this.closed = false;
    this.nativeTurnRevisions = new Map(); this.nativeNameRevisions = new Map(); this.pagedHistoryHydrated = new Set();
    this.workflow = new WorkflowRouter(this, { templates, workflowFactory });
    this.claudeCommands = new ClaudeCommandRouter(this);
  }
  assertOpen() { if (this.closed) throw new Error('Engine gateway is shutting down.'); }
  async prepareInput(prepare, signal) {
    this.assertOpen(); signal.throwIfAborted();
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('Input preparation interrupted.'));
      signal.addEventListener('abort', abort, { once: true });
    });
    // A cloud-backed open may not settle promptly. Stop releases the owned turn
    // now; Promise.race still drains late rejection, and the reader closes its
    // descriptor after seeing this same aborted signal.
    const preparing = Promise.resolve().then(() => { signal.throwIfAborted(); return prepare(signal); });
    try {
      const result = await Promise.race([preparing, interrupted]);
      signal.throwIfAborted(); this.assertOpen();
      return result;
    } finally { signal.removeEventListener('abort', abort); }
  }
  state(id) {
    const value = this.store.get(id);
    const claudeRun = this.runs.get(value?.activeRun?.id);
    let claudeSessionOptions = {};
    try { if (value && ['claude', 'both'].includes(value.mode)) claudeSessionOptions = this.claudeCommands.context(id).claudeOptions; }
    catch { /* Codex-only templates and unavailable role contexts have no Claude selection. */ }
    const claudeActiveRuns = (value?.turns.find(row => row.turn.id === value?.activeRun?.turnId)?.runs ?? []).filter(run => run.engine === 'claude' && run.roleId && ['running', 'awaitingApproval'].includes(run.status)).map(({ id, roleId, stepId, round }) => ({ id, roleId, stepId, round }));
    return { threadId: id, engineMode: value?.mode ?? 'codex', models: value?.models ?? { codex: null, claude: DEFAULT_CLAUDE_MODEL }, busy: !!value?.activeRun,
      claudePermissionMode: value?.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE, claudeActualPermissionMode: value?.claudeActualPermissionMode ?? null,
      claudeCommandTarget: value?.claudeCommandTarget ?? null,
      claudeWorkflowOptions: value?.claudeWorkflowOptions ?? {},
      claudeSessionOptions,
      claudeActivity: claudeRun ? { ...claudeRun.activity, turnId: claudeRun.turn.id, runId: claudeRun.id } : null,
      claudeRoleActivities: this.workflow.progress(id),
      claudeActiveRuns, claudeCommandRunId: claudeActiveRuns.some(run => run.id === value?.claudeCommandRunId) ? value.claudeCommandRunId : null,
      claudeClientActions: (value?.claudeClientActions ?? []).map(({ id, type, roleId }) => ({ id, type, roleId })),
      claudeRoleActualPermissionModes: Object.fromEntries((value?.turns ?? []).flatMap(row => row.runs ?? []).filter(run => run.engine === 'claude' && run.roleId && run.actualPermissionMode).map(run => [run.roleId, run.actualPermissionMode])),
      engines: ['codex', 'claude'], bothAvailable: this.workflow.available, roleOverrides: value?.roleOverrides ?? {}, template: value?.template ?? { id: 'polly', revision: 1, parameters: {} }, turnEngines: Object.fromEntries((value?.turns ?? []).map(row => [row.turn.id, row.engine])) };
  }
  saveClaudeEffort(id, options) {
    if (options === undefined) return;
    const chat = this.store.require(id);
    if (chat.mode === 'both') { chat.claudeWorkflowOptions = options; this.store.save(chat); }
    else this.store.setBinding(id, 'claude', { claudeOptions: options });
  }
  notify(method, params) { this.emit({ method, params }); }
  async interruptManagedTurn(id, turnId) {
    const value = this.store.require(id), active = value.activeRun;
    // Older clients could activate a native goal during a managed turn. The
    // visible turn can then be native while the gateway still owns Claude.
    // Only accept a live turn recorded in this chat; stale/arbitrary IDs fail.
    const nativeTurns = value.turns.filter(row => row.engine === 'codex' && row.turn.status === 'inProgress').map(row => row.turn.id);
    if (turnId !== active.turnId && !nativeTurns.includes(turnId)) throw new Error('Turn ownership mismatch.');
    const stopManaged = async () => {
      if (active.mode === 'both') return this.workflow.interrupt(id, active.turnId);
      const run = this.runs.get(active.id);
      run.controller.abort(); this.cancelApprovals(active.id);
      if (run.adapterRun) await run.adapterRun.interrupt();
      await run.done;
    };
    const results = await Promise.allSettled([
      stopManaged(),
      ...nativeTurns.map(nativeTurnId => this.native.request('turn/interrupt', { threadId: id, turnId: nativeTurnId })),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return {};
  }
  request(method, params = {}) {
    const id = params.threadId;
    // Read-only catalog discovery can wait on a subprocess. It must not queue
    // a user's interrupt or next submission behind that independent work.
    if (!id || ['engine/capabilities', 'engine/claude/commands', 'engine/agents/read', 'turn/interrupt', 'engine/runs/interrupt'].includes(method)) return this.dispatch(method, params);
    // Reserve submission before awaiting native I/O. Approval responses use the
    // separate response path and cannot deadlock behind a pending turn request.
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.dispatch(method, params));
    this.locks.set(id, task);
    task.finally(() => { if (this.locks.get(id) === task) this.locks.delete(id); }).catch(() => {});
    return task;
  }
  async readNativeThread(id) {
    let result;
    try { result = await this.native.request('thread/read', { threadId: id, includeTurns: true }); }
    catch (error) {
      if (!/paginated|full.history|includeTurns|list_turns is not supported yet/i.test(messageOf(error))) throw error;
      result = await this.native.request('thread/read', { threadId: id, includeTurns: false });
    }
    const thread = structuredClone(result.thread);
    // Side chats can inherit paginated metadata from a persistent fork, but
    // ephemeral threads have no pageable history. Keep their streamed turns.
    if (!thread.ephemeral && (thread.historyMode === 'paginated' || !Array.isArray(thread.turns))) {
      thread.turns = [];
      let cursor; const visited = new Set();
      do {
        let result;
        try { result = await this.native.request('thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) }); }
        catch (error) {
          if (/not materialized|before first user message|list_turns is not supported yet/.test(messageOf(error)) && !this.store.get(id)?.turns.some(row => row.engine === 'codex' && !row.nativeDetached)) break;
          throw error;
        }
        thread.turns.push(...result.data); cursor = result.nextCursor;
        if (cursor && visited.has(cursor)) throw new Error('Native history pagination repeated its cursor.');
        visited.add(cursor);
      } while (cursor);
    }
    return thread;
  }
  async hydrate(id) {
    const revisions = new Map(this.nativeTurnRevisions.get(id));
    const nameRevision = this.nativeNameRevisions.get(id) ?? 0;
    const thread = await this.readNativeThread(id);
    recoverHistoryEdit(this, id, thread);
    // Notifications can arrive during any page of this snapshot. Keep the newer
    // live version of those turns, including deltas on still-running turns.
    thread.turns = (thread.turns ?? [])
      .filter(turn => (revisions.get(turn.id) ?? 0) === (this.nativeTurnRevisions.get(id)?.get(turn.id) ?? 0))
      .map(turn => this.cleanNativeTurn(id, turn));
    if (nameRevision !== (this.nativeNameRevisions.get(id) ?? 0)) thread.name = this.store.get(id)?.thread.name;
    this.store.ensureThread(thread);
    // A native session already contains its own pre-existing history.
    const value = this.store.get(id);
    if (!value.turns.some(row => row.engine !== 'codex' || row.nativeDetached)) this.store.setBinding(id, 'codex', { consumedSeq: Math.max(0, ...value.turns.map(row => row.seq)) });
    this.pagedHistoryHydrated.add(id);
    return this.store.get(id);
  }
  cleanNativeTurn(id, turn) {
    const value = this.store.get(id);
    const input = value?.turns.find(row => row.turn.id === turn.id)?.originalInput ??
      (value?.activeRun?.engine === 'codex' && (value.activeRun.turnId === turn.id || (value.activeRun.turnId == null && !value.turns.some(row => row.turn.id === turn.id))) ? value.activeRun.originalInput : null);
    const cleaned = structuredClone(turn);
    if (input) {
      const row = value?.turns.find(row => row.turn.id === turn.id);
      const item = row?.firstUserItemId ? cleaned.items.find(item => item.id === row.firstUserItemId) : cleaned.items.find(item => item.type === 'userMessage');
      if (item) item.content = structuredClone(input);
    }
    return cleaned;
  }
  rememberNativeTurn(id, turn) {
    const value = this.store.require(id), active = value.activeRun;
    const existing = value.turns.find(row => row.turn.id === turn.id);
    if (existing && existing.turn.status !== 'inProgress' && turn.status === 'inProgress') return structuredClone(existing);
    const row = this.store.putTurn(id, this.cleanNativeTurn(id, turn), { engine: 'codex', runId: active?.id ?? turn.id });
    if (active?.engine === 'codex') {
      const stored = value.turns.find(row => row.turn.id === turn.id);
      stored.originalInput ??= active.originalInput;
      stored.firstUserItemId ??= turn.items.find(item => item.type === 'userMessage')?.id;
      active.turnId = turn.id;
      if (turn.items.some(item => item.type === 'userMessage')) active.acknowledgedSeq = row.seq;
      this.store.save(value);
    }
    return row;
  }
  thread(id, { includeTurns = true } = {}) {
    const value = this.store.get(id);
    return { ...value.thread, cwd: value.cwd, historyMode: 'legacy', status: value.activeRun ? { type: 'active', activeFlags: [] } : { type: 'idle' },
      turns: includeTurns ? value.turns.map(row => presentTurn(row.turn, row.engine)) : [], engineState: this.state(id) };
  }
  pageTurns(rows, params) {
    const unloaded = params.itemsView === 'notLoaded';
    const entries = rows.map(row => ({ key: row.turn.id, value: row.turn, engine: row.engine }));
    return page(entries, params, 'turns', {
      present: row => presentTurn(row.value, row.engine, params.itemsView),
      measure: row => Buffer.byteLength(JSON.stringify(unloaded ? { ...row.value, items: [] } : row.value)) + 128 * (unloaded ? 1 : (row.value.items?.length ?? 0) + 1),
    });
  }
  pageItems(rows, params) {
    const entries = rows.filter(row => !params.turnId || row.turn.id === params.turnId).flatMap(row => row.turn.items.map(item => ({ key: `${row.turn.id}/${item.id}`, value: item, turnId: row.turn.id, engine: row.engine })));
    return page(entries, params, 'items', {
      present: row => ({ turnId: row.turnId, item: presentItem(row.value, row.engine) }),
      measure: row => Buffer.byteLength(JSON.stringify(row.value)) + Buffer.byteLength(row.turnId) + 128,
    });
  }
  async dispatch(method, params) {
    this.assertOpen();
    if (params.claudePermissionMode !== undefined) assertClaudePermissionMode(params.claudePermissionMode);
    if (params.roleOverrides !== undefined) validateRoleOverrides(params.roleOverrides);
    const id = params.threadId;
    if (method === 'thread/goal/set' && (params.status == null || params.status === 'active') && this.store.get(id)?.mode !== undefined && this.store.get(id).mode !== 'codex') {
      throw new Error('Native /goal requires Only Codex. Remove /goal to send a regular turn to the selected engine.');
    }
    if (id && this.store.has(id) && this.store.require(id).pendingHistoryEdit && !['engine/capabilities', 'engine/claude/commands', 'turn/interrupt', 'engine/runs/interrupt'].includes(method)) await this.hydrate(id);
    if (id && this.workflow.internal.has(id)) throw new Error('Internal workflow sessions are not public chats.');
    if (id && this.store.has(id) && ['thread/turns/list', 'thread/items/list'].includes(method)) {
      if (!this.pagedHistoryHydrated.has(id)) await this.hydrate(id);
      const rows = this.store.require(id).turns;
      return method === 'thread/turns/list' ? this.pageTurns(rows, params) : this.pageItems(rows, params);
    }
    if (method === 'engine/agents/read') return readAgentMap(this, params);
    if (method === 'engine/claude/commands') return this.claudeCommands.list(params);
    if (method === 'engine/claude/client-action/claim') return this.claudeCommands.claim(id, params.actionId);
    if (method === 'engine/claude/control') return liveClaudeControl(this, method, params);
    if (method === 'engine/claude/target/set') {
      const chat = this.store.require(id);
      if (chat.mode !== 'both') throw new Error('Claude command role selection requires multi-agent mode.');
      const selected = chat.activeRun?.mode === 'both' ? { template: chat.turns.find(row => row.turn.id === chat.activeRun.turnId).workflow.config.template } : this.workflow.selection({}, chat);
      const target = this.claudeCommands.selection(params, chat, selected);
      if (params.runId && !this.state(id).claudeActiveRuns.some(run => run.roleId === target && run.id === params.runId)) throw new Error('Select an active task owned by this Claude role.');
      chat.claudeCommandTarget = target; chat.claudeCommandRunId = params.runId ?? null;
      this.store.save(chat); return this.state(id);
    }
    if (method.startsWith('engine/templates/')) return this.workflow.templateRequest(method, params);
    if (method.startsWith('engine/runs/')) {
      this.workflow.assertAvailable(params);
      if (!this.store.get(id)) await this.hydrate(id);
      if (method === 'engine/runs/read') return this.workflow.read(id, params.turnId);
      if (method === 'engine/runs/interrupt') return this.workflow.interrupt(id, params.turnId, params.runId);
      if (method === 'engine/runs/retry') return this.workflow.retry(id, params.turnId, params.runId);
      throw new Error(`Unknown workflow operation: ${method}`);
    }
    if (method === 'engine/capabilities') {
      let claudeModels = [], modelListError = null, modelCatalog = null;
      try {
        let cwd = id ? this.store.get(id)?.cwd : params.cwd;
        if (id && !cwd) cwd = (await this.native.request('thread/read', { threadId: id, includeTurns: false })).thread.cwd;
        const options = { cwd, refresh: params.refresh === true };
        if (typeof this.adapter.listModelCatalog === 'function') {
          const { models, ...metadata } = await this.adapter.listModelCatalog(options);
          claudeModels = models;
          modelCatalog = metadata;
          modelListError = metadata.warning ?? null;
        } else claudeModels = await this.adapter.listModels(options);
      } catch {
        // Provider/native error text can contain credentials; keep it out of UI
        // metadata, and let users continue with a saved model while retrying.
        modelListError = 'Could not load Claude models. Refresh models to retry.';
      }
      const bothAvailable = this.workflow.available && (this.remote || !params.hostId || params.hostId === 'local');
      return { engines: ['codex', 'claude'], claudeEffortSelection: true, claudeWorkflowEffortSelection: true, bothAvailable, ...(bothAvailable ? { templateSchemaVersion: 2, workflowVersion: 2 } : { bothUnavailableReason: 'Collaborative workflows require the native engine gateway on the selected host.' }), claudeModels, modelListError, modelCatalog, localOnly: !this.remote };
    }
    if (params.engineModel !== undefined && (params.engineMode === 'claude' || (params.engineMode == null && id && this.store.get(id)?.mode === 'claude'))) assertClaudeModel(params.engineModel);
    if (method === 'engine/turns/read') { if (!this.store.get(id)) await this.hydrate(id); return { turns: this.state(id).turnEngines }; }
    if (method === 'engine/mode/read') { if (!this.store.get(id)) await this.hydrate(id); return this.state(id); }
    if (method === 'engine/mode/set') {
      assertMode(params.engineMode);
      if (this.store.get(id)?.activeRun) throw new Error('Finish or interrupt the active run before switching engines.');
      await this.hydrate(id);
      const selected = params.engineMode === 'both' ? this.workflow.selection(params, this.store.get(id)) : null;
      const commandTarget = this.claudeCommands.selection(params, this.store.get(id), selected);
      const effortOptions = await prepareClaudeEffort(this.adapter, params, this.store.get(id), selected);
      this.store.batch(id, () => {
        this.store.setMode(id, params.engineMode, { ...(selected ? { models: selected.models, template: selected.selected, roleOverrides: selected.roleOverrides } : { model: params.engineModel }), claudePermissionMode: params.claudePermissionMode });
        this.saveClaudeEffort(id, effortOptions);
        if (commandTarget !== undefined) { const chat = this.store.require(id); chat.claudeCommandTarget = commandTarget; this.store.save(chat); }
      });
      return this.state(id);
    }
    if (method === 'thread/start') {
      assertMode(params.engineMode ?? 'codex');
      const selected = params.engineMode === 'both' ? this.workflow.selection(params, null, { nativeModel: true }) : null;
      const commandTarget = this.claudeCommands.selection(params, null, selected);
      const effortOptions = await prepareClaudeEffort(this.adapter, params, undefined, selected);
      const clean = nativeParams(params);
      if (params.engineMode === 'claude') delete clean.model;
      const result = await this.native.request(method, clean);
      this.store.ensureThread(result.thread, { mode: params.engineMode ?? 'codex', claudePermissionMode: params.claudePermissionMode });
      const value = this.store.require(result.thread.id);
      value.models.codex = result.model ?? null;
      if (params.engineModel && value.mode === 'claude') value.models.claude = params.engineModel;
      if (commandTarget !== undefined) value.claudeCommandTarget = commandTarget;
      this.store.save(value);
      this.saveClaudeEffort(value.id, effortOptions);
      if (selected) this.store.setMode(value.id, 'both', { models: selected.models, template: selected.selected, roleOverrides: selected.roleOverrides });
      return { ...result, thread: this.thread(value.id), engineState: this.state(value.id) };
    }
    if (method === 'turn/start') {
      if (!this.store.get(id)) await this.hydrate(id);
      if (params.claudeEffort !== undefined && this.store.get(id)?.activeRun) throw new Error('Finish or interrupt the active run before changing Claude effort.');
      if (params.engineMode) assertMode(params.engineMode);
      const current = this.store.get(id), mode = params.engineMode ?? current.mode;
      let selected = mode === 'both' && !current.activeRun ? this.workflow.selection(params, current, { nativeModel: true }) : null;
      const effortOptions = current.activeRun ? undefined : await prepareClaudeEffort(this.adapter, params, current, selected);
      if (params.engineMode) {
        if (params.engineMode === 'both') selected ??= this.workflow.selection(params, this.store.get(id));
        if (params.engineMode !== this.store.get(id).mode) {
          await this.hydrate(id);
          this.store.setMode(id, params.engineMode, { ...(selected ? { models: selected.models, template: selected.selected, roleOverrides: selected.roleOverrides } : { model: params.engineModel }), claudePermissionMode: params.claudePermissionMode });
        }
      }
      const value = this.store.require(id);
      this.assertOpen();
      if (value.activeRun) {
        if (value.activeRun.engine === 'codex' && value.mode === 'codex') return this.native.request(method, nativeParams(params));
        if (isClaudeCommandInput(params.input)) return liveClaudeControl(this, method, params);
        throw new Error('An engine workflow is active. Stop it before submitting another turn.');
      }
      if ((value.mode !== 'codex' || value.turns.some(row => row.engine !== 'codex')) && params.cwd && realpathSync(params.cwd) !== realpathSync(value.cwd)) throw new Error('Changing workspace inside a managed chat is not supported. Create a new chat in that workspace.');
      if (value.mode === 'both') {
        selected ??= this.workflow.selection(params, value);
        const target = this.claudeCommands.selection(params, value, selected);
        this.store.setMode(id, 'both', { models: selected.models, template: selected.selected, roleOverrides: selected.roleOverrides });
        if (target !== undefined) { value.claudeCommandTarget = target; this.store.save(value); }
      }
      if ((params.engineModel && value.mode === 'claude') || params.claudePermissionMode !== undefined) this.store.setMode(id, value.mode, { ...(value.mode === 'claude' ? { model: params.engineModel } : {}), claudePermissionMode: params.claudePermissionMode });
      if (value.mode !== 'codex') {
        this.saveClaudeEffort(id, effortOptions);
        const command = await this.claudeCommands.prepare(id, params);
        this.assertOpen();
        if (command) return this.startClaude(id, params, command);
      }
      if (value.mode === 'both') return this.workflow.start(id, params);
      if (value.mode === 'claude') return this.startClaude(id, params);
      return this.startCodex(id, params);
    }
    if (method === 'turn/steer' && this.store.get(id)?.mode !== 'codex' && this.store.get(id)?.activeRun && isClaudeCommandInput(params.input)) return liveClaudeControl(this, method, params);
    if (method === 'turn/steer' && ['claude', 'both'].includes(this.store.get(id)?.mode)) return steerManagedTurn(this, params);
    if (method === 'turn/interrupt' && (this.store.get(id)?.activeTurn?.mode === 'both' || this.store.get(id)?.activeRun?.engine === 'claude')) return this.interruptManagedTurn(id, params.turnId);
    const value = id && this.store.get(id);
    if ((value?.activeRun?.engine === 'claude' || value?.activeTurn?.mode === 'both') && ['thread/delete', 'thread/archive', 'thread/stop'].includes(method)) throw new Error('Finish or interrupt the active engine run before this action.');
    if (method === 'thread/read' || method === 'thread/resume') {
      const clean = method === 'thread/resume'
        ? await restoreLegacyResumePermissions(this.native, nativeParams(params)) : nativeParams(params);
      if (value && method === 'thread/read') clean.includeTurns = false;
      if (value && method === 'thread/resume') clean.excludeTurns = true;
      if (value?.mode === 'claude' || value?.mode === 'both') delete clean.model;
      const result = await this.native.request(method, clean);
      if (result.thread?.id && (value || this.store.get(result.thread.id))) {
        if (value && result.thread.id !== id) throw new Error('Resuming managed history into another thread is unsupported.');
        await this.hydrate(result.thread.id);
        return { ...result, ...(value?.mode === 'both' && value.models.codex ? { model: value.models.codex } : {}), thread: this.thread(result.thread.id, { includeTurns: method === 'thread/resume' ? !params.excludeTurns : params.includeTurns === true }),
          initialTurnsPage: params.initialTurnsPage ? this.pageTurns(this.store.require(result.thread.id).turns, { ...params.initialTurnsPage, threadId: result.thread.id }) : null, turnsBackwardsCursor: null, itemsBackwardsCursor: null, engineState: this.state(result.thread.id) };
      }
      return result;
    }
    if (value && (value.mode !== 'codex' || value.turns.some(row => row.engine !== 'codex' || row.nativeDetached) || value.discardedNativeTurnIds?.length) && ['thread/fork', 'thread/rollback', 'thread/revert'].includes(method)) return editManagedHistory(this, method, params);
    if (value && value.mode !== 'codex' && /^(turn\/(steer|tool)|thread\/(compact|realtime|startAeon|inject_items|shellCommand)|review\/)/.test(method)) throw new Error(`${method} is unavailable in ${value.mode === 'both' ? 'dual workflow' : 'Claude Code'} mode.`);
    const result = await this.native.request(method, nativeParams(params));
    if (value && ['thread/rollback', 'thread/revert', 'thread/delete'].includes(method)) {
      this.store.remove(id); this.pagedHistoryHydrated.delete(id);
      if (method !== 'thread/delete') { if (result.thread) this.store.ensureThread(result.thread); else await this.hydrate(id); }
    }
    if (method === 'thread/list' || method === 'thread/search') {
      const isPublic = entry => !this.workflow.internal.has(method === 'thread/search' ? entry.thread.id : entry.id);
      let visible = result.data.filter(isPublic);
      const visited = new Set(), limit = params.limit ?? 50;
      while (visible.length < limit && result.nextCursor) {
        if (visited.has(result.nextCursor)) throw new Error('Native thread pagination repeated its cursor.');
        visited.add(result.nextCursor);
        const next = await this.native.request(method, { ...nativeParams(params), cursor: result.nextCursor, limit: limit - visible.length });
        visible.push(...next.data.filter(isPublic));
        result.nextCursor = next.nextCursor;
      }
      result.data = method === 'thread/search' ? visible : visible.map(thread => {
      if (!this.store.get(thread.id)) return thread;
      this.store.mergeNativeThread(thread);
      return { ...thread, ...this.thread(thread.id, { includeTurns: false }) };
      });
    }
    return result;
  }
  handoff(id, engine) {
    const value = this.store.get(id);
    const history = publicHistory(value);
    // Keep legacy references accurate for existing sessions; new prompts always
    // use an immutable snapshot, including after a conversation is forked.
    writeFileSync(this.store.path(id).replace(/\.json$/, '.history.txt'), history, { mode: 0o600 });
    const historyPath = writeHistorySnapshot(this.store.directory, history);
    return buildHandoff(value, engine, { historyPath });
  }
  async startCodex(id, params) {
    this.assertOpen();
    const model = params.collaborationMode?.settings?.model ?? params.model;
    if (model != null) this.store.setMode(id, 'codex', { models: { codex: model } });
    const handoff = this.handoff(id, 'codex');
    const runId = randomUUID();
    this.store.beginRun(id, { id: runId, engine: 'codex', turnId: null, originalInput: handoff.text ? params.input : undefined });
    const clean = nativeParams(params);
    if (handoff.text) clean.input = [{ type: 'text', text: `${handoff.text}\n\n[Current user request follows]` }, ...params.input];
    const revisions = new Map(this.nativeTurnRevisions.get(id));
    try {
      const result = await this.native.request('turn/start', clean);
      let turn = result.turn;
      if ((revisions.get(turn.id) ?? 0) !== (this.nativeTurnRevisions.get(id)?.get(turn.id) ?? 0)) {
        const latest = this.store.get(id).turns.find(row => row.turn.id === turn.id)?.turn;
        if (latest) {
          // Input acknowledgement may be present only in the response, while
          // later notifications already contain newer streamed output.
          const missingUsers = turn.items.filter(item => item.type === 'userMessage' && !latest.items.some(current => current.id === item.id));
          turn = { ...latest, items: [...missingUsers, ...latest.items] };
        }
      }
      const row = this.rememberNativeTurn(id, turn);
      if (row.turn.items.some(item => item.type === 'userMessage')) this.store.setBinding(id, 'codex', { consumedSeq: Math.max(handoff.throughSeq, this.store.get(id).bindings.codex.consumedSeq) });
      return { ...result, turn: presentTurn(row.turn, 'codex') };
    } catch (error) {
      if (this.store.get(id).activeRun?.id === runId) this.store.finishRun(id, runId);
      throw error;
    }
  }
  async startClaude(id, params, commandContext = null) {
    this.assertOpen();
    if (params.outputSchema || params.toolOutput) throw new Error('Structured output/tool continuation is unavailable in Claude Code mode.');
    const publicInput = structuredClone(params.input), prompt = claudeInputText(publicInput);
    const value = this.store.get(id);
    if (!statSync(value.cwd).isDirectory()) throw new Error('Claude workspace is not a directory.');
    const handoff = commandContext ? { text: '' } : this.handoff(id, 'claude');
    const claudeOptions = normalizeClaudeSessionOptions(commandContext?.claudeOptions ?? this.claudeCommands.binding(id, commandContext)?.claudeOptions);
    const runId = `claude-run:${randomUUID()}`, turnId = `claude-turn:${randomUUID()}`;
    const turn = { id: turnId, status: 'inProgress', items: [{ type: 'userMessage', id: `user:${randomUUID()}`, content: publicInput, ...(params.clientUserMessageId ? { clientId: params.clientUserMessageId } : {}) }], startedAt: now(), error: null };
    this.store.beginRun(id, { id: runId, turnId, engine: 'claude', permissionMode: value.claudePermissionMode });
    this.store.putTurn(id, turn, { engine: 'claude', runId });
    const run = { id: runId, threadId: id, turn, commandContext, controller: new AbortController(), adapterRun: null, done: null,
      activity: { phase: 'starting', startedAt: Date.now(), updatedAt: Date.now() } };
    this.runs.set(runId, run);
    run.done = new Promise(resolve => setImmediate(resolve)).then(async () => {
      this.notify('thread/status/changed', { threadId: id, status: { type: 'active', activeFlags: [] } });
      this.notify('turn/started', { threadId: id, turn: presentTurn(turn, 'claude') });
      let result;
      try {
        if (run.controller.signal.aborted) result = { status: 'interrupted' };
        else {
          const content = publicInput.some(item => item.type !== 'text')
            ? await this.prepareInput(signal => claudeInputContent(publicInput, { signal,
              prefix: handoff.text ? `${handoff.text}\n\n[Current user request]` : '[Current user request]' }), run.controller.signal) : undefined;
          // The installed CLI does not durably create an empty thread until an
          // item is injected. An empty public message materializes the container
          // without invoking a model or adding instructions to its context.
          if (!value.nativeMaterialized && !value.turns.some(row => row.engine === 'codex')) {
            await this.native.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }] });
            const current = this.store.require(id); current.nativeMaterialized = true; this.store.save(current);
            if (!current.thread.name && prompt.trim()) await this.native.request('thread/name/set', { threadId: id, name: prompt.trim().slice(0, 80) });
          }
          if (run.controller.signal.aborted || this.closed) throw new Error('Run interrupted before Claude startup.');
          if (commandContext?.command.execution === 'local') {
            result = await this.claudeCommands.local(id, commandContext, { signal: run.controller.signal });
            run.controller.signal.throwIfAborted();
          }
          else {
            const model = commandContext ? commandContext.model : value.models.claude;
            run.adapterRun = this.adapter.start({ prompt: handoff.text ? `${handoff.text}\n\n[Current user request]\n${prompt}` : prompt, cwd: commandContext?.cwd ?? value.cwd,
              ...(content ? { content } : {}),
              nativeSessionId: this.claudeCommands.binding(id, commandContext).sessionId, model: model === 'default' || model == null ? undefined : model,
              permissionMode: commandContext?.permissionMode ?? value.claudePermissionMode,
              claudeOptions,
              ...(commandContext ? { command: commandContext.command, access: commandContext.access, instructions: commandContext.instructions } : {}),
              signal: run.controller.signal, onEvent: event => this.claudeEvent(run, event), onPermission: request => this.permission(run, request) });
            result = await run.adapterRun.done;
          }
          if (result.text && !turn.items.some(item => item.type === 'agentMessage')) this.claudeEvent(run, { type: 'message-completed', id: `${runId}:output`, text: result.text });
        }
      } catch (error) { result = { status: run.controller.signal.aborted ? 'interrupted' : 'failed', error: messageOf(error) }; }
      this.cancelApprovals(runId);
      turn.status = result.status; turn.completedAt = now(); turn.durationMs = (turn.completedAt - turn.startedAt) * 1000;
      if (result.error) turn.error = { message: result.error };
      const row = this.store.putTurn(id, turn, { engine: 'claude', runId });
      if (result.nativeTasks) { const current = this.store.require(id); current.turns.find(value => value.seq === row.seq).runs[0].nativeTasks = result.nativeTasks; this.store.save(current); }
      if (result.actualModel || result.usage) {
        const current = this.store.require(id), saved = current.turns.find(value => value.seq === row.seq).runs[0];
        if (result.actualModel) saved.actualModel = result.actualModel;
        if (result.usage) saved.usage = structuredClone(result.usage);
        this.store.save(current);
      }
      try {
        const sessionId = result.nativeSessionId ?? this.claudeCommands.binding(id, commandContext).sessionId;
        const acknowledged = result.status === 'completed' || this.store.get(id).activeRun?.acknowledgedSeq != null;
        if (commandContext) this.claudeCommands.finish(id, commandContext, result, row.seq);
        else if (sessionId) this.claudeCommands.setBinding(id, null, { sessionId, ...(acknowledged ? { consumedSeq: row.seq } : {}) });
        if (!commandContext && result.status === 'completed' && result.settingsPatch?.claudeOptions !== undefined) {
          this.claudeCommands.setBinding(id, null, { claudeOptions: normalizeClaudeSessionOptions({ ...normalizeClaudeSessionOptions(this.claudeCommands.binding(id, null).claudeOptions), ...normalizeClaudeSessionOptions(result.settingsPatch.claudeOptions) }) });
        }
        if (!commandContext && result.status === 'completed' && result.settingsPatch?.permissionMode !== undefined) {
          const current = this.store.require(id);
          current.claudePermissionMode = assertClaudePermissionMode(result.settingsPatch.permissionMode);
          this.store.save(current);
        }
      } catch (error) {
        turn.status = 'failed'; turn.error = { message: messageOf(error) };
        this.store.putTurn(id, turn, { engine: 'claude', runId });
      }
      this.store.finishRun(id, runId); this.runs.delete(runId);
      this.notify('turn/completed', { threadId: id, turn: presentTurn(turn, 'claude') });
      this.notify('thread/status/changed', { threadId: id, status: { type: 'idle' } });
    });
    run.done.finally(() => this.claudeCommands.release(commandContext)).catch(() => {});
    return { turn: presentTurn(turn, 'claude') };
  }
  claudeEvent(run, event) {
    const { threadId, turn } = run;
    if (event.type === 'activity' || event.type === 'token-usage') {
      if (this.runs.get(run.id) !== run || run.controller.signal.aborted) return;
      run.activity = updateClaudeProgress(run.activity, event);
      return;
    }
    if (event.type.startsWith('thinking-') && (this.runs.get(run.id) !== run || run.controller.signal.aborted)) return;
    if (event.type === 'native-tasks') {
      const chat = this.store.require(threadId), row = chat.turns.find(row => row.turn.id === turn.id);
      row.runs[0].nativeTasks = event.nativeTasks; this.store.save(chat); return;
    }
    if (event.type === 'agent-model') {
      const chat = this.store.require(threadId), row = chat.turns.find(row => row.turn.id === turn.id);
      (row.agentModels ??= {})[event.parentToolUseId] = event.model; this.store.save(chat); return;
    }
    if (event.type === 'permission-mode') {
      const current = this.store.require(threadId);
      if (current.activeRun?.id === run.id) {
        const actualMode = assertClaudePermissionMode(event.actualMode);
        if (run.commandContext?.bindingKey) this.claudeCommands.setBinding(threadId, run.commandContext, { actualPermissionMode: actualMode });
        else { current.claudeActualPermissionMode = actualMode; this.store.save(current); }
      }
      return;
    }
    if (event.type === 'input-acknowledged') {
      const current = this.store.require(threadId);
      if (current.activeRun?.id === run.id) {
        current.activeRun.acknowledgedSeq = current.turns.find(row => row.turn.id === turn.id).seq;
        this.store.save(current);
      }
      return;
    }
    if (event.type === 'session') { this.claudeCommands.setBinding(threadId, run.commandContext, { sessionId: event.sessionId }); return; }
    const update = (item, complete) => {
      if (run.commandContext?.roleId) item = { ...item, cdxRoleId: run.commandContext.roleId };
      const index = turn.items.findIndex(current => current.id === item.id);
      const existed = index >= 0;
      if (existed) turn.items[index] = item; else turn.items.push(item);
      this.store.putTurn(threadId, turn, { engine: 'claude', runId: run.id });
      if (!existed) this.notify('item/started', { threadId, turnId: turn.id, item: presentItem(item, 'claude') });
      if (complete) this.notify('item/completed', { threadId, turnId: turn.id, item: presentItem(item, 'claude') });
    };
    applyClaudeThinking(event, { turn, update, threadId, save: () => this.store.putTurn(threadId, turn, { engine: 'claude', runId: run.id }), notify: (method, params) => this.notify(method, params) });
    if (event.type === 'message-start') update({ id: event.id, type: 'agentMessage', text: '', phase: 'commentary' }, false);
    if (event.type === 'text-delta') {
      let item = turn.items.find(item => item.id === event.id);
      if (!item) { update({ id: event.id, type: 'agentMessage', text: '', phase: 'commentary' }, false); item = turn.items.at(-1); }
      item.text += event.delta;
      this.store.putTurn(threadId, turn, { engine: 'claude', runId: run.id });
      this.notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: event.id, delta: event.delta });
    }
    if (event.type === 'message-completed') update({ id: event.id, type: 'agentMessage', text: event.text, phase: 'final_answer' }, true);
    if (event.type === 'tool-start' || event.type === 'tool-completed') update(toolItem(event, this.store.get(threadId).cwd), event.type === 'tool-completed');
  }
  permission(run, request) {
    if (run.controller.signal.aborted || request.signal?.aborted) return Promise.resolve(deny());
    let interaction;
    try { interaction = createClaudeInteraction(request); }
    catch (error) { return Promise.resolve({ decision: 'decline', message: messageOf(error) }); }
    const id = `claude-approval:${randomUUID()}`;
    const base = { threadId: run.threadId, turnId: run.turn.id, itemId: request.id };
    return new Promise(resolve => {
      const finish = response => {
        if (!this.approvals.delete(id)) return;
        request.signal?.removeEventListener('abort', cancel);
        run.controller.signal.removeEventListener('abort', cancel);
        this.notify('serverRequest/resolved', { threadId: run.threadId, requestId: id });
        resolve(response);
      };
      const cancel = () => finish(deny());
      this.approvals.set(id, { runId: run.id, finish, request, interaction });
      request.signal?.addEventListener('abort', cancel, { once: true });
      run.controller.signal.addEventListener('abort', cancel, { once: true });
      this.emit({ id, method: interaction.method, params: { ...base, ...interaction.params } });
    });
  }
  respond(message) {
    if (this.workflow.respond(message)) return true;
    const pending = this.approvals.get(message.id);
    if (!pending) return false;
    const run = this.runs.get(pending.runId);
    if (!run || run.controller.signal.aborted || pending.request.signal?.aborted || message.error) { pending.finish(deny()); return true; }
    pending.finish(pending.interaction.respond(message.result));
    if (message.result?.decision === 'cancel') { run.controller.abort(); void run.adapterRun?.interrupt(); }
    return true;
  }
  cancelApprovals(runId) { for (const pending of this.approvals.values()) if (pending.runId === runId) pending.finish(deny()); }
  nativeNotification(message) {
    const { method, params } = message;
    if (this.workflow.internal.has(params?.threadId ?? params?.thread?.id)) return;
    const id = params?.threadId;
    if (!id || !this.store.has(id)) { this.emit(message); return; }
    // Most native events only pass through (notably tool-output deltas). Do not
    // clone a potentially large history merely to inspect ownership/tombstones.
    const value = this.store.require(id);
    const nativeTurnId = params.turn?.id ?? params.turnId;
    if (nativeTurnId && value.discardedNativeTurnIds?.includes(nativeTurnId)) return;
    if (nativeTurnId) {
      let revisions = this.nativeTurnRevisions.get(id);
      if (!revisions) this.nativeTurnRevisions.set(id, revisions = new Map());
      revisions.set(nativeTurnId, (revisions.get(nativeTurnId) ?? 0) + 1);
    }
    if (method === 'thread/deleted') { this.store.remove(id); this.pagedHistoryHydrated.delete(id); }
    if (method === 'thread/name/updated') { this.nativeNameRevisions.set(id, (this.nativeNameRevisions.get(id) ?? 0) + 1); const current = this.store.require(id); current.thread.name = params.threadName; this.store.save(current); }
    // The native container is idle during a Claude run; don't let an unrelated
    // metadata refresh overwrite its status in the frontend.
    if ((value.activeRun?.engine === 'claude' || value.activeTurn?.mode === 'both') && method === 'thread/status/changed') return;
    if (params.turn && (method === 'turn/started' || method === 'turn/completed')) {
      if (method === 'turn/started' && !value.activeRun) this.store.beginRun(id, { id: params.turn.id, turnId: params.turn.id, engine: 'codex' });
      const row = this.rememberNativeTurn(id, params.turn);
      if (method === 'turn/completed') {
        const active = this.store.get(id).activeRun;
        if (params.turn.status === 'completed' || (active?.engine === 'codex' && active.acknowledgedSeq === row.seq)) this.store.setBinding(id, 'codex', { consumedSeq: Math.max(row.seq, this.store.get(id).bindings.codex.consumedSeq) });
        if (active?.engine === 'codex') this.store.finishRun(id, active.id);
      }
      message = { ...message, params: { ...params, turn: presentTurn(this.cleanNativeTurn(id, params.turn), 'codex') } };
    } else if (params.turnId && (params.item || method === 'item/agentMessage/delta')) {
      // Mutation is isolated to this turn; keep older turns out of the hot path.
      const row = structuredClone(value.turns.find(row => row.turn.id === params.turnId));
      if (row?.engine === 'codex') {
        const turn = row.turn;
        if (params.item) {
          const item = structuredClone(params.item);
          if (item.type === 'userMessage') {
            const active = this.store.require(id).activeRun;
            if (active?.engine === 'codex' && active.turnId === turn.id) active.acknowledgedSeq = row.seq;
          }
          if (item.type === 'userMessage' && row.originalInput) {
            const record = this.store.require(id).turns.find(current => current.turn.id === turn.id);
            record.firstUserItemId ??= item.id;
            if (record.firstUserItemId === item.id) item.content = row.originalInput;
          }
          const index = turn.items.findIndex(current => current.id === item.id);
          if (index >= 0) turn.items[index] = item; else turn.items.push(item);
          message = { ...message, params: { ...params, item: presentItem(item, 'codex') } };
        } else {
          const item = turn.items.find(item => item.id === params.itemId);
          if (item?.type === 'agentMessage') item.text += params.delta;
        }
        this.store.putTurn(id, turn, { engine: 'codex' });
      }
    }
    this.emit(message);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.all([
      this.adapter.close?.(),
      this.workflow.close(),
      ...[...this.runs.values()].map(async run => { run.controller.abort(); this.cancelApprovals(run.id); await run.adapterRun?.interrupt(); await run.done; }),
    ]);
    await this.closing;
  }
}
