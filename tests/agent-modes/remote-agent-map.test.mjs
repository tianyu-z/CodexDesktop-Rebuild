import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { startRemoteServer } from '../../runtime/agent-modes/remote/server.mjs';

const daemon = fileURLToPath(new URL('../../runtime/agent-modes/remote/daemon.mjs', import.meta.url));
const nativeSpawn = (id = 'spawn', target = 'child') => ({ id, type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'chat', receiverThreadIds: [target], prompt: 'Inspect the public API', status: 'completed', agentsStates: { [target]: { status: 'running' } } });
const claudeAgent = (id, prompt, extra = {}) => ({ id, type: 'dynamicToolCall', namespace: 'claude_code', tool: 'Agent', arguments: { prompt }, status: 'inProgress', ...extra });
const snapshot = (engine = 'codex', items = [nativeSpawn()], extra = {}) => ({ schemaVersion: 2, id: 'chat', mode: engine, thread: { id: 'chat', name: 'Existing work' },
  bindings: { codex: { sessionId: 'chat' } }, activeTurn: { turnId: 'turn', engine },
  turns: [{ engine, turn: { id: 'turn', status: 'inProgress', items }, runs: [], ...extra }] });

async function fixture(t, { value = snapshot(), request, maxPayload } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cdx-map-proxy-')), directory = join(root, 'store');
  mkdirSync(directory);
  const token = createHash('sha256').update(directory).digest('hex').slice(0, 20);
  const socketDirectory = join(tmpdir(), 'cdx-engines-' + process.getuid() + '-' + token);
  mkdirSync(socketDirectory, { mode: 0o700 });
  const file = join(directory, createHash('sha256').update('chat').digest('hex') + '.json');
  if (value) writeFileSync(file, JSON.stringify(value));
  const requests = [], notifications = [], responses = [], clients = [];
  let emit, closes = 0, starts = 0;
  const server = await startRemoteServer({ socketPath: join(socketDirectory, 'rpc.sock'), version: 'old-busy-version', maxPayload, runtimeFactory: callbacks => {
    emit = callbacks.emit;
    return { isBusy: () => true, close: async () => { closes++; }, notify: message => notifications.push(message),
      respond: message => { responses.push(message); emit({ method: 'serverRequest/resolved', params: { requestId: message.id } }); return true; },
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === 'initialize') { starts++; return { userAgent: 'busy-owner' }; }
        const result = await request?.(method, params);
        if (result !== undefined) return result;
        if (method === 'engine/agents/read') throw Object.assign(Error('unknown variant `engine/agents/read`, expected a native method'), { code: -32600 });
        if (method === 'thread/read') return { thread: { id: params.threadId, agentNickname: 'Existing child', turns: [{ id: 'child-turn', status: 'completed', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Public API checked' }] }] } };
        return { method, params };
      } };
  } });
  const connect = async () => {
    const child = spawn(process.execPath, [daemon, 'proxy'], { env: { ...process.env, CDX_ENGINE_STORE: directory,
      CDX_REMOTE_VERSION: 'new-version', CDX_REAL_CODEX: '/nonexistent/codex', CDX_CLAUDE_PATH: '/nonexistent/claude' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => stderr += bytes);
    const exited = new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
    const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const ws = new WebSocket('ws://localhost/rpc', { createConnection: () => transport });
    const inbox = [], waiters = [];
    ws.on('error', () => {});
    ws.on('message', bytes => { const message = JSON.parse(bytes); const index = waiters.findIndex(waiter => waiter.matches(message));
      if (index < 0) inbox.push(message); else waiters.splice(index, 1)[0].resolve(message); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const next = (matches = () => true) => {
      const index = inbox.findIndex(matches);
      return index < 0 ? new Promise(resolve => waiters.push({ matches, resolve })) : Promise.resolve(inbox.splice(index, 1)[0]);
    };
    const client = { ws, child, exited, stderr: () => stderr, inbox, next, send: message => ws.send(JSON.stringify(message)),
      rpc: async (id, method, params) => { ws.send(JSON.stringify({ id, method, params })); return next(message => message.id === id && !message.method); },
      disconnect: async () => { if (ws.readyState !== WebSocket.CLOSED) { const closed = new Promise(resolve => ws.once('close', resolve)); ws.terminate(); await closed; } } };
    clients.push(client); return client;
  };
  t.after(async () => {
    for (const client of clients) { await client.disconnect(); if (client.child.exitCode === null) client.child.kill(); }
    await server.close(); rmSync(root, { recursive: true, force: true }); rmSync(socketDirectory, { recursive: true, force: true });
  });
  return { connect, file, directory, requests, notifications, responses, emit: message => emit(message), closes: () => closes, starts: () => starts,
    write: value => writeFileSync(file, JSON.stringify(value)) };
}

test('stdio proxy reads agents from an older busy owner without restarting work or losing approvals', { timeout: 10000 }, async t => {
  const f = await fixture(t), original = readFileSync(f.file, 'utf8');
  let c = await f.connect();
  assert.equal((await c.rpc(1, 'initialize', {})).result.userAgent, 'busy-owner');
  c.send({ method: 'initialized' });
  const approval = { id: 2, method: 'item/tool/requestUserInput', params: { threadId: 'chat', questions: [] } };
  f.emit(approval);
  assert.deepEqual(await c.next(message => message.method === approval.method), approval);
  await c.disconnect();
  c = await f.connect();
  await c.rpc(1, 'initialize', {});
  const map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  assert.equal(map.error, undefined, map.error?.message);
  assert.equal(map.result.nodes[0].status, 'running');
  assert.equal(map.result.nodes[1].result, 'Public API checked');
  assert.deepEqual(await c.next(message => message.method === approval.method), approval);
  assert.equal(f.starts(), 1); assert.equal(f.closes(), 0); assert.equal(f.responses.length, 0);
  c.send({ id: approval.id, result: { answers: {} } });
  assert.equal((await c.next(message => message.method === 'serverRequest/resolved')).params.requestId, approval.id);
  assert.deepEqual(f.responses, [{ id: approval.id, result: { answers: {} } }]);
  assert.equal(readFileSync(f.file, 'utf8'), original);
  assert.deepEqual(readdirSync(f.directory), [f.file.split('/').at(-1)]);
  assert.ok(f.requests.every(request => ['initialize', 'engine/agents/read', 'thread/read'].includes(request.method)));
});

test('every fallback refresh observes the busy owner latest persisted Claude and Both turns', { timeout: 10000 }, async t => {
  const f = await fixture(t, { value: snapshot('claude', [claudeAgent('agent', 'Review')] ) }), c = await f.connect();
  await c.rpc('initialize', 'initialize', {});
  let map = (await c.rpc('map', 'engine/agents/read', { threadId: 'chat' })).result;
  assert.equal(map.nodes[1].engine, 'claude'); assert.equal(map.nodes[1].status, 'running');
  const run = { id: 'role-run', engine: 'claude', roleId: 'reviewer', stepId: 'review', round: 0, attempt: 1, status: 'running', requestedModel: 'claude-existing' };
  const both = snapshot('both', [claudeAgent('role-run:agent', 'Continue review', { cdxRunId: run.id })], { runs: [run], workflow: { state: { invocations: {
    '["review","reviewer",0]': { prompt: 'Frozen exact request', instructions: 'Read the public API', engine: 'claude', roleId: 'reviewer', stepId: 'review', round: 0 },
  } } } });
  f.write(both);
  map = (await c.rpc('map', 'engine/agents/read', { threadId: 'chat' })).result;
  assert.equal(map.nodes.length, 3); assert.equal(map.nodes[1].kind, 'role'); assert.equal(map.nodes[1].prompt, 'Frozen exact request');
  assert.equal(map.nodes[2].parentId, map.nodes[1].id);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), both);
  assert.equal(f.requests.filter(request => request.method === 'thread/read').length, 0);
});

test('a native-only conversation hydrates through the same owner and never creates a snapshot', { timeout: 10000 }, async t => {
  const value = snapshot('codex', [nativeSpawn()]);
  const f = await fixture(t, { value: null, request: async (method, params) => {
    if (method === 'thread/read' && params.threadId === 'chat') return { thread: { id: 'chat', turns: value.turns.map(row => row.turn) } };
  } }), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  const map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  assert.equal(map.error, undefined, map.error?.message); assert.equal(map.result.nodes.length, 2);
  assert.equal(map.result.nodes[1].result, 'Public API checked'); assert.deepEqual(readdirSync(f.directory), []);
  assert.equal(f.starts(), 1);
});

test('native map support and ordinary errors are passed through without fallback reads', { timeout: 10000 }, async t => {
  const f = await fixture(t, { value: null, request: async (method, params) => {
    if (method !== 'engine/agents/read') return;
    if (params.threadId === 'supported') return { owner: true, nodes: [] };
    throw Object.assign(Error(params.threadId), { code: -32000 });
  } }), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  assert.deepEqual(await c.rpc('native-map', 'engine/agents/read', { threadId: 'supported' }), { id: 'native-map', result: { owner: true, nodes: [] } });
  for (const message of ['Authentication required', 'Read timed out', 'unknown variant `other/method`', 'Cannot read engine/agents/read']) {
    assert.deepEqual(await c.rpc(message, 'engine/agents/read', { threadId: message }), { id: message, error: { code: -32000, message } });
  }
  assert.equal(f.requests.some(request => request.method === 'thread/read'), false); assert.deepEqual(readdirSync(f.directory), []);
});

test('client ID types, approvals and notifications survive concurrent map native reads', { timeout: 10000 }, async t => {
  let release, reading;
  const started = new Promise(resolve => { reading = resolve; });
  const f = await fixture(t, { request: async (method, params) => {
    if (method === 'thread/read' && params.threadId === 'child') { reading(); return await new Promise(resolve => { release = () => resolve({ thread: { id: 'child', turns: [] } }); }); }
  } }), c = await f.connect();
  await c.rpc('__agent_map__:1', 'initialize', {});
  const map = c.rpc(1, 'engine/agents/read', { threadId: 'chat' });
  await started;
  const approval = { id: 3, method: 'item/tool/requestUserInput', params: { threadId: 'chat' } };
  const notification = { method: 'item/agentMessage/delta', params: { threadId: 'chat', delta: 'Existing work continues' } };
  f.emit(approval); f.emit(notification);
  assert.deepEqual(await c.next(message => message.method === approval.method), approval);
  assert.deepEqual(await c.next(message => message.method === notification.method), notification);
  const ids = ['1', 2, 3, 0, 'map:1', 'internal:3', '__agent_map__:1'];
  const replies = await Promise.all(ids.map(id => c.rpc(id, 'turn/interrupt', { marker: id })));
  assert.deepEqual(replies.map(reply => reply.id), ids);
  for (const reply of replies) assert.equal(reply.result.params.marker, reply.id);
  c.send({ id: approval.id, result: { accepted: true } });
  await c.next(message => message.method === 'serverRequest/resolved');
  release(); assert.equal((await map).result.nodes.length, 2);
  assert.deepEqual(f.responses, [{ id: 3, result: { accepted: true } }]);
  assert.equal(c.inbox.length, 0);
});

test('disconnect cancels compatibility reads and releases the controller without stopping its owner', { timeout: 10000 }, async t => {
  let reading, release;
  const started = new Promise(resolve => { reading = resolve; });
  const f = await fixture(t, { request: async (method, params) => {
    if (method === 'thread/read' && params.threadId === 'child') { reading(); return await new Promise(resolve => { release = () => resolve({ thread: { id: 'child', turns: [] } }); }); }
  } });
  let c = await f.connect();
  await c.rpc(1, 'initialize', {}); c.send({ id: 2, method: 'engine/agents/read', params: { threadId: 'chat' } });
  await started; await c.disconnect();
  const exit = await c.exited; assert.equal(exit.code, 0, exit.stderr);
  assert.equal(f.closes(), 0);
  c = await f.connect();
  assert.equal((await c.rpc(1, 'initialize', {})).result.userAgent, 'busy-owner');
  release();
  assert.equal((await c.rpc(2, 'turn/interrupt', { threadId: 'chat' })).result.method, 'turn/interrupt');
  assert.equal(f.starts(), 1); assert.equal(f.closes(), 0);
});

test('invalid or redirected snapshots fail closed without reading a different conversation', { timeout: 10000 }, async t => {
  const f = await fixture(t), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  f.write({ ...snapshot(), id: 'another-chat' });
  let map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  assert.match(map.error.message, /snapshot/);
  rmSync(f.file); symlinkSync('/etc/passwd', f.file);
  map = await c.rpc(3, 'engine/agents/read', { threadId: 'chat' });
  assert.ok(map.error); assert.equal(map.result, undefined);
  assert.equal(f.requests.some(request => request.method === 'thread/read'), false);
});

test('paginated native-only history is read with bounded public pages without writing snapshots', { timeout: 10000 }, async t => {
  const f = await fixture(t, { value: null, request: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, historyMode: 'paginated', turns: [] } };
    if (method === 'thread/turns/list') return { data: [{ id: 'native-turn', status: 'completed', items: [] }], nextCursor: null };
  } }), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  const map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  assert.equal(map.error, undefined, map.error?.message); assert.equal(map.result.turnId, 'native-turn');
  assert.deepEqual(readdirSync(f.directory), []);
});

test('native pagination rejects repeating cursors and stops at its page budget', { timeout: 10000 }, async t => {
  let pages = 0, repeated = true;
  const f = await fixture(t, { value: null, request: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, historyMode: 'paginated', turns: [] } };
    if (method === 'thread/turns/list') { pages++; return { data: [], nextCursor: repeated ? 'same' : String(pages) }; }
  } }), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  let map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  assert.match(map.error?.message ?? '', /cursor/i); assert.equal(pages, 2);
  pages = 0; repeated = false;
  map = await c.rpc(3, 'engine/agents/read', { threadId: 'chat' });
  assert.match(map.error?.message ?? '', /limit/i); assert.equal(pages, 10);
});

test('native includeTurns incompatibility retries metadata before public history pages', { timeout: 10000 }, async t => {
  const f = await fixture(t, { value: null, request: async (method, params) => {
    if (method === 'thread/read' && params.includeTurns) throw Error('includeTurns is not available for paginated history');
    if (method === 'thread/read') return { thread: { id: params.threadId, historyMode: 'paginated', turns: [] } };
    if (method === 'thread/turns/list') return { data: [{ id: 'paged-turn', items: [], status: 'completed' }], nextCursor: null };
  } }), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  const map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  assert.equal(map.error, undefined, map.error?.message); assert.equal(map.result.turnId, 'paged-turn');
  assert.deepEqual(f.requests.filter(request => request.method === 'thread/read').map(request => request.params.includeTurns), [true, false]);
});

test('native identity mismatches cannot supply transcript paths or child results', { timeout: 10000 }, async t => {
  const value = snapshot('codex', [{ id: 'call', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' }]);
  const f = await fixture(t, { value, request: async method => {
    if (method === 'thread/read') return { thread: { id: 'other-chat', path: '/definitely-not-a-native-thread.jsonl', turns: [] } };
  } }), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  const map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  assert.equal(map.error, undefined, map.error?.message);
  assert.equal(map.result.warnings.length, 2);
  assert.ok(map.result.warnings.every(warning => /identity mismatch/i.test(warning)));
});

test('a timed-out child read returns partial map data and its late reply never reaches the client', { timeout: 10000 }, async t => {
  let release;
  const f = await fixture(t, { request: async (method, params) => {
    if (method === 'thread/read' && params.threadId === 'child') return new Promise(resolve => { release = () => resolve({ thread: { id: 'child', turns: [] } }); });
  } }), c = await f.connect();
  await c.rpc(1, 'initialize', {});
  const map = await c.rpc(2, 'engine/agents/read', { threadId: 'chat' });
  release();
  assert.equal(map.result.nodes.length, 2); assert.ok(map.result.warnings.some(warning => /timed out/i.test(warning)));
  assert.equal((await c.rpc(3, 'turn/interrupt', { threadId: 'chat' })).result.method, 'turn/interrupt');
  assert.deepEqual(c.inbox, []); assert.equal(f.closes(), 0);
});

test('notification backpressure closes only the disconnected desktop proxy', { timeout: 15000 }, async t => {
  // Keep the fixture owner's buffer above the entire burst so its own guard
  // cannot win the race against the proxy's unchanged 32 MiB output bound.
  const f = await fixture(t, { maxPayload: 64 * 1024 * 1024 }), c = await f.connect();
  await c.rpc(1, 'initialize', {}); await c.rpc(2, 'getAuthStatus', {});
  c.ws._socket.pause();
  const delta = 'x'.repeat(1024 * 1024);
  for (let count = 0; count < 80 && c.child.exitCode === null; count++) {
    f.emit({ method: 'item/agentMessage/delta', params: { threadId: 'chat', delta } });
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  let timer;
  const processExit = c.child.exitCode !== null ? Promise.resolve({ code: c.child.exitCode }) : new Promise(resolve => c.child.once('exit', code => resolve({ code })));
  const exit = await Promise.race([processExit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); })]);
  clearTimeout(timer); c.ws._socket.resume();
  assert.ok(exit, 'A slow client must not accumulate unbounded notification output: ' + c.stderr());
  assert.equal(exit.code, 1, 'The proxy must enforce its own backpressure bound');
  assert.equal(f.closes(), 0);
});
