import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRemoteSandboxArgs } from '../../runtime/agent-modes/remote/sandbox.mjs';

function fixture(t, behavior) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-sandbox-'));
  const command = join(directory, 'codex'), log = join(directory, 'calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(command, `#!${process.execPath}\nconst args = process.argv.slice(2); require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\n${behavior}\n`, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { command, log, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}
const defaultArgs = ['sandbox', '-c', 'sandbox_mode="read-only"', '--', '/bin/true'];

test('a supported default native sandbox needs no compatibility flag', async t => {
  const f = fixture(t, 'process.exit(0);');
  assert.deepEqual(await resolveRemoteSandboxArgs({ command: f.command }), []);
  assert.deepEqual(f.calls(), [defaultArgs]);
});

test('only known bwrap permission failures select a verified native Landlock sandbox', async t => {
  for (const error of ['bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', 'bwrap: Failed to make / slave: Permission denied']) {
    const f = fixture(t, `if (!args.includes('use_legacy_landlock')) { console.error(${JSON.stringify(error)}); process.exit(1); }`);
    assert.deepEqual(await resolveRemoteSandboxArgs({ command: f.command }), ['--enable', 'use_legacy_landlock']);
    assert.deepEqual(f.calls(), [defaultArgs, ['sandbox', '-c', 'sandbox_mode="read-only"', '--enable', 'use_legacy_landlock', '--', '/bin/true']]);
  }
});

test('unrelated native errors do not enable another sandbox or expose raw configuration', async t => {
  const f = fixture(t, "console.error('invalid configuration: fixture-secret'); process.exit(3);");
  await assert.rejects(resolveRemoteSandboxArgs({ command: f.command }), error => /sandbox.*failed/i.test(error.message) && !error.message.includes('fixture-secret'));
  assert.deepEqual(f.calls(), [defaultArgs]);
});

test('both native sandbox failures stop startup without an unsandboxed attempt', async t => {
  const f = fixture(t, "console.error(args.includes('use_legacy_landlock') ? 'Landlock is unavailable' : 'bwrap: Failed to make / slave: Permission denied'); process.exit(1);");
  await assert.rejects(resolveRemoteSandboxArgs({ command: f.command }), /sandbox.*(?:unavailable|failed)/i);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls().every(args => args.includes('sandbox_mode="read-only"') && !args.some(arg => /danger|disable|bypass/.test(arg))));
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
});
