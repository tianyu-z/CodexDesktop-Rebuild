import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Duplex } from 'node:stream';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { startRemoteServer } from '../../runtime/agent-modes/remote/server.mjs';
import { startRemoteProxy } from '../../runtime/agent-modes/remote/proxy.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cdx-proxy-liveness-'));
  const socketPath = join(directory, 'rpc.sock');
  let initializations = 0, closed = false;
  const server = await startRemoteServer({ socketPath, runtimeFactory: () => ({
    request: async method => {
      if (method === 'initialize') { initializations++; return { userAgent: 'still-running' }; }
      if (method === 'getAuthStatus') return { authMethod: 'apikey' };
      throw Error('unknown method');
    },
    notify() {}, respond: () => false, close: async () => { closed = true; },
  }) });
  const proxies = [];
  t.after(async () => {
    proxies.forEach(proxy => proxy.close());
    await server.close();
    assert.equal(closed, true);
    await rm(directory, { recursive: true, force: true });
  });
  const connect = async (autoPong = true) => {
    const toProxy = new PassThrough(), fromProxy = new PassThrough();
    const proxy = startRemoteProxy({ socketPath, directory, input: toProxy, output: fromProxy, heartbeatIntervalMs: 30 });
    proxies.push(proxy);
    const transport = Duplex.from({ readable: fromProxy, writable: toProxy });
    const ws = new WebSocket('ws://localhost/rpc', { createConnection: () => transport, autoPong });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const rpc = (id, method) => new Promise(resolve => {
      ws.on('message', function onMessage(bytes) {
        const message = JSON.parse(bytes);
        if (message.id !== id) return;
        ws.off('message', onMessage); resolve(message);
      });
      ws.send(JSON.stringify({ id, method, params: {} }));
    });
    return { ws, rpc, toProxy, fromProxy };
  };
  return { connect, initializations: () => initializations, ownerClosed: () => closed };
}

test('unanswered downstream ping releases controller while owner stays running', { timeout: 5000 }, async t => {
  const f = await fixture(t), first = await f.connect(false);
  assert.equal((await first.rpc(1, 'initialize')).result.userAgent, 'still-running');
  first.ws.on('ping', payload => first.ws.pong(Buffer.from('wrong:' + payload.toString())));
  const close = new Promise(resolve => first.ws.once('close', resolve));
  let timer;
  try {
    assert.equal(await Promise.race([close.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]), true,
      'proxy must close a desktop that does not return the matching pong');
  } finally { clearTimeout(timer); }
  assert.equal(first.toProxy.destroyed, true);
  assert.equal(first.fromProxy.destroyed, true);
  const replacement = await f.connect();
  assert.equal((await replacement.rpc(1, 'initialize')).result.userAgent, 'still-running');
  assert.equal(f.initializations(), 1);
  assert.equal(f.ownerClosed(), false);
});

test('healthy idle desktop survives repeated pings and retains controller exclusion', { timeout: 5000 }, async t => {
  const f = await fixture(t), first = await f.connect();
  assert.equal((await first.rpc(1, 'initialize')).result.userAgent, 'still-running');
  let pings = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('desktop did not receive repeated pings')), 1000);
    first.ws.on('ping', () => { if (++pings === 3) { clearTimeout(timer); resolve(); } });
  });
  assert.equal(first.ws.readyState, WebSocket.OPEN);
  const second = await f.connect();
  assert.match((await second.rpc(1, 'initialize')).error.message, /another desktop controller/i);
  assert.equal(f.initializations(), 1);
});
