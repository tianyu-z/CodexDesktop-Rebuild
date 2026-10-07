import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { readAgentMap } from '../agent-map.mjs';

const maxSnapshotBytes = 32 * 1024 * 1024;
const modes = new Set(['codex', 'claude', 'both']);
const validTurn = turn => typeof turn?.id === 'string' && Array.isArray(turn.items);

async function loadSnapshot(directory, id) {
  const path = join(directory, createHash('sha256').update(id).digest('hex') + '.json');
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxSnapshotBytes) throw Error('Conversation snapshot exceeds the Agent map read limit.');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('Conversation snapshot changed during the Agent map read.');
      offset += bytesRead;
    }
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw Error('Invalid JSON in the conversation snapshot.'); }
    if (![1, 2].includes(value?.schemaVersion) || value.id !== id || !Array.isArray(value.turns)
      || !value.turns.every(row => modes.has(row?.engine) && validTurn(row.turn))) throw Error('Invalid conversation snapshot for the Agent map.');
    return value;
  } finally { await file.close(); }
}

/** Each call owns a detached snapshot. Never construct the writable owner store. */
export async function readRemoteAgentMap({ directory, request, signal }, params = {}) {
  const { threadId } = params;
  if (typeof threadId !== 'string' || !threadId || threadId.length > 1024) throw Error('Agent map requires a conversation.');
  const deadline = Date.now() + 4500;
  const nativeRequest = async (method, params) => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('Remote agent history read timed out.');
    const result = await request(method, params, { timeoutMs: Math.min(2000, remaining), signal });
    if (method === 'thread/read' && result?.thread?.id !== params.threadId) throw Error('Native child history identity mismatch.');
    return result;
  };
  const readNativeThread = async id => {
    let result;
    try { result = await nativeRequest('thread/read', { threadId: id, includeTurns: true }); }
    catch (error) {
      if (!/paginated|full.history|includeTurns|list_turns is not supported yet/i.test(error.message)) throw error;
      result = await nativeRequest('thread/read', { threadId: id, includeTurns: false });
    }
    const thread = result.thread;
    if (!thread.ephemeral && (thread.historyMode === 'paginated' || !Array.isArray(thread.turns))) {
      thread.turns = [];
      let cursor;
      const visited = new Set();
      for (let page = 0; page < 10; page++) {
        const result = await nativeRequest('thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data) || !result.data.every(validTurn)) throw Error('Invalid native history page for the Agent map.');
        thread.turns.push(...result.data);
        if (thread.turns.length > 1000) throw Error('Native agent history exceeded the turn read limit.');
        cursor = result.nextCursor;
        if (!cursor) break;
        if (typeof cursor !== 'string' || visited.has(cursor)) throw Error('Native history pagination repeated or returned an invalid cursor.');
        visited.add(cursor);
        if (page === 9) throw Error('Native agent history exceeded the page read limit.');
      }
    }
    return thread;
  };
  let chat = await loadSnapshot(directory, threadId);
  const requireChat = id => {
    if (id !== threadId || !chat) throw Error('Unknown conversation for the Agent map.');
    return chat;
  };
  const router = {
    native: { request: nativeRequest }, readNativeThread,
    store: { has: id => id === threadId && !!chat, require: requireChat,
      get: id => id === threadId && chat ? structuredClone(chat) : null, save() {} },
    hydrate: async id => {
      const thread = await readNativeThread(id);
      // A public read can materialize an owner's snapshot. Prefer its engine
      // provenance and workflow metadata when it becomes available.
      chat = await loadSnapshot(directory, id);
      if (chat) return;
      if (!Array.isArray(thread.turns) || !thread.turns.every(validTurn)) throw Error('Native conversation history is unavailable for the Agent map.');
      chat = { id, thread, turns: thread.turns.map(turn => {
        const engine = modes.has(turn.cdxEngineSource) ? turn.cdxEngineSource : 'codex';
        return { engine, turn, runs: [] };
      }) };
    },
  };
  return readAgentMap(router, params);
}
