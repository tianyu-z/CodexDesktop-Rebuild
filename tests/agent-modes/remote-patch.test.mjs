import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { patchRemoteMain } = require('../../scripts/patch-agent-remote.js');
test('pinned remote transport connects the private gateway and never executes upstream destructive bootstrap', () => {
  const sourcePath = resolve('src/mac-arm64/_asar/.vite/build/main-3kQRhaYi.js');
  assert.ok(existsSync(sourcePath), 'Pinned upstream main is required for seam verification');
  const original = readFileSync(sourcePath, 'utf8'), patched = patchRemoteMain(original);
  assert.equal(patchRemoteMain(patched), patched);
  assert.match(patched, /__cdxRemoteEngineModes.prepare/);
  assert.match(patched, /__cdxRemoteEngineModes.proxyCommand/);
  const method = patched.slice(patched.indexOf('async startRemoteAppServer(e)'), patched.indexOf('createSshSetupError(e,t)'));
  assert.doesNotMatch(method, /pkill|nohup|SKIP_APP_SERVER_BOOT/);
  const stop = patched.slice(patched.indexOf('async killCodexProcess()'), patched.indexOf('async runRemoteLoginShellCommand('));
  assert.doesNotMatch(stop, /pkill/);
  assert.match(stop, /__cdxRemoteEngineModes.stop/);
});
test('unsupported upstream remote seams fail closed', () => {
  assert.throws(() => patchRemoteMain('unsupported source'), /expected/);
});
