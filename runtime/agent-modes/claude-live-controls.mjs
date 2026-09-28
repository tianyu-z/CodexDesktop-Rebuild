import { randomUUID } from 'node:crypto';
import { inputText } from './handoff.mjs';
import { resolveClaudeCommand } from './claude-commands.mjs';
import { presentItem, presentTurn } from './codex-events.mjs';

/** Side controls share the running Query and never enter the workflow prompt. */
export async function liveClaudeControl(router, method, params) {
  const chat = router.store.require(params.threadId), active = chat.activeRun;
  if (!active) throw new Error('No Claude task is running. Send the command as a new message.');
  if ((params.expectedTurnId ?? params.turnId) && (params.expectedTurnId ?? params.turnId) !== active.turnId) throw new Error('Turn ownership mismatch.');
  const input = params.input ?? [{ type: 'text', text: params.command }];
  const text = inputText(input).trim();
  if (!/^\/(status|permissions|allowed-tools|tasks|bashes|btw)(?:\s|$)/.test(text)) throw new Error('Stop the active task before running this command. During a task use /status, /permissions, /tasks or /btw <question>.');
  let owner, control, roleId, nativeRunId, stepId, cwd = chat.cwd;
  if (active.mode === 'both') {
    owner = router.workflow.active.get(active.id);
    const row = chat.turns.find(row => row.turn.id === active.turnId);
    const roles = row.workflow.config.template.roles;
    roleId = params.claudeCommandTarget ?? params.target ?? chat.claudeCommandTarget;
    roleId ??= roles.host?.engine === 'claude' ? 'host' : Object.keys(roles).find(id => roles[id].engine === 'claude');
    if (roles[roleId]?.engine !== 'claude') throw new Error('Select a Claude role for this command.');
    const requestedRun = params.runId ?? (row.runs.some(run => run.id === chat.claudeCommandRunId && run.roleId === roleId && ['running', 'awaitingApproval'].includes(run.status)) ? chat.claudeCommandRunId : undefined);
    const candidates = row.runs.filter(run => run.roleId === roleId && run.engine === 'claude' && ['running', 'awaitingApproval'].includes(run.status) && (!requestedRun || run.id === requestedRun));
    if (candidates.length !== 1) throw new Error(candidates.length ? 'This role has multiple active tasks. Specify runId for the Claude control.' : 'The selected Claude role is not running. Select an active Claude role or wait for the workflow to finish.');
    nativeRunId = candidates[0].id; cwd = candidates[0].cwd; stepId = candidates[0].stepId;
    control = command => owner?.handle?.control(nativeRunId, command, { signal: owner.controller.signal });
  } else if (active.engine === 'claude') {
    owner = router.runs.get(active.id);
    roleId = owner?.commandContext?.roleId;
    const requestedRole = params.claudeCommandTarget ?? params.target ?? (chat.mode === 'both' ? chat.claudeCommandTarget : undefined);
    if (requestedRole && requestedRole !== roleId) throw new Error('The selected Claude role is not running. Live commands cannot switch native session ownership.');
    if (params.runId && params.runId !== active.id) throw new Error('Claude run ownership mismatch.');
    cwd = owner?.commandContext?.cwd ?? cwd;
    control = command => owner?.adapterRun?.control(command, { signal: owner.controller.signal });
  } else throw new Error('No Claude task is running.');
  if (!owner || (active.mode === 'both' ? typeof owner.handle?.control : typeof owner.adapterRun?.control) !== 'function') throw new Error('Claude is still starting. Retry the control after initialization.');
  const catalog = await router.adapter.listCommands({ cwd });
  const command = resolveClaudeCommand(catalog, text);
  if (!command || !['status', 'permissions', 'tasks', 'btw'].includes(command.name) || command.origin !== 'app') throw new Error('Stop the active task before running this command.');
  const response = await control(command);
  if (router.store.require(chat.id).activeRun?.id !== active.id) throw new Error('The Claude task ended before this control completed. Retry as a new message.');
  const source = { cdxClaudeLocalCommand: true, cdxEngineSource: 'claude', ...(roleId ? { cdxRoleId: roleId } : {}),
    ...(nativeRunId ? { cdxRunId: nativeRunId, cdxStepId: stepId } : { cdxClaudeControlRunId: active.id }) };
  const items = [
    { id: `claude-control-user:${randomUUID()}`, type: 'userMessage', content: structuredClone(input), ...(params.clientUserMessageId ? { clientId: params.clientUserMessageId } : {}), ...source },
    { id: `claude-control-output:${randomUUID()}`, type: 'agentMessage', text: response.text, phase: 'final_answer', ...source },
  ];
  owner.turn.items.push(...items);
  const engine = active.mode === 'both' ? 'both' : 'claude';
  router.store.putTurn(chat.id, owner.turn, { engine, runId: active.id });
  for (const item of items) {
    router.notify('item/started', { threadId: chat.id, turnId: active.turnId, item: presentItem(item, engine) });
    router.notify('item/completed', { threadId: chat.id, turnId: active.turnId, item: presentItem(item, engine) });
  }
  return method === 'turn/steer' ? { turnId: active.turnId } : { turn: presentTurn(owner.turn, engine), text: response.text, roleId: roleId ?? null, runId: nativeRunId ?? active.id };
}
