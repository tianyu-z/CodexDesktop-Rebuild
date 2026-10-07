import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const patch = require('../../scripts/patch-computer-use-runtime.js');
const source = readFileSync(new URL('./fixtures/native-computer-use-paths.js', import.meta.url), 'utf8');

test('runtime override changes module discovery without replacing desktop resources', () => {
  assert.equal(typeof patch.patchComputerUseBundle, 'function');
  const changed = patch.patchComputerUseBundle(source);
  const context = vm.createContext({ process, n: { Zn: r => [r + '/cua_node/lib/node_modules'] }, lte: () => null,
    Ri: ({ rawValue }) => rawValue ? { path: rawValue, source: 'env-override' } : null,
    Li: () => ({ path: '/dev/bundled', source: 'bundled-or-dev' }) });
  vm.runInContext(changed, context);
  const resolve = (env, platform = 'darwin') => context.Ii({ env, resourcesPath: '/dev', platform });
  assert.deepEqual(Array.from(resolve({}).nodeModuleDirs), ['/dev/cua_node/lib/node_modules']);
  const result = resolve({ NODE_REPL_NODE_MODULE_DIRS: ' /official/modules ' });
  assert.equal(result.nodeModuleDirs.join(':'), '/official/modules'); assert.equal(result.nodePath, '/dev/bundled');
  assert.deepEqual(Array.from(resolve({ NODE_REPL_NODE_MODULE_DIRS: '/first:/second' }).nodeModuleDirs), ['/first', '/second']);
  assert.deepEqual(Array.from(resolve({ NODE_REPL_NODE_MODULE_DIRS: ' ' }).nodeModuleDirs), ['/dev/cua_node/lib/node_modules']);
  assert.deepEqual(Array.from(resolve({ NODE_REPL_NODE_MODULE_DIRS: 'C:\\first;D:\\second' }, 'win32').nodeModuleDirs), ['C:\\first', 'D:\\second']);
  const gatewayEnv = { CODEX_CLI_PATH: '/dev/agent-modes/codex-gateway', CDX_COMPUTER_USE_CODEX_PATH: '/official/codex' };
  assert.equal(resolve(gatewayEnv).codexCliPath, '/official/codex');
  assert.equal(gatewayEnv.CODEX_CLI_PATH, '/dev/agent-modes/codex-gateway');
  assert.equal(resolve({ CODEX_CLI_PATH: '/custom/codex' }).codexCliPath, '/custom/codex');
  assert.equal(patch.patchComputerUseBundle(changed), changed);
  assert.throws(() => patch.patchComputerUseBundle(source + source), /exactly 1/);
  assert.throws(() => patch.patchComputerUseBundle('unknown upstream'), /exactly 1/);
});

test('native runtime setup runs after engine bootstrap and before upstream startup', () => {
  assert.equal(typeof patch.patchComputerUseBootstrap, 'function');
  const initial = 'require("./agent-modes-bootstrap.cjs");\nrequire("./main.js");';
  const changed = patch.patchComputerUseBootstrap(initial);
  const order = [];
  vm.runInNewContext(changed, { process: { resourcesPath: '/dev' }, require: name => {
    if (name.includes('native-computer-use-runtime')) return { configureNativeRuntime: () => order.push('native') };
    order.push(name.includes('agent-modes') ? 'gateway' : 'upstream');
  } });
  assert.deepEqual(order, ['gateway', 'native', 'upstream']);
  assert.equal(patch.patchComputerUseBootstrap(changed), changed);
});

test('build patch writes the actual entry and helper and rejects unknown source before writing', t => {
  assert.equal(typeof patch.patchComputerUseBuild, 'function');
  const root = mkdtempSync(join(tmpdir(), 'computer-use-patch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = join(root, '.vite/build'); mkdirSync(build, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ main: '.vite/build/early-bootstrap.js' }));
  const main = join(build, 'main-fixture.js'), entry = join(build, 'early-bootstrap.js');
  writeFileSync(main, 'unsupported'); writeFileSync(entry, 'require("./main-fixture.js");');
  assert.throws(() => patch.patchComputerUseBuild(root), /exactly 1/);
  assert.equal(readFileSync(entry, 'utf8'), 'require("./main-fixture.js");');
  writeFileSync(main, source); patch.patchComputerUseBuild(root);
  assert.match(readFileSync(entry, 'utf8'), /configureNativeRuntime/);
  assert.match(readFileSync(main, 'utf8'), /NODE_REPL_NODE_MODULE_DIRS/);
  assert.match(readFileSync(join(build, 'native-computer-use-runtime.cjs'), 'utf8'), /module.exports/);
  const once = readFileSync(entry, 'utf8'); patch.patchComputerUseBuild(root);
  assert.equal(readFileSync(entry, 'utf8'), once);
});
