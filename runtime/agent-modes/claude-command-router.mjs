import { inputText } from './handoff.mjs';
import { resolveClaudeCommand, formatClaudeTasks, assertClaudeCommandAccess } from './claude-commands.mjs';
import { assertClaudePermissionMode } from './claude-permissions.mjs';
import { assertClaudeModel } from './claude-models.mjs';
import { roleBindingKey } from './orchestration/scheduler.mjs';
import { randomUUID } from 'node:crypto';

const roleIdPattern = /^[a-z][a-z0-9_-]{0,63}$/;

/** Routes explicit user commands before workflow or handoff prompt expansion. */
export class ClaudeCommandRouter {
  constructor(router) { this.router = router; this.store = router.store; this.reservations = new Map(); this.contextReservations = new WeakMap(); }

  selection(params, current, selected) {
    let target = params.claudeCommandTarget;
    if (target === undefined) return current?.claudeCommandTarget;
    if (target === null) return null;
    if (typeof target !== 'string' || !roleIdPattern.test(target)) throw new Error('Invalid Claude command target.');
    if (!selected?.template?.roles?.[target] || selected.template.roles[target].engine !== 'claude') throw new Error('Command target must be a Claude role in the selected template.');
    return target;
  }

  context(id, params = {}) {
    const chat = this.store.require(id);
    if (chat.mode === 'claude') return { cwd: chat.cwd, model: chat.models.claude, permissionMode: chat.claudePermissionMode, binding: chat.bindings.claude };
    if (chat.mode !== 'both') throw new Error('Choose Claude Code or a workflow containing Claude to use Claude commands.');
    const selection = this.router.workflow.selection(params, chat);
    const roles = selection.template.roles;
    const explicit = params.target ?? params.claudeCommandTarget;
    const saved = chat.claudeCommandTarget;
    const target = explicit ?? (roles[saved]?.engine === 'claude' ? saved : roles.host?.engine === 'claude' ? 'host' : Object.keys(roles).find(id => roles[id].engine === 'claude'));
    if (!target || !Object.hasOwn(roles, target) || roles[target].engine !== 'claude') throw new Error('Command target must be a Claude role in the selected template.');
    const role = roles[target];
    let cwd = chat.cwd, purpose = 'default', access = role.access, instructions = role.prompt;
    let bindingKey = roleBindingKey({ template: selection.template, roleId: target, cwd });
    let binding = chat.roleBindings[bindingKey];
    // Fresh roles and task workspaces still have native transcripts. A command
    // follows the latest compatible invocation, including a session moved by
    // /model. Its narrower access and instructions remain part of that scope.
    for (const row of [...chat.turns].reverse()) {
      if (row.historyDetached) continue;
      const commandKey = row.claudeCommand?.roleId === target ? row.claudeCommand.bindingKey : undefined;
      const commandBinding = commandKey ? chat.roleBindings[commandKey] : undefined;
      const saved = commandBinding?.commandScope;
      if (commandBinding?.sessionId && commandBinding.engine === 'claude' && saved &&
        commandKey === roleBindingKey({ template: selection.template, roleId: target, cwd: saved.cwd, purpose: saved.purpose })) {
        ({ cwd, purpose, instructions } = saved);
        access = role.access === 'read' || saved.access === 'read' ? 'read' : role.access;
        bindingKey = commandKey; binding = commandBinding;
        break;
      }
      const previousRole = row.workflow?.config?.template?.roles?.[target];
      if (!previousRole || row.workflow.config.template.id !== selection.template.id || row.workflow.config.template.revision !== selection.template.revision || previousRole.engine !== 'claude' || previousRole.prompt !== role.prompt || previousRole.model !== role.model) continue;
      const run = [...(row.runs ?? [])].reverse().find(run => run.roleId === target && run.engine === 'claude' && run.requestedModel === role.model && run.nativeSessionId);
      if (!run) continue;
      const descriptor = Object.values(row.workflow.state?.invocations ?? {}).find(value => value.roleId === target && value.stepId === run.stepId && value.round === run.round);
      const runPurpose = descriptor?.purpose ?? 'default';
      const runKey = roleBindingKey({ template: selection.template, roleId: target, cwd: run.cwd, purpose: runPurpose });
      // A native /model command can move this transcript to a new profile.
      // Do not resurrect the deleted source binding from historical runs.
      if (!chat.roleBindings[runKey] && Object.entries(chat.roleBindings).some(([key, value]) => key !== runKey && value.sessionId === run.nativeSessionId)) continue;
      cwd = run.cwd; purpose = runPurpose; bindingKey = runKey;
      access = role.access === 'read' || descriptor?.access === 'read' ? 'read' : role.access;
      instructions = descriptor?.instructions ?? role.prompt;
      binding = chat.roleBindings[bindingKey] ?? { sessionId: run.nativeSessionId, consumedSeq: row.seq, engine: 'claude' };
      break;
    }
    return { cwd, purpose, roleId: target, bindingKey, binding: binding ?? { engine: 'claude', consumedSeq: 0 }, model: role.model,
      permissionMode: role.permissionMode ?? 'default', access, instructions, scope: { cwd, purpose, access, instructions }, selection };
  }

  async list(params) {
    let cwd = params.cwd;
    if (params.threadId) {
      if (!this.store.get(params.threadId)) await this.router.hydrate(params.threadId);
      const chat = this.store.require(params.threadId);
      cwd = chat.mode === 'both' && params.target ? this.context(params.threadId, params).cwd : chat.cwd;
    }
    if (typeof this.router.adapter.listCommands !== 'function') throw new Error('This host needs an updated Claude command adapter.');
    return this.router.adapter.listCommands({ cwd, refresh: params.refresh === true });
  }

  async prepare(id, params) {
    const text = inputText(params.input).trim();
    if (!/^\/[^\s/\\]+(?:\s|$)/.test(text)) return null;
    const context = this.context(id, params);
    const catalog = await this.list({ threadId: id, target: context.roleId });
    const command = resolveClaudeCommand(catalog, text);
    if (!command) throw new Error(`Unknown Claude command: ${text.split(/\s/, 1)[0]}. Refresh Claude commands for this workspace.`);
    if (command.origin === 'app' && command.name === 'permissions' && command.args) {
      const mode = assertClaudePermissionMode(command.args);
      command.execution = 'local'; command.settingsPatch = { permissionMode: mode }; command.output = `Claude permissions: ${mode}.`;
    }
    if (['app', 'builtin'].includes(command.origin) && command.name === 'rename') { command.execution = 'local'; command.output = command.args ? `Chat renamed to ${command.args}.` : 'Usage: /rename <name>'; }
    if (command.origin === 'app' && command.name === 'tasks') { command.output = this.tasks(id, context); command.execution = 'local'; }
    if (command.origin === 'app' && command.name === 'copy') {
      const number = command.args ? Number(command.args) : 1;
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Usage: /copy [N] — copy the Nth most recent Claude response.');
      command.execution = 'local'; command.output = 'Claude response ready to copy.';
      command.clientAction = { type: 'copy', text: this.lastResponse(id, context, number) };
    }
    if (command.origin === 'app' && command.name === 'resume') command.execution = 'local';
    assertClaudeCommandAccess(command, context.access);
    // Native slash parsing owns this input. Unseen public conversation remains
    // unconsumed until the next ordinary message can carry it as user context.
    return { ...context, command };
  }

  binding(id, context) { return context?.bindingKey ? this.store.require(id).roleBindings[context.bindingKey] ?? context.binding : this.store.require(id).bindings.claude; }
  setBinding(id, context, patch) {
    if (patch.sessionId) this.assertSessionAvailable(id, context, patch.sessionId);
    if (context?.bindingKey) this.store.setRoleBinding(id, context.bindingKey, { ...this.binding(id, context), ...patch, engine: 'claude' });
    else this.store.setBinding(id, 'claude', patch);
  }
  finish(id, context, result, seq) {
    try { return this.finishBinding(id, context, result, seq); }
    finally { this.release(context); }
  }
  finishBinding(id, context, result, seq) {
    const chat = this.store.require(id), binding = this.binding(id, context);
    const patch = result.settingsPatch ?? context.command.settingsPatch;
    const sourceKey = context.bindingKey;
    let bindingKey = sourceKey, roleOverrides = chat.roleOverrides, models = chat.models, permissionMode = chat.claudePermissionMode;
    if (result.status === 'completed' && patch) {
      if (patch.model !== undefined && patch.model !== null) assertClaudeModel(patch.model);
      if (patch.permissionMode !== undefined) assertClaudePermissionMode(patch.permissionMode);
      if (context.roleId) {
        roleOverrides = { ...roleOverrides, [context.roleId]: { ...roleOverrides[context.roleId], ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}) } };
        const selected = this.router.workflow.selection({ roleOverrides }, chat);
        bindingKey = roleBindingKey({ template: selected.template, roleId: context.roleId, cwd: context.cwd, purpose: context.purpose });
      } else {
        if (patch.model !== undefined) models = { ...models, claude: patch.model ?? 'default' };
        if (patch.permissionMode !== undefined) permissionMode = patch.permissionMode;
      }
    }
    const local = result.localCommand != null || context.command.execution !== 'native';
    const consumedSeq = result.status === 'completed' && result.contextReset ? seq : binding.consumedSeq ?? 0;
    const row = chat.turns.find(row => row.seq === seq);
    const action = result.clientAction ?? context.command.clientAction;
    if (result.status === 'completed' && action && (!['copy', 'download'].includes(action.type) || typeof action.text !== 'string')) throw new Error('Invalid Claude client action.');
    if (!row) throw new Error('Claude command turn was not found.');
    const restoreSession = ['failed', 'interrupted'].includes(result.status) && Object.hasOwn(result, 'sessionIdToRestore');
    const sessionId = restoreSession ? result.sessionIdToRestore : result.nativeSessionId;
    if (restoreSession && sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) throw new Error('Invalid Claude session restoration.');
    if (sessionId) this.assertSessionAvailable(id, context, sessionId);
    const reservation = this.contextReservations.get(context);
    if (reservation?.signal?.aborted) throw new Error('Claude session selection was interrupted.');
    if (result.status === 'completed' && context.command.origin === 'app' && context.command.name === 'resume' && result.nativeSessionId && reservation?.sessionId !== result.nativeSessionId) throw new Error('Claude session selection no longer owns its reservation.');
    if (bindingKey !== sourceKey && chat.roleBindings[bindingKey]?.engine && chat.roleBindings[bindingKey].engine !== 'claude') throw new Error('Role binding engine ownership mismatch.');
    const nextBinding = { ...binding, ...(restoreSession || sessionId ? { sessionId } : {}), consumedSeq,
      ...(context.scope ? { commandScope: context.scope } : {}) };
    this.store.batch(id, () => {
      if (bindingKey && bindingKey !== sourceKey) {
        // The cursor belongs to the moved transcript. Replacing another saved
        // transcript must neither inherit its cursor nor leave a source alias.
        delete chat.roleBindings[sourceKey];
        delete chat.roleBindings[bindingKey];
      }
      if (bindingKey) this.store.setRoleBinding(id, bindingKey, nextBinding);
      else this.store.setBinding(id, 'claude', nextBinding);
      chat.roleOverrides = roleOverrides; chat.models = models; chat.claudePermissionMode = permissionMode;
      row.claudeCommand = { name: context.command.name, roleId: context.roleId ?? null, local, ...(bindingKey ? { bindingKey } : {}) };
      if (context.roleId) chat.claudeCommandTarget = context.roleId;
      if (result.status === 'completed' && action) {
        chat.claudeClientActions ??= [];
        chat.claudeClientActions.push({ ...action, id: randomUUID(), roleId: context.roleId ?? null });
      }
      this.store.save(chat);
    });
    context.bindingKey = bindingKey; context.binding = nextBinding;
  }
  async local(id, context, { signal } = {}) {
    signal?.throwIfAborted();
    const { command } = context;
    if (command.name === 'rename' && command.args) await this.router.native.request('thread/name/set', { threadId: id, name: command.args });
    if (command.name === 'resume') return this.resume(id, context, { signal });
    if (command.output === undefined) throw new Error(`/${command.name} needs its native interactive interface; this host does not expose that action yet.`);
    return { status: 'completed', text: command.output, settingsPatch: command.settingsPatch, clientAction: command.clientAction };
  }
  async resume(id, context, { signal } = {}) {
    signal?.throwIfAborted();
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    let sessions;
    try {
      sessions = await Promise.race([(async () => {
        const api = this.sessionApi ?? await import('@anthropic-ai/claude-agent-sdk');
        signal?.throwIfAborted();
        return await api.listSessions({ dir: context.cwd });
      })(), cancelled]);
      signal?.throwIfAborted();
    } finally { signal?.removeEventListener('abort', onAbort); }
    const target = context.command.args.trim();
    if (!target) return { status: 'completed', text: ['Use /resume <session-id> to continue a native Claude session in this workspace.', ...sessions.map(session => `${session.sessionId} — ${session.customTitle ?? session.summary ?? session.firstPrompt ?? 'Untitled session'}`)].join('\n') };
    if (!sessions.some(session => session.sessionId === target)) throw new Error('Claude session was not found in this workspace. Use /resume to list available sessions.');
    this.assertSessionAvailable(id, context, target);
    this.release(context);
    const reservation = { context, sessionId: target, signal, onAbort: () => this.release(context) };
    this.reservations.set(target, reservation);
    this.contextReservations.set(context, reservation);
    signal?.addEventListener('abort', reservation.onAbort, { once: true });
    return { status: 'completed', text: `Claude session selected: ${target}. The next message continues that native conversation.`, nativeSessionId: target, contextReset: true };
  }
  assertSessionAvailable(id, context, target) {
    const reserved = this.reservations.get(target);
    if (reserved && reserved.context !== context) throw new Error('This Claude session is reserved by another chat or role.');
    // A native transcript has one owner. Importing it cannot alias another chat
    // or role, including roles that may run concurrently in a later workflow.
    for (const chat of this.store.records.values()) {
      if (chat.bindings.claude.sessionId === target && (chat.id !== id || context?.roleId)) throw new Error('This Claude session is already owned by another chat or role.');
      for (const [key, binding] of Object.entries(chat.roleBindings)) {
        if (binding.engine === 'claude' && binding.sessionId === target && (chat.id !== id || key !== context?.bindingKey)) throw new Error('This Claude session is already owned by another chat or role.');
      }
    }
  }
  release(context) {
    const reservation = context && this.contextReservations.get(context);
    if (!reservation) return;
    reservation.signal?.removeEventListener('abort', reservation.onAbort);
    if (this.reservations.get(reservation.sessionId) === reservation) this.reservations.delete(reservation.sessionId);
    this.contextReservations.delete(context);
  }
  claim(id, actionId) {
    const chat = this.store.require(id), actions = chat.claudeClientActions ?? [];
    const index = actions.findIndex(action => action.id === actionId);
    if (index < 0) return { action: null };
    const [action] = actions.splice(index, 1);
    this.store.save(chat);
    return { action };
  }
  lastResponse(id, context, number = 1) {
    for (const row of [...this.store.require(id).turns].reverse()) {
      if (row.claudeCommand?.local || row.engine === 'codex') continue;
      const items = row.turn.items.filter(item => item.type === 'agentMessage' && (item.cdxEngineSource ?? row.engine) === 'claude' && !item.cdxClaudeLocalCommand && (!context.roleId || item.cdxRoleId === context.roleId));
      for (const item of items.reverse()) if (--number === 0) return item.text;
    }
    throw new Error('No matching Claude response is available yet.');
  }
  tasks(id, context) {
    const runs = this.store.require(id).turns.flatMap(row => row.runs ?? []).filter(run => run.engine === 'claude' && (!context.roleId || run.roleId === context.roleId));
    const native = runs.filter(run => run.nativeTasks?.length).slice(-10).map(run => `Claude native tasks (${run.roleId ?? 'chat'}, ${run.id}):\n${formatClaudeTasks(run.nativeTasks).text}`);
    const workflows = runs.filter(run => run.roleId).map(run => `${run.roleId} · ${run.stepId} · ${run.status}`);
    return [...native, ...(workflows.length ? [`Host workflow roles:\n${workflows.join('\n')}`] : [])].join('\n\n') || 'No tracked Claude native or workflow tasks in this chat.';
  }
}
