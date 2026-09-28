import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const daemon = fileURLToPath(new URL('../../runtime/agent-modes/remote/daemon.mjs', import.meta.url));
// This covers three bounded owner startups plus an upgrade/stop while other
// suites compete for filesystem/process time. Each daemon operation keeps its
// production timeout; the encompassing scenario needs a larger total budget.
test('concurrent remote ensure and direct serve keep one reachable owner and support restart', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cdx-daemon-test-')), command = join(root, 'codex');
  const nativeCalls = join(root, 'native-calls.jsonl');
  writeFileSync(nativeCalls, '');
  writeFileSync(command, '#!' + process.execPath + '\nconst args=process.argv.slice(2);require("node:fs").appendFileSync(' + JSON.stringify(nativeCalls) + ',JSON.stringify(args)+"\\n");if(args.includes("sandbox")){if(!args.includes("use_legacy_landlock")){console.error("bwrap: Failed to make / slave: Permission denied");process.exit(1)}process.exit(0)}\nrequire("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.id!=null)console.log(JSON.stringify({id:m.id,result:{}}))});\n', { mode: 0o700 });
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
  const first = await Promise.all(Array.from({ length: 5 }, () => run('ensure').done));
  for (const result of first) assert.equal(result.code, 0, result.stderr);
  const pid = Number(readFileSync(join(root, 'store', '.gateway.lock'), 'utf8'));
  const readCalls = () => readFileSync(nativeCalls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const nativeDeadline = Date.now() + 10000;
  while (!readCalls().some(args => args.includes('app-server')) && Date.now() < nativeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  const calls = readCalls();
  assert.equal(calls.filter(args => args.includes('sandbox')).length, 2, 'Only the winning owner probes default and Landlock once');
  assert.deepEqual(calls.filter(args => args.includes('app-server')), [['--enable', 'use_legacy_landlock', '-c', 'features.code_mode_host=true', 'app-server']]);
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
