import { isAbsolute, relative, resolve } from 'node:path';
import { NativeClient } from '../upstream.mjs';

const errorText = error => error instanceof Error ? error.message : String(error);
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const interruptedError = () => new Error('Native Codex role was interrupted.');

/** One original App Server process per role, with native persisted thread resume. */
export class CodexRole {
  constructor({ codexCommand = '/Applications/chatgpt-dev.app/Contents/Resources/codex', codexArgs = ['app-server'], codexReadArgs = codexArgs, nativeClientFactory = options => new NativeClient(options) } = {}) {
    this.command = codexCommand;
    this.args = [...codexArgs];
    this.readArgs = [...codexReadArgs];
    this.clientFactory = nativeClientFactory;
  }

  start(options) {
    const stopped = deferred(), terminal = deferred(), exit = deferred();
    const emit = event => options.onEvent?.(event);
    const events = new CodexRoleEvents(options.runId, emit);
    const permissions = new Map();
    let client, sessionId = options.nativeSessionId, turnId, actualModel, settled = false, finishing = false, sessionReported = false, turnEnded = false;
    let interrupted = options.signal?.aborted === true;
    const abort = () => { if (!settled) { interrupted = true; stopped.resolve(); for (const request of permissions.values()) request.abort(); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (interrupted) abort();
    const alive = () => { if (interrupted) throw interruptedError(); };
    const wait = promise => Promise.race([promise, stopped.promise.then(() => { throw interruptedError(); }), exit.promise.then(error => { throw error; })]);
    const session = id => { if (typeof id !== 'string' || !id) return; if (sessionId !== id || !sessionReported) { sessionId = id; sessionReported = true; emit({ type: 'session', sessionId }); } };
    const request = async (method, params) => {
      alive();
      const response = client.request(method, params).then(value => {
        // Cancellation can win the request race after native created a durable
        // session. Retain its ownership while the transport drains on close.
        if (!settled && (method === 'thread/start' || method === 'thread/resume')) session(value.thread?.id);
        return value;
      });
      return await wait(response);
    };
    const belongs = params => (!params.threadId || params.threadId === sessionId) && (!turnId || !params.turnId || params.turnId === turnId);

    const onRequest = async message => {
      if (finishing || interrupted) return;
      const { id, method, params = {} } = message;
      const controller = new AbortController();
      permissions.set(id, controller);
      try {
        const allowed = belongs(params) && permissionMethods.has(method) && (options.access !== 'read' || method === 'item/tool/requestUserInput');
        if (!allowed || typeof options.onPermission !== 'function') {
          client.respond({ id, ...(permissionMethods.has(method) || method === 'item/tool/call' ? { result: denyNativeRequest(method) } : { error: { code: -32601, message: 'Unsupported native role request.' } }) });
          return;
        }
        const result = await options.onPermission({ id: `${options.runId}:${id}`, engine: 'codex', method, params: structuredClone(params), signal: controller.signal });
        if (!controller.signal.aborted && !finishing && !interrupted) client.respond({ id, result: result ?? denyNativeRequest(method) });
      } catch {
        if (!controller.signal.aborted && !finishing && !interrupted) try { client.respond({ id, result: denyNativeRequest(method) }); } catch { /* shutdown owns the transport */ }
      } finally { permissions.delete(id); }
    };
    const onNotification = message => {
      const { method, params = {} } = message;
      try {
        if (method === 'thread/started') { if (!settled && (!sessionId || params.thread?.id === sessionId)) session(params.thread?.id); return; }
        if (finishing || interrupted) return;
        if (!belongs(params)) return;
        if (method === 'serverRequest/resolved') { permissions.get(params.requestId)?.abort(); return; }
        if (method === 'turn/started') { if (!turnId) turnId = params.turn?.id; return; }
        if (method === 'turn/completed' && (!turnId || params.turn?.id === turnId)) {
          turnEnded = true;
          turnId ??= params.turn?.id;
          for (const item of params.turn?.items ?? []) events.item(item, true);
          terminal.resolve(params.turn); return;
        }
        events.consume(method, params);
      } catch (error) { exit.resolve(error); }
    };

    const done = Promise.resolve().then(async () => {
      let summary;
      try {
        alive();
        if (typeof options.prompt !== 'string' || typeof options.cwd !== 'string' || !isAbsolute(options.cwd)) throw new TypeError('Native Codex requires a prompt and absolute working directory.');
        if (options.model != null && (typeof options.model !== 'string' || !options.model || /[\0\r\n]/.test(options.model))) throw new TypeError('Invalid native Codex model identifier.');
        client = this.clientFactory({ command: this.command, args: [...(options.access === 'read' ? this.readArgs : this.args)], env: process.env, onNotification, onRequest: message => { void onRequest(message); }, onExit: (code, signal) => exit.resolve(new Error(`Native Codex exited (${signal ?? code}).`)) });
        await request('initialize', { clientInfo: { name: 'codex_role_runner', version: '1.0.0' }, capabilities: { experimentalApi: true } });
        alive(); client.notify({ method: 'initialized', params: {} });
        const config = options.access === 'read' ? (await request('config/read', { cwd: options.cwd, includeLayers: true })).config : undefined;
        const params = roleParams(options, config);
        const response = await request(sessionId ? 'thread/resume' : 'thread/start', { ...params.thread, ...(sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false, allowProviderModelFallback: false }) });
        session(response.thread?.id);
        if (!sessionId) throw new Error('Native Codex did not return a resumable thread ID.');
        if (options.access === 'read' && (response.sandbox?.type !== 'readOnly' || response.sandbox.networkAccess === true)) throw new Error('Native Codex did not enforce the requested read-only sandbox.');
        if (typeof response.model === 'string' && response.model) actualModel = response.model;
        const turn = await request('turn/start', { ...params.turn, threadId: sessionId, input: [{ type: 'text', text: options.prompt, text_elements: [] }] });
        turnId ??= turn.turn?.id;
        if (!turnId) throw new Error('Native Codex did not acknowledge a turn ID.');
        const result = turn.turn?.status !== 'inProgress' ? turn.turn : await wait(terminal.promise);
        for (const item of result?.items ?? []) events.item(item, true);
        const status = ['completed', 'failed', 'interrupted'].includes(result?.status) ? result.status : 'failed';
        summary = { status, ...(status === 'failed' ? { error: result?.error?.message ?? 'Native Codex turn failed.' } : {}) };
      } catch (error) { summary = { status: interrupted ? 'interrupted' : 'failed', ...(interrupted ? {} : { error: errorText(error) }) }; }
      finally {
        finishing = true;
        for (const request of permissions.values()) request.abort();
        permissions.clear();
        try { await client?.close(); } catch (error) { summary = { status: interrupted ? 'interrupted' : 'failed', error: `Native Codex cleanup failed: ${errorText(error)}` }; }
        options.signal?.removeEventListener('abort', abort);
        try { events.finish(); } catch { /* done still exposes the final text */ }
      }
      summary = { ...summary, text: events.text, nativeSessionId: sessionId, ...(actualModel ? { actualModel } : {}), ...(events.usage ? { usage: events.usage } : {}) };
      if (summary.status === 'completed' && options.outputSchema !== undefined) {
        try { summary.structuredOutput = JSON.parse(summary.text); } catch { summary = { ...summary, status: 'failed', error: 'Native Codex structured output was not valid JSON.' }; }
      }
      settled = true;
      try { emit({ type: 'result', ...summary }); } catch { /* result remains available through done */ }
      return summary;
    });
    return { done, steer: async text => {
      alive();
      if (settled || finishing || turnEnded || !client || !sessionId || !turnId) throw new Error('Codex steering requires an active native turn.');
      if (typeof text !== 'string' || !text.trim()) throw new Error('Steering requires a nonempty text prompt.');
      return await request('turn/steer', { threadId: sessionId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] });
    }, interrupt: async () => { abort(); if (client && sessionId && turnId && !finishing) void client.request('turn/interrupt', { threadId: sessionId, turnId }).catch(() => {}); return await done; } };
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const select = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));

/** Only explicit native policy/model options are accepted, never generic env/config overrides. */
function roleParams(options, resolvedConfig) {
  const native = options.nativeOptions ?? {};
  const common = { cwd: options.cwd, runtimeWorkspaceRoots: [options.cwd],
    ...select(native, ['approvalPolicy', 'approvalsReviewer', 'serviceTier']),
    ...(options.model != null ? { model: options.model } : {}),
  };
  const thread = { ...common, ...select(native, ['modelProvider', 'sandbox', 'permissions']),
    ...(options.instructions ? { developerInstructions: options.instructions } : {}),
  };
  const turn = { ...common, ...select(native, ['effort', 'sandboxPolicy', 'permissions']),
    ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
  };
  if (turn.sandboxPolicy?.type === 'workspaceWrite') {
    const origin = typeof native.cwd === 'string' && isAbsolute(native.cwd) ? native.cwd : options.cwd;
    turn.sandboxPolicy.writableRoots = (turn.sandboxPolicy.writableRoots ?? []).map(root => {
      const path = relative(origin, root);
      return path === '' || (!path.startsWith('..') && !isAbsolute(path)) ? resolve(options.cwd, path) : root;
    });
  }
  if (options.access === 'read') {
    if (!record(resolvedConfig)) throw new Error('Native read-role configuration could not be resolved.');
    const config = { 'features.multi_agent': false, 'features.apps': false };
    const servers = resolvedConfig.mcp_servers;
    if (servers !== undefined && !record(servers)) throw new Error('Native MCP configuration is malformed.');
    for (const name of Object.keys(servers ?? {})) {
      const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
      config[`mcp_servers.${key}.enabled`] = false;
    }
    Object.assign(thread, { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', config });
    Object.assign(turn, { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    delete thread.permissions;
    delete turn.permissions;
  }
  return { thread, turn };
}

function denyNativeRequest(method) {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/tool/call') return { success: false, contentItems: [{ type: 'inputText', text: 'This role cannot execute the requested tool.' }] };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'denied' };
  return { decision: 'decline' };
}

const permissionMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/requestUserInput', 'execCommandApproval', 'applyPatchApproval']);

const publicTools = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration']);

/** Normalize public App Server items without exposing reasoning/raw API events. */
class CodexRoleEvents {
  constructor(runId, emit) { this.runId = runId; this.emit = emit; this.messages = new Map(); this.tools = new Map(); this.acknowledged = false; }
  id(id) { return `${this.runId}:${id}`; }
  acknowledge() { if (!this.acknowledged) { this.acknowledged = true; this.emit({ type: 'input-acknowledged' }); } }
  message(id) {
    if (!this.messages.has(id)) { this.messages.set(id, { id, text: '', completed: false }); this.emit({ type: 'message-start', id: this.id(id) }); }
    return this.messages.get(id);
  }
  append(id, delta) {
    if (typeof id !== 'string' || typeof delta !== 'string' || !delta) return;
    const message = this.message(id);
    if (message.completed) return;
    this.acknowledge(); message.text += delta; this.emit({ type: 'text-delta', id: this.id(id), delta });
  }
  item(item, completed) {
    if (!item || typeof item.id !== 'string') return;
    if (item.type === 'agentMessage') {
      const message = this.message(item.id);
      if (message.completed) return;
      message.phase = item.phase ?? message.phase;
      if (typeof item.text === 'string') {
        if (item.text.startsWith(message.text)) this.append(item.id, item.text.slice(message.text.length));
        message.text = item.text;
      }
      if (completed) { message.completed = true; this.emit({ type: 'message-completed', id: this.id(item.id), text: message.text, nativeItem: structuredClone(item) }); }
    } else if (publicTools.has(item.type)) {
      const previous = this.tools.get(item.id);
      if (previous === 'completed' || (!completed && previous)) return;
      this.acknowledge();
      this.tools.set(item.id, completed ? 'completed' : 'started');
      this.emit({ type: completed ? 'tool-completed' : 'tool-start', id: this.id(item.id), name: item.type, input: item.arguments ?? (item.command ? { command: item.command } : {}), nativeItem: structuredClone(item), ...(completed ? { output: item.aggregatedOutput ?? item.contentItems ?? item.result ?? '', isError: item.status === 'failed' || item.status === 'declined' || item.success === false } : {}) });
    }
  }
  consume(method, params) {
    if (method === 'item/started' || method === 'item/completed') this.item(params.item, method === 'item/completed');
    else if (method === 'item/agentMessage/delta') this.append(params.itemId, params.delta);
    else if (method === 'thread/tokenUsage/updated') this.usage = structuredClone(params.tokenUsage);
  }
  finish() { for (const message of this.messages.values()) if (!message.completed) { message.completed = true; this.emit({ type: 'message-completed', id: this.id(message.id), text: message.text }); } }
  get text() {
    const messages = [...this.messages.values()];
    const final = messages.filter(message => message.phase === 'final_answer');
    return (final.length ? final : messages).map(message => message.text).join('\n');
  }
}
