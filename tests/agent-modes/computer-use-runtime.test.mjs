import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../../scripts/assets/native-computer-use-runtime.cjs');

function fixture(t, { modern = true, incomplete = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'computer-use-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'ChatGPT with spaces.app'), resources = join(app, 'Contents', 'Resources');
  const cli = join(resources, modern ? 'codex-cli/CodexCLI.app/Contents/MacOS/codex' : 'codex');
  const node = join(resources, 'cua_node/bin/node'), repl = join(resources, 'cua_node/bin/node_repl');
  const modules = join(resources, 'cua_node/lib/node_modules');
  for (const file of [cli, node, ...(incomplete ? [] : [repl]), join(modules, '@oai/sky/package.json')]) {
    mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '{}');
  }
  return { root, app, resources, cli, node, repl, modules };
}

test('selects all native components from one verified modern installation', t => {
  assert.equal(typeof runtime.resolveNativeRuntime, 'function', 'native runtime resolver is implemented');
  const f = fixture(t), checked = [];
  const selected = runtime.resolveNativeRuntime({ platform: 'darwin', appPaths: [f.app], verifyExecutable: (file, id) => { checked.push([file, id]); return true; } });
  assert.equal(selected.codexPath, f.cli); assert.equal(selected.nodePath, f.node);
  assert.equal(selected.nodeReplPath, f.repl); assert.equal(selected.nodeModuleDirs, f.modules);
  assert.deepEqual(checked, [[f.cli, 'codex'], [f.node, 'node'], [f.repl, 'node_repl']]);
});

test('supports the legacy official app layout', t => {
  const f = fixture(t, { modern: false });
  assert.equal(runtime.resolveNativeRuntime({ platform: 'darwin', appPaths: [f.app], verifyExecutable: () => true })?.codexPath, f.cli);
});

test('rejects an unsigned backend instead of mixing it with signed clients', t => {
  const f = fixture(t);
  assert.equal(runtime.resolveNativeRuntime({ platform: 'darwin', appPaths: [f.app], verifyExecutable: file => file !== f.cli }), null);
});

test('skips an incomplete installation and uses the next complete runtime', t => {
  const bad = fixture(t, { incomplete: true }), good = fixture(t);
  const selected = runtime.resolveNativeRuntime({ platform: 'darwin', appPaths: [bad.app, good.app], verifyExecutable: () => true });
  assert.equal(selected?.codexPath, good.cli);
});

test('preserves the engine gateway while replacing its native backend and CUA paths', t => {
  const f = fixture(t), resourcesPath = join(f.root, 'dev.app/Contents/Resources');
  const gateway = join(resourcesPath, 'agent-modes/codex-gateway');
  const env = { CODEX_CLI_PATH: gateway, CDX_REAL_CODEX: join(resourcesPath, 'codex'), CODEX_ELECTRON_RESOURCES_PATH: resourcesPath, CDX_ENGINE_STORE: '/existing/store' };
  runtime.configureNativeRuntime({ platform: 'darwin', resourcesPath, env, appPaths: [f.app], verifyExecutable: () => true, warn: () => {} });
  assert.equal(env.CODEX_CLI_PATH, gateway); assert.equal(env.CDX_REAL_CODEX, f.cli);
  assert.equal(env.CDX_COMPUTER_USE_CODEX_PATH, f.cli);
  assert.equal(env.CODEX_NODE_REPL_PATH, f.repl); assert.equal(env.CODEX_BROWSER_USE_NODE_PATH, f.node);
  assert.equal(env.NODE_REPL_NODE_MODULE_DIRS, f.modules);
  assert.equal(env.CODEX_ELECTRON_RESOURCES_PATH, resourcesPath); assert.equal(env.CDX_ENGINE_STORE, '/existing/store');
});

test('selects the signed native CLI for a desktop without the engine gateway', t => {
  const f = fixture(t), env = {};
  runtime.configureNativeRuntime({ platform: 'darwin', resourcesPath: '/dev/Contents/Resources', env, appPaths: [f.app], verifyExecutable: () => true, warn: () => {} });
  assert.equal(env.CODEX_CLI_PATH, f.cli);
});

test('does not rewrite an explicitly configured third-party CLI', t => {
  const f = fixture(t), env = { CODEX_CLI_PATH: '/custom/codex', CDX_REAL_CODEX: '/custom/native' }, original = { ...env }, warnings = [];
  assert.equal(typeof runtime.configureNativeRuntime, 'function');
  runtime.configureNativeRuntime({ platform: 'darwin', resourcesPath: '/dev/Contents/Resources', env, appPaths: [f.app], verifyExecutable: () => true, warn: text => warnings.push(text) });
  assert.deepEqual(env, original); assert.match(warnings.join('\n'), /custom.*CLI/i);
});

test('leaves non-macOS and missing-runtime configurations intact', () => {
  assert.equal(typeof runtime.configureNativeRuntime, 'function');
  for (const platform of ['linux', 'win32', 'darwin']) {
    const env = { CODEX_CLI_PATH: '/dev/codex' }, original = { ...env }, warnings = [];
    runtime.configureNativeRuntime({ platform, resourcesPath: '/dev', env, appPaths: [], warn: text => warnings.push(text) });
    assert.deepEqual(env, original);
    if (platform === 'darwin') assert.match(warnings.join('\n'), /official ChatGPT.*Computer Use/i);
    else assert.equal(warnings.length, 0);
  }
});
