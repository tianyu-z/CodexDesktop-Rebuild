import { realpathSync, writeFileSync } from 'node:fs';
import { publicHistory } from './handoff.mjs';

const clone = value => structuredClone(value);
const nativeRow = row => row.engine === 'codex' && !row.nativeDetached;
const idle = chat => {
  if (chat.activeRun || chat.turns.some(row => row.turn.status === 'inProgress')) throw new Error('Finish or interrupt the active run before editing history.');
};
const liveStatus = status => ['inProgress', 'queued', 'preparing', 'running', 'awaitingApproval'].includes(status);
const settle = value => { if (liveStatus(value?.status)) value.status = 'interrupted'; };
const activeNativeRow = (source, row) => nativeRow(row) &&
  (row.turn.status === 'inProgress' || source.activeRun?.engine === 'codex' && source.activeRun.turnId === row.turn.id);

function boundary(chat, method, params) {
  if (method === 'thread/rollback') {
    if (!Number.isSafeInteger(params.numTurns) || params.numTurns < 1 || params.numTurns > chat.turns.length) throw new Error('Invalid rollback turn count.');
    return chat.turns.length - params.numTurns;
  }
  const turnId = method === 'thread/fork' ? params.lastTurnId : params.beforeTurnId;
  if (method === 'thread/fork' && turnId == null) return chat.turns.length;
  const index = chat.turns.findIndex(row => row.turn.id === turnId);
  if (index < 0) throw new Error('History boundary turn does not belong to this conversation.');
  return index + (method === 'thread/fork' ? 1 : 0);
}

async function truncateNative(router, thread, removed) {
  if (!removed.length) return null;
  // Public Claude/workflow turns do not exist in the Codex container. Translate
  // the boundary to its first discarded Codex turn, never a public turn count.
  if (thread.historyMode === 'paginated') return router.native.request('thread/revert', { threadId: thread.id, beforeTurnId: removed[0].turn.id });
  return router.native.request('thread/rollback', { threadId: thread.id, numTurns: removed.length });
}

function detachedSnapshot(source, thread, rows) {
  const { turns: ignored, ...metadata } = thread;
  const next = clone(source);
  next.id = thread.id;
  next.cwd = thread.cwd;
  next.thread = { ...source.thread, ...metadata, status: { type: 'idle' }, preview: rows.flatMap(row => row.turn.items).find(item => item.type === 'userMessage')?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 250) ?? '' };
  next.turns = clone(rows);
  next.activeRun = null; next.activeTurn = null;
  delete next.pendingHistoryEdit;
  next.bindings = {
    // Native Codex retained its own prefix, including handoffs in those turns.
    codex: { sessionId: thread.id, consumedSeq: Math.max(0, ...rows.filter(nativeRow).map(row => row.seq)) },
    // Reusing the old Claude session would retain the removed suffix or share
    // future messages between versions. A fresh session receives public history.
    claude: { sessionId: null, consumedSeq: 0 },
  };
  next.roleBindings = {};
  next.claudeClientActions = [];
  next.claudeCommandRunId = null;
  delete next.claudeActualPermissionMode;
  for (const row of next.turns) {
    row.historyDetached = true;
    settle(row.turn);
    for (const item of row.turn.items) {
      settle(item);
      settle(item.dispatch);
      for (const agent of Object.values(item.agentsStates ?? {})) settle(agent);
    }
    for (const run of row.runs ?? []) { settle(run); delete run.nativeSessionId; }
    // Historical results remain visible, but must not recover mutable native
    // sessions or retry workspaces owned by the previous version.
    if (row.workflow) {
      settle(row.workflow);
      if (row.workflow.state) {
        settle(row.workflow.state);
        row.workflow.state.bindings = {};
        for (const run of row.workflow.state.runs ?? []) { settle(run); delete run.nativeSessionId; }
      }
    }
  }
  return next;
}

function persist(router, snapshot) {
  router.store.replaceIdleHistory(snapshot);
  writeFileSync(router.store.path(snapshot.id).replace(/\.json$/, '.history.txt'), publicHistory(snapshot), { mode: 0o600 });
}

// Called with an actual native snapshot before another operation may run. The
// durable intent survives a crash between native truncation and sidecar commit.
export function recoverHistoryEdit(router, id, nativeThread) {
  const chat = router.store.get(id), pending = chat?.pendingHistoryEdit;
  if (!pending) return;
  const present = new Set(nativeThread.turns.map(turn => turn.id));
  const remaining = pending.removedNativeTurnIds.filter(id => present.has(id));
  if (!remaining.length) { persist(router, pending.snapshot); return 'committed'; }
  else if (remaining.length === pending.removedNativeTurnIds.length) {
    delete chat.pendingHistoryEdit;
    router.store.replaceIdleHistory(chat);
    return 'unchanged';
  } else throw new Error('Native history edit is incomplete. Reload the conversation before continuing.');
}

/** History operations for the unified transcript used by the native edit UI. */
export async function editManagedHistory(router, method, params) {
  const id = params.threadId;
  if (method !== 'thread/fork') idle(router.store.get(id));
  if (method === 'thread/fork') {
    if (params.path || params.ephemeral) throw new Error('Managed history forks require a persistent conversation ID.');
    if (params.cwd && realpathSync(params.cwd) !== realpathSync(router.store.get(id).cwd)) throw new Error('Fork managed history in the same workspace.');
  }
  // Validate against the unified timeline after loading every native page.
  await router.hydrate(id);
  router.assertOpen();
  const source = router.store.get(id);
  if (method !== 'thread/fork') idle(source);
  const index = boundary(source, method, params);
  const retained = source.turns.slice(0, index), removed = source.turns.slice(index);
  if (method !== 'thread/fork') {
    const nativeRemoved = removed.filter(nativeRow);
    const snapshot = detachedSnapshot(source, source.thread, retained);
    snapshot.discardedNativeTurnIds = [...new Set([...(source.discardedNativeTurnIds ?? []), ...nativeRemoved.map(row => row.turn.id)])];
    let result;
    if (nativeRemoved.length) {
      router.store.replaceIdleHistory({ ...source, pendingHistoryEdit: { snapshot, removedNativeTurnIds: nativeRemoved.map(row => row.turn.id) } });
      try {
        result = await truncateNative(router, source.thread, nativeRemoved);
        persist(router, snapshot);
      } catch (error) {
        // A native rejection can leave history unchanged; a lost response or a
        // failed sidecar write may follow a completed truncation. Read to decide.
        let recovered;
        try { recovered = recoverHistoryEdit(router, id, await router.readNativeThread(id)); } catch {}
        if (recovered !== 'committed') throw error;
      }
    } else persist(router, snapshot);
    return { ...result, thread: router.thread(id), engineState: router.state(id) };
  }

  // The source may keep streaming while native I/O runs. Preserve the public
  // partial turn as a detached, interrupted snapshot; native Codex forks only
  // through the last completed turn so later source output cannot leak in.
  const retainedCodex = retained.filter(row => nativeRow(row) && !activeNativeRow(source, row));
  // `lastTurnId` is a public boundary. The native fork ends at the closest
  // retained Codex turn; a Claude-only prefix has no native boundary at all.
  const { lastTurnId, engineMode, engineModel, engineModels, template, roleOverrides, claudePermissionMode, claudeActualPermissionMode, claudeCommandTarget, skipAutoTitleGeneration, ...clean } = params;
  if (source.mode !== 'codex') delete clean.model;
  const result = await router.native.request('thread/fork', { ...clean, excludeTurns: true, ...(retainedCodex.length ? { lastTurnId: retainedCodex.at(-1).turn.id } : {}) });
  const forkId = result.thread?.id;
  if (!forkId || forkId === id) throw new Error('Native fork did not create an independent conversation.');
  try {
    await router.hydrate(forkId);
    let nativeFork = router.store.get(forkId);
    if (!retainedCodex.length && nativeFork.turns.length) {
      await truncateNative(router, nativeFork.thread, nativeFork.turns);
      router.store.remove(forkId);
      await router.hydrate(forkId);
      nativeFork = router.store.get(forkId);
    }
    if (nativeFork.turns.length !== retainedCodex.length) throw new Error('Native fork history does not match the retained Codex prefix.');
    // Older installations used one mutable file for bounded handoffs. A fork
    // must not keep those native prompts pointing into the source conversation.
    const legacyPath = router.store.path(id).replace(/\.json$/, '.history.txt');
    const detachCodex = nativeFork.turns.some(row => JSON.stringify(row.turn.items).includes(legacyPath));
    if (detachCodex) await truncateNative(router, nativeFork.thread, nativeFork.turns);
    let nativeIndex = 0;
    const mapped = retained.map(row => {
      if (!nativeRow(row)) return row;
      if (detachCodex || activeNativeRow(source, row)) return { ...clone(row), nativeDetached: true };
      const copy = clone(row), nativeTurn = nativeFork.turns[nativeIndex++].turn;
      copy.turn = clone(nativeTurn);
      const user = copy.turn.items.find(item => item.type === 'userMessage');
      if (user && copy.originalInput) { user.content = clone(copy.originalInput); copy.firstUserItemId = user.id; }
      for (const run of copy.runs ?? []) if (run.nativeTurnId === row.turn.id) run.nativeTurnId = copy.turn.id;
      return copy;
    });
    const snapshot = detachedSnapshot(source, nativeFork.thread, mapped);
    snapshot.discardedNativeTurnIds = detachCodex ? nativeFork.turns.map(row => row.turn.id) : [];
    snapshot.nativeMaterialized = true;
    persist(router, snapshot);
    return { ...result, thread: router.thread(forkId, { includeTurns: !params.excludeTurns }), engineState: router.state(forkId) };
  } catch (error) {
    // This fork is owned by this failed operation. The source is never changed.
    router.store.remove(forkId);
    await router.native.request('thread/archive', { threadId: forkId }).catch(() => {});
    throw error;
  }
}
