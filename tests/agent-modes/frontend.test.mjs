import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8');
function load({ now } = {}) {
  const context = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date: now ? class extends Date { static now() { return now(); } } : Date };
  vm.runInNewContext(source, context);
  return context.__cdxEngineModes;
}
const draft = () => ({ node: {}, value: { kind: 'new' } });
const plain = x => JSON.parse(JSON.stringify(x));

test('Claude effort follows draft capture, prewarm and retry without crossing hosts or engines', () => {
  const api = load(), scope = draft(), manager = { getHostId: () => 'local' };
  api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'opus', claudeEffort: 'max' });
  const fields = api.capture(scope, 'local');
  assert.equal(fields.claudeEffort, 'max');
  assert.equal(api.capture(scope, 'remote').claudeEffort, undefined);
  api.noteStarted(manager, 'prewarm', fields);
  assert.equal(api.turnRequestFields(manager, 'prewarm', {}, 'message').claudeEffort, 'max');
  api.setDraftSelection(scope, { engineMode: 'codex' });
  assert.equal(api.capture(scope, 'local').claudeEffort, undefined);
  api.setDraftSelection(scope, { engineMode: 'claude', claudeEffort: null });
  assert.equal(api.capture(scope, 'local').claudeEffort, null);
});

test('effort save failure preserves the acknowledged setting', async () => {
  const api = load(), scope = draft(); let fail = false;
  const manager = { getHostId: () => 'local', sendRequest: async (_method, params) => {
    if (fail) throw Error('Cannot save');
    assert.equal(params.claudeEffort, 'high');
    return { engineMode: 'claude', claudeSessionOptions: { effort: params.claudeEffort } };
  } };
  const context = { scope, threadId: 'a', hostId: 'local', manager };
  await api.changeSelection(context, { engineMode: 'claude', claudeEffort: 'high' });
  fail = true;
  await assert.rejects(api.changeSelection(context, { engineMode: 'claude', claudeEffort: 'max' }));
  assert.equal(api.getSnapshot(scope, 'a', 'local').claudeSessionOptions.effort, 'high');
});

test('draft engine and Claude model stay scoped; Codex carries no Claude model override', () => {
  const api = load(), a = draft(), b = draft();
  api.setDraftSelection(a, { engineMode: 'claude', engineModel: 'opus' });
  assert.deepEqual(plain(api.capture(a, 'local')), { engineMode: 'claude', engineModel: 'opus', skipAutoTitleGeneration: true });
  assert.deepEqual(plain(api.capture(b, 'local')), { engineMode: 'codex' });
  api.setDraftSelection(a, { engineMode: 'codex' });
  assert.deepEqual(plain(api.capture(a, 'local')), { engineMode: 'codex' });
  api.setDraftSelection(a, { engineMode: 'claude' });
  assert.equal(api.capture(a, 'local').engineModel, 'opus');
  assert.deepEqual(plain(api.capture(a, 'remote-ssh:test')), { engineMode: 'codex' });
});

test('unknown modes and invalid model selections fail explicitly', () => {
  const api = load(), scope = draft();
  assert.throws(() => api.setDraftSelection(scope, { engineMode: 'unknown' }), /Unknown/);
  assert.throws(() => api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'invalid model' }), /model/);
});

test('mode switch persists on its thread and failed changes preserve selected engine', async () => {
  const api = load(), scope = draft();
  let calls = [], fail = false;
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => {
    calls.push({ method, params });
    if (fail) throw Error('A turn is still running');
    return { threadId: params.threadId, engineMode: params.engineMode, models: { claude: params.engineModel ?? 'sonnet' }, busy: false };
  } };
  await api.changeSelection({ scope, threadId: 'thread-a', hostId: 'local', manager }, { engineMode: 'claude', engineModel: 'haiku' });
  assert.equal(api.getSnapshot(scope, 'thread-a', 'local').engineMode, 'claude');
  assert.equal(api.getSnapshot(scope, 'thread-b', 'local').engineMode, 'codex');
  assert.deepEqual(plain(calls[0]), { method: 'engine/mode/set', params: { threadId: 'thread-a', engineMode: 'claude', engineModel: 'haiku' } });
  fail = true;
  await assert.rejects(api.changeSelection({ scope, threadId: 'thread-a', hostId: 'local', manager }, { engineMode: 'codex' }), /still running/);
  assert.equal(api.getSnapshot(scope, 'thread-a', 'local').engineMode, 'claude');
  assert.equal(api.getSnapshot(scope, 'thread-a', 'local').pending, false);
});

test('remote mode selection uses its manager and failed reads deny native metadata', async () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'remote-ssh:test', sendRequest: () => { throw Error('Remote gateway offline'); } };
  await assert.rejects(api.changeSelection({ scope, threadId: 'a', hostId: 'remote-ssh:test', manager }, { engineMode: 'claude' }), /Remote gateway offline/);
  assert.equal(await api.permitsNativeMetadata(manager, 'a'), false);
});

test('native metadata never generates for Claude, including before first request completes', async () => {
  const api = load();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engineMode: 'claude', models: {}, busy: false }) };
  assert.equal(await api.permitsNativeMetadata(manager, 'saved'), false);
  api.noteStarted(manager, 'new', { engineMode: 'claude', engineModel: 'opus' });
  assert.equal(await api.permitsNativeMetadata(manager, 'new'), false);
});

test('source attribution is per turn and survives current engine changes', () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'local' };
  api.observe(manager, 'engine/mode/read', { threadId: 'a' }, { engineMode: 'claude', turnEngines: { old: 'codex', recent: 'claude' } });
  assert.equal(api.sourceFor('a', 'local', 'old'), 'codex');
  assert.equal(api.sourceFor('a', 'local', 'recent'), 'claude');
  api.observe(manager, 'engine/mode/set', { threadId: 'a' }, { engineMode: 'codex', models: {} });
  assert.equal(api.sourceFor('a', 'local', 'recent'), 'claude');
  assert.equal(api.sourceFor('a', 'local', 'live', { items: [{ cdxEngineSource: 'claude' }] }), 'claude');
  assert.equal(api.getSnapshot(scope, 'a', 'local').engineMode, 'codex');
});

test('a stale mode read cannot overwrite a more recent acknowledged selection', async () => {
  const api = load(), scope = draft();
  let resolveRead;
  const manager = { getHostId: () => 'local', sendRequest: async (method) => method === 'engine/mode/read'
    ? new Promise(resolve => { resolveRead = resolve; })
    : { engineMode: 'claude', models: { claude: 'sonnet' }, busy: false } };
  const read = api.refreshThread(scope, 'a', 'local', manager);
  await api.changeSelection({ scope, threadId: 'a', hostId: 'local', manager }, { engineMode: 'claude' });
  resolveRead({ engineMode: 'codex', models: {}, busy: false });
  await read;
  assert.equal(api.getSnapshot(scope, 'a', 'local').engineMode, 'claude');
});

function componentHarness(api, { mode = 'codex', busy = false, hostId = 'local', manager: providedManager, scope: providedScope, threadId = 'a', cwd, model, seed = true } = {}) {
  const scope = providedScope ?? draft();
  const manager = providedManager ?? { getHostId: () => hostId, getConversation: () => ({ requests: [], threadRuntimeStatus: { type: busy ? 'active' : 'idle' } }) };
  if (seed) api.noteStarted(manager, threadId, { engineMode: mode, ...(model ? { engineModel: model } : {}) });
  const React = { useSyncExternalStore: (_subscribe, read) => read(), useEffect: () => {} };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const nativeModelPicker = { native: true };
  return { tree: api.Selector({ React, jsx, scope, threadId, hostId, cwd, getHost: () => hostId, getManager: () => manager, useAtom: atom => atom === 'runtime' ? { type: busy ? 'active' : 'idle' } : atom === 'requests' ? [] : false, busyAtom: 'inProgress', runtimeStatusAtom: 'runtime', requestsAtom: 'requests', nativeModelPicker }), nativeModelPicker };
}

test('draft model and engine menus clear unsupported inherited effort before first submission', async () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engines: ['codex', 'claude'], claudeModels: [{ value: 'opus', supportsEffort: true, supportedEffortLevels: ['max'] }, { value: 'provider-only' }] }) };
  await api.refreshCapabilities(manager, { hostId: 'local' });
  const render = () => componentHarness(api, { scope, manager, threadId: null, seed: false }).tree;
  api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'opus', claudeEffort: 'max' });
  render().props.children[1].props.onChange({ target: { value: 'provider-only' } });
  assert.equal(api.capture(scope, 'local').claudeEffort, null);
  api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'opus', claudeEffort: 'max' });
  api.setDraftSelection(scope, { engineMode: 'both', engineModels: { claude: 'provider-only' } });
  render().props.children[0].props.onChange({ target: { value: 'claude' } });
  assert.equal(api.capture(scope, 'local').claudeEffort, null);
});

test('selector preserves native Codex picker and presents reserved Both as disabled', () => {
  const api = load(), { tree, nativeModelPicker } = componentHarness(api);
  const [engine, model] = tree.props.children;
  assert.equal(model, nativeModelPicker);
  assert.equal(engine.props.disabled, false);
  assert.equal(engine.props.children[0].props.children, 'Only Codex');
  assert.equal(engine.props.children[1].props.children, 'Only Claude Code');
  assert.equal(engine.props.children[2].props.disabled, true);
});

test('Claude selector uses a separate model picker and explains permission ownership', () => {
  const api = load(), { tree, nativeModelPicker } = componentHarness(api, { mode: 'claude' });
  const [, model] = tree.props.children;
  assert.notEqual(model, nativeModelPicker);
  assert.equal(model.props['aria-label'], 'Claude Code model');
  assert.match(model.props.title, /own project\/user permissions and per-tool approvals/);
  assert.match(model.props.title, /Codex permission selector applies only to Codex/);
});

test('selector disables engine changes for active runtime on local and remote hosts', () => {
  for (const options of [{ busy: true }, { hostId: 'remote-ssh:test', busy: true }]) {
    const api = load(), { tree } = componentHarness(api, options);
    assert.equal(tree.props.children[0].props.disabled, true);
  }
});

test('metadata rechecks authoritative mode after another window switches engines', async () => {
  const api = load();
  let mode = 'codex', reads = 0;
  const manager = { getHostId: () => 'local', sendRequest: async () => { reads++; return { engineMode: mode, models: {}, busy: false }; } };
  assert.equal(await api.permitsNativeMetadata(manager, 'a'), true);
  mode = 'claude';
  assert.equal(await api.permitsNativeMetadata(manager, 'a'), false);
  assert.equal(reads, 2);
});

test('prewarm reads retain captured Claude creation intent until the first turn acknowledgment', async () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engineMode: 'codex', models: { claude: 'default' }, busy: false }) };
  api.noteStarted(manager, 'prewarm', { engineMode: 'claude', engineModel: 'opus', clientUserMessageId: 'first-message' });
  await api.refreshThread(scope, 'prewarm', 'local', manager);
  assert.equal(api.getSnapshot(scope, 'prewarm', 'local').engineMode, 'claude');
  assert.equal(api.getSnapshot(scope, 'prewarm', 'local').models.claude, 'opus');
  assert.equal(await api.permitsNativeMetadata(manager, 'prewarm'), false);
  api.observe(manager, 'turn/start', { threadId: 'different', engineMode: 'claude', clientUserMessageId: 'first-message' }, { turn: { id: 'unrelated' } });
  await api.refreshThread(scope, 'prewarm', 'local', manager);
  assert.equal(api.getSnapshot(scope, 'prewarm', 'local').engineMode, 'claude');
  api.observe(manager, 'turn/start', { threadId: 'prewarm', engineMode: 'claude', engineModel: 'opus', clientUserMessageId: 'first-message' }, { turn: { id: 'first-turn', status: 'completed' } });
  await api.refreshThread(scope, 'prewarm', 'local', manager);
  assert.equal(api.getSnapshot(scope, 'prewarm', 'local').engineMode, 'codex');
  assert.equal(await api.permitsNativeMetadata(manager, 'prewarm'), true);
});

test('first-turn acknowledgment invalidates reads that began while creation intent was pending', async () => {
  const api = load(), scope = draft();
  let resolveRead;
  const manager = { getHostId: () => 'local', sendRequest: () => new Promise(resolve => { resolveRead = resolve; }) };
  api.noteStarted(manager, 'prewarm', { engineMode: 'claude', engineModel: 'opus' });
  const pendingRead = api.refreshThread(scope, 'prewarm', 'local', manager);
  api.observe(manager, 'turn/start', { threadId: 'prewarm', engineMode: 'claude', engineModel: 'opus' }, { turn: { id: 'first-turn', status: 'inProgress' } });
  resolveRead({ engineMode: 'codex', models: {}, busy: false });
  await pendingRead;
  assert.equal(api.getSnapshot(scope, 'prewarm', 'local').engineMode, 'claude');
});

test('failed-turn controls react to the later idle event even when latest-turn busy is unchanged', () => {
  const api = load(), scope = draft(), subscriptions = new Set();
  const native = { inProgress: false, runtime: { type: 'active', activeFlags: [] }, requests: [] };
  const manager = { getHostId: () => 'local', getConversation: () => ({ threadRuntimeStatus: native.runtime, requests: native.requests }) };
  api.observe(manager, 'engine/mode/set', { threadId: 'failed' }, { engineMode: 'claude', models: { claude: 'default' }, busy: false });
  const React = { useSyncExternalStore: (_subscribe, read) => read(), useEffect: () => {} };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  let tree;
  const render = () => { tree = api.Selector({ React, jsx, scope, threadId: 'failed', hostId: 'local', getHost: () => 'local', getManager: () => manager,
    busyAtom: 'inProgress', runtimeStatusAtom: 'runtime', requestsAtom: 'requests', useAtom: atom => { subscriptions.add(atom); return native[atom]; }, nativeModelPicker: {} }); };
  const publish = (atom, value) => { native[atom] = value; if (subscriptions.has(atom)) render(); };
  render();
  assert.equal(tree.props.children[0].props.disabled, true);
  // turn/completed already made yk false and the gateway busy read was always
  // false. Only thread/status/changed can trigger the remaining transition.
  publish('runtime', { type: 'idle' });
  assert.equal(tree.props.children[0].props.disabled, false);
  assert.equal(tree.props.children[1].props.disabled, false);
  publish('requests', [{ method: 'item/commandExecution/requestApproval', id: 'approval-1' }]);
  assert.equal(tree.props.children[0].props.disabled, true);
  publish('requests', []);
  assert.equal(tree.props.children[0].props.disabled, false);
});

test('retrying failed first-turn preparation reapplies only the pending creation intent', () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'local' };
  api.noteStarted(manager, 'retry-thread', { engineMode: 'claude', engineModel: 'opus', clientUserMessageId: 'failed-message' });
  assert.equal(typeof api.turnRequestFields, 'function');
  const fields = api.turnRequestFields(manager, 'retry-thread', { model: 'native-default' }, 'retry-message');
  assert.deepEqual(plain(fields), { engineMode: 'claude', engineModel: 'opus' });
  api.observe(manager, 'turn/start', { threadId: 'retry-thread', clientUserMessageId: 'retry-message', ...fields }, { turn: { id: 'retry-turn' } });
  assert.deepEqual(plain(api.turnRequestFields(manager, 'retry-thread', { model: 'native-default' }, 'after-ack')), {});
  assert.deepEqual(plain(api.turnRequestFields(manager, 'different-thread', {}, 'message')), {});
  assert.equal(api.getSnapshot(scope, 'retry-thread', 'local').engineMode, 'claude');
});


test('exact and custom Claude model identifiers are captured and forwarded without alias substitution', async () => {
  const api = load(), scope = draft(), calls = [];
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => { calls.push({ method, params }); return { engineMode: params.engineMode, models: { claude: params.engineModel }, busy: false }; } };
  for (const model of ['claude-opus-4-8', 'claude-opus-4-6', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-6[1m]', 'arn:aws:bedrock:us-west-2:123:inference-profile/custom-deployment-v3', 'my-team/deployment_2026@v2', 'opus', 'sonnet', 'haiku']) {
    api.setDraftSelection(scope, { engineMode: 'claude', engineModel: model });
    assert.equal(api.capture(scope, 'local').engineModel, model);
    assert.equal(api.requestFields(api.capture(scope, 'local')).engineModel, model);
    await api.changeSelection({ scope, threadId: 'models', hostId: 'local', manager }, { engineMode: 'claude', engineModel: model });
    assert.equal(calls.at(-1).params.engineModel, model);
  }
});

test('Claude model identifier validation rejects malformed and oversized values', () => {
  const api = load(), scope = draft();
  for (const model of ['', ' ', ' claude-opus-5', 'claude-opus-5 ', 'model\nname', 'model\0name', 'claude-opus-5\n', 'claude-opus-5\r', 'claude-opus-5\r\n', 'claude-opus-5\u2028', '-flag', 'a'.repeat(257)]) {
    assert.throws(() => api.setDraftSelection(scope, { engineMode: 'claude', engineModel: model }), /model/, JSON.stringify(model));
  }
});

test('discovered SDK models render versioned labels and preserve a saved model missing from discovery', async () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engines: ['codex', 'claude'], modelListError: null, claudeModels: [
    { value: 'opus', resolvedModel: 'claude-opus-4-8', displayName: 'Opus', description: 'Alias follows the configured Opus version' },
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Exact Opus 5.5 model' },
  ] }) };
  assert.equal(typeof api.refreshCapabilities, 'function');
  await api.refreshCapabilities(manager, { threadId: 'a' });
  const { tree } = componentHarness(api, { mode: 'claude', model: 'saved-team/deployment-v2', manager, scope });
  const model = tree.props.children[1], options = model.props.children;
  assert.equal(model.props.value, 'saved-team/deployment-v2');
  assert.deepEqual(plain(options.map(option => option.props.value)), ['default', 'opus', 'claude-opus-5-5', 'saved-team/deployment-v2']);
  assert.match(options.find(option => option.props.value === 'opus').props.children, /^Opus 4\.8/);
  assert.match(options.find(option => option.props.value === 'opus').props.title, /claude-opus-4-8/);
  assert.equal(options.find(option => option.props.value === 'claude-opus-5-5').props.children, 'Opus 5.5');
  assert.match(options.find(option => option.props.value === 'claude-opus-5-5').props.title, /claude-opus-5-5/);
  assert.match(options.at(-1).props.title, /saved|Saved/);
  assert.equal(api.getSnapshot(scope, 'a', 'local').models.claude, 'saved-team/deployment-v2');
  const refresh = tree.props.children.find(child => child?.props?.['aria-label'] === 'Refresh Claude models');
  assert.equal(refresh.type, 'button');
});

test('model discovery caches by manager and project context and expires on picker reopening', async () => {
  let now = 1000;
  const api = load({ now: () => now }), calls = [];
  const makeManager = label => ({ getHostId: () => 'local', sendRequest: async (method, params) => { calls.push({ label, method, params }); return { engines: ['codex', 'claude'], claudeModels: [{ value: `${label}-${params.threadId ?? params.cwd ?? 'draft'}`, displayName: label }], modelListError: null }; } });
  const a = makeManager('account-a'), b = makeManager('account-b');
  await api.refreshCapabilities(a, { threadId: 'project-one' });
  await api.refreshCapabilities(a, { threadId: 'project-one' });
  await api.refreshCapabilities(a, { threadId: 'project-two' });
  await api.refreshCapabilities(b, { threadId: 'project-one' });
  assert.equal(calls.length, 3);
  assert.equal(api.getCapabilities(a, { threadId: 'project-one' }).claudeModels[0].value, 'account-a-project-one');
  assert.equal(api.getCapabilities(b, { threadId: 'project-one' }).claudeModels[0].value, 'account-b-project-one');
  now += 61_000;
  await api.refreshCapabilities(a, { threadId: 'project-one' });
  assert.equal(calls.length, 4);
  assert.deepEqual(plain(calls[0].params), { threadId: 'project-one' });
});

test('failed discovery leaves engine selection available with default/current options and retries explicitly', async () => {
  const api = load(), scope = draft(), calls = [];
  let fail = true;
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => { calls.push(params); if (fail) throw Error('Model discovery unavailable'); return { engines: ['codex', 'claude'], claudeModels: [{ value: 'claude-opus-5', displayName: 'Opus 5' }], modelListError: null }; } };
  await api.refreshCapabilities(manager, { threadId: 'a' });
  const { tree } = componentHarness(api, { mode: 'claude', model: 'opus', manager, scope });
  assert.equal(tree.props.children[0].props.disabled, false);
  assert.deepEqual(plain(tree.props.children[1].props.children.map(option => option.props.value)), ['default', 'opus']);
  assert.ok(tree.props.children.some(child => child?.props?.children?.includes?.('Model discovery unavailable')));
  const retry = tree.props.children.find(child => child?.props?.['aria-label'] === 'Refresh Claude models');
  fail = false;
  await retry.props.onClick();
  assert.deepEqual(plain(calls.at(-1)), { threadId: 'a', refresh: true });
  assert.equal(api.getCapabilities(manager, { threadId: 'a' }).modelListError, null);
  assert.equal(api.getSnapshot(scope, 'a', 'local').models.claude, 'opus');
});

test('catalog error responses retain advertised engines and retry after failure without a TTL delay', async () => {
  const api = load();
  let calls = 0;
  const manager = { getHostId: () => 'local', sendRequest: async () => { calls++; return calls === 1
    ? { engines: ['codex', 'claude'], claudeModels: [], modelListError: 'Sign in to discover models' }
    : { engines: ['codex', 'claude'], claudeModels: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }], modelListError: null }; } };
  await api.refreshCapabilities(manager, { cwd: '/project' });
  assert.deepEqual(plain(api.getCapabilities(manager, { cwd: '/project' }).engines), ['codex', 'claude']);
  await api.refreshCapabilities(manager, { cwd: '/project' });
  assert.equal(calls, 2);
  assert.equal(api.getCapabilities(manager, { cwd: '/project' }).modelListError, null);
});

test('stale discovery responses cannot replace newer results or mutate saved selection', async () => {
  const api = load(), scope = draft(), pending = [];
  const manager = { getHostId: () => 'local', sendRequest: () => new Promise(resolve => pending.push(resolve)) };
  api.noteStarted(manager, 'a', { engineMode: 'claude', engineModel: 'saved-custom-id' });
  const old = api.refreshCapabilities(manager, { threadId: 'a' });
  const latest = api.refreshCapabilities(manager, { threadId: 'a', force: true });
  pending[1]({ engines: ['codex', 'claude'], claudeModels: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5' }], modelListError: null });
  await latest;
  pending[0]({ engines: ['codex', 'claude'], claudeModels: [{ value: 'claude-opus-4-6', displayName: 'Opus 4.6' }], modelListError: null });
  await old;
  assert.equal(api.getCapabilities(manager, { threadId: 'a' }).claudeModels[0].value, 'claude-opus-5-5');
  assert.equal(api.getSnapshot(scope, 'a', 'local').models.claude, 'saved-custom-id');
  assert.equal(api.getCapabilities(manager, { threadId: 'a' }).loading, false);
});

test('synchronous discovery failure does not leave a completed request cached forever', async () => {
  const api = load();
  let calls = 0;
  const manager = { getHostId: () => 'local', sendRequest: () => { calls++; if (calls === 1) throw Error('Connection not ready'); return { engines: ['codex', 'claude'], claudeModels: [{ value: 'claude-opus-5', displayName: 'Opus 5' }], modelListError: null }; } };
  await api.refreshCapabilities(manager);
  await api.refreshCapabilities(manager);
  assert.equal(calls, 2);
  assert.equal(api.getCapabilities(manager).modelListError, null);
});

test('initial capability transport failure leaves Codex accessible without enabling Claude', async () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'local', sendRequest: async () => { throw Error('Discovery unavailable'); } };
  await api.refreshCapabilities(manager);
  const { tree } = componentHarness(api, { threadId: null, manager, scope, seed: false });
  assert.equal(api.getSnapshot(scope, null, 'local').available, null);
  assert.equal(tree.props.children[0].props.disabled, false);
  assert.equal(tree.props.children[0].props.children[1].props.disabled, true);
  assert.ok(tree.props.children.some(child => child?.props?.['aria-label'] === 'Refresh Claude models'));
  assert.ok(tree.props.children.some(child => child?.props?.children?.includes?.('Discovery unavailable')));
});


test('successful gateway handshake allows Claude despite a model-list error', async () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engines: ['codex', 'claude'], claudeModels: [], modelListError: 'Sign in to discover models' }) };
  await api.refreshCapabilities(manager);
  api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'sonnet' });
  const { tree } = componentHarness(api, { mode: 'claude', threadId: null, manager, scope, seed: false });
  assert.equal(api.getSnapshot(scope, null, 'local').available, null);
  assert.equal(tree.props.children[0].props.children[1].props.disabled, false);
  assert.equal(tree.props.children[1].props.disabled, false);
  assert.equal(tree.props.children[1].props.value, 'sonnet');
});

test('compact native labels put versions first and distinguish aliases and long context', async () => {
  const api = load();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engines: ['codex', 'claude'], modelListError: null, claudeModels: [
    { value: 'default', resolvedModel: 'claude-sonnet-4-5', displayName: 'Default', description: 'Use the default model (currently Sonnet 4.5)' },
    { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
    { value: 'claude-opus-5-5[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 for long sessions' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
    { value: 'claude-future-family-7-2', displayName: 'Future Family', description: '' },
  ] }) };
  await api.refreshCapabilities(manager, { threadId: 'a' });
  const { tree } = componentHarness(api, { mode: 'claude', manager });
  const options = tree.props.children[1].props.children;
  const label = value => options.find(option => option.props.value === value).props.children;
  assert.equal(label('default'), 'Default · Sonnet 4.5');
  assert.equal(label('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(label('claude-opus-5-5[1m]'), 'Opus 5.5 (1M context)');
  assert.equal(label('haiku'), 'Haiku 4.5 (alias)');
  assert.equal(label('claude-future-family-7-2'), 'Future Family 7.2');
});


test('draft selector uses its supplied project cwd for model discovery and refresh', async () => {
  const api = load(), scope = draft(), calls = [];
  const manager = { getHostId: () => 'local', sendRequest: async (_method, params) => { calls.push(params); return { engines: ['codex', 'claude'], modelListError: null, claudeModels: [{ value: params.cwd === '/project-a' ? 'project-a-model' : 'project-b-model', displayName: 'Project model' }] }; } };
  await api.refreshCapabilities(manager, { cwd: '/project-a' });
  await api.refreshCapabilities(manager, { cwd: '/project-b' });
  api.setDraftSelection(scope, { engineMode: 'claude' });
  const { tree } = componentHarness(api, { mode: 'claude', threadId: null, cwd: '/project-a', manager, scope, seed: false });
  const values = tree.props.children[1].props.children.map(option => option.props.value);
  assert.ok(values.includes('project-a-model'));
  assert.ok(!values.includes('project-b-model'));
  await tree.props.children.find(child => child?.props?.['aria-label'] === 'Refresh Claude models').props.onClick();
  assert.deepEqual(plain(calls.at(-1)), { cwd: '/project-a', refresh: true });
});

test('selector discovers models through the callable RPC client without synchronous host lookups', async () => {
  const api = load(), scope = draft(), calls = [];
  let hostLookups = 0;
  // The real forHost() client is a callable proxy whose methods all return promises.
  const manager = Object.assign(() => {}, {
    getHostId: async () => { hostLookups++; return 'local'; },
    sendRequest: async (method, params) => {
      calls.push({ method, params });
      return { engines: ['codex', 'claude'], modelListError: null, claudeModels: [{ value: 'claude-opus-5-5' }] };
    },
  });
  const render = () => componentHarness(api, { threadId: null, cwd: '/project', manager, scope, seed: false }).tree;
  await render().props.children[0].props.onPointerDown();
  assert.equal(calls.length, 1);
  assert.equal(hostLookups, 0);
  api.setDraftSelection(scope, { engineMode: 'claude' });
  const model = render().props.children[1];
  assert.equal(model.props.disabled, false);
  assert.ok(model.props.children.some(option => option.props.value === 'claude-opus-5-5'));
  const remote = componentHarness(api, { hostId: 'remote-ssh:rno', threadId: null, manager, scope, seed: false }).tree;
  await remote.props.children[0].props.onPointerDown();
  assert.equal(calls.length, 2);
  assert.equal(hostLookups, 0);
});
