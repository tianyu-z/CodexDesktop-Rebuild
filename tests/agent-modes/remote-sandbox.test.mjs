import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRemoteSandboxArgs } from '../../runtime/agent-modes/remote/sandbox.mjs';

function fixture(t, behavior) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-sandbox-'));
  const command = join(directory, 'codex'), log = join(directory, 'calls.jsonl'), directories = join(directory, 'directories.jsonl');
  writeFileSync(log, '');
  writeFileSync(directories, '');
  writeFileSync(command, `#!${process.execPath}\nconst args = process.argv.slice(2); require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n'); require('node:fs').appendFileSync(${JSON.stringify(directories)}, JSON.stringify({cwd:process.cwd(),mode:require('node:fs').statSync(process.cwd()).mode & 0o077}) + '\\n');\n${behavior}\n`, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { command, log, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    assertIsolatedCwd: () => {
      const calls = readFileSync(directories, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.ok(calls.length > 0, 'The fixture should observe its probe cwd');
      assert.equal(new Set(calls.map(call => call.cwd)).size, 1, 'Both backends use the same private cwd');
      for (const call of calls) {
        assert.notEqual(call.cwd, process.cwd(), 'A capability probe must not depend on the login directory');
        assert.equal(call.mode, 0, 'The probe directory is private');
        assert.equal(existsSync(call.cwd), false, 'The owned directory is removed after the probe');
      }
    } };
}
const defaultArgs = ['sandbox', '-c', 'sandbox_mode="read-only"', '--', '/bin/true'];

test('a supported default native sandbox needs no compatibility flag', async t => {
  const f = fixture(t, 'process.exit(0);');
  assert.deepEqual(await resolveRemoteSandboxArgs({ command: f.command }), []);
  assert.deepEqual(f.calls(), [defaultArgs]);
  f.assertIsolatedCwd();
});

test('only known bwrap permission failures select a verified native Landlock sandbox', async t => {
  for (const error of ['bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', 'bwrap: Failed to make / slave: Permission denied']) {
    const f = fixture(t, `if (!args.includes('use_legacy_landlock')) { console.error(${JSON.stringify(error)}); process.exit(1); }`);
    assert.deepEqual(await resolveRemoteSandboxArgs({ command: f.command }), ['--enable', 'use_legacy_landlock']);
    assert.deepEqual(f.calls(), [defaultArgs, ['sandbox', '-c', 'sandbox_mode="read-only"', '--enable', 'use_legacy_landlock', '--', '/bin/true']]);
    f.assertIsolatedCwd();
  }
});

test('unrelated native errors do not enable another sandbox or expose raw configuration', async t => {
  const f = fixture(t, "console.error('invalid configuration: fixture-secret'); process.exit(3);");
  await assert.rejects(resolveRemoteSandboxArgs({ command: f.command }), error => /sandbox.*failed/i.test(error.message) && !error.message.includes('fixture-secret'));
  assert.deepEqual(f.calls(), [defaultArgs]);
  f.assertIsolatedCwd();
});

test('both native sandbox failures stop startup without an unsandboxed attempt', async t => {
  const f = fixture(t, "console.error(args.includes('use_legacy_landlock') ? 'Landlock is unavailable' : 'bwrap: Failed to make / slave: Permission denied'); process.exit(1);");
  await assert.rejects(resolveRemoteSandboxArgs({ command: f.command }), /sandbox.*(?:unavailable|failed)/i);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls().every(args => args.includes('sandbox_mode="read-only"') && !args.some(arg => /danger|disable|bypass/.test(arg))));
  f.assertIsolatedCwd();
});

test('a stalled sandbox probe is bounded and never triggers compatibility fallback', { timeout: 3000 }, async t => {
  const f = fixture(t, '');
  // The deadline tests a stalled process, not Node's interpreter startup while
  // all test files compete for CPU. This shell owns no descendant processes.
  writeFileSync(f.command, "#!/bin/sh\nprintf '[]\\n' >> '" + f.log.replaceAll("'", "'\\''") + "'\ntrap '' TERM\nwhile :; do :; done\n", { mode: 0o700 });
  const start = Date.now();
  await assert.rejects(resolveRemoteSandboxArgs({ command: f.command, timeoutMs: 250 }), /timed out/i);
  assert.ok(Date.now() - start < 2000);
  // Under process/filesystem contention the owned child may be killed before
  // its script starts. Both cases must settle without launching a retry.
  assert.ok(f.calls().length <= 1);
});

test('excessive native probe output is bounded and is not a fallback signal', async t => {
  const f = fixture(t, "process.stderr.write('x'.repeat(128 * 1024)); setInterval(() => {}, 1000);");
  await assert.rejects(resolveRemoteSandboxArgs({ command: f.command }), /output/i);
  assert.equal(f.calls().length, 1);
  f.assertIsolatedCwd();
});

test('the gateway startup deadline also bounds a compatibility retry', { timeout: 12000 }, async t => {
  const f = fixture(t, "setInterval(() => { if (!args.includes('use_legacy_landlock') && require('node:fs').existsSync(__filename + '.continue')) { console.error('bwrap: Failed to make / slave: Permission denied'); process.exit(1); } }, 20);");
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const result = resolveRemoteSandboxArgs({ command: f.command, timeoutMs: 5000, deadline: 6000 }).then(() => null, error => error);
  const readyDeadline = Date.now() + 4000;
  while (!f.calls().length && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls().length, 1, 'Wait for the default probe before consuming its remaining budget');
  now = 5750;
  const start = Date.now();
  writeFileSync(f.command + '.continue', '');
  assert.match((await result)?.message ?? '', /timed out/i);
  assert.ok(Date.now() - start < 3000, 'The retry must use its remaining 250ms instead of a new 5-second budget');
  // Contention can delay the retry's script past its deadline, before logging.
  assert.ok(f.calls().length <= 2);
  f.assertIsolatedCwd();
});

test('an expired startup deadline cannot launch a later probe', async t => {
  const f = fixture(t, 'process.exit(0);');
  await assert.rejects(resolveRemoteSandboxArgs({ command: f.command, deadline: performance.now() - 1 }), /timed out/i);
  assert.deepEqual(f.calls(), []);
});
