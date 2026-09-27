import { randomUUID } from 'node:crypto';
import { writeFileSync, statSync, realpathSync } from 'node:fs';
import { assertEngine } from './store.mjs';
import { buildHandoff, inputText, publicHistory } from './handoff.mjs';
import { page, presentItem, presentTurn, toolItem } from './codex-events.mjs';

const now = () => Math.floor(Date.now() / 1000);
const messageOf = error => error instanceof Error ? error.message : String(error);
const nativeParams = params => { const { engineMode, engineModel, ...rest } = params; return rest; };
const deny = () => ({ decision: 'decline' });

export class EngineRouter {
  constructor({ store, native, adapter, emit }) {
    Object.assign(this, { store, native, adapter, emit });
    this.runs = new Map(); this.approvals = new Map(); this.locks = new Map(); this.closed = false;
    this.nativeTurnRevisions = new Map(); this.nativeNameRevisions = new Map();
  }
  assertOpen() { if (this.closed) throw new Error('Engine gateway is shutting down.'); }
  state(id) {
    const value = this.store.get(id);
    return { threadId: id, engineMode: value?.mode ?? 'codex', models: value?.models ?? { codex: null, claude: 'default' }, busy: !!value?.activeRun,
      engines: ['codex', 'claude'], bothAvailable: false, turnEngines: Object.fromEntries((value?.turns ?? []).map(row => [row.turn.id, row.engine])) };
  }
  notify(method, params) { this.emit({ method, params }); }
  request(method, params = {}) {
    const id = params.threadId;
    if (!id) return this.dispatch(method, params);
    // Reserve submission before awaiting native I/O. Approval responses use the
    // separate response path and cannot deadlock behind a pending turn request.
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.dispatch(method, params));
    this.locks.set(id, task);
    task.finally(() => { if (this.locks.get(id) === task) this.locks.delete(id); }).catch(() => {});
    return task;
  }
  async hydrate(id) {
    const revisions = new Map(this.nativeTurnRevisions.get(id));
    const nameRevision = this.nativeNameRevisions.get(id) ?? 0;
    let result;
    try { result = await this.native.request('thread/read', { threadId: id, includeTurns: true }); }
    catch (error) {
      if (!/paginated|full.history|includeTurns|list_turns is not supported yet/i.test(messageOf(error))) throw error;
      result = await this.native.request('thread/read', { threadId: id, includeTurns: false });
    }
    const thread = structuredClone(result.thread);
    if (thread.historyMode === 'paginated' || !Array.isArray(thread.turns)) {
      thread.turns = [];
      let cursor; const visited = new Set();
      do {
        let result;
        try { result = await this.native.request('thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) }); }
        catch (error) {
          if (/not materialized|before first user message|list_turns is not supported yet/.test(messageOf(error)) && !this.store.get(id)?.turns.some(row => row.engine === 'codex')) break;
          throw error;
        }
        thread.turns.push(...result.data); cursor = result.nextCursor;
        if (cursor && visited.has(cursor)) throw new Error('Native history pagination repeated its cursor.');
        visited.add(cursor);
      } while (cursor);
    }
    // Notifications can arrive during any page of this snapshot. Keep the newer
    // live version of those turns, including deltas on still-running turns.
    thread.turns = (thread.turns ?? [])
      .filter(turn => (revisions.get(turn.id) ?? 0) === (this.nativeTurnRevisions.get(id)?.get(turn.id) ?? 0))
      .map(turn => this.cleanNativeTurn(id, turn));
    if (nameRevision !== (this.nativeNameRevisions.get(id) ?? 0)) thread.name = this.store.get(id)?.thread.name;
    this.store.ensureThread(thread);
    // A native session already contains its own pre-existing history.
    const value = this.store.get(id);
    if (!value.turns.some(row => row.engine === 'claude')) this.store.setBinding(id, 'codex', { consumedSeq: Math.max(0, ...value.turns.map(row => row.seq)) });
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
  async dispatch(method, params) {
    this.assertOpen();
    const id = params.threadId;
    if (method === 'engine/capabilities') return { engines: ['codex', 'claude'], bothAvailable: false, claudeModels: ['default', 'sonnet', 'opus', 'haiku'], localOnly: true };
    if (method === 'engine/turns/read') { if (!this.store.get(id)) await this.hydrate(id); return { turns: this.state(id).turnEngines }; }
    if (method === 'engine/mode/read') { if (!this.store.get(id)) await this.hydrate(id); return this.state(id); }
    if (method === 'engine/mode/set') {
      assertEngine(params.engineMode);
      if (this.store.get(id)?.activeRun) throw new Error('Finish or interrupt the active run before switching engines.');
      await this.hydrate(id);
      this.store.setMode(id, params.engineMode, { model: params.engineModel });
      return this.state(id);
    }
    if (method === 'thread/start') {
      assertEngine(params.engineMode ?? 'codex');
      const clean = nativeParams(params);
      if (params.engineMode === 'claude') delete clean.model;
      const result = await this.native.request(method, clean);
      this.store.ensureThread(result.thread, { mode: params.engineMode ?? 'codex' });
      const value = this.store.require(result.thread.id);
      value.models.codex = result.model;
      if (params.engineModel) value.models[value.mode] = params.engineModel;
      this.store.save(value);
      return { ...result, thread: this.thread(value.id), engineState: this.state(value.id) };
    }
    if (method === 'turn/start') {
      if (!this.store.get(id)) await this.hydrate(id);
      if (params.engineMode) {
        assertEngine(params.engineMode);
        if (params.engineMode !== this.store.get(id).mode) {
          await this.hydrate(id);
          this.store.setMode(id, params.engineMode, { model: params.engineModel });
        }
      }
      const value = this.store.get(id);
      this.assertOpen();
      if (value.activeRun) {
        if (value.activeRun.engine === 'codex' && value.mode === 'codex') return this.native.request(method, nativeParams(params));
        throw new Error('A Claude run is active. Stop it before submitting another turn.');
      }
      if ((value.mode === 'claude' || value.turns.some(row => row.engine === 'claude')) && params.cwd && realpathSync(params.cwd) !== realpathSync(value.cwd)) throw new Error('Changing workspace inside a managed chat is not supported. Create a new chat in that workspace.');
      if (params.engineModel) this.store.setMode(id, value.mode, { model: params.engineModel });
      if (value.mode === 'claude') return this.startClaude(id, params);
      return this.startCodex(id, params);
    }
    if (method === 'turn/interrupt' && this.store.get(id)?.activeRun?.engine === 'claude') {
      const active = this.store.get(id).activeRun, run = this.runs.get(active.id);
      if (params.turnId !== active.turnId) throw new Error('Turn ownership mismatch.');
      run.controller.abort(); this.cancelApprovals(active.id);
      if (run.adapterRun) await run.adapterRun.interrupt();
      await run.done;
      return {};
    }
    const value = id && this.store.get(id);
    if (value?.activeRun?.engine === 'claude' && ['thread/delete', 'thread/archive', 'thread/stop'].includes(method)) throw new Error('Finish or interrupt the active Claude run before this action.');
    if (method === 'thread/read' || method === 'thread/resume') {
      const clean = nativeParams(params);
      if (value && method === 'thread/read') clean.includeTurns = false;
      if (value && method === 'thread/resume') clean.excludeTurns = true;
      if (value?.mode === 'claude') delete clean.model;
      const result = await this.native.request(method, clean);
      if (result.thread?.id && (value || this.store.get(result.thread.id))) {
        if (value && result.thread.id !== id) throw new Error('Resuming managed history into another thread is unsupported.');
        await this.hydrate(result.thread.id);
        return { ...result, thread: this.thread(result.thread.id, { includeTurns: method === 'thread/resume' ? !params.excludeTurns : params.includeTurns === true }),
          initialTurnsPage: params.initialTurnsPage ? page(this.store.get(id).turns.map(row => ({ key: row.turn.id, value: presentTurn(row.turn, row.engine) })), { ...params.initialTurnsPage, threadId: id }, 'turns') : null, turnsBackwardsCursor: null, itemsBackwardsCursor: null, engineState: this.state(result.thread.id) };
      }
      return result;
    }
    if (value && ['thread/turns/list', 'thread/items/list'].includes(method)) {
      await this.hydrate(id);
      const rows = this.store.get(id).turns;
      if (method === 'thread/turns/list') return page(rows.map(row => ({ key: row.turn.id, value: presentTurn(row.turn, row.engine) })), params, 'turns');
      const entries = rows.filter(row => !params.turnId || row.turn.id === params.turnId).flatMap(row => row.turn.items.map(item => ({ key: `${row.turn.id}/${item.id}`, value: { turnId: row.turn.id, item: presentItem(item, row.engine) } })));
      return page(entries, params, 'items');
    }
    if (value?.mode === 'claude' && /^(turn\/(steer|tool)|thread\/(compact|rollback|revert|fork|realtime|startAeon|inject_items|shellCommand)|review\/)/.test(method)) throw new Error(`${method} is unavailable in Claude Code mode.`);
    if (value?.turns.some(row => row.engine === 'claude') && /thread\/(rollback|revert|fork)/.test(method)) throw new Error('Fork/rollback of mixed-engine history is not available yet.');
    const result = await this.native.request(method, nativeParams(params));
    if (value && ['thread/rollback', 'thread/revert', 'thread/delete'].includes(method)) {
      this.store.remove(id);
      if (method !== 'thread/delete') { if (result.thread) this.store.ensureThread(result.thread); else await this.hydrate(id); }
    }
    if (method === 'thread/list') result.data = result.data.map(thread => {
      if (!this.store.get(thread.id)) return thread;
      this.store.mergeNativeThread(thread);
      return { ...thread, ...this.thread(thread.id, { includeTurns: false }) };
    });
    return result;
  }
  handoff(id, engine) {
    const value = this.store.get(id);
    const historyPath = this.store.path(id).replace(/\.json$/, '.history.txt');
    writeFileSync(historyPath, publicHistory(value), { mode: 0o600 });
    return buildHandoff(value, engine, { historyPath });
  }
  async startCodex(id, params) {
    this.assertOpen();
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
  startClaude(id, params) {
    this.assertOpen();
    if (params.outputSchema || params.toolOutput) throw new Error('Structured output/tool continuation is unavailable in Claude Code mode.');
    const prompt = inputText(params.input);
    const value = this.store.get(id);
    if (!statSync(value.cwd).isDirectory()) throw new Error('Claude workspace is not a directory.');
    const handoff = this.handoff(id, 'claude');
    const runId = `claude-run:${randomUUID()}`, turnId = `claude-turn:${randomUUID()}`;
    const turn = { id: turnId, status: 'inProgress', items: [{ type: 'userMessage', id: `user:${randomUUID()}`, content: structuredClone(params.input), ...(params.clientUserMessageId ? { clientId: params.clientUserMessageId } : {}) }], startedAt: now(), error: null };
    this.store.beginRun(id, { id: runId, turnId, engine: 'claude' });
    this.store.putTurn(id, turn, { engine: 'claude', runId });
    const run = { id: runId, threadId: id, turn, controller: new AbortController(), adapterRun: null, done: null };
    this.runs.set(runId, run);
    run.done = new Promise(resolve => setImmediate(resolve)).then(async () => {
      this.notify('thread/status/changed', { threadId: id, status: { type: 'active', activeFlags: [] } });
      this.notify('turn/started', { threadId: id, turn: presentTurn(turn, 'claude') });
      let result;
      try {
        if (run.controller.signal.aborted) result = { status: 'interrupted' };
        else {
          // The installed CLI does not durably create an empty thread until an
          // item is injected. An empty public message materializes the container
          // without invoking a model or adding instructions to its context.
          if (!value.nativeMaterialized && !value.turns.some(row => row.engine === 'codex')) {
            await this.native.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }] });
            const current = this.store.require(id); current.nativeMaterialized = true; this.store.save(current);
            if (!current.thread.name && prompt.trim()) await this.native.request('thread/name/set', { threadId: id, name: prompt.trim().slice(0, 80) });
          }
          if (run.controller.signal.aborted || this.closed) throw new Error('Run interrupted before Claude startup.');
          run.adapterRun = this.adapter.start({ prompt: handoff.text ? `${handoff.text}\n\n[Current user request]\n${prompt}` : prompt, cwd: value.cwd,
            nativeSessionId: value.bindings.claude.sessionId, model: value.models.claude === 'default' ? undefined : value.models.claude,
            signal: run.controller.signal, onEvent: event => this.claudeEvent(run, event), onPermission: request => this.permission(run, request) });
          result = await run.adapterRun.done;
        }
      } catch (error) { result = { status: run.controller.signal.aborted ? 'interrupted' : 'failed', error: messageOf(error) }; }
      this.cancelApprovals(runId);
      turn.status = result.status; turn.completedAt = now(); turn.durationMs = (turn.completedAt - turn.startedAt) * 1000;
      if (result.error) turn.error = { message: result.error };
      const row = this.store.putTurn(id, turn, { engine: 'claude', runId });
      const sessionId = result.nativeSessionId ?? this.store.get(id).bindings.claude.sessionId;
      const acknowledged = result.status === 'completed' || this.store.get(id).activeRun?.acknowledgedSeq != null;
      if (sessionId) this.store.setBinding(id, 'claude', { sessionId, ...(acknowledged ? { consumedSeq: row.seq } : {}) });
      this.store.finishRun(id, runId); this.runs.delete(runId);
      this.notify('turn/completed', { threadId: id, turn: presentTurn(turn, 'claude') });
      this.notify('thread/status/changed', { threadId: id, status: { type: 'idle' } });
    });
    return { turn: presentTurn(turn, 'claude') };
  }
  claudeEvent(run, event) {
    const { threadId, turn } = run;
    if (event.type === 'input-acknowledged') {
      const current = this.store.require(threadId);
      if (current.activeRun?.id === run.id) {
        current.activeRun.acknowledgedSeq = current.turns.find(row => row.turn.id === turn.id).seq;
        this.store.save(current);
      }
      return;
    }
    if (event.type === 'session') { this.store.setBinding(threadId, 'claude', { sessionId: event.sessionId }); return; }
    const update = (item, complete) => {
      const index = turn.items.findIndex(current => current.id === item.id);
      const existed = index >= 0;
      if (existed) turn.items[index] = item; else turn.items.push(item);
      this.store.putTurn(threadId, turn, { engine: 'claude', runId: run.id });
      if (!existed) this.notify('item/started', { threadId, turnId: turn.id, item: presentItem(item, 'claude') });
      if (complete) this.notify('item/completed', { threadId, turnId: turn.id, item: presentItem(item, 'claude') });
    };
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
    const id = `claude-approval:${randomUUID()}`;
    const base = { threadId: run.threadId, turnId: run.turn.id, itemId: request.id };
    return new Promise(resolve => {
      const finish = response => { this.approvals.delete(id); request.signal?.removeEventListener('abort', cancel); resolve(response); };
      const cancel = () => finish(deny());
      this.approvals.set(id, { runId: run.id, finish, request });
      request.signal?.addEventListener('abort', cancel, { once: true });
      if (request.name === 'Bash') this.emit({ id, method: 'item/commandExecution/requestApproval', params: { ...base, startedAtMs: Date.now(), command: request.input.command, cwd: this.store.get(run.threadId).cwd, commandActions: [], reason: `Claude Code requests this command. Approval applies once.${request.reason ? ` ${request.reason}` : ''}` } });
      else this.emit({ id, method: 'item/tool/requestUserInput', params: { ...base, isBlocking: true, questions: [{ id: 'permission', header: 'Claude Code', question: `Allow Claude Code tool ${request.name} once?\n${JSON.stringify(request.input, null, 2)}`, options: [{ label: 'Allow once', description: 'Authorize only this tool request.' }, { label: 'Deny', description: 'Do not execute this tool request.' }], isOther: false }] } });
    });
  }
  respond(message) {
    const pending = this.approvals.get(message.id);
    if (!pending) return false;
    const run = this.runs.get(pending.runId);
    if (!run || run.controller.signal.aborted) { pending.finish(deny()); return true; }
    const accepted = pending.request.name === 'Bash' ? message.result?.decision === 'accept' || message.result?.decision === 'acceptForSession' : message.result?.answers?.permission?.answers?.[0] === 'Allow once';
    pending.finish(accepted ? { decision: 'accept', updatedInput: pending.request.input } : deny());
    if (message.result?.decision === 'cancel') { run.controller.abort(); void run.adapterRun?.interrupt(); }
    return true;
  }
  cancelApprovals(runId) { for (const pending of this.approvals.values()) if (pending.runId === runId) pending.finish(deny()); }
  nativeNotification(message) {
    const { method, params } = message;
    const id = params?.threadId;
    if (!id || !this.store.get(id)) { this.emit(message); return; }
    const value = this.store.get(id);
    const nativeTurnId = params.turn?.id ?? params.turnId;
    if (nativeTurnId) {
      let revisions = this.nativeTurnRevisions.get(id);
      if (!revisions) this.nativeTurnRevisions.set(id, revisions = new Map());
      revisions.set(nativeTurnId, (revisions.get(nativeTurnId) ?? 0) + 1);
    }
    if (method === 'thread/deleted') this.store.remove(id);
    if (method === 'thread/name/updated') { this.nativeNameRevisions.set(id, (this.nativeNameRevisions.get(id) ?? 0) + 1); const current = this.store.require(id); current.thread.name = params.threadName; this.store.save(current); }
    // The native container is idle during a Claude run; don't let an unrelated
    // metadata refresh overwrite its status in the frontend.
    if (value.activeRun?.engine === 'claude' && method === 'thread/status/changed') return;
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
      const row = this.store.get(id).turns.find(row => row.turn.id === params.turnId);
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
    this.closed = true;
    await Promise.all([...this.runs.values()].map(async run => { run.controller.abort(); this.cancelApprovals(run.id); await run.adapterRun?.interrupt(); await run.done; }));
  }
}
