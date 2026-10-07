import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { promisify } from 'node:util';
import WebSocket, { WebSocketServer } from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { startRemoteProxy } from '../../runtime/agent-modes/remote/proxy.mjs';
import { startRemoteServer } from '../../runtime/agent-modes/remote/server.mjs';
import { readHistorySnapshot } from '../../runtime/agent-modes/remote/history-snapshot.mjs';

const MiB = 1024 * 1024;
const snapshot = (turns, extra = {}) => ({ schemaVersion: 2, id: 'chat', mode: 'codex', thread: { id: 'chat' }, turns: turns.map((turn, i) => ({ engine: 'codex', turn: { id: `t${i}`, status: 'completed', items: [{ id: `i${i}`, type: 'agentMessage', text: turn }] } })), ...extra });

async function fixture(t, handler, { legacy = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cdx-history-proxy-'));
  const socketPath = join(directory, 'rpc.sock');
  const file = join(directory, createHash('sha256').update('chat').digest('hex') + '.json');
  const calls = [], proxies = [], errors = [], diagnostics = [], ownerSockets = new Set();
  let owner;
  if (legacy) {
    const http = createServer();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * MiB, perMessageDeflate: false });
    http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
      ownerSockets.add(ws); ws.on('close', () => ownerSockets.delete(ws));
      ws.on('message', bytes => {
        const message = JSON.parse(bytes); calls.push(message);
        if (message.method == null) return;
        Promise.resolve(handler(message.method, message.params ?? {}, message)).then(result => ws.send(JSON.stringify({ id: message.id, result })), error => ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error.message } })));
      });
    }));
    await new Promise(resolve => http.listen(socketPath, resolve));
    owner = { close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => http.close(resolve)); } };
  } else owner = await startRemoteServer({ socketPath, runtimeFactory: () => ({ request: handler, notify() {}, respond: () => false, close: async () => {} }) });
  t.after(async () => { proxies.forEach(p => p.close()); await owner.close(); await rm(directory, { recursive: true, force: true }); });
  async function connect() {
    const toProxy = new PassThrough(), fromProxy = new PassThrough();
    let paused = false, held;
    const outbound = new Writable({ write(chunk, _encoding, callback) {
      if (paused) held = () => { fromProxy.write(chunk); callback(); };
      else { fromProxy.write(chunk); callback(); }
    } });
    const proxy = startRemoteProxy({ socketPath, directory, input: toProxy, output: outbound, heartbeatIntervalMs: 30000,
      onError: e => errors.push(e), onDiagnostic: detail => diagnostics.push(detail) });
    proxies.push(proxy);
    const transport = Duplex.from({ readable: fromProxy, writable: toProxy });
    const ws = new WebSocket('ws://localhost/rpc', { createConnection: () => transport, maxPayload: 128 * MiB });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const inbox = [], waiters = [];
    ws.on('message', bytes => { const msg = JSON.parse(bytes); const i = waiters.findIndex(w => w.id === msg.id); if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else inbox.push(msg); });
    const next = id => { const i = inbox.findIndex(msg => msg.id === id); return i >= 0 ? Promise.resolve(inbox.splice(i, 1)[0]) : new Promise(resolve => waiters.push({ id, resolve })); };
    const send = (id, method, params = {}) => { ws.send(JSON.stringify({ id, method, params })); return next(id); };
    return { ws, send, next, proxy, fromProxy, toProxy, pauseOutput: () => { paused = true; }, hasHeldOutput: () => !!held,
      resumeOutput: () => { paused = false; held?.(); held = undefined; } };
  }
  return { directory, file, calls, errors, diagnostics, connect, write: value => writeFile(file, JSON.stringify(value)), emit: message => { for (const ws of ownerSockets) ws.send(JSON.stringify(message)); } };
}

test('legacy 28.5 MiB reply crosses the proxy and a later RPC still works', { timeout: 20000 }, async t => {
  const large = 'x'.repeat(Math.floor(28.5 * MiB));
  const f = await fixture(t, method => method === 'big' ? { text: large } : { ok: true });
  const c = await f.connect();
  assert.equal((await c.send(1, 'initialize')).result.ok, true);
  assert.equal((await c.send(2, 'big')).result.text.length, large.length);
  assert.equal((await c.send(3, 'small')).result.ok, true);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test('oversize owner reply gets original ID error without replaying mutation', { timeout: 20000 }, async t => {
  const f = await fixture(t, method => method === 'turn/start' ? { text: 'x'.repeat(65 * MiB) } : { ok: true });
  const c = await f.connect(); await c.send(1, 'initialize');
  const rejected = await c.send('mutation-id', 'turn/start');
  assert.equal(rejected.id, 'mutation-id'); assert.match(rejected.error.message, /decoded message length too large/i);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal((await c.send(3, 'small')).result.ok, true);
});

test('single queued response pressure rejects that RPC and keeps approvals reachable', { timeout: 10000 }, async t => {
  const large = { text: 'x'.repeat(Math.floor(28.5 * MiB)) };
  const f = await fixture(t, method => method === 'big' ? large : {});
  const c = await f.connect(); await c.send(1, 'initialize');
  c.pauseOutput();
  c.ws.send(JSON.stringify({ id: 2, method: 'big', params: {} }));
  c.ws.send(JSON.stringify({ id: 3, method: 'big', params: {} }));
  c.ws.send(JSON.stringify({ id: 4, method: 'big', params: {} }));
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('owner did not receive all RPCs')), 1000); const poll = () => { if (f.calls.filter(call => call.method === 'big').length === 3) { clearTimeout(deadline); resolve(); } else setTimeout(poll, 5); }; poll(); });
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('proxy did not reach held writer')), 1000); const poll = () => { if (c.hasHeldOutput()) { clearTimeout(deadline); resolve(); } else setTimeout(poll, 5); }; poll(); });
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('proxy did not report output pressure')), 5000);
    const poll = () => { if (f.diagnostics.some(detail => detail.code === 'REMOTE_OUTPUT_PRESSURE')) { clearTimeout(deadline); resolve(); } else setTimeout(poll, 5); }; poll(); });
  const approval = { id: 'approval:one', method: 'item/tool/requestUserInput', params: { threadId: 'chat' } };
  f.emit(approval);
  c.resumeOutput();
  const first = await c.next(2), second = await c.next(3), third = await c.next(4);
  assert.ok(first.result || first.error);
  assert.ok([second, third].some(message => /backlogged|retry/i.test(message.error?.message ?? '')), JSON.stringify([first, second, third].map(message => ({ error: message.error, size: message.result?.text?.length }))));
  const receivedApproval = await c.next('approval:one');
  assert.deepEqual(receivedApproval, approval);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.deepEqual((await c.send(5, 'small')).result, {});
});

test('desktop oversized inbound frame reports WebSocket size code', { timeout: 10000 }, async t => {
  const f = await fixture(t, method => method === 'initialize' ? {} : { ok: true });
  const c = await f.connect(); await c.send(1, 'initialize');
  c.ws.send(JSON.stringify({ id: 2, method: 'big', params: { text: 'x'.repeat(17 * MiB) } }));
  await new Promise(resolve => c.ws.once('close', resolve));
  assert.equal(f.errors[0].code, 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
  assert.equal(f.errors[0].direction, 'desktop-inbound');
  assert.equal(f.errors[0].limitBytes, 16 * MiB);
  assert.equal(f.calls.some(call => call.method === 'big'), false);
});

test('new owner rejects its own oversize RPC response and keeps controller', { timeout: 20000 }, async t => {
  let starts = 0;
  const f = await fixture(t, async method => method === 'initialize' ? {} : method === 'turn/start' ? (starts++, { text: 'x'.repeat(65 * MiB) }) : { ok: true }, { legacy: false });
  const ws = new WebSocket('ws+unix://' + join(f.directory, 'rpc.sock') + ':/rpc', { maxPayload: 128 * MiB });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  const rpc = (id, method) => new Promise(resolve => { const on = bytes => { const msg = JSON.parse(bytes); if (msg.id !== id) return; ws.off('message', on); resolve(msg); }; ws.on('message', on); ws.send(JSON.stringify({ id, method, params: {} })); });
  await rpc(1, 'initialize');
  assert.match((await rpc(2, 'turn/start')).error.message, /decoded message length too large/i);
  assert.equal(starts, 1); assert.equal((await rpc(3, 'small')).result.ok, true);
});

test('snapshot pages are bounded, reconstruct history, and reflect replaced files', { timeout: 15000 }, async t => {
  let value = snapshot(Array.from({ length: 8 }, (_, i) => `${i}${'x'.repeat(400_000)}`));
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: params.threadId, turns: [] } } : { data: [], nextCursor: null, backwardsCursor: null });
  await f.write(value);
  const c = await f.connect(); await c.send(1, 'initialize');
  assert.equal((await c.send(2, 'thread/read', { threadId: 'chat', includeTurns: false })).result.thread.id, 'chat');
  let cursor, ids = [], n = 3;
  do {
    const response = await c.send(n++, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded', sortDirection: 'asc', limit: 1000, byteTargetBytes: 900_000, ...(cursor ? { cursor } : {}) });
    assert.equal(response.error, undefined, response.error?.message);
    assert.ok(response.result.data.length <= 20);
    assert.ok(response.result.data.every(row => row.itemsView === 'notLoaded' && row.items.length === 0));
    ids.push(...response.result.data.map(row => row.id)); cursor = response.result.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, value.turns.map(row => row.turn.id));
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 0);
  value = snapshot(['replacement']); await f.write(value);
  assert.equal((await c.send(n++, 'thread/turns/list', { threadId: 'chat', itemsView: 'full' })).result.data[0].items[0].text, 'replacement');
  assert.equal((await c.send(n++, 'thread/items/list', { threadId: 'chat', turnId: 't0' })).result.data[0].item.text, 'replacement');
});

test('full snapshot pages preserve every byte across cursors and cap forwarded owner limits', { timeout: 15000 }, async t => {
  const value = snapshot(Array.from({ length: 25 }, (_, i) => `${i}:${'x'.repeat(750_000)}`));
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read'
    ? { thread: { id: params.threadId }, initialTurnsPage: null }
    : { data: [{ id: 'owner', items: [] }], nextCursor: 'opaque-native-cursor' });
  await f.write(value);
  const c = await f.connect(); await c.send(1, 'initialize');
  await c.send(2, 'thread/read', { threadId: 'chat', initialTurnsPage: { limit: 1000 } });
  assert.equal(f.calls.find(call => call.method === 'thread/read').params.initialTurnsPage.limit, 20);
  let cursor, turns = [], id = 3, pages = 0;
  do {
    const result = (await c.send(id++, 'thread/turns/list', { threadId: 'chat', sortDirection: 'asc', limit: 1000, ...(cursor ? { cursor } : {}) })).result;
    assert.ok(result.data.length <= 20);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * MiB + 2048);
    turns.push(...result.data); cursor = result.nextCursor; pages++;
  } while (cursor);
  assert.ok(pages >= 3);
  assert.deepEqual(turns.map(turn => turn.items[0].text), value.turns.map(row => row.turn.items[0].text));
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 0);
  assert.equal((await c.send(id++, 'thread/turns/list', { threadId: 'chat', cursor: 'opaque-native-cursor', limit: 500 })).result.data[0].id, 'owner');
  assert.equal(f.calls.at(-1).params.limit, 20);
});

test('item pages cap at 100 and return each item once', { timeout: 10000 }, async t => {
  const value = snapshot(['first']);
  value.schemaVersion = 1;
  value.turns[0].turn.items = Array.from({ length: 205 }, (_, i) => ({ id: `i${i}`, type: 'agentMessage', text: `body-${i}` }));
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: params.threadId } }
    : { data: [], nextCursor: null });
  await f.write(value);
  const c = await f.connect(); await c.send(1, 'initialize'); await c.send(2, 'thread/read', { threadId: 'chat' });
  let cursor, items = [], id = 3;
  do {
    const result = (await c.send(id++, 'thread/items/list', { threadId: 'chat', turnId: 't0', limit: 1000, ...(cursor ? { cursor } : {}) })).result;
    assert.ok(result.data.length <= 100);
    items.push(...result.data.map(row => row.item)); cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(items.map(item => item.text), value.turns[0].turn.items.map(item => item.text));
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 0);
});

test('unscoped item pages delegate an active Codex turn with no persisted items', { timeout: 10000 }, async t => {
  const value = snapshot(['completed', '']);
  value.turns[1].turn.status = 'inProgress';
  value.turns[1].turn.items = [];
  value.activeTurn = { engine: 'codex', turnId: 't1' };
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read'
    ? { thread: { id: params.threadId } } : method === 'thread/items/list'
      ? { data: [{ turnId: 't1', item: { id: 'live', text: 'streaming content' } }], nextCursor: null, backwardsCursor: null }
      : { data: [], nextCursor: null, backwardsCursor: null });
  await f.write(value);
  const c = await f.connect(); await c.send(1, 'initialize'); await c.send(2, 'thread/read', { threadId: 'chat' });
  assert.equal((await c.send(3, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data.length, 2);
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 0, 'metadata-only turns remain cached');
  assert.equal((await c.send(4, 'thread/items/list', { threadId: 'chat', turnId: 't0' })).result.data[0].item.text, 'completed');
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 0, 'completed scoped items remain cached');
  assert.equal((await c.send(5, 'thread/items/list', { threadId: 'chat' })).result.data[0].item.text, 'streaming content');
  const cursor = Buffer.from(JSON.stringify({ kind: 'items', threadId: 'chat', turnId: null, anchor: 't0/i0', inclusive: false })).toString('base64url');
  assert.equal((await c.send(6, 'thread/items/list', { threadId: 'chat', cursor })).result.data[0].item.id, 'live');
  assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 2);
});

test('aborted snapshot read stops before opening the file', { timeout: 10000 }, async t => {
  const f = await fixture(t, method => method === 'initialize' ? {} : {});
  await f.write(snapshot(['disk']));
  const controller = new AbortController(); controller.abort(Error('closed'));
  await assert.rejects(readHistorySnapshot(f.directory, 'chat', controller.signal), /closed/);
});

test('history mutation serializes pages and requires owner refresh before snapshot reuse', { timeout: 10000 }, async t => {
  let finish;
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: params.threadId } }
    : method === 'thread/revert' ? new Promise(resolve => { finish = resolve; }) : { data: [{ id: 'owner', items: [] }], nextCursor: null });
  await f.write(snapshot(['disk']));
  const c = await f.connect(); await c.send(1, 'initialize'); await c.send(2, 'thread/read', { threadId: 'chat' });
  assert.equal((await c.send(3, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data[0].id, 't0');
  const mutation = c.send(4, 'thread/revert', { threadId: 'chat', beforeTurnId: 't0' });
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('mutation did not reach owner')), 1000);
    const poll = () => { if (finish) { clearTimeout(deadline); resolve(); } else setTimeout(poll, 5); }; poll(); });
  const during = c.send(5, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' });
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 0, 'page waits for active history edit');
  finish({ thread: { id: 'chat' } }); await mutation;
  assert.equal((await during).result.data[0].id, 'owner');
  assert.equal((await c.send(6, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data[0].id, 't0');
  await c.send(7, 'thread/read', { threadId: 'chat' });
  assert.equal((await c.send(8, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data[0].id, 't0');
});

test('unsupported snapshot falls back and managed cursor ownership is rejected', { timeout: 10000 }, async t => {
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: params.threadId } }
    : { data: [{ id: 'owner', items: [] }], nextCursor: null });
  await f.write({ ...snapshot(['disk']), schemaVersion: 3 });
  const c = await f.connect(); await c.send(1, 'initialize'); await c.send(2, 'thread/read', { threadId: 'chat' });
  assert.equal((await c.send(3, 'thread/turns/list', { threadId: 'chat' })).result.data[0].id, 'owner');
  await f.write(snapshot(['disk']));
  const cursor = Buffer.from(JSON.stringify({ kind: 'turns', threadId: 'other', turnId: null, anchor: 't0', inclusive: true })).toString('base64url');
  assert.match((await c.send(4, 'thread/turns/list', { threadId: 'chat', cursor })).error.message, /ownership mismatch/i);
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 1);
});

test('owner page with foreign managed cursor cannot authorize snapshot reads', { timeout: 10000 }, async t => {
  const foreign = Buffer.from(JSON.stringify({ kind: 'turns', threadId: 'other', turnId: null, anchor: 't0', inclusive: false })).toString('base64url');
  const f = await fixture(t, method => method === 'initialize' ? {} : { data: [{ id: 'owner', items: [] }], nextCursor: foreign });
  await f.write(snapshot(['disk']));
  const c = await f.connect(); await c.send(1, 'initialize');
  assert.equal((await c.send(2, 'thread/turns/list', { threadId: 'chat' })).result.data[0].id, 'owner');
  assert.equal((await c.send(3, 'thread/turns/list', { threadId: 'chat' })).result.data[0].id, 'owner');
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 2);
});

test('a delayed old owner read cannot restore readiness after history mutation', { timeout: 10000 }, async t => {
  let finishRead;
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read'
    ? new Promise(resolve => { finishRead = () => resolve({ thread: { id: params.threadId } }); })
    : method === 'thread/revert' ? { thread: { id: 'chat' } } : { data: [{ id: 'owner', items: [] }], nextCursor: null });
  await f.write(snapshot(['disk']));
  const c = await f.connect(); await c.send(1, 'initialize');
  const read = c.send(2, 'thread/read', { threadId: 'chat' });
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('read did not reach owner')), 1000);
    const poll = () => { if (finishRead) { clearTimeout(deadline); resolve(); } else setTimeout(poll, 5); }; poll(); });
  await c.send(3, 'thread/revert', { threadId: 'chat' });
  finishRead(); await read;
  assert.equal((await c.send(4, 'thread/turns/list', { threadId: 'chat' })).result.data[0].id, 'owner');
});

test('second controller cannot use another controller snapshot readiness', { timeout: 10000 }, async t => {
  const f = await fixture(t, async (method, params) => method === 'initialize' ? {} : method === 'thread/read'
    ? { thread: { id: params.threadId } } : { data: [{ id: 'owner', items: [] }], nextCursor: null }, { legacy: false });
  await f.write(snapshot(['disk']));
  const first = await f.connect(); await first.send(1, 'initialize'); await first.send(2, 'thread/read', { threadId: 'chat' });
  assert.equal((await first.send(3, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data[0].id, 't0');
  const second = await f.connect();
  assert.match((await second.send(1, 'initialize')).error.message, /another desktop controller/i);
  assert.match((await second.send(2, 'thread/turns/list', { threadId: 'chat' })).error.message, /initialize/i);
  assert.equal((await first.send(4, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data[0].id, 't0');
});

test('nonregular snapshot is rejected without blocking its owner page request', { timeout: 10000 }, async t => {
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: params.threadId } }
    : { data: [{ id: 'owner', items: [] }], nextCursor: null });
  const c = await f.connect(); await c.send(1, 'initialize'); await c.send(2, 'thread/read', { threadId: 'chat' });
  await promisify(execFile)('mkfifo', [f.file]);
  assert.match((await c.send(3, 'thread/turns/list', { threadId: 'chat' })).error.message, /snapshot|ownership/i);
});

test('pending limit returns the final page ID error without crashing proxy', { timeout: 10000 }, async t => {
  const f = await fixture(t, method => method === 'initialize' ? {} : method === 'thread/turns/list' ? new Promise(() => {}) : {});
  const c = await f.connect(); await c.send(1, 'initialize');
  for (let id = 2; id <= 1026; id++) c.ws.send(JSON.stringify({ id, method: 'thread/turns/list', params: { threadId: 'chat' } }));
  assert.match((await c.next(1026)).error.message, /too many pending/i);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test('pages waiting behind a history edit have a finite per-connection bound', { timeout: 10000 }, async t => {
  let editing;
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: params.threadId } }
    : method === 'thread/revert' ? new Promise(resolve => { editing = resolve; }) : { data: [{ id: 'owner', items: [] }], nextCursor: null });
  await f.write(snapshot(['disk']));
  const c = await f.connect(); await c.send(1, 'initialize'); await c.send(2, 'thread/read', { threadId: 'chat' });
  c.ws.send(JSON.stringify({ id: 3, method: 'thread/revert', params: { threadId: 'chat' } }));
  await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('edit did not reach owner')), 1000);
    const poll = () => { if (editing) { clearTimeout(deadline); resolve(); } else setTimeout(poll, 5); }; poll(); });
  for (let id = 4; id <= 1028; id++) c.ws.send(JSON.stringify({ id, method: 'thread/turns/list', params: { threadId: 'chat' } }));
  assert.match((await c.next(1028)).error.message, /too many pages waiting/i);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.proxy.close(); editing({ thread: { id: 'chat' } });
});

test('snapshot requires owner refresh; active Codex full pages and pending edits delegate', { timeout: 15000 }, async t => {
  const value = snapshot(['disk'], { pendingHistoryEdit: null });
  let readId = 'chat';
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: readId } } : { data: [{ id: 'owner', items: [{ id: 'live', text: 'live delta' }] }], nextCursor: null });
  await f.write(value);
  const c = await f.connect();
  assert.equal((await c.send(1, 'thread/turns/list', { threadId: 'chat' })).result.data[0].id, 'owner');
  await c.send(2, 'initialize');
  readId = 'wrong'; await c.send(3, 'thread/read', { threadId: 'chat' });
  assert.equal((await c.send(4, 'thread/turns/list', { threadId: 'chat' })).result.data[0].id, 'owner');
  readId = 'chat'; await c.send(5, 'thread/read', { threadId: 'chat' });
  value.turns[0].turn.status = 'inProgress'; await f.write(value);
  assert.equal((await c.send(6, 'thread/turns/list', { threadId: 'chat', itemsView: 'full' })).result.data[0].id, 'owner');
  assert.equal((await c.send(7, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data[0].id, 't0');
  assert.equal((await c.send(71, 'thread/items/list', { threadId: 'chat', turnId: 't0', limit: 1000 })).result.data[0].id, 'owner');
  assert.equal(f.calls.at(-1).params.limit, 100);
  value.pendingHistoryEdit = { snapshot: {} }; await f.write(value);
  assert.equal((await c.send(8, 'thread/turns/list', { threadId: 'chat', itemsView: 'notLoaded' })).result.data[0].id, 'owner');
});

test('snapshot symlink and identity mismatch fail closed, absent snapshot falls back', { timeout: 10000 }, async t => {
  const f = await fixture(t, (method, params) => method === 'initialize' ? {} : method === 'thread/read' ? { thread: { id: params.threadId } } : { data: [{ id: 'owner' }], nextCursor: null });
  const c = await f.connect(); await c.send(1, 'initialize'); await c.send(2, 'thread/read', { threadId: 'chat' });
  assert.equal((await c.send(3, 'thread/turns/list', { threadId: 'chat' })).result.data[0].id, 'owner');
  await f.write({ ...snapshot(['secret']), id: 'other' });
  assert.match((await c.send(4, 'thread/turns/list', { threadId: 'chat' })).error.message, /identity|snapshot/i);
  await unlink(f.file); await symlink(join(f.directory, 'outside.json'), f.file);
  assert.ok((await c.send(5, 'thread/turns/list', { threadId: 'chat' })).error);
});
