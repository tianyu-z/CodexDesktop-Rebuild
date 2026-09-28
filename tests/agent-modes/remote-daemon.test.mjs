import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const daemon = fileURLToPath(new URL('../../runtime/agent-modes/remote/daemon.mjs', import.meta.url));
test('concurrent remote ensure and direct serve keep one reachable owner and support restart', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cdx-daemon-test-')), command = join(root, 'codex');
  writeFileSync(command, '#!' + process.execPath + '\nrequire("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.id!=null)console.log(JSON.stringify({id:m.id,result:{}}))});\n', { mode: 0o700 });
  const env = { ...process.env, CDX_ENGINE_STORE: join(root, 'store'), CDX_REMOTE_SCOPE: 'fixture', CDX_REAL_CODEX: command, CDX_CLAUDE_PATH: command };
  const children = [];
  const run = action => {
    const child = spawn(process.execPath, [daemon, action], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
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
  const duplicate = await run('serve').done;
  assert.equal(duplicate.code, 0, duplicate.stderr);
  const alive = await run('ensure').done; assert.equal(alive.code, 0, alive.stderr);
  assert.equal(Number(readFileSync(join(root, 'store', '.gateway.lock'), 'utf8')), pid);
  await stopOwner();
  const restarted = await run('ensure').done;
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.notEqual(Number(readFileSync(join(root, 'store', '.gateway.lock'), 'utf8')), pid);
});
