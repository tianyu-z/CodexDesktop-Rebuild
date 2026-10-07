/** Public, installed App Server v2 item shapes. Engine attribution is additive. */
export function toolItem(event, cwd) {
  const done = event.type === 'tool-completed';
  const output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? '');
  const metadata = {
    ...(typeof event.parentToolUseId === 'string' && event.parentToolUseId ? { cdxParentToolUseId: event.parentToolUseId } : {}),
    ...(Number.isFinite(event.startedAt) ? { startedAt: event.startedAt } : {}),
    ...(Number.isFinite(event.completedAt) ? { completedAt: event.completedAt } : {}),
    ...(typeof event.model === 'string' && event.model ? { model: event.model } : {}),
    durationMs: Number.isFinite(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null,
  };
  if (event.name === 'Bash') return {
    id: event.id, type: 'commandExecution', command: event.input?.command ?? '', cwd,
    commandActions: [], status: done ? (event.isError ? 'failed' : 'completed') : 'inProgress',
    aggregatedOutput: done ? output : null, exitCode: null, ...metadata,
  };
  // Preserve the actual arguments/results; guessing a patch from an Edit/Write
  // request would falsely report a file change before Claude confirms execution.
  return { id: event.id, type: 'dynamicToolCall', namespace: 'claude_code',
    tool: event.name, arguments: event.input ?? {},
    status: done ? (event.isError ? 'failed' : 'completed') : 'inProgress',
    success: done ? !event.isError : null,
    contentItems: done ? [{ type: 'inputText', text: output }] : null,
    ...metadata,
  };
}

export function presentItem(item, engine) {
  const source = engine === 'both' && ['codex', 'claude'].includes(item.cdxEngineSource) ? item.cdxEngineSource : engine;
  return { ...structuredClone(item), cdxEngineSource: source };
}
export function presentTurn(turn, engine, itemsView = 'full') {
  const { items, ...metadata } = turn;
  const unloaded = itemsView === 'notLoaded';
  return { ...structuredClone(metadata), items: unloaded ? [] : (items ?? []).map(item => presentItem(item, engine)), cdxEngineSource: engine, itemsView: unloaded ? 'notLoaded' : 'full' };
}

/** Stable anchor cursors survive newly appended turns and support reversing direction.
 * A size-changing presenter should provide a conservative measure alongside present.
 */
export function page(entries, params, kind, presenter = row => row.value) {
  const direction = params.sortDirection ?? (kind === 'turns' ? 'desc' : 'asc');
  if (!['asc', 'desc'].includes(direction)) throw new Error('Invalid pagination direction.');
  const ordered = direction === 'desc' ? [...entries].reverse() : entries;
  let start = 0;
  if (params.cursor) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString()); } catch { throw new Error('Invalid engine history cursor. Reload the conversation.'); }
    if (cursor.kind !== kind || cursor.threadId !== params.threadId || cursor.turnId !== (params.turnId ?? null)) throw new Error('History cursor ownership mismatch. Reload the conversation.');
    start = ordered.findIndex(row => row.key === cursor.anchor);
    if (start < 0) throw new Error('History cursor anchor is unavailable. Reload the conversation.');
    if (!cursor.inclusive) start++;
  }
  const limit = Math.min(500, Math.max(1, params.limit ?? 50));
  const byteTarget = Number.isSafeInteger(params.byteTargetBytes) && params.byteTargetBytes > 0 ? Math.min(8 * 1024 * 1024, params.byteTargetBytes) : 8 * 1024 * 1024;
  const present = typeof presenter === 'function' ? presenter : presenter.present;
  const measure = typeof presenter === 'function' ? row => Buffer.byteLength(JSON.stringify(row.value)) : (presenter.measure ?? (row => Buffer.byteLength(JSON.stringify(row.value))));
  const rows = [];
  let bytes = 2; // JSON array brackets; one comma between entries.
  for (let index = start; index < ordered.length && rows.length < limit; index++) {
    const row = ordered[index];
    const nextBytes = measure(row) + (rows.length ? 1 : 0);
    if (rows.length && bytes + nextBytes > byteTarget) break;
    rows.push(row);
    bytes += nextBytes;
  }
  const cursor = (anchor, inclusive) => Buffer.from(JSON.stringify({ kind, threadId: params.threadId, turnId: params.turnId ?? null, anchor, inclusive })).toString('base64url');
  return { data: rows.map(present), nextCursor: start + rows.length < ordered.length && rows.length ? cursor(rows.at(-1).key, false) : null,
    backwardsCursor: rows.length ? cursor(rows[0].key, true) : null };
}
