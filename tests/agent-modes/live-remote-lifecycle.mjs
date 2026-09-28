// CDX_LIVE_REMOTE=1 node tests/agent-modes/live-remote-lifecycle.mjs HOST
// Real native approval, reconnect, interruption, restart and engine handoff probe.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Duplex, Transform } from 'node:stream';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { nativeLoginWrapper } from './live-remote-login.mjs';
const require = createRequire(import.meta.url);
const helper = require('../../scripts/assets/agent-modes-remote.cjs');
if (process.env.CDX_LIVE_REMOTE !== '1') throw Error('Set CDX_LIVE_REMOTE=1 to invoke real cluster models.');
const host = process.argv[2] ?? 'rno';
if (!/^[a-z0-9-]+$/.test(host)) throw Error('Invalid host.');
process.resourcesPath = resolve(process.env.CDX_REMOTE_TEST_RESOURCES ?? '.artifacts/remote-check-resources');
const connection = { ssh: '/usr/bin/ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host],
  sshConnection: { alias: host }, login: nativeLoginWrapper(), env: process.env, codex: 'codex' };
const transport = {}, evidence = { host, startedAt: new Date().toISOString(), stages: [] };
const stage = (name, detail = {}) => { evidence.stages.push({ name, ...detail }); console.log(JSON.stringify({ host, stage: name, ...detail })); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureCode = 'import tempfile,json; print(json.dumps({"cwd":tempfile.mkdtemp(prefix="cdx-lifecycle-")}))';
await helper.prepare(transport, connection);
const lastLine = text => text.trim().split(/\r?\n/).at(-1);
const { cwd } = JSON.parse(lastLine(await helper.execute(connection, 'python3 -c ' + helper.quote(fixtureCode))));
evidence.cwd = cwd;
let client, chatId, activeTurn;
async function connect() {
  const marker = randomBytes(24);
  const child = spawn(connection.ssh, [...connection.args, connection.login(helper.proxyCommand(transport), marker)], { env: connection.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let framed = false, boundary = Buffer.alloc(0);
  const framedOutput = new Transform({ transform(bytes, encoding, callback) {
    if (!framed) {
      const combined = Buffer.concat([boundary, bytes]), index = combined.indexOf(marker);
      if (index < 0) { boundary = combined.subarray(Math.max(0, combined.length - marker.length + 1)); callback(); return; }
      framed = true; bytes = combined.subarray(index + marker.length); boundary = Buffer.alloc(0);
    }
    callback(null, bytes);
  } });
  const stream = Duplex.from({ writable: child.stdin, readable: child.stdout.pipe(framedOutput) });
  Object.assign(stream, { setTimeout: () => stream, setNoDelay: () => stream, setKeepAlive: () => stream });
  const ws = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => stream, perMessageDeflate: false });
  const pending = new Map(), approvals = [], notices = []; let seq = 0;
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const m = JSON.parse(bytes);
    if (m.id != null && !m.method) {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    } else if (m.id != null) approvals.push(m);
    else notices.push(m);
  });
  ws.on('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Disconnected')); } pending.clear(); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('Timed out: ' + method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await rpc('initialize', { clientInfo: { name: 'remote_lifecycle_acceptance', version: '1' }, capabilities: { experimentalApi: true } });
  // The pinned desktop performs this RPC without an initialized notification.
  await rpc('getAuthStatus', { includeToken: false, refreshToken: false });
  return { rpc, approvals, notices, respond: message => ws.send(JSON.stringify(message)), close: () => { ws.terminate(); child.kill(); } };
}
async function nextApproval() {
  for (let i = 0; i < 120; i++) {
    const approval = client.approvals.shift();
    if (approval) {
      assert.equal(approval.params.threadId, chatId); assert.equal(approval.params.turnId, activeTurn);
      return approval;
    }
    await pause(500);
  }
  throw Error('Native tool approval did not arrive.');
}
async function readTurn() {
  const { thread } = await client.rpc('thread/read', { threadId: chatId, includeTurns: true });
  return thread.turns.find(turn => turn.id === activeTurn);
}
async function settledTurn() {
  for (let i = 0; i < 120; i++) {
    for (const approval of client.approvals.splice(0)) {
      client.respond({ id: approval.id, result: approval.method === 'item/tool/requestUserInput' ? { answers: { permission: { answers: ['Deny'] } } } : { decision: 'decline' } });
    }
    const turn = await readTurn();
    if (turn && turn.status !== 'inProgress') { activeTurn = null; return turn; }
    await pause(500);
  }
  throw Error('Native turn did not settle.');
}
async function startTurn(text) {
  const { turn } = await client.rpc('turn/start', { threadId: chatId, cwd, input: [{ type: 'text', text }], approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  activeTurn = turn.id; return turn;
}
async function claudeSession() {
  const filename = createHash('sha256').update(chatId).digest('hex') + '.json';
  const dataPath = helper.layout(connection).data + '/conversations/' + filename;
  const code = 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["bindings"]["claude"]["sessionId"]))';
  const id = JSON.parse(lastLine(await helper.execute(connection, 'python3 -c ' + helper.quote(code) + ' ' + dataPath)));
  assert.equal(typeof id, 'string', 'Expected a persisted native Claude session ID');
  assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, 'Expected a native Claude session UUID');
  return id;
}
try {
  client = await connect();
  const { thread } = await client.rpc('thread/start', { cwd, engineMode: 'claude', engineModel: 'claude-haiku-4-5' });
  chatId = thread.id; evidence.threadId = chatId;
  await startTurn('Use the native Write tool exactly once to create ' + cwd + '/denied.txt containing ONLY TEST. This tests tool approval. If denied, do not try another tool; simply say denied.');
  const approval = await nextApproval();
  assert.match(JSON.stringify(approval), /denied\.txt/);
  stage('pending-approval', { id: approval.id });
  client.close(); await pause(350); client = await connect();
  const replay = await nextApproval(); assert.deepEqual(replay, approval);
  client.respond({ id: replay.id, result: { answers: { permission: { answers: ['Deny'] } } } });
  const denied = await settledTurn(); assert.equal(denied.status, 'completed');
  assert.equal(lastLine(await helper.execute(connection, 'test ! -e ' + helper.quote(cwd + '/denied.txt') + ' && printf absent')), 'absent');
  stage('reconnect-same-approval-denied');
  await startTurn('Use the native Write tool once to create ' + cwd + '/cancelled.txt containing ONLY TEST. If denied, stop immediately.');
  await nextApproval();
  await client.rpc('turn/interrupt', { threadId: chatId, turnId: activeTurn });
  const interrupted = await settledTurn(); assert.equal(interrupted.status, 'interrupted');
  assert.equal(lastLine(await helper.execute(connection, 'test ! -e ' + helper.quote(cwd + '/cancelled.txt') + ' && printf absent')), 'absent');
  stage('pending-approval-interrupted');
  const marker = 'RESUME_' + randomUUID();
  await startTurn('Remember this exact test marker for the next turn: ' + marker + '. Reply with the marker only. No tools.');
  const remembered = await settledTurn(); assert.equal(remembered.status, 'completed');
  assert.ok(JSON.stringify(remembered.items).includes(marker));
  const nativeSessionId = await claudeSession(); assert.ok(nativeSessionId);
  client.close(); await pause(350);
  await helper.stop(transport, connection); await helper.prepare(transport, connection);
  client = await connect();
  await client.rpc('thread/resume', { threadId: chatId });
  await startTurn('What exact test marker did I ask you to remember in the preceding turn? Reply with it only. No tools.');
  const resumed = await settledTurn(); assert.equal(resumed.status, 'completed');
  assert.ok(JSON.stringify(resumed.items).includes(marker));
  assert.equal(await claudeSession(), nativeSessionId);
  stage('gateway-restart-native-session-recovered', { nativeSessionId });
  await client.rpc('engine/mode/set', { threadId: chatId, engineMode: 'codex' });
  await startTurn('What exact RESUME_ test marker did the previous engine quote? Repeat it only. No tools.');
  const codex = await settledTurn(); assert.equal(codex.status, 'completed'); assert.ok(JSON.stringify(codex.items).includes(marker));
  stage('claude-to-codex-context');
  await client.rpc('engine/mode/set', { threadId: chatId, engineMode: 'claude' });
  await startTurn('What exact marker did Codex quote in the previous turn? Repeat it only. No tools.');
  const claude = await settledTurn(); assert.equal(claude.status, 'completed'); assert.ok(JSON.stringify(claude.items).includes(marker));
  stage('codex-to-claude-context');
  evidence.passed = true;
} catch (error) { evidence.error = error.message; console.error(JSON.stringify({ host, error: error.message })); process.exitCode = 1; }
finally {
  if (client && chatId && activeTurn) await client.rpc('turn/interrupt', { threadId: chatId, turnId: activeTurn }).catch(() => {});
  client?.close(); mkdirSync('.artifacts', { recursive: true });
  writeFileSync('.artifacts/remote-lifecycle-' + host + '.json', JSON.stringify(evidence, null, 2));
}
