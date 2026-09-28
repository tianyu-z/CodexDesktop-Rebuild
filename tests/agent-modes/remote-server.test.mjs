import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { runInNewContext } from 'node:vm';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { startRemoteServer } from '../../runtime/agent-modes/remote/server.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cdx-remote-test-'));
  let emit, starts = 0, initialized = 0, finished = false, pending = null, closed = false, releaseInitialization, busy = false;
  const blocked = [], notifications = [], requests = [];
  const server = await startRemoteServer({ ...options, socketPath: join(dir, 'rpc.sock'), runtimeFactory: callbacks => {
    emit = callbacks.emit;
    return { request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'initialize') { initialized++; if (options.pauseInitialize) return new Promise(resolve => { releaseInitialization = () => resolve({ userAgent: 'fixture' }); }); return { userAgent: 'fixture' }; }
      if (method === 'getAuthStatus') return { authMethod: 'apikey', requiresOpenaiAuth: false };
      if (method === 'turn/start') {
        starts++;
        setTimeout(() => { if (params.approve) { pending = 'approval:one'; emit({ id: pending, method: 'item/tool/requestUserInput', params: { threadId: 'remote-chat' } }); }
          else { finished = true; emit({ method: 'turn/completed', params: { threadId: 'remote-chat' } }); } }, 20);
        return { turn: { id: 'turn-one' } };
      }
      if (method === 'thread/read') return { finished, starts, initialized, pending };
      if (method === 'config/read') return new Promise(resolve => blocked.push(resolve));
      if (method === 'turn/interrupt') return { interrupted: true };
      throw Error('unknown method');
    }, respond: message => { if (message.id === pending) { pending = null; finished = message.result.decision === 'accept'; emit({ method: 'serverRequest/resolved', params: { requestId: message.id } }); return true; } return false; },
    notify: message => notifications.push(message), isBusy: () => busy, close: async () => { closed = true; releaseInitialization?.(); blocked.forEach(resolve => resolve({})); } };
  } });
  t.after(async () => { await server.close(); assert.equal(closed, true); await rm(dir, { recursive: true, force: true }); });
  const connect = async () => {
    const ws = new WebSocket('ws+unix://' + join(dir, 'rpc.sock') + ':/rpc');
    const inbox = [], waiters = [];
    ws.on('message', bytes => { const message = JSON.parse(bytes); const next = waiters.shift(); if (next) next(message); else inbox.push(message); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiters.push(resolve));
    return { ws, next, send: message => ws.send(JSON.stringify(message)), disconnect: () => new Promise(resolve => { ws.once('close', resolve); ws.terminate(); }) };
  };
  const http = path => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: join(dir, 'rpc.sock'), path, method: path.startsWith('/shutdown') ? 'POST' : 'GET' }, res => {
      let body = ''; res.on('data', bytes => body += bytes); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(body) }));
    }); req.on('error', reject); req.end();
  });
  return { connect, dir, http, notifications, requests, setBusy: value => { busy = value; }, releaseInitialization: () => releaseInitialization() };
}
test('pinned desktop completes its initialize-to-auth handshake without an initialized notification', { timeout: 5000 }, async t => {
  const source = await readFile(new URL('../../src/mac-arm64/_asar/.vite/build/src-DJnwJvdz.js', import.meta.url), 'utf8');
  const extract = (start, end) => {
    assert.equal(source.split(start).length, 2, 'Expected one pinned desktop method');
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(to > from); return source.slice(from, to);
  };
  const methods = [extract('async completeInitialization(){', 'async startAppServerProcess(){'),
    extract('async getPostInitializeConnectionState(){', 'async refreshAuthenticatedConnectionState(){'),
    extract('async requestAuthStatus(e,t=!0){', 'async listSkills(e){')];
  const app = runInNewContext('({' + methods.join(',') + '})', { XU: '__codex_initialize__', BG: 1000, s: { randomUUID: () => 'fixture' } });
  const f = await fixture(t), c = await f.connect();
  c.send({ id: '__codex_initialize__', method: 'initialize', params: {} });
  assert.equal((await c.next()).id, '__codex_initialize__');
  Object.assign(app, { options: { ensureAuth: true, transport: { kind: 'websocket' } }, logger: { info() {} }, getInitializeDurationMs: () => 0,
    clearInitializeTimeoutTimer() {}, setConnectionProgress() {}, getAuthStatusTimeoutMs: () => 5000,
    sendInternalRequest: async message => { c.send(message); return await c.next(); },
    messageDelivery: { broadcastToWindows() {} }, getInitializationMessage: () => ({}),
    setConnectionState(state) { this.connectionState = state; }, startNetworkConnectivityTimer() {}, chronicleCoordinator: { reconcile() {} } });
  await app.completeInitialization();
  assert.equal(app.connectionState, 'connected');
  assert.deepEqual(f.requests.find(row => row.method === 'getAuthStatus').params, { includeToken: false, refreshToken: false });
  assert.deepEqual(f.notifications, [{ method: 'initialized' }]);
  await c.disconnect();
});
test('remote socket is private and reconnect observes completion without re-running a turn', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal((await stat(join(f.dir, 'rpc.sock'))).mode & 0o777, 0o600);
  let c = await f.connect();
  c.send({ id: 1, method: 'initialize', params: {} }); assert.equal((await c.next()).id, 1);
  c.send({ method: 'initialized' });
  c.send({ id: 2, method: 'turn/start', params: {} }); assert.equal((await c.next()).id, 2);
  await c.disconnect(); await new Promise(resolve => setTimeout(resolve, 40));
  c = await f.connect();
  c.send({ id: 1, method: 'initialize', params: {} }); assert.equal((await c.next()).id, 1);
  c.send({ method: 'initialized' });
  c.send({ id: 2, method: 'thread/read', params: {} });
  let m; do { m = await c.next(); } while (m.id !== 2);
  assert.deepEqual(m.result, { finished: true, starts: 1, initialized: 1, pending: null });
  await c.disconnect();
});
test('idle upgrade refuses active work but explicit scoped stop can interrupt its own runtime', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.setBusy(true);
  assert.equal((await f.http('/health')).body.busy, true);
  assert.equal((await f.http('/shutdown')).code, 409);
  assert.equal((await f.http('/shutdown?force=1')).code, 200);
});
test('initialization can finish after the originating controller disconnects', { timeout: 5000 }, async t => {
  const f = await fixture(t, { pauseInitialize: true });
  let c = await f.connect(); c.send({ id: 1, method: 'initialize', params: {} });
  c.send({ id: 'too-early', method: 'getAuthStatus', params: { includeToken: false, refreshToken: false } });
  assert.ok((await c.next()).error);
  assert.equal(f.requests.some(row => row.method === 'getAuthStatus'), false);
  await new Promise(resolve => setTimeout(resolve, 10)); await c.disconnect();
  c = await f.connect(); c.send({ id: 2, method: 'initialize', params: {} });
  f.releaseInitialization(); assert.equal((await c.next()).id, 2); c.send({ method: 'initialized' });
  c.send({ id: 3, method: 'thread/read', params: {} }); assert.equal((await c.next()).result.initialized, 1);
  await c.disconnect();
});
test('implicit desktop readiness replays approval once and a later initialized notification is harmless', { timeout: 5000 }, async t => {
  const f = await fixture(t); let c = await f.connect();
  c.send({ id: 1, method: 'initialize', params: {} }); await c.next(); c.send({ method: 'initialized' });
  c.send({ id: 2, method: 'turn/start', params: { approve: true } }); await c.next();
  const approval = await c.next(); await c.disconnect();
  c = await f.connect(); c.send({ id: 1, method: 'initialize', params: {} }); await c.next();
  c.send({ id: 2, method: 'getAuthStatus', params: { includeToken: false, refreshToken: false } });
  assert.deepEqual(await c.next(), approval);
  assert.equal((await c.next()).id, 2);
  c.send({ method: 'initialized' }); c.send({ id: 3, method: 'thread/read', params: {} });
  const read = await c.next(); assert.equal(read.id, 3); assert.equal(read.result.pending, approval.id);
  assert.deepEqual(f.notifications, [{ method: 'initialized' }]);
  await c.disconnect();
});
test('bounded ordinary RPCs retain separate interrupt capacity', { timeout: 5000 }, async t => {
  const f = await fixture(t, { maxInFlight: 2 }), c = await f.connect();
  c.send({ id: 1, method: 'initialize', params: {} }); await c.next(); c.send({ method: 'initialized' });
  c.send({ id: 2, method: 'config/read' }); c.send({ id: 3, method: 'config/read' }); c.send({ id: 4, method: 'config/read' });
  const rejected = await c.next(); assert.equal(rejected.id, 4); assert.match(rejected.error.message, /in.flight/i);
  c.send({ id: 5, method: 'turn/interrupt', params: {} }); assert.deepEqual((await c.next()).result, { interrupted: true });
  await c.disconnect();
});
test('pending approval replays the same ID after reconnect and remains unapproved', { timeout: 5000 }, async t => {
  const f = await fixture(t); let c = await f.connect();
  c.send({ id: 1, method: 'initialize', params: {} }); await c.next(); c.send({ method: 'initialized' });
  c.send({ id: 2, method: 'turn/start', params: { approve: true } }); await c.next();
  const approval = await c.next(); assert.equal(approval.id, 'approval:one');
  await c.disconnect(); c = await f.connect();
  c.send({ id: 1, method: 'initialize', params: {} }); await c.next(); c.send({ method: 'initialized' });
  assert.deepEqual(await c.next(), approval);
  c.send({ id: approval.id, result: { decision: 'decline' } });
  assert.equal((await c.next()).method, 'serverRequest/resolved');
  c.send({ id: 3, method: 'thread/read', params: {} });
  assert.equal((await c.next()).result.finished, false);
  await c.disconnect();
});
test('second controller cannot initialize or answer an approval owned by a live connection', { timeout: 5000 }, async t => {
  const f = await fixture(t), a = await f.connect(), b = await f.connect();
  a.send({ id: 1, method: 'initialize', params: {} }); await a.next(); a.send({ method: 'initialized' });
  a.send({ id: 2, method: 'turn/start', params: { approve: true } }); await a.next();
  const approval = await a.next();
  b.send({ id: 1, method: 'initialize', params: {} }); assert.match((await b.next()).error.message, /controller/i);
  b.send({ id: approval.id, result: { decision: 'accept' } }); assert.ok((await b.next()).error);
  b.send({ id: 2, method: 'turn/start', params: {} }); assert.ok((await b.next()).error);
  a.send({ id: 3, method: 'thread/read', params: {} }); assert.equal((await a.next()).result.pending, approval.id);
  await b.disconnect(); await a.disconnect();
});
