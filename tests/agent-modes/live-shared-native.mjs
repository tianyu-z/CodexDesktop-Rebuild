// CDX_LIVE_SHARED_NATIVE=1 node tests/agent-modes/live-shared-native.mjs rno
// Uses a fresh temporary CODEX_HOME and creates no model turns.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';

if (process.env.CDX_LIVE_SHARED_NATIVE !== '1') throw Error('Set CDX_LIVE_SHARED_NATIVE=1 for this isolated native probe.');
const host = process.argv[2] ?? 'rno';
if (!/^[a-z0-9-]+$/.test(host)) throw Error('Invalid host.');
const cli = '/mnt/vast/home/tianyu.zhang/.codex/packages/standalone/releases/0.142.5-x86_64-unknown-linux-musl/bin/codex';
const bridge = fileURLToPath(new URL('../../runtime/agent-modes/remote/shared-native.mjs', import.meta.url));
const ssh = (code, args = []) => spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'python3', '-', ...args],
  { input: code, encoding: 'utf8', timeout: 20000 });
const setup = `import os,json,tempfile,subprocess\nhome=tempfile.mkdtemp(prefix='cd-',dir='/tmp')\ncli='${cli}'\nos.makedirs(home+'/packages/standalone/current')\nos.symlink(cli,home+'/packages/standalone/current/codex')\nenv=os.environ.copy();env['CODEX_HOME']=home;env.pop('OPENAI_API_KEY',None);env.pop('CODEX_API_KEY',None)\np=subprocess.run([cli,'app-server','daemon','start'],env=env,capture_output=True,text=True,timeout=15)\nassert p.returncode==0,p.stderr\nstart=json.loads(p.stdout)\nprint(json.dumps({'home':home,'socket':start['socketPath'],'cliVersion':start['cliVersion'],'appServerVersion':start['appServerVersion']}))\n`;
const begin = ssh(setup);
assert.equal(begin.status, 0, begin.stderr || begin.stdout);
const { home, socket, cliVersion, appServerVersion } = JSON.parse(begin.stdout.trim().split('\n').at(-1));
if (!/^\/tmp\/cd-[a-zA-Z0-9_-]+$/.test(home) || socket !== home + '/app-server-control/app-server-control.sock') throw Error('Unsafe temp daemon path.');
assert.equal(cliVersion, '0.142.5'); assert.equal(appServerVersion, '0.142.5');
const local = mkdtempSync(join(tmpdir(), 'cdx-bridge-probe-'));
const localSocket = join(local, 'native.sock');
// Expose the isolated daemon's Unix socket locally without another Codex CLI.
// This relay is test-only; production runs the bridge next to the native socket.
const relayCode = `import socket,sys,threading\ns=socket.socket(socket.AF_UNIX);s.connect(${JSON.stringify(socket)})\ndef send():\n try:\n  while True:\n   b=sys.stdin.buffer.read1(65536)\n   if not b:break\n   s.sendall(b)\n finally:\n  try:s.shutdown(socket.SHUT_WR)\n  except OSError:pass\nthreading.Thread(target=send,daemon=True).start()\nwhile True:\n b=s.recv(65536)\n if not b:break\n sys.stdout.buffer.write(b);sys.stdout.buffer.flush()\ns.close()\n`;
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const relays = new Set();
const relay = createServer(stream => {
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'python3 -u -c ' + quote(relayCode)],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const entry = { child, stream }; relays.add(entry);
  stream.pipe(child.stdin); child.stdout.pipe(stream);
  stream.on('error', () => {}); child.stdin.on('error', () => stream.destroy());
  child.on('error', () => stream.destroy());
  child.on('close', () => { relays.delete(entry); stream.destroy(); });
  stream.on('close', () => child.kill());
});
const clients = [];
async function rpc(client, method, params) {
  console.log(JSON.stringify({ stage: 'request', method }));
  const result = await client.request(method, params);
  console.log(JSON.stringify({ stage: 'response', method }));
  return result;
}
async function connect() {
  const client = new NativeClient({ command: process.execPath, args: [bridge, localSocket], env: process.env,
    onNotification: () => {}, onRequest: () => {}, requestTimeoutMs: 10000 });
  clients.push(client);
  await rpc(client, 'initialize', { clientInfo: { name: 'shared-bridge-isolated-probe', version: '1' }, capabilities: { experimentalApi: true } });
  return client;
}
try {
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(localSocket, resolve); });
  const first = await connect();
  const created = await rpc(first, 'thread/start', { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' });
  // Persist the empty thread's rollout without starting an inference turn.
  await rpc(first, 'thread/name/set', { threadId: created.thread.id, name: 'isolated-shared-bridge-probe' });
  const second = await connect();
  const resumed = await rpc(second, 'thread/resume', { threadId: created.thread.id });
  assert.equal(resumed.approvalPolicy, 'never');
  assert.equal((resumed.sandbox ?? resumed.sandboxPolicy)?.type, 'dangerFullAccess');
  await rpc(first, 'thread/settings/update', { threadId: created.thread.id, approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } });
  const restricted = await rpc(second, 'thread/resume', { threadId: created.thread.id });
  assert.equal(restricted.approvalPolicy, 'on-request');
  assert.equal((restricted.sandbox ?? restricted.sandboxPolicy)?.type, 'workspaceWrite');
  await rpc(first, 'thread/settings/update', { threadId: created.thread.id, approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' } });
  const restored = await rpc(second, 'thread/resume', { threadId: created.thread.id });
  assert.equal(restored.approvalPolicy, 'never');
  assert.equal((restored.sandbox ?? restored.sandboxPolicy)?.type, 'dangerFullAccess');
  await first.close();
  const read = await rpc(second, 'thread/read', { threadId: created.thread.id, includeTurns: false });
  assert.equal(resumed.thread.id, created.thread.id);
  assert.equal(read.thread.id, created.thread.id);
  console.log(JSON.stringify({ host, cliVersion, appServerVersion, sharedResume: true, fullBareResume: true,
    restrictedBareResume: true, restoredFullBareResume: true, readAfterFirstProxyClose: true, threadId: created.thread.id }));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const { child, stream } of relays) { stream.destroy(); child.kill(); }
  await new Promise(resolve => relay.close(resolve));
  const cleanup = ssh(`import os,subprocess,shutil,sys\nhome=sys.argv[1];cli='${cli}'\nassert home.startswith('/tmp/cd-')\nenv=os.environ.copy();env['CODEX_HOME']=home\np=subprocess.run([cli,'app-server','daemon','stop'],env=env,capture_output=True,text=True,timeout=15)\nassert p.returncode==0,p.stderr\nprint(p.stdout.strip())\nshutil.rmtree(home)\n`, [home]);
  rmSync(local, { recursive: true, force: true });
  assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
}
