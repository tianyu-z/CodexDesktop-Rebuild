import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function setup() {
  const context = { console, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(source, context);
  return { api: context.__cdxEngineModes, scope: { node: {} } };
}
const selected = () => ({ engineMode: 'both', engineModels: { codex: 'gpt-default', claude: 'default' }, template: { id: 'debby', revision: 2, parameters: { rounds: 2, host_mode: 'per-round' } }, roleOverrides: { participant_a: { engine: 'codex', model: 'gpt-role-a', prompt: 'Explore option A.' }, participant_b: { engine: 'codex', model: 'gpt-role-a' }, host: { engine: 'claude', model: null } } });
const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
function render(api, scope, manager, hostId, extras = {}) {
  const React = { useSyncExternalStore: (_subscribe, read) => read(), useEffect: () => {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] };
  return api.Selector({ React, jsx, scope, hostId, getManager: () => manager, useAtom: () => false, nativeModelPicker: { native: true }, ...extras });
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...[].concat(tree.props?.children ?? []).flat(Infinity).flatMap(nodes)]; }
const find = (tree, label) => nodes(tree).find(node => node.props?.['aria-label'] === label);

test('role choices are immutable through fresh, prewarmed, retried and existing turns on a remote host', async () => {
  const { api, scope } = setup(), hostId = 'ssh:alpha';
  const manager = { getHostId: () => hostId, sendRequest: async () => ({ engineMode: 'codex', models: { codex: 'stale' }, roleOverrides: {} }) };
  const initial = selected();
  api.setDraftSelection(scope, initial, hostId);
  initial.roleOverrides.participant_a.model = 'mutated';
  const captured = api.capture(scope, hostId);
  assert.deepEqual(plain(api.requestFields(captured)), selected());
  api.noteStarted(manager, 'same', captured);
  await api.refreshThread(scope, 'same', hostId, manager);
  assert.deepEqual(plain(api.getSnapshot(scope, 'same', hostId).roleOverrides), selected().roleOverrides);
  assert.equal(await api.permitsNativeMetadata(manager, 'same'), false);
  const first = api.turnRequestFields(manager, 'same', {}, 'failed', 'gpt-native-one');
  const retry = api.turnRequestFields(manager, 'same', {}, 'retry', 'gpt-native-two');
  assert.equal(first.engineModels.codex, 'gpt-native-one');
  assert.deepEqual(plain(retry.roleOverrides), selected().roleOverrides);
  api.observe(manager, 'turn/start', { threadId: 'same', clientUserMessageId: 'retry', ...retry }, { turn: { id: 't' } });
  const later = api.turnRequestFields(manager, 'same', {}, 'later', 'gpt-native-three');
  assert.deepEqual(plain(later.roleOverrides), selected().roleOverrides);
  assert.equal(later.engineModels.codex, 'gpt-native-three');
  assert.equal(api.getSnapshot(scope, 'same', 'local').engineMode, 'codex');
});

test('partial selection changes preserve roles; explicit empty map and changed template clear them', async () => {
  const { api, scope } = setup(), calls = [], hostId = 'ssh:alpha';
  const manager = { getHostId: () => hostId, sendRequest: async (_method, params) => { calls.push(plain(params)); return { ...params, models: params.engineModels }; } };
  const context = { scope, threadId: 'chat', hostId, manager };
  await api.changeSelection(context, selected());
  await api.changeSelection(context, { engineMode: 'both', engineModels: { codex: 'new-default' } });
  assert.deepEqual(calls.at(-1).roleOverrides, selected().roleOverrides);
  await api.changeSelection(context, { engineMode: 'both', roleOverrides: {} });
  assert.deepEqual(calls.at(-1).roleOverrides, {});
  await api.changeSelection(context, selected());
  await api.changeSelection(context, { engineMode: 'both', template: { id: 'polly', revision: 1, parameters: {} } });
  assert.deepEqual(calls.at(-1).roleOverrides, {});
  api.setDraftSelection(scope, selected(), hostId);
  api.setDraftSelection(scope, { engineMode: 'both', template: { id: 'polly', revision: 1, parameters: {} } }, hostId);
  assert.deepEqual(plain(api.capture(scope, hostId).roleOverrides), {});
});

test('same composer and thread IDs keep drafts, busy state and attribution isolated by host', async () => {
  const { api, scope } = setup();
  api.setDraftSelection(scope, selected(), 'ssh:a');
  api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'claude-b' }, 'ssh:b');
  assert.equal(api.capture(scope, 'ssh:a').engineMode, 'both');
  assert.equal(api.capture(scope, 'ssh:b').engineModel, 'claude-b');
  assert.equal(api.capture(scope, 'local').engineMode, 'codex');
  const a = { getHostId: () => 'ssh:a' }, b = { getHostId: () => 'ssh:b' };
  api.observe(a, 'engine/mode/set', { threadId: 'same' }, { engineMode: 'both', busy: true, bothAvailable: true, roleOverrides: selected().roleOverrides, turnEngines: { turn: 'both' } });
  api.observe(b, 'engine/mode/set', { threadId: 'same' }, { engineMode: 'claude', busy: false, turnEngines: { turn: 'claude' } });
  assert.equal(api.sourceFor('same', 'ssh:a', 'turn'), 'both');
  assert.equal(api.sourceFor('same', 'ssh:b', 'turn'), 'claude');
  assert.equal(find(render(api, scope, a, 'ssh:a', { threadId: 'same' }), 'Chat engine').props.disabled, true);
  assert.equal(find(render(api, scope, b, 'ssh:b', { threadId: 'same' }), 'Chat engine').props.disabled, false);
  await assert.rejects(api.changeSelection({ scope, threadId: 'same', hostId: 'ssh:a', manager: a }, { engineMode: 'codex' }), /finish/);
});

test('remote engine options require the selected host handshake even when its manager object is reused', async () => {
  const { api, scope } = setup(), calls = [];
  const manager = { getHostId: () => 'ssh:a', sendRequest: async (method, params) => { calls.push({ method, params }); return { localOnly: false, bothAvailable: true, engines: ['codex', 'claude'], claudeModels: [{ value: 'claude-a' }] }; } };
  await api.refreshCapabilities(manager, { hostId: 'ssh:a' });
  assert.equal(find(render(api, scope, manager, 'ssh:a'), 'Chat engine').props.children[2].props.disabled, false);
  assert.equal(find(render(api, scope, manager, 'ssh:b'), 'Chat engine').props.children[2].props.disabled, true);
  assert.equal(find(render(api, scope, manager, 'ssh:b'), 'Chat engine').props.children[1].props.disabled, true);
  assert.equal(api.getCapabilities(manager, { hostId: 'ssh:b' }).claudeModels.length, 0);
  assert.equal(calls.length, 1);
});

test('delayed capability and thread reads update only their captured host', async () => {
  const { api, scope } = setup(), waiting = [];
  const manager = { sendRequest: (method) => new Promise(resolve => waiting.push({ method, resolve })) };
  const capA = api.refreshCapabilities(manager, { hostId: 'ssh:a', threadId: 'same' });
  const capB = api.refreshCapabilities(manager, { hostId: 'ssh:b', threadId: 'same' });
  waiting[1].resolve({ engines: ['codex', 'claude'], claudeModels: ['claude-b'], bothAvailable: true }); await capB;
  waiting[0].resolve({ engines: ['codex', 'claude'], claudeModels: ['claude-a'], bothAvailable: true }); await capA;
  assert.equal(api.getCapabilities(manager, { hostId: 'ssh:b', threadId: 'same' }).claudeModels[0].value, 'claude-b');
  const readA = api.refreshThread(scope, 'same', 'ssh:a', manager);
  const readB = api.refreshThread(scope, 'same', 'ssh:b', manager);
  waiting[3].resolve({ engineMode: 'claude', models: { claude: 'claude-b' } }); await readB;
  waiting[2].resolve({ engineMode: 'both', roleOverrides: selected().roleOverrides }); await readA;
  assert.equal(api.getSnapshot(scope, 'same', 'ssh:b').models.claude, 'claude-b');
  assert.deepEqual(plain(api.getSnapshot(scope, 'same', 'ssh:b').roleOverrides), {});
});

test('complete paginated native Codex catalogs remain independent for each host', async () => {
  const { api } = setup(), calls = []; let host = 'ssh:a';
  const manager = { getHostId: () => host, sendRequest: async (method, params) => { calls.push({ method, params: plain(params), host }); return { data: [{ id: 'opaque-id', model: `${host === 'ssh:a' ? 'a' : 'b'}-${params.cursor ? 'second' : 'first'}`, displayName: 'Native model' }], nextCursor: params.cursor ? null : 'next' }; } };
  await api.refreshCodexModels(manager, { hostId: host });
  host = 'ssh:b'; await api.refreshCodexModels(manager, { hostId: host });
  assert.deepEqual(plain(api.getCodexModels(manager, { hostId: 'ssh:a' }).models.map(model => model.value)), ['a-first', 'a-second']);
  assert.deepEqual(plain(api.getCodexModels(manager, { hostId: 'ssh:b' }).models.map(model => model.value)), ['b-first', 'b-second']);
  assert.ok(calls.every(call => call.method === 'model/list' && call.params.limit === 100 && call.params.includeHidden === true));
});

test('delayed template catalogs and workflow reads retain host ownership', async () => {
  const { api, scope } = setup(), pending = [];
  const manager = { sendRequest: (method, params) => new Promise(resolve => pending.push({ method, params, resolve })) };
  const a = api.refreshTemplates(manager, 'ssh:a'), b = api.refreshTemplates(manager, 'ssh:b');
  await Promise.resolve();
  pending[1].resolve({ templates: [{ id: 'remote-b', revision: 1, name: 'B', roles: {}, parameters: {} }] }); await b;
  pending[0].resolve({ templates: [{ id: 'remote-a', revision: 1, name: 'A', roles: {}, parameters: {} }] }); await a;
  const React = { useSyncExternalStore: (_subscribe, read) => read(), useEffect: () => {}, useState: x => [x, () => {}] };
  const picker = api.TemplateControls({ React, jsx, manager, hostId: 'ssh:b', selection: { id: 'remote-b', revision: 1, parameters: {} } });
  assert.deepEqual(plain(find(picker, 'Workflow template').props.children.map(node => node.props.value)), ['remote-b@1']);
  api.registerManager(manager, 'ssh:a'); api.registerManager(manager, 'ssh:b');
  const runsA = api.refreshRuns('same', 'ssh:a', 'turn'), runsB = api.refreshRuns('same', 'ssh:b', 'turn');
  await Promise.resolve();
  pending[3].resolve({ workflows: [{ turnId: 'turn', status: 'completed', runs: [{ id: 'b' }] }] }); await runsB;
  pending[2].resolve({ workflows: [{ turnId: 'turn', status: 'failed', runs: [{ id: 'a' }] }] }); await runsA;
  assert.equal(api.getSnapshot(scope, 'same', 'ssh:b').workflows.turn.runs[0].id, 'b');
});

test('request observation retains the dispatch host across delayed responses', async () => {
  const { createRequire } = await import('node:module');
  const patchPath = new URL('../../scripts/patch-agent-modes.js', import.meta.url);
  const context = { require: createRequire(patchPath), module: { exports: {} }, console, process };
  vm.runInNewContext(`${readFileSync(patchPath, 'utf8')}\nglobalThis.seams = APP_PATCHES;`, context);
  const seam = context.seams.find(([name]) => name === 'manager response observation')[2];
  const { api } = setup(); let hostId = 'ssh:a', resolve;
  const manager = new Function('globalThis', `return ({${seam}})`)({ __cdxEngineModes: api });
  manager.getHostId = () => hostId;
  manager.requestClient = { sendRequest: () => new Promise(done => { resolve = done; }) };
  const pending = manager.sendRequest('engine/turns/read', { threadId: 'same' });
  hostId = 'ssh:b';
  resolve({ turns: { turn: 'both' } }); await pending;
  assert.equal(api.sourceFor('same', 'ssh:a', 'turn'), 'both');
  assert.equal(api.sourceFor('same', 'ssh:b', 'turn'), 'codex');
});

test('native Codex discovery retains previous pages on errors and rejects repeated cursors', async () => {
  const { api } = setup(); let fail = false;
  const manager = { sendRequest: async () => fail ? { data: [{ model: 'partial' }], nextCursor: 'again' } : { data: [{ model: 'stable' }], nextCursor: null } };
  await api.refreshCodexModels(manager, { hostId: 'ssh:a' });
  fail = true; await api.refreshCodexModels(manager, { hostId: 'ssh:a', force: true });
  assert.equal(api.getCodexModels(manager, { hostId: 'ssh:a' }).models[0].value, 'stable');
  assert.match(api.getCodexModels(manager, { hostId: 'ssh:a' }).error, /repeated/);
});

test('remote composer busy atoms reject cached role edits until its runtime becomes idle', async () => {
  const { api, scope } = setup(), hostId = 'ssh:a', manager = { getHostId: () => hostId };
  api.setDraftSelection(scope, selected(), hostId);
  const context = { scope, hostId, manager };
  render(api, scope, manager, hostId, { useAtom: () => true });
  await assert.rejects(api.changeSelection(context, { engineMode: 'both', roleOverrides: {} }), /finish/);
  assert.deepEqual(plain(api.capture(scope, hostId).roleOverrides), selected().roleOverrides);
  render(api, scope, manager, hostId, { useAtom: () => false });
  await api.changeSelection(context, { engineMode: 'both', roleOverrides: {} });
  assert.deepEqual(plain(api.capture(scope, hostId).roleOverrides), {});
});

test('submitting while a role save is pending cannot send old overrides and overwrite the save', async () => {
  const { api, scope } = setup(), hostId = 'ssh:a'; let finish;
  const manager = { getHostId: () => hostId, sendRequest: (_method, params) => new Promise(resolve => { finish = () => resolve({ ...params, models: params.engineModels }); }) };
  api.observe(manager, 'engine/mode/set', { threadId: 'chat' }, { ...selected(), models: selected().engineModels });
  const changed = { ...selected().roleOverrides, host: { prompt: 'NEW HOST', model: 'claude-new' } };
  const saving = api.changeSelection({ scope, threadId: 'chat', hostId, manager }, { engineMode: 'both', roleOverrides: changed });
  assert.equal(api.getSnapshot(scope, 'chat', hostId).pending, true);
  assert.throws(() => api.turnRequestFields(manager, 'chat', {}, 'immediate', 'gpt-current'), /saving.*send again/i);
  finish(); await saving;
  assert.deepEqual(plain(api.turnRequestFields(manager, 'chat', {}, 'retry', 'gpt-current').roleOverrides), changed);
});

test('failed role saves never leak unacknowledged overrides into a later turn', async () => {
  const { api, scope } = setup(), hostId = 'ssh:a'; let reject;
  const manager = { getHostId: () => hostId, sendRequest: () => new Promise((_resolve, fail) => { reject = fail; }) };
  api.observe(manager, 'engine/mode/set', { threadId: 'chat' }, { ...selected(), models: selected().engineModels });
  const saving = api.changeSelection({ scope, threadId: 'chat', hostId, manager }, { engineMode: 'both', roleOverrides: { host: { prompt: 'Unsaved host prompt' } } });
  const rejected = assert.rejects(saving, /Cannot save/);
  assert.throws(() => api.turnRequestFields(manager, 'chat', selected(), 'immediate', 'gpt-current'), /saving.*send again/i);
  reject(Error('Cannot save roles')); await rejected;
  assert.deepEqual(plain(api.turnRequestFields(manager, 'chat', {}, 'later', 'gpt-current').roleOverrides), selected().roleOverrides);
  assert.equal(api.getSnapshot(scope, 'chat', hostId).pending, false);
  assert.match(api.getSnapshot(scope, 'chat', hostId).error, /Cannot save/);
});

test('native picker patch supplies the actual host auth, provider and availability policy to role selectors', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url), { patchNativePicker } = require('../../scripts/patch-agent-modes.js');
  const fixture = readFileSync(new URL('./fixtures/native-model-picker.js', import.meta.url), 'utf8');
  const patched = patchNativePicker(fixture), calls = []; let hooks;
  const availabilityAtom = {}, configAtom = {}, config = { model_provider: 'custom' }, policy = { availableModels: new Set(['hidden-allowed']), useHiddenModels: true };
  const context = {
    __cdxEngineModes: { configureCodexAvailability: value => { hooks = value; } },
    Vqa: availabilityAtom, RS: configAtom,
    ss: (atom, hostId, options) => { calls.push({ atom, hostId, options }); return atom === availabilityAtom ? policy : { data: { config } }; },
    LA: hostId => { assert.equal(hostId, 'ssh:target'); return { authMethod: 'chatgpt', isLoading: false }; },
    cb: value => value, Afn: value => value.model_provider === 'custom', Wqa: value => value.model.model === 'allowed',
  };
  vm.runInNewContext(patched, context);
  assert.ok(hooks, 'The native module must register its policy before role controls render');
  const actual = hooks.usePolicy('ssh:target');
  assert.equal(actual.availableModels, policy.availableModels);
  assert.equal(actual.useHiddenModels, true); assert.equal(actual.authMethod, 'chatgpt'); assert.equal(actual.isCustomModelProvider, true);
  assert.equal(calls.find(call => call.atom === configAtom).hostId, 'ssh:target');
  assert.deepEqual(plain(calls.find(call => call.atom === configAtom).options), { enabled: false });
  assert.equal(hooks.isAvailable({ model: { model: 'allowed' } }), true);
  const previous = patched.slice(patched.indexOf('function fNc'));
  assert.equal(patchNativePicker(previous), patched.slice(patched.indexOf('globalThis.__cdxEngineModes.configureCodexAvailability')));
});
