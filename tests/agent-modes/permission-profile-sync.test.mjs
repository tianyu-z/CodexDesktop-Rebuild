import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { patchPermissionProfiles, selectPermissionProfile } = createRequire(import.meta.url)('../../scripts/patch-permission-profiles.js');

const fixture = name => readFileSync(new URL(`./fixtures/native-permission-${name}.js`, import.meta.url), 'utf8');
const full = { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } };
const workspace = {
  activePermissionProfile: { id: ':workspace', extends: null }, approvalPolicy: 'on-request', approvalsReviewer: 'user',
  sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false },
  runtimeWorkspaceRoots: ['/project'],
};
const plain = value => JSON.parse(JSON.stringify(value));

function loadNative() {
  // Only filesystem/workspace services are stubbed. Permission resolution and
  // the actual turn/start request builder are the captured production code.
  const context = vm.createContext({
    Zzn: async () => [], yRn: () => ({ applied: null, pendingRevision: null, workspace: null }), SRn: () => [],
    hu: () => true, wRn: () => 'project', VYt: value => value, WZt: state => state.turns.at(-1),
    wl: roots => ({ ...workspace, sandboxPolicy: { ...workspace.sandboxPolicy, writableRoots: roots } }),
    $ft: policy => policy, RYt: () => null, LYt: ({ cwd }) => cwd, zYt: ({ sandboxPolicy }) => sandboxPolicy,
    Qzn: policy => policy, Op: (a, b) => a === b,
    ept: () => false, ah: (a, b) => [...new Set([...a, ...b])], tpt: (_, roots) => roots,
    cpn: async value => value, RRn: 'explicitRequestOnly', ZLn: 'summaries', Om: 1000,
  });
  vm.runInContext(patchPermissionProfiles(fixture('turn') + fixture('resume')), context);
  return context;
}

async function prepare({ settings = null, previous = full, current = workspace, request = {}, context = {} } = {}) {
  const native = loadNative();
  const manager = { getThreadWorkspaceState: () => null, getHostId: () => 'remote-ssh-discovered:rno', getPersonality: () => null, getDefaultFeatureOverride: () => false, logger: { info() {} } };
  return plain(await native.Jzn(manager, 'forked-chat', { request: { input: [], ...request }, context }, 'message', null, {
    cwd: '/project', workspaceKind: 'project', currentPermissions: current, latestThreadSettings: settings,
    latestModel: 'gpt-6-astra', turns: previous ? [{ turnId: 'old-turn', params: previous }] : [],
  }));
}

for (const location of ['history', 'settings']) {
  test(`Full access from legacy ${location} cannot inherit the fork's workspace profile`, async () => {
    const result = await prepare({ settings: location === 'settings' ? full : null });
    assert.equal(result.request.approvalPolicy, 'never');
    assert.equal(result.request.permissions, null);
    assert.deepEqual(result.request.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.deepEqual(result.permissions.sandboxPolicy, { type: 'dangerFullAccess' });
  });
}

test('resume keeps a legacy Full access sandbox together with its lack of a profile', () => {
  const native = loadNative();
  const result = native.resumePermissions(undefined, undefined, full, { currentPermissions: workspace }, workspace, 'user', [], []);
  assert.equal(result.activePermissionProfile, null);
  assert.deepEqual(plain(result.sandboxPolicy), full.sandboxPolicy);
});

test('legacy workspace sandbox never borrows an older Full access profile', async () => {
  const restricted = { ...workspace, activePermissionProfile: undefined };
  const result = await prepare({ previous: restricted, current: { ...full, activePermissionProfile: { id: ':danger-full-access' } } });
  assert.equal(result.request.permissions, null);
  assert.equal(result.request.approvalPolicy, 'on-request');
  assert.equal(result.request.sandboxPolicy.type, 'workspaceWrite');
});

test('explicit sandbox override clears a previously selected profile', async () => {
  const result = await prepare({ settings: { ...full, activePermissionProfile: { id: ':danger-full-access' } }, request: { approvalPolicy: 'on-request', sandboxPolicy: workspace.sandboxPolicy } });
  assert.equal(result.request.permissions, null);
  assert.equal(result.request.sandboxPolicy.type, 'workspaceWrite');
});

for (const [id, expectedPolicy] of [[':workspace', 'on-request'], [':danger-full-access', 'never'], ['team-restricted', 'on-request']]) {
  test(`explicit profile ${id} remains on the wire`, async () => {
    const result = await prepare({ request: { permissions: id, approvalPolicy: expectedPolicy } });
    assert.equal(result.request.permissions, id);
    assert.equal(result.request.approvalPolicy, expectedPolicy);
    assert.equal(result.request.sandboxPolicy, null);
  });
}

test('explicit null profile does not resurrect current workspace selection', async () => {
  for (const settings of [{ ...full, activePermissionProfile: null }, { ...full, permissions: null }]) {
    const result = await prepare({ settings });
    assert.equal(result.request.permissions, null);
    assert.equal(result.request.sandboxPolicy.type, 'dangerFullAccess');
  }
});

test('server-default and native permission selection do not send local overrides', async () => {
  for (const context of [{ useAppServerPermissionDefault: true }, { usePermissionSelection: true }]) {
    const result = await prepare({ settings: full, context });
    assert.equal(result.request.permissions, null);
    assert.equal(result.request.sandboxPolicy, null);
    assert.equal(result.request.approvalPolicy, null);
  }
});

test('custom profile identity and approval-only updates preserve the selected snapshot', () => {
  const custom = { id: 'company-tools', extends: ':workspace' };
  assert.equal(selectPermissionProfile({ approvalPolicy: 'never' }, { activePermissionProfile: custom }, full), custom);
  assert.equal(selectPermissionProfile({ activePermissionProfile: null, permissions: ':workspace' }, workspace), null);
  assert.equal(selectPermissionProfile({ permissions: null }, workspace), null);
  assert.equal(selectPermissionProfile({ approvalPolicy: 'never' }), undefined);
  const native = loadNative();
  assert.equal(native.resumePermissions(undefined, { ...workspace, activePermissionProfile: custom }, full, { currentPermissions: workspace }, workspace, 'user', [], []).activePermissionProfile, custom);
});

test('native patch is idempotent and rejects changed or ambiguous upstream code', () => {
  const source = fixture('turn') + fixture('resume');
  const patched = patchPermissionProfiles(source);
  assert.equal(patchPermissionProfiles(patched), patched);
  assert.throws(() => patchPermissionProfiles(source.replace('R=Xzn(', 'R=newResolver(')), /turn sandbox profile source/);
  assert.throws(() => patchPermissionProfiles(source + source), /turn sandbox profile source/);
});

test('general CLI build skips an unsupported upstream bundle without changing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'permission-patch-cli-'));
  try {
    mkdirSync(join(root, 'scripts'));
    for (const name of ['patch-permission-profiles.js', 'patch-agent-modes.js', 'patch-util.js']) {
      copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
    }
    const assets = join(root, 'src/mac-arm64/_asar/webview/assets');
    mkdirSync(assets, { recursive: true });
    const file = join(assets, 'app-initial-future-upstream.js');
    writeFileSync(file, 'const unrelatedUpstream = true;');
    const result = spawnSync(process.execPath, [join(root, 'scripts/patch-permission-profiles.js'), 'mac-arm64'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skipped unsupported/);
    assert.equal(readFileSync(file, 'utf8'), 'const unrelatedUpstream = true;');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
