import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { readRemoteAgentMap } from './agent-map-snapshot.mjs';
import { readHistorySnapshot, managedCursor, historyPage } from './history-snapshot.mjs';
import { DESKTOP_REQUEST_BYTES, OWNER_RESPONSE_BYTES, DESKTOP_RESPONSE_BYTES, OUTPUT_QUEUE_BYTES, HARD_OUTPUT_QUEUE_BYTES, sizeError, pressureError } from './limits.mjs';

const mapMethod = 'engine/agents/read';
const pageMethods = new Set(['thread/turns/list', 'thread/items/list']);
const refreshMethods = new Set(['thread/read', 'thread/resume', ...pageMethods]);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 1024;
const ownerPage = (method, result) => result && Array.isArray(result.data)
  && result.data.every(row => method === 'thread/turns/list' ? validId(row?.id) && Array.isArray(row.items)
    : validId(row?.turnId) && validId(row?.item?.id))
  && (result.nextCursor == null || typeof result.nextCursor === 'string')
  && (result.backwardsCursor == null || typeof result.backwardsCursor === 'string');
const mutatesHistory = method => /^(?:turn\/|engine\/runs\/|thread\/)/.test(method)
  && !refreshMethods.has(method) && !['thread/list', 'thread/search'].includes(method);
const unsupportedMap = error => error?.code === -32601 || typeof error?.message === 'string'
  && /(?:unknown variant|unknown method|unsupported method|method not found)/i.test(error.message) && error.message.includes(mapMethod);

/** Terminate stdio WebSocket framing, keeping one controller on the same owner. */
export function startRemoteProxy({ socketPath, directory, input = process.stdin, output = process.stdout, heartbeatIntervalMs = 30000, onError = () => {}, onDiagnostic = () => {}, onClose = () => {} }) {
  const transport = Duplex.from({ readable: input, writable: output });
  const http = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: DESKTOP_REQUEST_BYTES, perMessageDeflate: false });
  const pending = new Map(), abort = new AbortController();
  const ready = new Map(), revisions = new Map(), editing = new Map(), editWaiters = new Map();
  let upstream, downstream, heartbeat, awaitingPong, closed = false, initialized = false, sequence = 0, maps = 0, snapshotReads = 0, waitingPages = 0;
  const safeMethod = method => typeof method === 'string' && /^[A-Za-z0-9/_-]{1,120}$/.test(method) ? method : undefined;
  const diagnostic = (code, details = {}) => Object.assign(Error('Remote gateway connection failed.'), {
    code, direction: details.direction, method: safeMethod(details.method),
    payloadBytes: details.payloadBytes, limitBytes: details.limitBytes,
  });
  const backlog = socket => Math.max(socket.bufferedAmount, socket === downstream ? output.writableLength ?? 0 : 0,
    socket === downstream ? transport.writableLength ?? 0 : 0);
  const close = (error, details = {}) => {
    if (closed) return;
    closed = true; clearInterval(heartbeat); awaitingPong = undefined;
    abort.abort(Error('Remote gateway proxy disconnected.'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject?.(abort.signal.reason); }
    pending.clear(); ready.clear();
    for (const waiters of editWaiters.values()) for (const resolve of waiters) resolve();
    editWaiters.clear(); upstream?.terminate(); downstream?.terminate(); transport.destroy(); sockets.close(); http.close();
    if (error) onError(diagnostic(error.code ?? (error.message.includes('heartbeat') ? 'REMOTE_HEARTBEAT_TIMEOUT' : error.message.includes('backlogged') ? 'REMOTE_OUTPUT_PRESSURE' : 'REMOTE_TRANSPORT_ERROR'), details));
    onClose();
  };
  const forward = (socket, bytes, binary = false, details = {}) => {
    if (closed || socket?.readyState !== WebSocket.OPEN) return false;
    const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
    if (backlog(socket) + size > HARD_OUTPUT_QUEUE_BYTES) {
      close(Error('Remote gateway output is backlogged.'), { ...details, payloadBytes: size, limitBytes: HARD_OUTPUT_QUEUE_BYTES }); return false;
    }
    socket.send(bytes, { binary }, error => { if (error) close(error, details); }); return true;
  };
  const send = (socket, message) => forward(socket, JSON.stringify(message));
  const sendRpc = (socket, message, method) => {
    if (closed || socket?.readyState !== WebSocket.OPEN) return false;
    const bytes = JSON.stringify(message), size = Buffer.byteLength(bytes);
    let rejection;
    if (size > DESKTOP_RESPONSE_BYTES) rejection = sizeError(size, DESKTOP_RESPONSE_BYTES);
    else if (backlog(socket) > OUTPUT_QUEUE_BYTES || backlog(socket) + size > HARD_OUTPUT_QUEUE_BYTES) rejection = pressureError();
    if (rejection) {
      onDiagnostic(diagnostic(size > DESKTOP_RESPONSE_BYTES ? 'REMOTE_RPC_RESPONSE_TOO_LARGE' : 'REMOTE_OUTPUT_PRESSURE',
        { direction: 'desktop-outbound', method, payloadBytes: size, limitBytes: size > DESKTOP_RESPONSE_BYTES ? DESKTOP_RESPONSE_BYTES : HARD_OUTPUT_QUEUE_BYTES }));
      const small = JSON.stringify({ id: message.id, error: rejection });
      if (backlog(socket) + Buffer.byteLength(small) > HARD_OUTPUT_QUEUE_BYTES) {
        close(Error('Remote gateway output is backlogged.'), { direction: 'desktop-outbound', method, payloadBytes: size, limitBytes: HARD_OUTPUT_QUEUE_BYTES }); return false;
      }
      socket.send(small, error => { if (error) close(error, { direction: 'desktop-outbound', method }); });
      return false;
    }
    socket.send(bytes, error => { if (error) close(error, { direction: 'desktop-outbound', method }); });
    return true;
  };
  const allocate = () => {
    if (sequence >= Number.MAX_SAFE_INTEGER || pending.size >= 1024) throw Error('Too many pending proxy requests.');
    return ++sequence;
  };
  const request = (method, params, { timeoutMs = 2000 } = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(abort.signal.reason); return; }
    const id = allocate();
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Remote agent history read timed out.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (!send(upstream, { id, method, params })) { clearTimeout(timer); pending.delete(id); reject(Error('Remote gateway proxy is disconnected.')); }
  });
  const fallback = async entry => {
    if (maps >= 4) { sendRpc(downstream, { id: entry.id, error: { code: -32000, message: 'Too many Agent map reads. Retry after a read finishes.' } }, entry.method); return; }
    maps++;
    try {
      const result = await readRemoteAgentMap({ directory, request, signal: abort.signal }, entry.params);
      sendRpc(downstream, { id: entry.id, result }, entry.method);
    } catch (error) { sendRpc(downstream, { id: entry.id, error: { code: error.code ?? -32000, message: error.message } }, entry.method); }
    finally { maps--; }
  };
  let generation = 0;
  const revision = id => revisions.get(id) ?? 0;
  const invalidate = id => {
    if (!validId(id)) return;
    revisions.delete(id); revisions.set(id, ++generation); ready.delete(id);
    if (revisions.size > 1024) revisions.delete(revisions.keys().next().value);
  };
  const refresh = id => {
    if (!validId(id) || !initialized || editing.get(id)) return;
    ready.delete(id); ready.set(id, revision(id));
    if (ready.size > 128) ready.delete(ready.keys().next().value);
  };
  const settleEdit = id => {
    const count = (editing.get(id) ?? 1) - 1;
    if (count) { editing.set(id, count); return; }
    editing.delete(id);
    for (const resolve of editWaiters.get(id) ?? []) resolve();
    editWaiters.delete(id);
  };
  const waitForEdits = id => {
    if (!editing.get(id)) return Promise.resolve();
    if (waitingPages >= 1024) return Promise.reject(Error('Too many pages waiting for a history edit. Retry this read.'));
    waitingPages++;
    return new Promise(resolve => {
      if (!editWaiters.has(id)) editWaiters.set(id, new Set());
      editWaiters.get(id).add(resolve);
    }).finally(() => { waitingPages--; });
  };
  const cappedParams = (method, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
    if (pageMethods.has(method)) return { ...params, limit: Math.min(method === 'thread/turns/list' ? 20 : 100,
      Math.max(1, Number.isSafeInteger(params.limit) ? params.limit : method === 'thread/turns/list' ? 20 : 100)) };
    if (['thread/read', 'thread/resume'].includes(method) && params.initialTurnsPage && typeof params.initialTurnsPage === 'object')
      return { ...params, initialTurnsPage: { ...params.initialTurnsPage, limit: Math.min(20, Math.max(1, Number.isSafeInteger(params.initialTurnsPage.limit) ? params.initialTurnsPage.limit : 20)) } };
    return params;
  };
  const forwardRequest = (message, params) => {
    const id = allocate();
    const threadId = params?.threadId;
    const mutation = mutatesHistory(message.method) && validId(threadId);
    if (mutation) { invalidate(threadId); editing.set(threadId, (editing.get(threadId) ?? 0) + 1); }
    pending.set(id, { id: message.id, method: message.method, params, mutation, threadId, revision: revision(threadId) });
    if (!send(upstream, { ...message, params, id })) {
      pending.delete(id);
      if (mutation) settleEdit(threadId);
      sendRpc(downstream, { id: message.id, error: { code: -32000, message: 'Remote gateway proxy is disconnected.' } }, message.method);
    }
  };
  const trySnapshot = async (message, params) => {
    const id = params?.threadId, kind = message.method === 'thread/turns/list' ? 'turns' : 'items';
    if (!validId(id) || !initialized) return false;
    try {
      await waitForEdits(id);
      if (closed) return true;
      if (ready.get(id) !== revision(id)) return false;
      if (!managedCursor(params, kind)) return false;
      if (snapshotReads >= 4) return false;
      snapshotReads++;
      const before = revision(id);
      let snapshot;
      try { snapshot = await readHistorySnapshot(directory, id, abort.signal); }
      finally { snapshotReads--; }
      if (closed) return true;
      if (before !== revision(id) || ready.get(id) !== before || editing.get(id)) {
        await waitForEdits(id);
        return !closed ? false : true;
      }
      if (!snapshot) return false;
      const result = historyPage(snapshot, message.method, params);
      if (!result) return false;
      sendRpc(downstream, { id: message.id, result }, message.method);
      return true;
    } catch (error) {
      if (closed) return true;
      sendRpc(downstream, { id: message.id, error: { code: error.code ?? -32000, message: error.message } }, message.method);
      return true;
    }
  };
  http.on('upgrade', (req, socket, head) => {
    if (downstream || upstream || req.url !== '/rpc') { socket.destroy(); return; }
    upstream = new WebSocket('ws+unix://' + socketPath + ':/rpc', { maxPayload: OWNER_RESPONSE_BYTES, perMessageDeflate: false });
    upstream.on('error', error => close(error, { direction: 'owner-inbound', limitBytes: OWNER_RESPONSE_BYTES })); upstream.on('close', () => close());
    upstream.on('open', () => {
      if (closed) return;
      sockets.handleUpgrade(req, socket, head, ws => {
        downstream = ws;
        ws.on('error', error => close(error, { direction: 'desktop-inbound', limitBytes: DESKTOP_REQUEST_BYTES })); ws.on('close', () => close());
        ws.on('pong', payload => {
          if (awaitingPong?.equals(payload)) awaitingPong = undefined;
        });
        heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (awaitingPong) { close(Error('Remote desktop failed to respond to heartbeat.'), { direction: 'desktop-inbound' }); return; }
          awaitingPong = randomBytes(16);
          ws.ping(awaitingPong, error => { if (error) close(error, { direction: 'desktop-inbound' }); });
        }, heartbeatIntervalMs);
        heartbeat.unref();
        ws.on('message', (bytes, binary) => {
          let message;
          try { message = JSON.parse(bytes); }
          catch { forward(upstream, bytes, binary, { direction: 'owner-outbound' }); return; }
          if (message?.id != null && message.method != null) {
            try {
              const params = cappedParams(message.method, message.params);
              if (pageMethods.has(message.method)) void trySnapshot(message, params).then(handled => {
                if (!handled && !closed) forwardRequest(message, params);
              }).catch(error => { if (!closed) sendRpc(ws, { id: message.id, error: { code: -32000, message: error.message } }, message.method); });
              else forwardRequest(message, params);
            } catch (error) { sendRpc(ws, { id: message.id, error: { code: -32000, message: error.message } }, message.method); }
          } else forward(upstream, bytes, binary, { direction: 'owner-outbound' });
        });
      });
    });
    upstream.on('message', (bytes, binary) => {
      let message;
      try { message = JSON.parse(bytes); }
      catch { forward(downstream, bytes, binary, { direction: 'desktop-outbound' }); return; }
      if (message?.id != null && message.method == null) {
        const entry = pending.get(message.id);
        // Timed-out internal reads must never leak into the desktop ID space.
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (entry.resolve) {
          if (message.error) entry.reject(Object.assign(Error(message.error.message), { code: message.error.code }));
          else entry.resolve(message.result);
          return;
        }
        if (entry.mutation) settleEdit(entry.threadId);
        if (entry.method === mapMethod && unsupportedMap(message.error)) { void fallback(entry); return; }
        const delivered = sendRpc(downstream, { ...message, id: entry.id }, entry.method);
        if (!delivered || message.error) return;
        if (entry.method === 'initialize') initialized = true;
        else if (validId(entry.params?.threadId) && refreshMethods.has(entry.method) && entry.revision === revision(entry.params.threadId)
          && (pageMethods.has(entry.method) ? ownerPage(entry.method, message.result)
            && ['nextCursor', 'backwardsCursor'].every(field => {
              const cursor = message.result[field];
              if (cursor == null) return true;
              try { return managedCursor({ ...entry.params, cursor }, entry.method === 'thread/turns/list' ? 'turns' : 'items'); }
              catch { return false; }
            }) : message.result?.thread?.id === entry.params.threadId)) refresh(entry.params.threadId);
      } else {
        if (message?.method === 'thread/deleted') invalidate(message.params?.threadId);
        forward(downstream, bytes, binary, { direction: 'desktop-outbound' });
      }
    });
  });
  transport.on('error', error => close(error, { direction: 'desktop-inbound' })); transport.on('close', () => close());
  http.on('clientError', error => close(error, { direction: 'desktop-inbound' }));
  http.emit('connection', transport);
  return { close };
}
