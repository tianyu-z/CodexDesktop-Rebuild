import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const nativeUI = { Button: 'NativeButton', Dropdown: 'NativeDropdown', PowerMenu: 'NativePowerMenu', Menu: { Item: 'NativeItem' } };
const React = { useState: value => [value, () => {}], useEffect() {}, useSyncExternalStore: (_subscribe, read) => read() };
const model = { value: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] };
const plain = value => JSON.parse(JSON.stringify(value));
function load() {
  const context = { setInterval, clearInterval, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8'), context);
  return context.__cdxEngineModes;
}
function nodes(value) { return value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(nodes)] : []; }
function selector(api, scope, manager, { threadId = null, busy = false, cwd } = {}) {
  return api.Selector({ React, jsx, nativeUI, scope, threadId, cwd, hostId: 'rno', getHost: () => 'rno', getManager: () => manager,
    useAtom: () => busy, nativeModelPicker: { type: 'CodexPicker' }, bothNativeModelPicker: { type: 'CodexPicker', props: { effort: 'high' } } });
}

test('Both effort survives capture, prewarm and retry without replacing Only Claude effort', () => {
  const api = load(), scope = { node: {} }, manager = { getHostId: () => 'rno' };
  api.setDraftSelection(scope, { engineMode: 'claude', engineModel: model.value, claudeEffort: 'high' }, 'rno');
  api.setDraftSelection(scope, { engineMode: 'both', engineModels: { claude: model.value }, claudeEffort: 'max' }, 'rno');
  const fields = api.capture(scope, 'rno');
  assert.equal(fields.engineMode, 'both');
  assert.equal(fields.claudeEffort, 'max');
  assert.equal(api.capture(scope, 'local').claudeEffort, undefined);
  api.noteStarted(manager, 'prewarm', fields);
  api.observe(manager, 'engine/mode/read', { threadId: 'prewarm' }, { engineMode: 'codex' });
  assert.equal(api.turnRequestFields(manager, 'prewarm', {}, 'first').claudeEffort, 'max');
  assert.equal(api.turnRequestFields(manager, 'prewarm', {}, 'retry').claudeEffort, 'max');
  api.setDraftSelection(scope, { engineMode: 'claude' }, 'rno');
  assert.equal(api.capture(scope, 'rno').claudeEffort, 'high');
  api.setDraftSelection(scope, { engineMode: 'both', claudeEffort: null }, 'rno');
  assert.equal(api.capture(scope, 'rno').claudeEffort, null);
});

test('Both native effort menu saves in Both and uses the shared setting rather than a role setting', async () => {
  const api = load(), scope = { node: {} }, calls = [];
  const manager = { getHostId: () => 'rno', sendRequest: async (method, params) => {
    calls.push({ method, params: plain(params) });
    if (method === 'engine/capabilities') return { engines: ['codex', 'claude'], bothAvailable: true, claudeEffortSelection: true, claudeWorkflowEffortSelection: true, claudeModels: [model] };
    return { engineMode: 'both', models: { claude: model.value }, claudeWorkflowOptions: { effort: params.claudeEffort }, claudeSessionOptions: { effort: 'low', thinking: { type: 'adaptive' } } };
  } };
  await api.refreshCapabilities(manager, { hostId: 'rno', threadId: 'chat' });
  api.observe(manager, 'engine/mode/set', { threadId: 'chat' }, { engineMode: 'both', models: { claude: model.value }, claudeWorkflowOptions: { effort: 'high' }, claudeSessionOptions: { effort: 'low' } });
  const tree = selector(api, scope, manager, { threadId: 'chat' });
  const picker = nodes(tree).find(node => node.type === api.ClaudeModelPicker);
  assert.equal(picker.props.effort, 'high');
  const menu = api.ClaudeModelPicker(picker.props).props.children;
  assert.deepEqual(Array.from(menu.props.advancedConfig.effort.options, row => row.id), ['auto', ...model.supportedEffortLevels]);
  menu.props.advancedConfig.effort.options.find(row => row.id === 'max').onSelect();
  await new Promise(resolve => setImmediate(resolve));
  const save = calls.find(call => call.method === 'engine/mode/set');
  assert.equal(save.params.engineMode, 'both');
  assert.equal(save.params.claudeEffort, 'max');
  assert.equal(save.params.effort, undefined);
  assert.equal(api.getSnapshot(scope, 'chat', 'rno').claudeWorkflowOptions.effort, 'max');
  assert.ok(nodes(tree).some(node => node.type === 'CodexPicker' && node.props.effort === 'high'));
});

test('Only Claude and Both use separate runtime feature gates and reject busy selection', async () => {
  for (const mode of ['claude', 'both']) {
    const api = load(), scope = { node: {} }, calls = [];
    const manager = { getHostId: () => 'rno', sendRequest: async () => ({ engines: ['codex', 'claude'], bothAvailable: true,
      claudeEffortSelection: true, claudeWorkflowEffortSelection: false, claudeModels: [model] }) };
    await api.refreshCapabilities(manager, { hostId: 'rno' });
    api.setDraftSelection(scope, { engineMode: mode, engineModel: model.value, engineModels: { claude: model.value } }, 'rno');
    const picker = nodes(selector(api, scope, manager)).find(node => node.type === api.ClaudeModelPicker);
    assert.equal(picker.props.effortAvailable, mode === 'claude');
    const menu = api.ClaudeModelPicker({ ...picker.props, onEffort: value => calls.push(value) }).props.children;
    menu.props.advancedConfig.effort.options[1].onSelect();
    assert.equal(calls.length, mode === 'claude' ? 1 : 0);
    const busyPicker = nodes(selector(api, scope, manager, { busy: true })).find(node => node.type === api.ClaudeModelPicker);
    assert.equal(busyPicker.props.disabled, true);
    api.ClaudeModelPicker({ ...busyPicker.props, onEffort: value => calls.push(value) }).props.children.props.advancedConfig.effort.options[1].onSelect();
    assert.equal(calls.length, mode === 'claude' ? 1 : 0);
  }
});

test('failed Both effort save keeps the acknowledged setting and Auto clears it on success', async () => {
  const api = load(), scope = { node: {} }; let fail = false;
  const manager = { getHostId: () => 'rno', sendRequest: async (_method, params) => {
    if (fail) throw Error('Host cannot save this setting');
    return { engineMode: 'both', claudeWorkflowOptions: { effort: params.claudeEffort } };
  } };
  const context = { scope, threadId: 'chat', hostId: 'rno', manager };
  await api.changeSelection(context, { engineMode: 'both', claudeEffort: 'high' });
  fail = true;
  await assert.rejects(api.changeSelection(context, { engineMode: 'both', claudeEffort: 'max' }), /cannot save/);
  assert.equal(api.getSnapshot(scope, 'chat', 'rno').claudeWorkflowOptions.effort, 'high');
  fail = false;
  await api.changeSelection(context, { engineMode: 'both', claudeEffort: null });
  assert.equal(api.getSnapshot(scope, 'chat', 'rno').claudeWorkflowOptions.effort, null);
});

test('an old host explains the missing control even when its model capabilities are absent', () => {
  const api = load();
  const tree = api.ClaudeModelPicker({ React, jsx, nativeUI, models: [{ value: model.value }], value: model.value, effortAvailable: false });
  assert.match(JSON.stringify(tree), /older version|updated host/);
});

test('Both draft role and template changes clear incompatible effort using the project catalog', async () => {
  const api = load(), scope = { node: {} }, cwd = '/work/project';
  const limited = { value: 'claude-limited', supportsEffort: true, supportedEffortLevels: ['low', 'high'] };
  const template = { id: 'polly', revision: 1, roles: { participant_a: { engine: 'claude' }, host: { engine: 'codex' } } };
  const alternative = { id: 'limited', revision: 1, roles: { host: { engine: 'claude', model: limited.value } } };
  const manager = { getHostId: () => 'rno', sendRequest: async method => method === 'engine/templates/list'
    ? { templates: [template, alternative] }
    : { engines: ['codex', 'claude'], bothAvailable: true, claudeWorkflowEffortSelection: true, claudeModels: [model, limited] } };
  await api.refreshTemplates(manager, 'rno');
  await api.refreshCapabilities(manager, { hostId: 'rno', cwd });
  const reset = () => api.setDraftSelection(scope, { engineMode: 'both', engineModels: { claude: model.value },
    template: { id: 'polly', revision: 1, parameters: {} }, roleOverrides: {}, claudeEffort: 'max' }, 'rno');
  const roleChange = async roleOverrides => {
    nodes(selector(api, scope, manager, { cwd })).find(node => node.type === api.RoleControls).props.onChange(roleOverrides);
    await new Promise(resolve => setImmediate(resolve));
  };
  reset();
  await roleChange({ participant_a: { model: limited.value } });
  assert.equal(api.capture(scope, 'rno').claudeEffort, null);
  reset();
  await roleChange({ participant_a: { model: model.value } });
  assert.equal(api.capture(scope, 'rno').claudeEffort, 'max', 'a compatible role keeps the selected effort');
  reset();
  await roleChange({ host: { model: 'gpt-6', prompt: 'Summarize the results' }, participant_a: { permissionMode: 'plan' } });
  assert.equal(api.capture(scope, 'rno').claudeEffort, 'max', 'Codex models, prompts and permissions do not reset Claude effort');
  reset();
  nodes(selector(api, scope, manager, { cwd })).find(node => node.type === api.TemplateControls).props.onChange({ id: 'limited', revision: 1, parameters: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.capture(scope, 'rno').claudeEffort, null);
  reset();
  await api.changeSelection({ scope, hostId: 'rno', manager, cwd }, { engineMode: 'both', template: { id: 'uncached', revision: 1, parameters: {} } });
  assert.equal(api.capture(scope, 'rno').claudeEffort, null, 'an uncached template cannot inherit unverified effort');
});

for (const override of [{ model: null }, { engine: 'codex' }]) test(`Both draft resets inherited effort for ${JSON.stringify(override)}`, async () => {
  const api = load(), scope = { node: {} };
  const manager = { getHostId: () => 'rno', sendRequest: async method => method === 'engine/templates/list'
    ? { templates: [{ id: 'polly', revision: 1, roles: { host: { engine: 'claude' } } }] }
    : { claudeModels: [model, { value: 'default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }] } };
  await api.refreshTemplates(manager, 'rno');
  await api.refreshCapabilities(manager, { hostId: 'rno' });
  api.setDraftSelection(scope, { engineMode: 'both', engineModels: { claude: model.value }, claudeEffort: 'max' }, 'rno');
  await api.changeSelection({ scope, hostId: 'rno', manager }, { engineMode: 'both', roleOverrides: { host: override } });
  assert.equal(api.capture(scope, 'rno').claudeEffort, null);
});

for (const mode of ['claude', 'both']) test(`${mode} effort save requires the host to acknowledge the value, including Auto`, async () => {
  for (const observed of [false, true]) {
    const api = load(), scope = { node: {} }, field = mode === 'both' ? 'claudeWorkflowOptions' : 'claudeSessionOptions';
    let response;
    const manager = { getHostId: () => 'rno', sendRequest: async (method, params) => {
      if (observed) api.observe(manager, method, params, response);
      return response;
    } };
    const context = { scope, threadId: 'chat', hostId: 'rno', manager };
    const seed = () => api.observe(manager, 'engine/mode/set', { threadId: 'chat' }, { engineMode: mode, [field]: { effort: 'high' } });
    for (const requested of ['max', null]) {
      for (const unconfirmed of [{ engineMode: mode }, { engineMode: mode, [field]: { effort: 'high' } },
        { engineMode: mode === 'both' ? 'claude' : 'both', [field]: { effort: requested } }]) {
        seed(); response = unconfirmed;
        await assert.rejects(api.changeSelection(context, { engineMode: mode, claudeEffort: requested }), /confirm|updated host|reconnect/i);
        const state = api.getSnapshot(scope, 'chat', 'rno');
        assert.equal(state[field].effort, 'high');
        assert.equal(state.engineMode, mode);
        assert.equal(state.pending, false);
        assert.match(state.error, /confirm|updated host|reconnect/i);
      }
    }
    response = { engineMode: mode, [field]: { effort: null } };
    await api.changeSelection(context, { engineMode: mode, claudeEffort: null });
    assert.equal(api.getSnapshot(scope, 'chat', 'rno')[field].effort, null);
  }
});
