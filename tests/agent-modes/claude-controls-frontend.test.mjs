import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const load = () => { const context = { console, setTimeout, clearTimeout, setInterval, clearInterval }; vm.runInNewContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8'), context); return context.__cdxEngineModes; };
const plain = value => JSON.parse(JSON.stringify(value));
const React = { useSyncExternalStore: (_, read) => read(), useEffect() {}, useMemo: fn => fn(), useState: initial => [initial, () => {}] };
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];

test('Claude native permission and command target survive capture and are isolated by host', () => {
  const api = load(), scope = { node: {} };
  api.setDraftSelection(scope, { engineMode: 'claude', claudePermissionMode: 'plan' });
  assert.equal(api.capture(scope, 'local').claudePermissionMode, 'plan');
  assert.equal(api.capture(scope, 'cluster').claudePermissionMode, undefined);
  api.setDraftSelection(scope, { engineMode: 'codex' });
  assert.equal(api.capture(scope, 'local').claudePermissionMode, undefined);
  api.setDraftSelection(scope, { engineMode: 'both', claudeCommandTarget: 'host', roleOverrides: { host: { engine: 'claude', permissionMode: 'auto' } } });
  const fields = api.capture(scope, 'local');
  assert.equal(fields.claudePermissionMode, 'plan');
  assert.equal(fields.claudeCommandTarget, 'host');
  assert.equal(fields.roleOverrides.host.permissionMode, 'auto');
});

test('native permission fallback is visible without silently changing the requested mode', async () => {
  const api = load(), scope = { node: {} }, manager = { getHostId: () => 'local', sendRequest: async () => ({ engineMode: 'claude', claudePermissionMode: 'auto', claudeActualPermissionMode: 'default' }) };
  await api.refreshThread(scope, 'chat', 'local', manager);
  assert.equal(api.getSnapshot(scope, 'chat', 'local').claudeActualPermissionMode, 'default');
  const tree = api.PermissionControls({ React, jsx, scope, threadId: 'chat', hostId: 'local', nativePicker: {}, getManager: () => manager });
  assert.equal(nodes(tree).find(node => node.props?.['aria-label'] === 'Claude permissions').props.value, 'auto');
  assert.match(nodes(tree).map(node => node.props?.children).filter(value => typeof value === 'string').join(' '), /Manual/);
});

test('invalid Claude permissions cannot be sent or saved optimistically', () => {
  const api = load(), scope = { node: {} };
  for (const mode of ['full-access', 'guardian-approvals', '', null]) {
    assert.throws(() => api.setDraftSelection(scope, { engineMode: 'claude', claudePermissionMode: mode }), /permission/i);
    assert.throws(() => api.requestFields({ engineMode: 'both', roleOverrides: { host: { permissionMode: mode } } }), /permission/i);
  }
});

test('Claude-only replaces native Codex permissions with five native modes', () => {
  const api = load(), scope = { node: {} }, nativePicker = { type: 'native-codex-permissions' };
  api.setDraftSelection(scope, { engineMode: 'claude', claudePermissionMode: 'auto' });
  const tree = api.PermissionControls({ React, jsx, scope, hostId: 'local', nativePicker, getHost: () => 'local', getManager: () => null });
  assert.equal(nodes(tree).some(node => node.type === 'native-codex-permissions'), false);
  const select = nodes(tree).find(node => node.props?.['aria-label'] === 'Claude permissions');
  assert.equal(select.props.value, 'auto');
  assert.deepEqual(plain(select.props.children.map(node => node.props.value)), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  api.setDraftSelection(scope, { engineMode: 'codex' });
  assert.deepEqual(api.PermissionControls({ React, jsx, scope, hostId: 'local', nativePicker, getHost: () => 'local', getManager: () => null }), nativePicker);
});

test('command discovery is host/project scoped, refreshable, and sanitizes entries', async () => {
  const api = load(), calls = [];
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => { calls.push({ method, params }); return { commands: [{ name: 'context', description: 'Usage', argumentHint: '' }, { name: 'team:review', description: 'Review', aliases: ['review-team'] }, { name: '../invalid' }] }; } };
  const a = await api.refreshClaudeCommands(manager, { cwd: '/project-a' });
  assert.deepEqual(plain(a.commands.map(row => row.name)), ['context', 'team:review']);
  await api.refreshClaudeCommands(manager, { cwd: '/project-a' });
  assert.equal(calls.length, 1);
  await api.refreshClaudeCommands(manager, { cwd: '/project-b' });
  await api.refreshClaudeCommands(manager, { cwd: '/project-a', force: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, 'engine/claude/commands');
});

test('Claude slash selection inserts exact editable command text instead of a Codex action', async () => {
  const api = load(), scope = { node: {} }, inserted = [], manager = { getHostId: () => 'local', sendRequest: async () => ({ commands: [{ name: 'model', description: 'Native Claude model', argumentHint: '[model]' }] }) };
  api.setDraftSelection(scope, { engineMode: 'claude' });
  await api.refreshClaudeCommands(manager, { cwd: '/project' });
  const composer = { view: { state: { tr: { insertText: (...args) => { inserted.push(args); return 'transaction'; } } }, dispatch: value => inserted.push(value) }, focus() {} };
  const entries = api.useClaudeCommands({ React, scope, hostId: 'local', cwd: '/project', composer, nativeCommands: [{ id: 'codex-model' }], getManager: () => manager });
  assert.equal(entries.some(row => row.id === 'codex-model'), false);
  entries.find(row => row.id === 'claude:model').onSelectFromInlineSlash({ range: { from: 1, to: 4 } });
  assert.deepEqual(inserted, [['/model ', 1, 4], 'transaction']);
});

test('client actions are claimed once before delivery and failed clipboard writes remain retryable', async () => {
  const api = load(), calls = [], delivered = [], scope = { node: {} };
  const action = { id: 'copy-one', type: 'copy', text: 'Native answer' };
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => {
    calls.push({ method, params });
    return method.endsWith('/claim') ? { action } : { engineMode: 'claude', claudeClientActions: [{ id: action.id, type: action.type }] };
  } };
  await api.refreshThread(scope, 'chat', 'local', manager);
  await Promise.all([api.deliverClaudeClientActions({ scope, threadId: 'chat', hostId: 'local', manager }, async () => { throw Error('Clipboard unavailable'); }), api.deliverClaudeClientActions({ scope, threadId: 'chat', hostId: 'local', manager }, async value => delivered.push(value))]);
  assert.equal(calls.filter(row => row.method.endsWith('/claim')).length, 1);
  assert.equal(delivered.length, 0);
  assert.match(api.getSnapshot(scope, 'chat', 'local').claudeClientDelivery.error, /Clipboard unavailable/);
  await api.retryClaudeClientAction({ scope, threadId: 'chat', hostId: 'local' }, async value => delivered.push(value));
  assert.deepEqual(plain(delivered), [action]);
  assert.equal(api.getSnapshot(scope, 'chat', 'local').claudeClientDelivery.message, 'Claude response copied.');
});

test('busy multi-agent controls allow exact task selection and show per-role native fallback', async () => {
  const api = load(), scope = { node: {} }, calls = [];
  const template = { id: 'test', revision: 1, roles: { host: { engine: 'claude', permissionMode: 'auto' } } };
  const state = { engineMode: 'both', busy: true, bothAvailable: true, template: { id: 'test', revision: 1, parameters: {} }, claudeCommandTarget: 'host', claudeCommandRunId: null, claudeRoleActualPermissionModes: { host: 'default' }, claudeActiveRuns: [{ id: 'task-one', roleId: 'host', stepId: 'first' }, { id: 'task-two', roleId: 'host', stepId: 'second' }] };
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => { calls.push({ method, params }); return method === 'engine/templates/list' ? { templates: [template] } : method === 'engine/claude/target/set' ? { ...state, claudeCommandRunId: params.runId } : state; } };
  await api.refreshThread(scope, 'chat', 'local', manager); await api.refreshTemplates(manager, 'local');
  const selector = api.Selector({ React, jsx, scope, threadId: 'chat', hostId: 'local', getManager: () => manager, useAtom: () => null });
  const entry = nodes(selector).find(node => node.type?.name === 'CommandControls');
  const controls = nodes(entry.type(entry.props));
  assert.equal(controls.find(node => node.props?.['aria-label'] === 'Claude command target').props.disabled, false);
  const task = controls.find(node => node.props?.['aria-label'] === 'Claude command task');
  await task.props.onChange({ target: { value: 'task-two' } });
  assert.deepEqual(plain(calls.at(-1)), { method: 'engine/claude/target/set', params: { threadId: 'chat', claudeCommandTarget: 'host', runId: 'task-two' } });
  const permission = api.PermissionControls({ React, jsx, scope, threadId: 'chat', hostId: 'local', getManager: () => manager });
  assert.match(nodes(permission).map(node => node.props?.children).filter(value => typeof value === 'string').join(' '), /Last run: Manual/);
});
