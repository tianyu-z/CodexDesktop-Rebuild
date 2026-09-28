import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { packageRemoteRuntime } = require('../../scripts/remote-runtime-package.js');
const helper = require('../../scripts/assets/agent-modes-remote.cjs');
const fixture = t => { const path = mkdtempSync(join(tmpdir(), 'remote-bootstrap-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
test('runtime package bytes depend on content, not gzip timestamps or file mtimes', async t => {
  const root = fixture(t), source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'fixture.mjs'), 'export const fixture = true;\n');
  const first = packageRemoteRuntime(source, join(root, 'one.tgz'));
  await new Promise(resolve => setTimeout(resolve, 1100));
  writeFileSync(join(source, 'fixture.mjs'), 'export const fixture = true;\n');
  const second = packageRemoteRuntime(source, join(root, 'two.tgz'));
  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(readFileSync(join(root, 'one.tgz')), readFileSync(join(root, 'two.tgz')));
});
test('gateway store scope uses stable SSH identity rather than connection timeout', t => {
  const root = fixture(t), runtime = join(root, 'agent-modes'); mkdirSync(runtime);
  writeFileSync(join(runtime, 'build.json'), JSON.stringify({ appName: 'fixture' }));
  writeFileSync(join(runtime, 'remote-build.json'), JSON.stringify({ sha256: 'a'.repeat(64) }));
  const identity = { alias: 'rno', host: 'ignored-for-alias', port: 22 };
  const a = helper.layout({ sshConnection: identity, args: ['-o', 'ConnectTimeout=10', 'rno'] }, root);
  const b = helper.layout({ sshConnection: identity, args: ['-o', 'ConnectTimeout=20', 'rno'] }, root);
  assert.equal(a.scope, b.scope);
  assert.notEqual(a.scope, helper.layout({ sshConnection: { alias: 'bar' }, args: ['bar'] }, root).scope);
});
test('Node discovery skips an unusable PATH candidate and exposes the selected interpreter to CLI shebangs', t => {
  const root = fixture(t), old = join(root, 'old-node');
  writeFileSync(old, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const script = helper.nodeCommand([helper.quote(old), helper.quote(process.execPath)]) + '\nprintf "%s\\n%s" "$CDX_REMOTE_NODE" "$PATH"';
  const [selected, path] = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).split('\n');
  assert.equal(selected, process.execPath);
  assert.equal(path.split(':')[0], require('node:path').dirname(process.execPath));
});
test('forwarded SSH agent path is stable while its per-connection target changes', async t => {
  const root = fixture(t), first = join(root, 'a.sock'), second = join(root, 'b.sock');
  const a = createServer(), b = createServer();
  await Promise.all([new Promise(resolve => a.listen(first, resolve)), new Promise(resolve => b.listen(second, resolve))]);
  t.after(() => { a.close(); b.close(); });
  const script = helper.agentCommand({ data: helper.quote(join(root, 'data')) }) + '\nprintf "%s" "$SSH_AUTH_SOCK"';
  const one = execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, SSH_AUTH_SOCK: first }, encoding: 'utf8' });
  const two = execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, SSH_AUTH_SOCK: second }, encoding: 'utf8' });
  assert.equal(one, two);
  assert.equal(require('node:fs').readlinkSync(two), second);
});
test('concurrent first installs publish one complete runtime without nesting a losing stage', { timeout: 15000 }, async t => {
  const root = fixture(t), resources = join(root, 'resources'), runtime = join(resources, 'agent-modes');
  const source = join(root, 'source'), bin = join(root, 'bin'), barrier = join(root, 'barrier');
  for (const directory of [runtime, join(source, 'remote'), bin, barrier]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(source, 'remote', 'daemon.mjs'), 'console.log("fixture gateway ready");\n');
  const manifest = packageRemoteRuntime(source, join(runtime, 'remote-runtime.tar.gz'));
  writeFileSync(join(runtime, 'build.json'), JSON.stringify({ appName: 'fixture' }));
  writeFileSync(join(runtime, 'remote-build.json'), JSON.stringify(manifest));
  for (const cli of ['codex', 'claude']) writeFileSync(join(bin, cli), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  // Both legacy installers must pass their [ ! -d root ] check before either
  // move runs. The loser then reaches a populated destination deterministically.
  writeFileSync(join(bin, 'mv'), '#!' + process.execPath + '\n' + `
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const barrier = process.env.CDX_TEST_BARRIER;
fs.writeFileSync(path.join(barrier, 'ready-' + process.pid), '');
const wait = condition => { const end = Date.now() + 8000; while (!condition()) { if (Date.now() > end) process.exit(90); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };
wait(() => fs.readdirSync(barrier).filter(name => name.startsWith('ready-')).length === 2);
let winner = false;
try { fs.closeSync(fs.openSync(path.join(barrier, 'owner'), 'wx')); winner = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
if (!winner) wait(() => fs.existsSync(path.join(barrier, 'published')));
const result = spawnSync('/bin/mv', process.argv.slice(2), { stdio: 'inherit' });
if (winner) fs.writeFileSync(path.join(barrier, 'published'), '');
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const previousResources = process.resourcesPath;
  process.resourcesPath = resources;
  t.after(() => { if (previousResources === undefined) delete process.resourcesPath; else process.resourcesPath = previousResources; });
  let installs = 0;
  const connection = alias => ({
    ssh: '/bin/sh', args: ['-c'], sshConnection: { alias }, codex: 'codex',
    login: command => { if (command.includes('mktemp -d')) installs++; return command.replaceAll('$HOME', '$CDX_TEST_HOME'); },
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, CDX_TEST_HOME: root, CDX_TEST_BARRIER: barrier },
  });
  await Promise.all([helper.prepare({}, connection('rno')), helper.prepare({}, connection('bar'))]);
  assert.equal(installs, 2, 'both connections should attempt the first installation');
  const parent = join(root, '.local', 'share', 'codex-desktop-rebuild', 'runtime');
  assert.deepEqual(readdirSync(parent), [manifest.sha256], 'all unpublished stages should be removed');
  assert.deepEqual(readdirSync(join(parent, manifest.sha256)).sort(), ['.complete', 'remote'], 'a losing stage must not be moved inside the winner');
  assert.equal(readFileSync(join(parent, manifest.sha256, 'remote', 'daemon.mjs'), 'utf8'), 'console.log("fixture gateway ready");\n');
});
