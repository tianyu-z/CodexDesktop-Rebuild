/** Public, installed App Server v2 item shapes. Engine attribution is additive. */
export function toolItem(event, cwd) {
  const done = event.type === 'tool-completed';
  const output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? '');
  if (event.name === 'Bash') return {
    id: event.id, type: 'commandExecution', command: event.input?.command ?? '', cwd,
    commandActions: [], status: done ? (event.isError ? 'failed' : 'completed') : 'inProgress',
    aggregatedOutput: done ? output : null, exitCode: null, durationMs: null,
  };
  // Preserve the actual arguments/results; guessing a patch from an Edit/Write
  // request would falsely report a file change before Claude confirms execution.
  return { id: event.id, type: 'dynamicToolCall', namespace: 'claude_code',
    tool: event.name, arguments: event.input ?? {},
    status: done ? (event.isError ? 'failed' : 'completed') : 'inProgress',
    success: done ? !event.isError : null,
    contentItems: done ? [{ type: 'inputText', text: output }] : null,
    durationMs: null,
  };
}

export function presentItem(item, engine) { return { ...structuredClone(item), cdxEngineSource: engine }; }
export function presentTurn(turn, engine) {
  return { ...structuredClone(turn), items: turn.items.map(item => presentItem(item, engine)), cdxEngineSource: engine, itemsView: 'full' };
}

/** Stable anchor cursors survive newly appended turns and support reversing direction. */
export function page(entries, params, kind) {
  const direction = params.sortDirection ?? (kind === 'turns' ? 'desc' : 'asc');
  if (!['asc', 'desc'].includes(direction)) throw new Error('Invalid pagination direction.');
  const ordered = direction === 'desc' ? [...entries].reverse() : [...entries];
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
  const rows = ordered.slice(start, start + limit);
  const cursor = (anchor, inclusive) => Buffer.from(JSON.stringify({ kind, threadId: params.threadId, turnId: params.turnId ?? null, anchor, inclusive })).toString('base64url');
  return { data: rows.map(row => row.value), nextCursor: start + rows.length < ordered.length && rows.length ? cursor(rows.at(-1).key, false) : null,
    backwardsCursor: rows.length ? cursor(rows[0].key, true) : null };
}
