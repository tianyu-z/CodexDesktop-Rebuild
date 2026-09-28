import { createServer } from 'node:http';
import { chmod, mkdir, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

/** One durable engine owner, independent of the transient desktop connection. */
export async function startRemoteServer({ socketPath, runtimeFactory, version = 'development', maxPayload = 16 * 1024 * 1024, maxInFlight = 64 }) {
  const http = createServer((request, response) => {
    if (request.url === '/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, version })); return; }
    response.writeHead(404); response.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const pending = new Map(), tasks = new Set();
  let controller, initialization, initialized = false, closing, inFlight = 0, controls = 0;
  const send = (ws, message) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    // History is persisted by the router; slow clients reconnect and read it.
    if (ws.bufferedAmount > maxPayload * 2) { ws.terminate(); return; }
    ws.send(JSON.stringify(message));
  };
  const emit = message => {
    if (message.method === 'serverRequest/resolved') pending.delete(message.params?.requestId);
    if (message.id != null && message.method) {
      if (pending.size >= 1024) {
        queueMicrotask(() => runtime.respond({ id: message.id, error: { code: -32000, message: 'Too many pending approvals.' } }));
        return;
      }
      pending.set(message.id, structuredClone(message));
    }
    if (controller?.ready) send(controller.ws, message);
  };
  const runtime = await runtimeFactory({ emit, onExit: () => { void close(); } });
  // A disconnected peer must not leave an await/then closure on an initialization
  // that may never settle. Keep one removable subscriber per live controller.
  function finishInitialization(state, result, error) {
    if (error) { if (initialization === state) initialization = undefined; }
    else { state.result = result; state.ready = true; }
    for (const [peer, id] of state.waiters) {
      if (!error) peer.initialized = true;
      send(peer.ws, { id, ...(error ? { error: { code: error.code ?? -32000, message: error.message } } : { result }) });
    }
    state.waiters.clear();
  }
  function beginInitialization(state, params) {
    Promise.resolve().then(() => runtime.request('initialize', params)).then(
      result => finishInitialization(state, result), error => finishInitialization(state, null, error));
  }
  http.on('upgrade', (request, socket, head) => {
    if (closing || request.url !== '/rpc') { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    const peer = { ws, ready: false, claimed: false, alive: true };
    ws.on('pong', () => { peer.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => { initialization?.waiters.delete(peer); if (controller === peer) controller = undefined; });
    ws.on('message', bytes => {
      const task = (async () => {
        let message;
        try { message = JSON.parse(bytes); }
        catch { send(ws, { id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const respond = result => send(ws, { id: message.id, result });
        try {
          if (message.method === 'initialize') {
            if (peer.claimed) throw Error('This controller has already requested initialization.');
            if (controller && controller !== peer && controller.ws.readyState === WebSocket.OPEN) throw Error('Another desktop controller is connected to this gateway.');
            controller = peer; peer.claimed = true;
            if (initialization?.ready) { peer.initialized = true; respond(initialization.result); return; }
            const start = !initialization;
            initialization ??= { ready: false, waiters: new Map() };
            initialization.waiters.set(peer, message.id);
            if (start) beginInitialization(initialization, message.params);
            return;
          }
          if (controller !== peer || !peer.claimed) throw Error('Initialize this controller before making engine requests.');
          if (message.method === 'initialized') {
            if (!peer.initialized) throw Error('Initialization did not finish.');
            if (!initialized) { initialized = true; runtime.notify({ method: 'initialized' }); }
            peer.ready = true;
            for (const approval of pending.values()) send(ws, approval);
            return;
          }
          if (message.method == null) {
            if (pending.has(message.id) && runtime.respond(message)) pending.delete(message.id);
            return;
          }
          if (!peer.ready) throw Error('Send initialized before making engine requests.');
          if (message.id == null) { runtime.notify(message); return; }
          const control = ['turn/interrupt', 'engine/runs/interrupt'].includes(message.method);
          if (control ? controls >= 16 : inFlight >= maxInFlight) throw Error('Too many in-flight engine requests. Retry after a request finishes.');
          if (control) controls++; else inFlight++;
          try { respond(await runtime.request(message.method, message.params)); }
          finally { if (control) controls--; else inFlight--; }
        } catch (error) {
          if (message.id != null) send(ws, { id: message.id, error: { code: error.code ?? -32000, message: error.message } });
        }
      })();
      tasks.add(task); task.finally(() => tasks.delete(task));
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.__awaitingPong) { ws.terminate(); continue; }
      ws.__awaitingPong = true;
      ws.once('pong', () => { ws.__awaitingPong = false; });
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.terminate();
      await runtime.close();
      await Promise.allSettled([...tasks]);
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => http.close(resolve));
      try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return closing;
  }
  try {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())) throw Error('Gateway socket requires a private, owned directory.');
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) { clearInterval(heartbeat); await runtime.close(); sockets.close(); http.close(); throw error; }
  return { close, socketPath };
}
