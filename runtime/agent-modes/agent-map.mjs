/** Read-only projection of public delegation records. Never consumes reasoning. */
import { readCodexAgentHistory } from './codex-agent-history.mjs';
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value : undefined;
const finite = value => Number.isFinite(value) && value >= 0 ? value : undefined;
const status = value => ({ inProgress: 'running', pendingInit: 'pending', errored: 'failed', shutdown: 'stopped', notFound: 'unavailable' }[value] ?? value ?? 'unknown');
const live = value => ['running', 'pending', 'queued', 'inProgress', 'awaitingApproval', 'unknown'].includes(value);
const rootId = turnId => `turn:${turnId}`;
const roleId = id => `role:${id}`;
const childId = (scope, engine, id) => JSON.stringify([scope, engine, id]);
const label = value => text(value)?.replace(/\s+/g, ' ').trim().slice(0, 100);
const promptOf = turn => turn.items?.filter(item => item.type === 'userMessage').flatMap(item => item.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n') || undefined;
const tokenCount = usage => finite(usage?.total_tokens) ?? finite(usage?.totalTokens) ?? finite(usage?.total?.totalTokens)
  ?? (finite(usage?.input_tokens) !== undefined && finite(usage?.output_tokens) !== undefined ? usage.input_tokens + usage.output_tokens + (finite(usage.cache_read_input_tokens) ?? 0) + (finite(usage.cache_creation_input_tokens) ?? 0) : undefined);
const timing = source => ({ startedAt: finite(source?.startedAt), completedAt: finite(source?.completedAt), durationMs: finite(source?.durationMs) });
const isCollab = item => item.type === 'collabAgentToolCall';
const isClaudeAgent = item => item.type === 'dynamicToolCall' && item.namespace === 'claude_code' && ['Agent', 'Task'].includes(item.tool) && typeof item.arguments?.prompt === 'string';
const nativeArgs = item => Object.fromEntries(['senderThreadId', 'receiverThreadIds', 'prompt', 'model', 'reasoningEffort'].filter(key => item[key] != null).map(key => [key, clone(item[key])]));
const invocationKey = run => JSON.stringify([run.stepId, run.roleId, run.round ?? 0]);
const targetsOf = item => isCollab(item) ? item.receiverThreadIds ?? [] : item.type === 'subAgentActivity' ? [item.agentThreadId] : [];
const spawned = item => (isCollab(item) && item.tool === 'spawnAgent') || (item.type === 'subAgentActivity' && item.kind === 'started');

function codexCalls(items, dispatches = {}) {
  return items.map(item => {
    if (item.type !== 'subAgentActivity' || item.kind === 'completed' || item.kind === 'interrupted') return item;
    const dispatch = dispatches[item.id];
    return { ...item, type: 'collabAgentToolCall', tool: item.kind === 'started' ? 'spawnAgent' : dispatch?.tool ?? 'subAgentActivity.interacted',
      receiverThreadIds: [item.agentThreadId], prompt: dispatch?.prompt, model: dispatch?.arguments?.model,
      startedAt: dispatch?.startedAt, dispatch: dispatch ?? { tool: `subAgentActivity.${item.kind}`, arguments: { agentThreadId: item.agentThreadId, agentPath: item.agentPath } },
      agentsStates: item.kind === 'started' ? { [item.agentThreadId]: { status: 'running' } } : {} };
  });
}

function relatedCodexItems(record, scope) {
  if (scope.node.kind === 'root') return record.engine === 'codex' ? record.turn.items : [];
  const ids = new Set((record.runs ?? []).filter(run => run.engine === 'codex' && run.nativeSessionId && run.nativeSessionId === scope.node.sessionId).map(run => run.id));
  return record.turn.items.filter(item => ids.has(item.cdxRunId));
}

async function boundedRead(read, milliseconds) {
  let timer;
  try { return await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native agent history read timed out.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function inheritedTurns(chat, row, graph, node) {
  const ids = new Set(chat.turns.map(row => row.turn.id)), visited = new Set();
  for (let parent = graph.nodes.find(candidate => candidate.id === node.parentId); parent && !visited.has(parent.id); parent = graph.nodes.find(candidate => candidate.id === parent.parentId)) {
    visited.add(parent.id);
    for (const turn of row.agentThreads?.[parent.id]?.turns ?? []) ids.add(turn.id);
  }
  return ids;
}

function selectedRow(chat, turnId) {
  const row = turnId == null ? chat.turns.at(-1) : chat.turns.find(row => row.turn.id === turnId);
  if (turnId != null && !row) throw new Error('Agent map turn does not belong to this conversation.');
  return row;
}

export function buildAgentMap(chat, turnId) {
  const row = selectedRow(chat, turnId);
  const graph = { threadId: chat.id, turnId: row?.turn.id ?? null, turns: [...chat.turns].reverse().map(row => ({ id: row.turn.id, label: label(promptOf(row.turn)) || row.turn.id, engine: row.engine, status: status(row.turn.status) })), nodes: [], warnings: [] };
  if (!row) return graph;
  const root = { id: rootId(row.turn.id), parentId: null, kind: 'root', engine: row.engine, label: text(chat.thread?.name) || label(promptOf(row.turn)) || 'Conversation', status: status(row.turn.status), prompt: promptOf(row.turn),
    startedAt: finite(row.turn.startedAt) !== undefined ? row.turn.startedAt * 1000 : undefined,
    completedAt: finite(row.turn.completedAt) !== undefined ? row.turn.completedAt * 1000 : undefined, durationMs: finite(row.turn.durationMs),
    model: row.engine !== 'both' ? row.runs?.[0]?.actualModel ?? row.runs?.[0]?.requestedModel ?? row.agentHistory?.[rootId(row.turn.id)]?.model : undefined,
    tokenCount: tokenCount(row.runs?.[0]?.usage) ?? row.agentHistory?.[rootId(row.turn.id)]?.tokenCount };
  graph.nodes.push(root);
  const scopes = [];
  if (row.engine === 'both') {
    for (const run of row.runs ?? []) {
      const descriptor = row.workflow?.state?.invocations?.[invocationKey(run)];
      const dispatch = run.dispatch ?? (descriptor ? { tool: 'workflow.run', prompt: descriptor.prompt, instructions: descriptor.instructions,
        arguments: Object.fromEntries(['engine', 'roleId', 'stepId', 'round', 'requestedModel', 'cwd', 'access'].filter(key => descriptor[key] !== undefined).map(key => [key, descriptor[key]])) } : undefined);
      const node = { id: roleId(run.id), parentId: root.id, kind: 'role', engine: run.engine, label: `${run.roleId} · ${run.stepId}`, status: status(run.status),
        model: run.actualModel ?? run.requestedModel, roleId: run.roleId, stepId: run.stepId, attempt: run.attempt, sessionId: run.nativeSessionId,
        prompt: dispatch?.prompt, instructions: dispatch?.instructions, dispatches: dispatch ? [clone(dispatch)] : [], result: text(run.text), tokenCount: tokenCount(run.usage), ...timing(run) };
      for (const guidance of row.workflow?.state?.guidance ?? []) if (guidance.deliveries?.some(delivery => delivery.runId === run.id && delivery.status === 'accepted')) {
        node.dispatches.push({ tool: 'workflow.steer', prompt: guidance.text, arguments: { text: guidance.text }, status: 'accepted' });
      }
      graph.nodes.push(node);
      scopes.push({ id: run.id, run, node, engine: run.engine, items: row.turn.items.filter(item => item.cdxRunId === run.id), tasks: run.nativeTasks ?? [], models: row.agentModels ?? {} });
    }
  } else scopes.push({ id: root.id, node: root, engine: row.engine, items: row.turn.items, tasks: row.runs?.[0]?.nativeTasks ?? [], models: row.agentModels ?? {} });
  for (const scope of scopes) {
    if (scope.engine === 'claude') addClaude(graph, scope);
    if (scope.engine === 'codex') {
      const index = chat.turns.indexOf(row), previous = chat.turns.slice(0, index), wanted = new Set(scope.items.flatMap(targetsOf));
      const sameSession = (row.runs ?? []).filter(run => scope.run?.nativeSessionId && run.engine === 'codex' && run.nativeSessionId === scope.run.nativeSessionId);
      const runIndex = sameSession.indexOf(scope.run), earlierRuns = new Set(sameSession.slice(0, Math.max(0, runIndex)).map(run => run.id)), laterRuns = new Set(sameSession.slice(runIndex + 1).filter(run => run.id !== scope.id).map(run => run.id));
      const prior = [...previous.flatMap(record => relatedCodexItems(record, scope)), ...row.turn.items.filter(item => earlierRuns.has(item.cdxRunId))]
        .filter(item => spawned(item) && targetsOf(item).some(id => wanted.has(id))).map(item => ({ ...item, historicalSpawn: true }));
      const dispatches = Object.assign({}, ...[...previous, row].flatMap(record => Object.values(record.agentHistory ?? {}).map(history => history.dispatches ?? {})));
      scope.laterTargets = new Set([...chat.turns.slice(index + 1).flatMap(record => relatedCodexItems(record, scope)), ...row.turn.items.filter(item => laterRuns.has(item.cdxRunId))].flatMap(targetsOf));
      scope.cutoff = scope.run ? finite(scope.run.completedAt) ?? finite(sameSession[runIndex + 1]?.startedAt) : (finite(row.turn.completedAt) ?? finite(chat.turns[index + 1]?.turn.startedAt)) * 1000;
      scope.lowerBound = scope.run ? finite(scope.run.startedAt) : finite(row.turn.startedAt) === undefined ? undefined : row.turn.startedAt * 1000;
      scope.nativeItems = scope.items;
      scope.items = codexCalls([...prior, ...scope.items], dispatches);
      addCodex(graph, scope, row.agentThreads ?? {});
    }
  }
  // An ended owner cannot attest that an unobserved child is still executing.
  for (const node of graph.nodes) if (node.kind === 'subagent' && live(node.status)) {
    const parent = graph.nodes.find(candidate => candidate.id === node.parentId);
    if (parent && !live(parent.status) && !(node.observedAt > Date.now() - 5000)) node.status = 'unknown';
  }
  return graph;
}

function addClaude(graph, scope) {
  const items = scope.items.filter(isClaudeAgent), ids = new Set(items.map(item => item.id));
  for (const item of items) {
    const task = scope.tasks.find(task => task.toolUseId === item.id);
    const background = item.arguments.run_in_background === true || task?.isBackgrounded === true;
    const state = task?.status ?? (item.status === 'completed' ? background ? 'unknown' : 'completed' : item.status);
    const node = { id: childId(scope.id, 'claude', item.id), parentId: ids.has(item.cdxParentToolUseId) ? childId(scope.id, 'claude', item.cdxParentToolUseId) : scope.node.id,
      kind: 'subagent', engine: 'claude', label: label(item.arguments.description) || label(task?.description) || label(item.arguments.prompt) || 'Claude subagent',
      status: status(state), model: scope.models[item.id] ?? text(item.arguments.model), prompt: item.arguments.prompt,
      dispatches: [{ tool: item.tool, arguments: clone(item.arguments), status: item.status }],
      result: text(task?.summary) ?? ((item.contentItems ?? []).filter(content => content.type === 'inputText').map(content => content.text).join('\n') || undefined),
      ...timing(background ? task : item), tokenCount: tokenCount(task?.usage), observedAt: task?.updatedAt };
    if (task?.startedAt != null) node.startedAt = task.startedAt;
    if (task?.completedAt != null) node.completedAt = task.completedAt;
    if (finite(task?.usage?.duration_ms) !== undefined) node.durationMs = task.usage.duration_ms;
    const messages = scope.items.filter(message => message.type === 'dynamicToolCall' && message.namespace === 'claude_code' && message.tool === 'SendMessage');
    for (const message of messages) {
      const recipient = message.arguments?.recipient ?? message.arguments?.to;
      if (typeof recipient !== 'string') continue;
      const matches = items.filter(candidate => candidate.arguments.name === recipient || scope.tasks.some(task => task.id === recipient && task.toolUseId === candidate.id));
      if (matches.length === 1 && matches[0].id === item.id) node.dispatches.push({ tool: message.tool, arguments: clone(message.arguments), prompt: text(message.arguments.content ?? message.arguments.message), status: message.status });
    }
    graph.nodes.push(node);
  }
  // Old/native histories can have task bookends without the corresponding call.
  for (const task of scope.tasks) {
    if (items.some(item => task.toolUseId === item.id) || !['local_agent', 'agent', 'subagent'].includes(task.taskType)) continue;
    graph.nodes.push({ id: childId(scope.id, 'claude-task', task.id), parentId: scope.node.id, kind: 'subagent', engine: 'claude', label: label(task.description) || 'Claude subagent', status: status(task.status), result: text(task.summary), tokenCount: tokenCount(task.usage), ...timing(task), durationMs: finite(task.usage?.duration_ms), dispatches: [] });
  }
}

function addCodex(graph, scope, snapshots) {
  const nodes = new Map(), visited = new Set(), reused = new Set();
  const visit = (items, parent) => {
    // Establish ownership only through spawn records, never arbitrary wait IDs.
    for (const item of items.filter(isCollab)) if (item.tool === 'spawnAgent') {
      const targets = item.receiverThreadIds?.length ? item.receiverThreadIds : [null];
      for (const target of targets) {
        const key = target ?? `pending:${item.id}`;
        if (nodes.has(key)) continue;
        const snapshot = target ? snapshots[childId(scope.id, 'codex', target)] : undefined;
        const node = { id: childId(scope.id, 'codex', key), parentId: parent.id, kind: 'subagent', engine: 'codex', label: item.dispatch?.arguments?.task_name || label(item.prompt) || item.agentPath || snapshot?.agentNickname || 'Codex subagent', prompt: text(item.prompt), model: text(item.model),
          status: status(item.agentsStates?.[target]?.status ?? (item.status === 'failed' ? 'failed' : item.status === 'interrupted' ? 'interrupted' : target ? 'unknown' : 'pending')),
          ...(target ? { sessionId: target } : {}), dispatches: [], ...timing(item) };
        nodes.set(key, node); graph.nodes.push(node);
        if (item.historicalSpawn) reused.add(key);
      }
    }
    for (const item of items) {
      if (isCollab(item)) for (const target of item.receiverThreadIds?.length ? item.receiverThreadIds : item.tool === 'spawnAgent' ? [`pending:${item.id}`] : []) {
        const node = nodes.get(target);
        if (!node) continue;
        node.dispatches.push(item.dispatch ? clone(item.dispatch) : { tool: item.tool, arguments: nativeArgs(item), status: item.status });
        node.prompt ??= item.dispatch?.prompt ?? text(item.prompt);
        if (reused.has(target) && !item.historicalSpawn && (item.dispatch?.prompt || item.prompt)) {
          delete node.result; delete node.completedAt; delete node.durationMs;
          node.startedAt = item.startedAt ?? scope.lowerBound;
          node.model = text(item.model);
          node.prompt = item.dispatch?.prompt ?? item.prompt;
          node.label = label(node.prompt) || node.label;
        }
        const reported = item.agentsStates?.[target];
        if (reported) { node.status = status(reported.status); if (text(reported.message)) node.result = reported.message; }
      }
      if (item.type === 'subAgentActivity' && nodes.has(item.agentThreadId)) {
        const node = nodes.get(item.agentThreadId);
        if (item.kind === 'completed' || item.kind === 'interrupted') node.status = item.kind;
      }
    }
    for (const node of [...nodes.values()].filter(node => node.parentId === parent.id)) {
      if (!node.sessionId || visited.has(node.sessionId)) continue;
      visited.add(node.sessionId);
      const snapshot = snapshots[node.id];
      if (!snapshot) continue;
      const hasLaterWork = scope.laterTargets?.has(node.sessionId);
      const isReused = reused.has(node.sessionId);
      const turns = (snapshot.turns ?? []).filter(turn =>
        (!hasLaterWork || (finite(turn.startedAt) !== undefined && Number.isFinite(scope.cutoff) && turn.startedAt * 1000 < scope.cutoff)) &&
        (!isReused || (finite(turn.startedAt) !== undefined && Number.isFinite(scope.lowerBound) && turn.startedAt * 1000 >= scope.lowerBound)));
      const last = turns.at(-1);
      if (last) {
        node.status = status(last.status);
        node.observedAt = last.lifecycleUnfinished && !snapshot.nativeActive && !live(parent.status) ? undefined : snapshot.readAt;
        if (last.startedAt != null) node.startedAt = last.startedAt * 1000;
        if (last.completedAt != null) node.completedAt = last.completedAt * 1000;
        if (last.durationMs != null) node.durationMs = last.durationMs;
        if (last.result) node.result = last.result;
      }
      if (!hasLaterWork && !isReused && snapshot.model) node.model = snapshot.model;
      if (!hasLaterWork && !isReused && snapshot.tokenCount != null) node.tokenCount = snapshot.tokenCount;
      if (!node.prompt && snapshot.prompt) node.prompt = snapshot.prompt;
      if ((hasLaterWork || isReused) && !turns.length) graph.warnings.push(`${node.label}: reused-agent history is excluded because this invocation has no reliable historical boundary.`);
      visit(codexCalls(turns.flatMap(turn => turn.items ?? []), snapshot.dispatches), node);
    }
  };
  visit(scope.items, scope.node);
}

/** Bound native traversal; cache only public delegation fields in the owning turn. */
export async function readAgentMap(router, { threadId, turnId }) {
  if (typeof threadId !== 'string' || !threadId) throw new Error('Agent map requires a conversation.');
  if (!router.store.has(threadId)) await router.hydrate(threadId);
  const chat = router.store.require(threadId), row = selectedRow(chat, turnId);
  if (!row) return buildAgentMap(chat, turnId);
  const assertCurrent = () => {
    const current = router.store.require(threadId);
    if (current !== chat || current.turns.find(current => current.turn.id === row.turn.id) !== row) throw new Error('Conversation history changed while reading its agents.');
  };
  const warnings = [], visited = new Set(), deadline = Date.now() + 4500;
  const sources = row.engine === 'codex' ? [{ id: rootId(row.turn.id), sessionId: chat.id, path: chat.thread?.path, prefix: '', items: row.turn.items, turnIds: [row.turn.id] }]
    : row.engine === 'both' ? (row.runs ?? []).filter(run => run.engine === 'codex' && run.nativeSessionId).map(run => ({ id: run.id, sessionId: run.nativeSessionId, prefix: `${run.id}:`, items: row.turn.items.filter(item => item.cdxRunId === run.id) })) : [];
  for (const source of sources) {
    if (Date.now() >= deadline) { warnings.push('Some delegation details were deferred because the refresh time limit was reached.'); break; }
    const activities = source.items.filter(item => item.type === 'subAgentActivity');
    if (!activities.length) continue;
    const previous = row.agentHistory?.[source.id];
    if (previous && Date.now() - previous.readAt < 1500) continue;
    try {
      const path = source.path ?? previous?.path ?? (await boundedRead(() => router.native.request('thread/read', { threadId: source.sessionId, includeTurns: false }), Math.min(1500, Math.max(1, deadline - Date.now())))).thread?.path;
      if (!path) { warnings.push('Original Codex delegation arguments are unavailable for this native session.'); continue; }
      const history = await boundedRead(() => readCodexAgentHistory(path, { callIds: activities.map(item => source.prefix && item.id.startsWith(source.prefix) ? item.id.slice(source.prefix.length) : item.id), ...(source.turnIds ? { turnIds: source.turnIds } : {}) }), Math.max(1, deadline - Date.now()));
      assertCurrent();
      warnings.push(...(history.warnings ?? []));
      (row.agentHistory ??= {})[source.id] = { ...history, path, readAt: Date.now(), dispatches: Object.fromEntries(Object.entries(history.dispatches).map(([id, dispatch]) => [source.prefix + id, dispatch])) };
      router.store.save(chat);
    } catch (error) { warnings.push(`Codex delegation details: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let graph = buildAgentMap(chat, row.turn.id);
  // Constrain work per read and preserve known nodes when native history fails.
  for (let depth = 0; depth < 8; depth++) {
    const pending = graph.nodes.filter(node => node.engine === 'codex' && node.sessionId && node.kind === 'subagent' && !visited.has(node.id)).slice(0, 64 - visited.size);
    if (!pending.length) break;
    for (const node of pending) {
      if (Date.now() >= deadline) break;
      visited.add(node.id);
      const previous = row.agentThreads?.[node.id];
      if (previous && Date.now() - previous.readAt < 1500) continue;
      try {
        const thread = await boundedRead(() => router.readNativeThread(node.sessionId), Math.min(2000, Math.max(1, deadline - Date.now())));
        if (thread.id !== node.sessionId) throw new Error('Native child history identity mismatch.');
        const inherited = inheritedTurns(chat, row, graph, node);
        const snapshot = { readAt: Date.now(), nativeActive: thread.status?.type === 'active', agentNickname: text(thread.agentNickname), model: text(thread.model), turns: (thread.turns ?? []).filter(turn => !inherited.has(turn.id)).map(turn => ({ id: turn.id, status: turn.status, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs,
          items: (turn.items ?? []).filter(item => (isCollab(item) && item.senderThreadId === thread.id) || item.type === 'subAgentActivity').map(clone), result: (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').map(item => item.text).join('\n') || undefined })) };
        if (thread.path) {
          const history = await boundedRead(() => readCodexAgentHistory(thread.path, { callIds: snapshot.turns.flatMap(turn => turn.items).filter(item => item.type === 'subAgentActivity').map(item => item.id), turnIds: snapshot.turns.map(turn => turn.id) }), Math.max(1, deadline - Date.now()));
          snapshot.dispatches = history.dispatches;
          for (const turn of snapshot.turns) {
            const lifecycle = history.turnStates?.[turn.id];
            if (!lifecycle) continue;
            turn.status = lifecycle.status;
            turn.lifecycleUnfinished = lifecycle.status === 'running';
            if (lifecycle.startedAt != null) turn.startedAt = lifecycle.startedAt / 1000;
            if (lifecycle.completedAt != null) turn.completedAt = lifecycle.completedAt / 1000;
            if (lifecycle.startedAt != null && lifecycle.completedAt != null) turn.durationMs = lifecycle.completedAt - lifecycle.startedAt;
          }
          if (history.model) snapshot.model = history.model;
          if (history.tokenCount != null) snapshot.tokenCount = history.tokenCount;
          warnings.push(...(history.warnings ?? []));
        }
        // Edits/rollbacks can remove the selected turn while native I/O is pending.
        assertCurrent();
        (row.agentThreads ??= {})[node.id] = snapshot;
        router.store.save(chat);
      } catch (error) { warnings.push(`${node.label}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    assertCurrent();
    graph = buildAgentMap(chat, row.turn.id);
    if (Date.now() >= deadline) break;
  }
  if (graph.nodes.some(node => node.engine === 'codex' && node.sessionId && node.kind === 'subagent' && !visited.has(node.id))) warnings.push('Some nested agents were omitted from this refresh because the history traversal limit was reached.');
  assertCurrent();
  return { ...graph, warnings: [...graph.warnings, ...warnings] };
}
