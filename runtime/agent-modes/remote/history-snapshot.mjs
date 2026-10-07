import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { page, presentItem, presentTurn } from '../codex-events.mjs';
import { MiB, OWNER_RESPONSE_BYTES } from './limits.mjs';

const modes = new Set(['codex', 'claude', 'both']);
const engines = new Set(['codex', 'claude', 'both']);
const invalid = message => Object.assign(Error(message), { code: -32000 });
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 1024;
const validTurn = row => isObject(row) && engines.has(row.engine) && isObject(row.turn)
  && validId(row.turn.id) && Array.isArray(row.turn.items)
  && row.turn.items.every(item => isObject(item) && validId(item.id));

/** Invalid or older layouts delegate to the owner; identity failures never do. */
export async function readHistorySnapshot(directory, id, signal) {
  signal?.throwIfAborted();
  let parent;
  try { parent = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw invalid('Conversation snapshot directory cannot be read.'); }
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid())) throw invalid('Conversation snapshot directory ownership is invalid.');
  const path = join(directory, createHash('sha256').update(id).digest('hex') + '.json');
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    if (error.code === 'ELOOP') throw invalid('Conversation snapshot identity is invalid.');
    throw invalid('Conversation snapshot cannot be opened.');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw invalid('Conversation snapshot ownership is invalid.');
    if (stat.size > OWNER_RESPONSE_BYTES) throw invalid('Conversation snapshot exceeds the 128 MiB read limit.');
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, Math.min(MiB, bytes.length - offset), offset);
      if (!bytesRead) throw invalid('Conversation snapshot changed during read.');
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (value?.id !== id || value?.thread?.id && value.thread.id !== id) throw invalid('Conversation snapshot identity mismatch.');
    if (![1, 2].includes(value?.schemaVersion) || !modes.has(value.mode) || !Array.isArray(value.turns)
      || value.thread != null && !isObject(value.thread) || !value.turns.every(validTurn)) return;
    const turnIds = new Set();
    for (const row of value.turns) {
      if (turnIds.has(row.turn.id) || new Set(row.turn.items.map(item => item.id)).size !== row.turn.items.length) return;
      turnIds.add(row.turn.id);
    }
    return value;
  } catch (error) {
    if (error.code === -32000 || signal?.aborted) throw error;
    throw invalid('Conversation snapshot read failed.');
  } finally { await file.close(); }
}

/** Opaque native cursors stay with the owner. A recognizable managed cursor
 * belongs to exactly one thread, turn and page type. */
export function managedCursor(params, kind) {
  if (params.cursor == null) return true;
  if (typeof params.cursor !== 'string' || params.cursor.length > 4096) return false;
  let value;
  try { value = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch { return false; }
  if (!isObject(value) || !['turns', 'items'].includes(value.kind)) return false;
  if (value.kind !== kind || value.threadId !== params.threadId || value.turnId !== (params.turnId ?? null)) throw invalid('History cursor ownership mismatch. Reload the conversation.');
  if (!validId(value.anchor) || typeof value.inclusive !== 'boolean') throw invalid('Invalid engine history cursor. Reload the conversation.');
  return true;
}

/** Return undefined when the owner must supply live content. */
export function historyPage(snapshot, method, params) {
  if (snapshot.pendingHistoryEdit) return;
  const turns = method === 'thread/turns/list';
  const kind = turns ? 'turns' : 'items';
  const active = row => row.engine !== 'claude' && (row.turn.status === 'inProgress' || snapshot.activeTurn?.engine === 'codex' && snapshot.activeTurn.turnId === row.turn.id);
  // Unscoped item cursors can pass the final persisted item while a live Codex
  // turn has streamed more items than the legacy snapshot contains.
  if (!turns && !params.turnId && (snapshot.activeTurn?.engine === 'codex' || snapshot.turns.some(active))) return;
  const capped = { ...params, limit: Math.min(turns ? 20 : 100, Math.max(1, Number.isSafeInteger(params.limit) ? params.limit : turns ? 20 : 100)) };
  const rows = turns ? snapshot.turns.map(row => ({ key: row.turn.id, value: row.turn, engine: row.engine }))
    : snapshot.turns.filter(row => !params.turnId || row.turn.id === params.turnId)
      .flatMap(row => row.turn.items.map(item => ({ key: `${row.turn.id}/${item.id}`, value: item, turnId: row.turn.id, engine: row.engine })));
  const result = page(rows, capped, kind, turns ? {
    present: row => presentTurn(row.value, row.engine, params.itemsView),
    measure: row => Buffer.byteLength(JSON.stringify(params.itemsView === 'notLoaded' ? { ...row.value, items: [] } : row.value)) + 128 * (params.itemsView === 'notLoaded' ? 1 : row.value.items.length + 1),
  } : {
    present: row => ({ turnId: row.turnId, item: presentItem(row.value, row.engine) }),
    measure: row => Buffer.byteLength(JSON.stringify(row.value)) + Buffer.byteLength(row.turnId) + 128,
  });
  if (turns && params.itemsView === 'notLoaded') return result;
  const selected = new Set(result.data.map(row => turns ? row.id : row.turnId));
  if (snapshot.turns.some(row => selected.has(row.turn.id) && active(row))) return;
  if (!turns && params.turnId && snapshot.turns.some(row => row.turn.id === params.turnId && active(row))) return;
  return result;
}
