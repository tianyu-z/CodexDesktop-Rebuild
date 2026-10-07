import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { readRemoteAgentMap } from './agent-map-snapshot.mjs';

const mapMethod = 'engine/agents/read';
const unsupportedMap = error => error?.code === -32601 || typeof error?.message === 'string'
  && /(?:unknown variant|unknown method|unsupported method|method not found)/i.test(error.message) && error.message.includes(mapMethod);

/** Terminate stdio WebSocket framing, keeping one controller on the same owner. */
export function startRemoteProxy({ socketPath, directory, input = process.stdin, output = process.stdout, heartbeatIntervalMs = 30000, onError = () => {}, onClose = () => {} }) {
  const maxPayload = 16 * 1024 * 1024;
  const transport = Duplex.from({ readable: input, writable: output });
  const http = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const pending = new Map(), abort = new AbortController();
  let upstream, downstream, heartbeat, awaitingPong, closed = false, sequence = 0, maps = 0;
  const close = error => {
    if (closed) return;
    closed = true; clearInterval(heartbeat); awaitingPong = undefined;
    abort.abort(Error('Remote gateway proxy disconnected.'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject?.(abort.signal.reason); }
    pending.clear(); upstream?.terminate(); downstream?.terminate(); transport.destroy(); sockets.close(); http.close();
    if (error) onError(error);
    onClose();
  };
  const forward = (socket, bytes, binary = false) => {
    if (closed || socket?.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > maxPayload * 2) { close(Error('Remote gateway proxy is backlogged.')); return false; }
    socket.send(bytes, { binary }); return true;
  };
  const send = (socket, message) => forward(socket, JSON.stringify(message));
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
    if (maps >= 4) { send(downstream, { id: entry.id, error: { code: -32000, message: 'Too many Agent map reads. Retry after a read finishes.' } }); return; }
    maps++;
    try {
      const result = await readRemoteAgentMap({ directory, request, signal: abort.signal }, entry.params);
      send(downstream, { id: entry.id, result });
    } catch (error) { send(downstream, { id: entry.id, error: { code: error.code ?? -32000, message: error.message } }); }
    finally { maps--; }
  };
  http.on('upgrade', (req, socket, head) => {
    if (downstream || upstream || req.url !== '/rpc') { socket.destroy(); return; }
    upstream = new WebSocket('ws+unix://' + socketPath + ':/rpc', { maxPayload, perMessageDeflate: false });
    upstream.on('error', close); upstream.on('close', () => close());
    upstream.on('open', () => {
      if (closed) return;
      sockets.handleUpgrade(req, socket, head, ws => {
        downstream = ws;
        ws.on('error', close); ws.on('close', () => close());
        ws.on('pong', payload => {
          if (awaitingPong?.equals(payload)) awaitingPong = undefined;
        });
        heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (awaitingPong) { close(Error('Remote desktop failed to respond to heartbeat.')); return; }
          awaitingPong = randomBytes(16);
          ws.ping(awaitingPong, error => { if (error) close(error); });
        }, heartbeatIntervalMs);
        heartbeat.unref();
        ws.on('message', (bytes, binary) => {
          let message;
          try { message = JSON.parse(bytes); }
          catch { forward(upstream, bytes, binary); return; }
          if (message?.id != null && message.method != null) {
            try {
              const id = allocate();
              pending.set(id, { id: message.id, method: message.method, params: message.params });
              send(upstream, { ...message, id });
            } catch (error) { send(ws, { id: message.id, error: { code: -32000, message: error.message } }); }
          } else forward(upstream, bytes, binary);
        });
      });
    });
    upstream.on('message', (bytes, binary) => {
      let message;
      try { message = JSON.parse(bytes); }
      catch { forward(downstream, bytes, binary); return; }
      if (message?.id != null && message.method == null) {
        const entry = pending.get(message.id);
        // Timed-out internal reads must never leak into the desktop ID space.
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (entry.resolve) {
          if (message.error) entry.reject(Object.assign(Error(message.error.message), { code: message.error.code }));
          else entry.resolve(message.result);
        } else if (entry.method === mapMethod && unsupportedMap(message.error)) void fallback(entry);
        else send(downstream, { ...message, id: entry.id });
      } else forward(downstream, bytes, binary);
    });
  });
  transport.on('error', close); transport.on('close', () => close());
  http.on('clientError', close);
  http.emit('connection', transport);
  return { close };
}
