import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';
import { startSharedNativeBridge } from '../../runtime/agent-modes/remote/shared-native.mjs';

const bridge = resolve('runtime/agent-modes/remote/shared-native.mjs');
const wsPath = resolve('runtime/agent-modes/node_modules/ws');

test('shared daemon startup reuses the official owner and fails closed on timeout', { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-shared-start-')), cli = join(dir, 'codex'), log = join(dir, 'calls');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(cli, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
fs.appendFileSync(process.env.CDX_TEST_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.env.CDX_TEST_HANG) setInterval(() => {}, 1000);
else console.log(JSON.stringify({ status: 'alreadyRunning', socketPath: '/tmp/official-codex.sock', appServerVersion: '0.142.5' }));
`, { mode: 0o700 });
  const { ensureSharedNativeDaemon } = await import('../../runtime/agent-modes/remote/shared-native.mjs');
  assert.equal(typeof ensureSharedNativeDaemon, 'function');
  const env = { ...process.env, CDX_TEST_LOG: log };
  assert.equal(await ensureSharedNativeDaemon({ command: cli, env, timeoutMs: 2000 }), '/tmp/official-codex.sock');
  assert.equal(await ensureSharedNativeDaemon({ command: cli, env, timeoutMs: 2000 }), '/tmp/official-codex.sock');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), Array(2).fill(['-c', 'features.code_mode_host=true', 'app-server', 'daemon', 'start']));
  await assert.rejects(ensureSharedNativeDaemon({ command: cli, env: { ...env, CDX_TEST_HANG: '1' }, timeoutMs: 50 }), /timed out/i);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-shared-native-'));
  const cli = join(dir, 'codex');
  writeFileSync(cli, `#!${process.execPath}\n` + String.raw`
const { createServer } = require('node:http');
const { Duplex } = require('node:stream');
const { WebSocketServer } = require(${JSON.stringify(wsPath)});
if (process.argv[2] !== 'app-server' || process.argv[3] !== 'proxy' || process.argv[4] !== '--sock') process.exit(2);
const transport = Duplex.from({ readable: process.stdin, writable: process.stdout });
const server = createServer(); const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws)));
sockets.on('connection', ws => {
  if (process.env.CDX_TEST_SLOW_PROXY) { ws._socket.pause(); setTimeout(() => ws._socket.resume(), 300); }
  ws.on('message', (bytes, binary) => {
    if (binary) { ws.close(1003, 'Native RPC requires text frames'); return; }
    const message = JSON.parse(bytes);
    if (message.method === 'initialize') {
      ws.send(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }));
      ws.send(JSON.stringify({ method: 'fixture/ready' }));
    } else if (message.method === 'fixture/approval') {
      ws.send(JSON.stringify({ id: 17, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn' } }));
      ws.send(JSON.stringify({ id: message.id, result: { sent: true } }));
    } else if (message.method === 'fixture/large-response') {
      ws.send(JSON.stringify({ id: message.id, result: { text: 'x'.repeat(65 * 1024 * 1024) } }));
    } else if (message.id === 17) {
      ws.send(JSON.stringify({ method: 'fixture/decision', params: message.result }));
    } else if (message.id != null) ws.send(JSON.stringify({ id: message.id, result: { method: message.method } }));
  });
});

server.emit('connection', transport);
`, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { cli };
}

test('shared native bridge carries requests, notifications, and pending approvals', { timeout: 5000 }, async t => {
  const { cli } = fixture(t), notifications = [], approvals = [];
  const client = new NativeClient({ command: process.execPath, args: [bridge, cli, '/tmp/fixture.sock'], env: process.env,
    onNotification: message => notifications.push(message), onRequest: message => approvals.push(message) });
  t.after(() => client.close());
  assert.deepEqual(await client.request('initialize', {}), { userAgent: 'fixture' });
  assert.deepEqual(await client.request('fixture/approval', {}), { sent: true });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].method, 'item/commandExecution/requestApproval');
  assert.equal(client.respond({ id: approvals[0].id, result: { decision: 'decline' } }), true);
  await client.request('fixture/barrier', {});
  assert.ok(notifications.some(message => message.method === 'fixture/ready'));
  assert.ok(notifications.some(message => message.method === 'fixture/decision' && message.params.decision === 'decline'));
});

test('shared native bridge drains queued JSON lines after a slow proxy resumes', { timeout: 20000 }, async t => {
  const { cli } = fixture(t);
  const client = new NativeClient({ command: process.execPath, args: [bridge, cli, '/tmp/fixture.sock'],
    env: { ...process.env, CDX_TEST_SLOW_PROXY: '1' }, onNotification: () => {}, onRequest: () => {}, requestTimeoutMs: 15000 });
  t.after(() => client.close());
  await client.request('initialize', {});
  const messages = Array.from({ length: 4 }, (_, index) => client.request(`fixture/${index}`, { payload: 'x'.repeat(9 * 1024 * 1024) }));
  assert.deepEqual((await Promise.all(messages)).map(result => result.method), ['fixture/0', 'fixture/1', 'fixture/2', 'fixture/3']);
});

test('shared native bridge preserves a response above the desktop frame limit', { timeout: 20000 }, async t => {
  const { cli } = fixture(t);
  const client = new NativeClient({ command: process.execPath, args: [bridge, cli, '/tmp/fixture.sock'], env: process.env,
    onNotification: () => {}, onRequest: () => {}, requestTimeoutMs: 15000 });
  t.after(() => client.close());
  await client.request('initialize', {});
  assert.equal((await client.request('fixture/large-response', {})).text.length, 65 * 1024 * 1024);
});

test('shared native bridge closes a proxy that never completes its handshake', { timeout: 3000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-stalled-proxy-')), cli = join(dir, 'codex');
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume();\n`, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = new PassThrough(), output = new PassThrough();
  const failed = new Promise(resolve => {
    const bridge = startSharedNativeBridge({ command: cli, socketPath: '/tmp/fixture.sock', input, output,
      timeoutMs: 75, onError: resolve });
    t.after(() => bridge.close());
  });
  assert.match((await failed).message, /handshake.*timed out/i);
});

test('shared native bridge rejects a request above its native input limit', { timeout: 10000 }, async t => {
  const { cli } = fixture(t);
  const stderr = new PassThrough(); let diagnostics = '';
  stderr.on('data', bytes => diagnostics += bytes);
  const client = new NativeClient({ command: process.execPath, args: [bridge, cli, '/tmp/fixture.sock'], env: process.env,
    stderr, onNotification: () => {}, onRequest: () => {}, requestTimeoutMs: 8000 });
  t.after(() => client.close());
  await client.request('initialize', {});
  await assert.rejects(client.request('fixture/too-large', { text: 'x'.repeat(17 * 1024 * 1024) }), /Native Codex exited|unavailable|EPIPE/i);
  assert.match(diagnostics, /16 MiB limit/);
});
