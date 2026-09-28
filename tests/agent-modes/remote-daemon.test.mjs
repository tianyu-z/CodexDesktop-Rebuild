import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { startRemoteServer } from '../../runtime/agent-modes/remote/server.mjs';
const daemon = fileURLToPath(new URL('../../runtime/agent-modes/remote/daemon.mjs', import.meta.url));

function upgradeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cdx-upgrade-test-')), directory = join(root, 'store');
  const token = createHash('sha256').update(directory).digest('hex').slice(0, 20);
  const socketDirectory = join(tmpdir(), 'cdx-engines-' + process.getuid() + '-' + token);
  mkdirSync(socketDirectory, { mode: 0o700 });
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(socketDirectory, { recursive: true, force: true }); });
  const run = (action = 'ensure') => new Promise(resolve => {
    // These cannot start a new runtime: reconnect must preserve the old owner.
    const child = spawn(process.execPath, [daemon, action], { env: { ...process.env, CDX_ENGINE_STORE: directory,
      CDX_REMOTE_VERSION: 'new-version', CDX_REAL_CODEX: '/nonexistent/codex', CDX_CLAUDE_PATH: '/nonexistent/claude' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    child.on('close', code => resolve({ code, stdout, stderr }));
    t.after(() => { if (child.exitCode === null) child.kill(); });
  });
  return { run, socketPath: join(socketDirectory, 'rpc.sock') };
}

test('busy older gateway reconnect preserves its task and replays pending approval', { timeout: 10000 }, async t => {
  const f = upgradeFixture(t);
  let emit, closed = false, active = false, starts = 0, approved = false;
  const approval = { id: 'existing-approval', method: 'item/tool/requestUserInput', params: { threadId: 'existing-chat' } };
  const server = await startRemoteServer({ socketPath: f.socketPath, version: 'old-version', runtimeFactory: callbacks => {
    emit = callbacks.emit;
    return { isBusy: () => active, close: async () => { closed = true; }, notify() {}, respond: () => { approved = true; return true; },
      request: async method => {
        if (method === 'turn/start') { active = true; starts++; queueMicrotask(() => emit(approval)); return { id: 'existing-turn' }; }
        return { active, starts };
      } };
  } });
  t.after(() => server.close());
  const connect = async () => {
    const ws = new WebSocket('ws+unix://' + f.socketPath + ':/rpc'), inbox = [], waiters = [];
    ws.on('message', bytes => { const message = JSON.parse(bytes), waiter = waiters.shift(); if (waiter) waiter(message); else inbox.push(message); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    t.after(() => ws.terminate());
    return { send: message => ws.send(JSON.stringify(message)), next: () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiters.push(resolve)),
      close: () => new Promise(resolve => { ws.once('close', resolve); ws.close(); }) };
  };
  let client = await connect();
  client.send({ id: 1, method: 'initialize' }); await client.next(); client.send({ method: 'initialized' });
  client.send({ id: 2, method: 'turn/start' });
  const initial = [await client.next(), await client.next()]; assert.ok(initial.some(message => message.id === approval.id));
  await client.close();
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, version: 'old-version', protocolVersion: 1, busy: true, stopping: false,
    upgradeDeferred: true, requestedVersion: 'new-version' });
  assert.equal(closed, false);
  client = await connect(); client.send({ id: 3, method: 'initialize' }); await client.next(); client.send({ method: 'initialized' });
  assert.deepEqual(await client.next(), approval);
  client.send({ id: 4, method: 'thread/read' }); assert.deepEqual((await client.next()).result, { active: true, starts: 1 });
  assert.equal(approved, false); await client.close();
});

test('work starting between health and graceful shutdown defers upgrade instead of blocking reconnect', { timeout: 10000 }, async t => {
  const f = upgradeFixture(t); let checks = 0, closed = false;
  const server = await startRemoteServer({ socketPath: f.socketPath, version: 'old-version', runtimeFactory: () => ({
    isBusy: () => ++checks > 1, close: async () => { closed = true; },
  }) });
  t.after(() => server.close());
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).upgradeDeferred, true);
  assert.equal(closed, false); assert.ok(checks >= 3, 'Recheck health after shutdown was refused');
});

test('incompatible busy gateways still fail without attempting shutdown', { timeout: 10000 }, async t => {
  const f = upgradeFixture(t), paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url); response.end(JSON.stringify({ ok: true, version: 'old-version', protocolVersion: 2, busy: true, stopping: false }));
  });
  await new Promise(resolve => server.listen(f.socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await f.run();
  assert.equal(result.code, 1); assert.match(result.stderr, /requires a scoped restart/); assert.deepEqual(paths, ['/health']);
});

test('gateway stop waits through a connection reset while the old owner closes', { timeout: 10000 }, async t => {
  const f = upgradeFixture(t); let healthChecks = 0;
  const server = createServer((request, response) => {
    if (request.url.startsWith('/shutdown')) { response.end(JSON.stringify({ stopping: true })); return; }
    healthChecks++;
    if (healthChecks === 1) { request.socket.destroy(); return; }
    response.setHeader('Connection', 'close'); response.end(JSON.stringify({ stopping: true })); server.close();
  });
  await new Promise(resolve => server.listen(f.socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await f.run('stop');
  assert.equal(result.code, 0, result.stderr); assert.equal(healthChecks, 2, 'A reset alone must not declare the owner stopped');
});

// This covers three bounded owner startups plus an upgrade/stop while other
// suites compete for filesystem/process time. Each daemon operation keeps its
// production timeout; the encompassing scenario needs a larger total budget.
test('concurrent remote ensure and direct serve keep one reachable owner and support restart', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cdx-daemon-test-')), command = join(root, 'codex');
  const nativeCalls = join(root, 'native-calls.jsonl');
  writeFileSync(nativeCalls, '');
  writeFileSync(command, '#!' + process.execPath + '\nconst fs=require("node:fs"),args=process.argv.slice(2),log=' + JSON.stringify(nativeCalls) + ';fs.appendFileSync(log,JSON.stringify(args)+"\\n");if(args.includes("sandbox")){if(!args.includes("use_legacy_landlock")){if(fs.readFileSync(log,"utf8").trim().split("\\n").length===1)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,12500);console.error("bwrap: Failed to make / slave: Permission denied");process.exit(1)}process.exit(0)}\nrequire("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.id!=null)console.log(JSON.stringify({id:m.id,result:{}}))});\n', { mode: 0o700 });
  const env = { ...process.env, CDX_ENGINE_STORE: join(root, 'store'), CDX_REMOTE_SCOPE: 'fixture', CDX_REAL_CODEX: command, CDX_CLAUDE_PATH: command };
  const children = [];
  const run = (action, overrides = {}) => {
    const child = spawn(process.execPath, [daemon, action], { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    return { child, done: new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr }))) };
  };
  const stopOwner = async () => {
    let pid; try { pid = Number(readFileSync(join(root, 'store', '.gateway.lock'), 'utf8')); } catch { return; }
    try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); await stopOwner(); rmSync(root, { recursive: true, force: true }); });
  const readCalls = () => readFileSync(nativeCalls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const starting = Promise.all(Array.from({ length: 5 }, () => run('ensure').done));
  const probeDeadline = Date.now() + 10000;
  while (!readCalls().length && Date.now() < probeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(readCalls().length, 'The owning gateway should begin its sandbox probe');
  // This host took 12.371s to return bwrap's namespace error. A concurrent
  // direct owner must wait for that probe instead of timing out at 10 seconds.
  const contender = run('serve');
  const first = await starting;
  for (const result of first) assert.equal(result.code, 0, result.stderr);
  const contended = await contender.done;
  assert.equal(contended.code, 0, contended.stderr);
  const pid = Number(readFileSync(join(root, 'store', '.gateway.lock'), 'utf8'));
  const nativeDeadline = Date.now() + 10000;
  while (!readCalls().some(args => args.includes('app-server')) && Date.now() < nativeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  const calls = readCalls();
  assert.equal(calls.filter(args => args.includes('sandbox')).length, 2, 'Only the winning owner probes default and Landlock once');
  assert.deepEqual(calls.filter(args => args.includes('app-server')), [['-c', 'features.code_mode_host=true', 'app-server']], 'Main native sessions keep the user-selected sandbox backend');
  const duplicate = await run('serve').done;
  assert.equal(duplicate.code, 0, duplicate.stderr);
  const alive = await run('ensure').done; assert.equal(alive.code, 0, alive.stderr);
  assert.equal(Number(readFileSync(join(root, 'store', '.gateway.lock'), 'utf8')), pid);
  await stopOwner();
  const restarted = await run('ensure').done;
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.notEqual(Number(readFileSync(join(root, 'store', '.gateway.lock'), 'utf8')), pid);
  const upgraded = await run('ensure', { CDX_REMOTE_VERSION: 'upgraded' }).done;
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.equal(JSON.parse(upgraded.stdout).version, 'upgraded');
  assert.equal((await run('stop').done).code, 0);
});
