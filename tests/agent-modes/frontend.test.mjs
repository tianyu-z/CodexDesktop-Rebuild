import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8');
function load() {
  const context = { console, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(source, context);
  return context.__cdxEngineModes;
}
const draft = () => ({ node: {}, value: { kind: 'new' } });
const plain = x => JSON.parse(JSON.stringify(x));

test('draft engine and Claude model stay scoped; Codex carries no Claude model override', () => {
  const api = load(), a = draft(), b = draft();
  api.setDraftSelection(a, { engineMode: 'claude', engineModel: 'opus' });
  assert.deepEqual(plain(api.capture(a, 'local')), { engineMode: 'claude', engineModel: 'opus', skipAutoTitleGeneration: true });
  assert.deepEqual(plain(api.capture(b, 'local')), { engineMode: 'codex' });
  api.setDraftSelection(a, { engineMode: 'codex' });
  assert.deepEqual(plain(api.capture(a, 'local')), { engineMode: 'codex' });
  api.setDraftSelection(a, { engineMode: 'claude' });
  assert.equal(api.capture(a, 'local').engineModel, 'opus');
  assert.deepEqual(plain(api.capture(a, 'remote-ssh:test')), {});
});

test('reserved Both and invalid model selections fail explicitly', () => {
  const api = load(), scope = draft();
  assert.throws(() => api.setDraftSelection(scope, { engineMode: 'both' }), /not available/);
  assert.throws(() => api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'gpt-6' }), /model/);
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

test('remote mode selection and reads never invoke local gateway RPCs', async () => {
  const api = load(), scope = draft();
  const manager = { getHostId: () => 'remote-ssh:test', sendRequest: () => { throw Error('Unexpected RPC'); } };
  await assert.rejects(api.changeSelection({ scope, threadId: 'a', hostId: 'remote-ssh:test', manager }, { engineMode: 'claude' }), /local/);
  assert.equal(await api.permitsNativeMetadata(manager, 'a'), true);
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

function componentHarness(api, { mode = 'codex', busy = false, hostId = 'local' } = {}) {
  const scope = draft();
  const manager = { getHostId: () => hostId, getConversation: () => ({ requests: [], threadRuntimeStatus: { type: busy ? 'active' : 'idle' } }) };
  api.noteStarted(manager, 'a', { engineMode: mode });
  const React = { useSyncExternalStore: (_subscribe, read) => read(), useEffect: () => {} };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const nativeModelPicker = { native: true };
  return { tree: api.Selector({ React, jsx, scope, threadId: 'a', hostId, getHost: () => hostId, getManager: () => manager, useAtom: atom => atom === 'runtime' ? { type: busy ? 'active' : 'idle' } : atom === 'requests' ? [] : false, busyAtom: 'inProgress', runtimeStatusAtom: 'runtime', requestsAtom: 'requests', nativeModelPicker }), nativeModelPicker };
}

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

test('selector disables engine changes for active runtime and remote chats', () => {
  for (const options of [{ busy: true }, { hostId: 'remote-ssh:test' }]) {
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
