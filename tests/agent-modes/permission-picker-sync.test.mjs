import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const { patchPermissionProfiles } = createRequire(import.meta.url)('../../scripts/patch-permission-profiles.js');
const fixture = name => readFileSync(new URL(`./fixtures/native-permission-${name}.js`, import.meta.url), 'utf8');
const modes = ['auto', 'read-only', 'full-access', 'custom', 'guardian-approvals'];

function picker({ conversationId = 'existing-chat', threadMode = 'auto', hostMode = 'full-access', profileId = ':workspace', guardianRequired = false,
  allowedModes = modes, defaultProfileId = ':workspace' } = {}) {
  const updates = [];
  const scope = { get: () => ({}), set() {} };
  // Execute the captured production hook. Stubs supply React subscriptions,
  // loaded host configuration, and already-resolved authoritative thread settings.
  const atoms = ['gk', 'CS', 'SS', 'Hci', 'Nsi', 'Psi', 'uuo', 'Fsi'];
  const context = vm.createContext({
    ...Object.fromEntries(atoms.map(name => [name, name])), Q: {}, Qg: null,
    cuo: { c: n => Array(n).fill(Symbol('uninitialized')) },
    us: () => scope,
    ss: atom => atom === 'gk' ? '/project' : atom === 'Hci' ? { data: [], isPending: false, isError: false } : false,
    Y: atom => atom === 'CS' ? '/project' : atom === 'SS' ? false : atom === 'Nsi' ? { rno: hostMode } : {},
    auo: () => ({ requirements: {}, resolvedConfig: {}, isConfigDataPending: false, isProjectless: false }),
    WG: () => ({ modelSettings: { model: 'gpt-6-astra', isLoading: false } }),
    Cge: () => guardianRequired,
    Rci: () => ({ defaultProfileId, profiles: [] }),
    tuo: () => 'auto', $lo: () => 'auto', Glo: id => id === ':workspace' ? 'auto' : null,
    Pge: () => allowedModes, Lge: () => allowedModes, ksi: () => ({}), luo: { isSet: false, value: null },
    iuo: () => ({ threadApprovalsReviewer: 'user', threadPermissionProfileId: profileId, threadMode,
      threadSandboxPolicy: { type: threadMode === 'full-access' ? 'dangerFullAccess' : 'workspaceWrite', writableRoots: ['/project'] } }),
    Uco: () => null,
    Ulo: () => ({ availableAgentModes: modes, configNonFullAccessMode: 'auto', isGuardianModeAvailable: true }),
    ruo: (host, values) => values[host] ?? null, nuo: (selected, fallback) => selected ?? fallback,
    Wlo: mode => ['full-access', 'custom', 'guardian-approvals'].includes(mode),
    Zlo: () => ({ validPreferredNonFullAccessMode: null }), jsi: () => null,
    Tl: mode => ({ approvalPolicy: mode === 'full-access' ? 'never' : 'on-request', approvalsReviewer: 'user',
      sandboxPolicy: { type: mode === 'full-access' ? 'dangerFullAccess' : 'workspaceWrite' } }),
    kge: value => ({ sandboxPolicy: value.sandboxPolicy }),
    zg: () => ({ updateThreadSettingsForNextTurn: async (id, settings) => { updates.push({ id, settings }); } }),
    Jp: { error() {} },
  });
  const source = fixture('turn') + fixture('resume') + fixture('response') + fixture('picker');
  vm.runInContext(patchPermissionProfiles(source), context);
  return { result: context.KG({ conversationId, hostId: 'rno' }), updates };
}

test('resumed restricted chat is not displayed or submitted as the host Full access default', () => {
  const { result, updates } = picker();
  assert.equal(result.agentMode, 'auto');
  assert.equal(result.permissionProfileId, ':workspace');
  assert.equal(result.shouldSendPermissionOverrides, false);
  assert.equal(result.permissionOverrideThreadSettings, null);
  assert.deepEqual(updates, [], 'Rendering a resumed chat must not change its permissions');
});

test('resumed Full access chat is not downgraded to another chat host default', () => {
  const { result } = picker({ threadMode: 'full-access', hostMode: 'auto', profileId: ':danger-full-access' });
  assert.equal(result.agentMode, 'full-access');
  assert.equal(result.permissionProfileId, ':danger-full-access');
  assert.equal(result.shouldSendPermissionOverrides, false);
});

test('new chats still inherit the selected host default', () => {
  const { result } = picker({ conversationId: null, threadMode: null, profileId: null });
  assert.equal(result.agentMode, 'full-access');
  assert.equal(result.shouldSendPermissionOverrides, true);
});

test('explicit permission changes still update the selected chat', async () => {
  const { result, updates } = picker();
  result.setAgentMode('full-access');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'existing-chat');
  assert.equal(updates[0].settings.approvalPolicy, 'never');
  assert.equal(updates[0].settings.sandboxPolicy.type, 'dangerFullAccess');
});

test('required guardian approval remains enforced', () => {
  const { result } = picker({ threadMode: 'full-access', profileId: ':danger-full-access', guardianRequired: true });
  assert.equal(result.agentMode, 'guardian-approvals');
  assert.equal(result.shouldSendPermissionOverrides, true);
});

test('allowed-mode policy replaces a forbidden existing mode with the required guardian mode', () => {
  const { result } = picker({ threadMode: 'full-access', profileId: ':danger-full-access', hostMode: 'guardian-approvals',
    allowedModes: ['guardian-approvals'], defaultProfileId: null });
  assert.equal(result.agentMode, 'guardian-approvals');
  assert.equal(result.shouldSendPermissionOverrides, true);
  assert.equal(result.permissionOverrideThreadSettings.approvalPolicy, 'on-request');
  assert.equal(result.permissionOverrideThreadSettings.sandboxPolicy.type, 'workspaceWrite');
});

test('resumed custom profile identity survives host defaults', () => {
  const { result } = picker({ threadMode: 'custom', profileId: 'team-tools' });
  assert.equal(result.agentMode, 'custom');
  assert.equal(result.permissionProfileId, 'team-tools');
  assert.equal(result.shouldSendPermissionOverrides, false);
});

test('registered profile identity survives when generic custom mode is unavailable', () => {
  const { result } = picker({ threadMode: 'custom', profileId: 'team-tools', allowedModes: ['auto', 'full-access'] });
  assert.equal(result.permissionProfileId, 'team-tools');
  assert.equal(result.shouldSendPermissionOverrides, false);
  assert.equal(result.permissionOverrideThreadSettings, null);
});
