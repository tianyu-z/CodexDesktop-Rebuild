import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { startRemoteServer } from '../../runtime/agent-modes/remote/server.mjs';

function fixture(t, { onRequest, onNotification } = {}) {
  const requests = [], notifications = [];
  const script = `
    const send = m => console.log(JSON.stringify(m));
    let replies = 0;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'fixture/replay') {
        send({id:m.params.id ?? 11,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'item',command:m.params.command ?? 'cat notes.md'}});
      } else if (m.method === 'fixture/resolve') {
        send({method:'serverRequest/resolved',params:{threadId:'thread',requestId:11}});
      } else if (!m.method && m.id === 11) { replies++; return; }
      send({id:m.id,result:{replies}});
    });
  `;
  const client = new NativeClient({ command: process.execPath, args: ['-e', script], env: process.env,
    onRequest: message => { requests.push(message); onRequest?.(message); },
    onNotification: message => { notifications.push(message); onNotification?.(message); } });
  t.after(() => client.close());
  return { client, requests, notifications };
}

test('resume replay preserves one approval identity and resolution removes it entirely', async t => {
  const { client, requests, notifications } = fixture(t);
  for (let i = 0; i < 3; i++) await client.request('fixture/replay', {});
  assert.equal(requests.length, 1, 'A replay must not produce another approval card');
  assert.equal(client.serverRequests.size, 1);
  await client.request('fixture/resolve', {});
  assert.equal(client.serverRequests.size, 0);
  assert.equal(client.serverRequestIds.size, 0);
  assert.deepEqual(notifications, [{ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: requests[0].id } }]);
  assert.equal(client.respond({ id: requests[0].id, result: { decision: 'accept' } }), false);
});

test('replay after a local answer cannot recreate an approval before native resolution', async t => {
  const { client, requests, notifications } = fixture(t);
  await client.request('fixture/replay', {});
  assert.equal(client.respond({ id: requests[0].id, result: { decision: 'decline' } }), true);
  const barrier = await client.request('fixture/replay', {});
  assert.equal(barrier.replies, 1);
  assert.equal(requests.length, 1);
  assert.equal(client.serverRequests.size, 0);
  await client.request('fixture/resolve', {});
  assert.equal(notifications[0].params.requestId, requests[0].id);
});

test('changed approval details retire the old decision before requesting a new one', async t => {
  const { client, requests, notifications } = fixture(t);
  await client.request('fixture/replay', {});
  await client.request('fixture/replay', { command: 'cat updated.md' });
  assert.equal(requests.length, 2);
  assert.notEqual(requests[1].id, requests[0].id);
  assert.deepEqual(notifications, [{ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: requests[0].id } }]);
  assert.equal(client.respond({ id: requests[0].id, result: { decision: 'accept' } }), false);
  assert.equal(requests[1].params.command, 'cat updated.md');
  assert.equal(client.serverRequests.size, 1);
  await client.request('fixture/replay', { id: 12, command: 'cat updated.md' });
  assert.notEqual(requests[2].id, requests[1].id);
  assert.equal(client.serverRequests.size, 2);
});

test('gateway reconnect replays one live approval and stops replaying after native resolution', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cdx-approval-replay-')), socketPath = join(directory, 'rpc.sock');
  const peers = [];
  const server = await startRemoteServer({ socketPath, runtimeFactory: ({ emit }) => {
    const { client } = fixture(t, { onRequest: emit, onNotification: emit });
    return { request: (method, params) => client.request(method, params), notify: () => {},
      respond: message => client.respond(message), close: () => client.close() };
  } });
  t.after(async () => {
    peers.forEach(ws => ws.terminate());
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const connect = async () => {
    const ws = new WebSocket('ws+unix://' + socketPath + ':/rpc'); peers.push(ws);
    const approvals = [], resolved = [], pending = new Map(); let sequence = 0;
    ws.on('message', bytes => {
      const message = JSON.parse(bytes);
      if (message.method && message.id != null) { approvals.push(message); return; }
      if (message.method === 'serverRequest/resolved') resolved.push(message);
      const handler = pending.get(message.id);
      if (handler) { pending.delete(message.id); message.error ? handler.reject(Error(message.error.message)) : handler.resolve(message.result); }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
    });
    await rpc('initialize');
    ws.send(JSON.stringify({ method: 'initialized' }));
    await rpc('fixture/barrier');
    const close = () => new Promise(resolve => { ws.once('close', resolve); ws.close(); });
    return { rpc, approvals, resolved, close };
  };
  const first = await connect();
  for (let i = 0; i < 3; i++) await first.rpc('fixture/replay');
  assert.equal(first.approvals.length, 1);
  const oldId = first.approvals[0].id;
  await first.rpc('fixture/replay', { command: 'cat updated.md' });
  assert.deepEqual(first.resolved.map(m => m.params.requestId), [oldId]);
  assert.equal(first.approvals.length, 2);
  const id = first.approvals[1].id;
  assert.notEqual(id, oldId);
  await first.close();
  const second = await connect();
  assert.deepEqual(second.approvals.map(a => a.id), [id]);
  assert.equal(second.approvals[0].params.command, 'cat updated.md');
  await second.rpc('fixture/resolve');
  assert.deepEqual(second.resolved.map(m => m.params.requestId), [id]);
  await second.close();
  const third = await connect();
  assert.equal(third.approvals.length, 0, 'A completed approval must not return after another reconnect');
});
