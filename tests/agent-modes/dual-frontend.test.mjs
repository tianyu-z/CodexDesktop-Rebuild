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
const selection = () => ({ engineMode: 'both', engineModels: { codex: 'gpt-selected', claude: 'claude-selected' }, template: { id: 'debby', revision: 1, parameters: { rounds: 1 } } });

test('both selection captures independent models and immutable template values', () => {
  const { api, scope } = setup(), selected = selection();
  api.setDraftSelection(scope, selected);
  selected.engineModels.claude = 'mutated'; selected.template.parameters.rounds = 4;
  const captured = api.capture(scope, 'local');
  assert.deepEqual(plain(captured), { ...selection(), roleOverrides: {}, skipAutoTitleGeneration: true });
  captured.template.parameters.rounds = 5;
  assert.equal(api.capture(scope, 'local').template.parameters.rounds, 1);
  api.setDraftSelection(scope, { engineMode: 'codex' });
  api.setDraftSelection(scope, { engineMode: 'both' });
  assert.deepEqual(plain(api.capture(scope, 'local').engineModels), selection().engineModels);
  assert.deepEqual(plain(api.capture(scope, 'remote')), { engineMode: 'codex' });
});

test('both prewarm intent survives stale native reads and uses the resolved native model at send', async () => {
  const { api, scope } = setup();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engineMode: 'codex', models: { codex: 'stale', claude: 'default' } }) };
  api.noteStarted(manager, 'chat', selection());
  await api.refreshThread(scope, 'chat', 'local', manager);
  assert.equal(api.getSnapshot(scope, 'chat', 'local').engineMode, 'both');
  assert.equal(api.getSnapshot(scope, 'chat', 'local').models.claude, 'claude-selected');
  assert.equal(await api.permitsNativeMetadata(manager, 'chat'), false);
  const fields = api.turnRequestFields(manager, 'chat', {}, 'first', 'gpt-current');
  assert.equal(fields.engineModels.codex, 'gpt-current');
  assert.equal(fields.engineModels.claude, 'claude-selected');
  assert.equal(fields.template.parameters.rounds, 1);
  api.observe(manager, 'turn/start', { ...fields, threadId: 'chat', clientUserMessageId: 'first' }, { turn: { id: 'turn' } });
  assert.equal(api.getSnapshot(scope, 'chat', 'local').models.codex, 'gpt-current');
  const later = api.turnRequestFields(manager, 'chat', {}, 'later', 'gpt-new');
  assert.equal(later.engineModels.codex, 'gpt-new');
  assert.equal(later.engineModels.claude, 'claude-selected');
});

test('both model switches preserve the other model and template at gateway submission', async () => {
  const { api, scope } = setup(), calls = [];
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => {
    calls.push({ method, params });
    return { engineMode: params.engineMode, models: params.engineModels, template: params.template, bothAvailable: true };
  } };
  await api.changeSelection({ scope, threadId: 'chat', hostId: 'local', manager }, selection());
  await api.changeSelection({ scope, threadId: 'chat', hostId: 'local', manager }, { engineMode: 'both', engineModels: { claude: 'claude-new' } });
  assert.deepEqual(plain(calls.at(-1).params.engineModels), { codex: 'gpt-selected', claude: 'claude-new' });
  assert.deepEqual(plain(calls.at(-1).params.template), selection().template);
});

test('both capability and source labels require authoritative engine values', async () => {
  const { api } = setup();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engines: ['codex', 'claude'], bothAvailable: true, templateSchemaVersion: 1, claudeModels: [] }) };
  await api.refreshCapabilities(manager);
  assert.equal(api.getCapabilities(manager).bothAvailable, true);
  assert.equal(api.sourceFor('chat', 'local', 't', { cdxEngineSource: 'both' }), 'both');
  assert.throws(() => api.requestFields({ ...selection(), engineModels: { claude: 'bad model' } }), /model/i);
});

test('dual turn provenance wins over its first child message after native normalization', () => {
  const { api } = setup();
  const manager = { getHostId: () => 'local' };
  const raw = { id: 't', items: [{ cdxEngineSource: 'claude', cdxRunId: 'child' }] };
  api.observe(manager, 'engine/turns/read', { threadId: 'chat' }, { turns: { t: 'both' } });
  assert.equal(api.sourceFor('chat', 'local', 't', raw), 'both');
  // Native normalization keeps item annotations but drops turn extensions.
  api.observe(manager, 'thread/read', { threadId: 'chat' }, { thread: { turns: [raw] } });
  assert.equal(api.getSnapshot(null, 'chat', 'local').turnEngines.t, 'both');
  assert.equal(ui(api, 'SourceBadge', { threadId: 'chat', turnId: 't', raw }).render().props['data-cdx-engine-source'], 'both');
});

test('dual child attribution identifies the workflow before its source read completes', () => {
  const { api } = setup(), manager = { getHostId: () => 'local' };
  const raw = { id: 't', items: [{ cdxEngineSource: 'codex', cdxRunId: 'child' }] };
  assert.equal(api.sourceFor('chat', 'local', 't', raw), 'both');
  api.observe(manager, 'thread/read', { threadId: 'chat' }, { thread: { turns: [raw] } });
  assert.equal(api.sourceFor('chat', 'local', 't'), 'both');
  assert.equal(api.sourceFor('chat', 'local', 'single', { items: [{ cdxEngineSource: 'claude' }] }), 'claude');
});

const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
function ui(api, component, props = {}) {
  const slots = []; let index = 0;
  const React = { useSyncExternalStore: (_subscribe, read) => read(), useEffect: () => {}, useState: initial => { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial; return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; } };
  return { render: () => { index = 0; return api[component]({ React, jsx, ...props }); } };
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...[].concat(tree.props?.children ?? []).flat(Infinity).flatMap(nodes)]; }
const find = (tree, label) => nodes(tree).find(node => node.props?.['aria-label'] === label);
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props?.children === label);
const words = tree => nodes(tree).flatMap(node => [].concat(node.props?.children ?? []).filter(value => typeof value === 'string')).join(' ');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function selectorProps(scope, manager, extras = {}) {
  return { scope, hostId: 'local', getHost: () => 'local', getManager: () => manager, useAtom: () => false, nativeModelPicker: { native: true }, ...extras };
}

test('both selector uses only authoritative host capability and preserves native model controls', async () => {
  const { api, scope } = setup();
  const manager = { getHostId: () => 'local', sendRequest: async () => ({ engines: ['codex', 'claude'], bothAvailable: true, claudeModels: [{ value: 'claude-exact' }] }) };
  await api.refreshCapabilities(manager);
  api.setDraftSelection(scope, selection());
  const props = selectorProps(scope, manager), tree = ui(api, 'Selector', props).render();
  assert.equal(find(tree, 'Chat engine').props.children[2].props.disabled, false);
  assert.ok(nodes(tree).includes(props.nativeModelPicker));
  assert.equal(find(tree, 'Claude Code model').props.value, 'claude-selected');
  assert.match(words(tree), /Codex model/);
  assert.match(tree.props.style.flexWrap, /wrap/);
  find(tree, 'Claude Code model').props.onChange({ target: { value: 'claude-exact' } });
  await tick();
  assert.deepEqual(plain(api.capture(scope, 'local').engineModels), { codex: 'gpt-selected', claude: 'claude-exact' });
  const other = { getHostId: () => 'local', sendRequest: async () => ({ engines: ['codex', 'claude'] }) };
  await api.refreshCapabilities(other);
  assert.equal(find(ui(api, 'Selector', selectorProps(scope, other)).render(), 'Chat engine').props.children[2].props.disabled, true);
  assert.equal(find(ui(api, 'Selector', selectorProps(scope, manager, { hostId: 'remote' })).render(), 'Chat engine').props.children[2].props.disabled, true);
});

test('both controls disable only the busy chat and include native picker interaction boundary', () => {
  const { api, scope } = setup(); const manager = { getHostId: () => 'local' };
  api.observe(manager, 'engine/mode/set', { threadId: 'busy' }, { engineMode: 'both', models: selection().engineModels, busy: true, bothAvailable: true });
  const busyTree = ui(api, 'Selector', selectorProps(scope, manager, { threadId: 'busy' })).render();
  assert.equal(find(busyTree, 'Chat engine').props.disabled, true);
  assert.equal(find(busyTree, 'Claude Code model').props.disabled, true);
  assert.equal(find(busyTree, 'Codex model controls').props.disabled, true);
  assert.equal(find(ui(api, 'Selector', selectorProps(scope, manager, { threadId: 'idle' })).render(), 'Chat engine').props.disabled, false);
});

async function templateSetup() {
  const { BUILTIN_TEMPLATES } = await import('../../runtime/agent-modes/templates/builtins.mjs');
  const { api, scope } = setup(), calls = [], templates = plain(BUILTIN_TEMPLATES);
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => {
    calls.push({ method, params: plain(params) });
    if (method === 'engine/templates/list') return { templates: plain(templates) };
    if (method === 'engine/templates/read') return { template: plain(templates.find(row => row.id === params.id)) };
    if (method === 'engine/templates/export') return { text: params.format === 'yaml' ? `id: ${params.id}\nrevision: ${params.revision}\n` : JSON.stringify(templates.find(row => row.id === params.id)) };
    if (method === 'engine/templates/delete') { templates.splice(templates.findIndex(row => row.id === params.id), 1); return { deleted: true }; }
    if (method === 'engine/templates/save' || method === 'engine/templates/import') {
      const template = method.endsWith('import') ? JSON.parse(params.text) : plain(params.template);
      if (!template.name) throw Object.assign(Error('$.name: must not be empty'), { path: '$.name' });
      template.revision = (templates.find(row => row.id === template.id)?.revision ?? 0) + 1; template.builtin = false;
      const previous = templates.findIndex(row => row.id === template.id); if (previous >= 0) templates.splice(previous, 1);
      templates.push(template); return { template };
    }
    throw Error(`Unexpected ${method}`);
  } };
  await api.refreshTemplates(manager, 'local');
  return { api, scope, manager, calls, templates };
}

test('template selector defaults to Polly and new Debby discussion starts at two bounded rounds', async () => {
  const { api, scope, manager } = await templateSetup(), changes = [];
  let selected = api.getSnapshot(scope).template;
  const props = { manager, hostId: 'local', selection: selected, disabled: false, onChange: value => { selected = value; changes.push(value); props.selection = value; } };
  const view = ui(api, 'TemplateControls', props);
  assert.equal(find(view.render(), 'Workflow template').props.value, 'polly@1');
  find(view.render(), 'Workflow template').props.onChange({ target: { value: 'debby@2' } });
  const debby = ui(api, 'TemplateControls', { ...props, selection: selected });
  assert.equal(find(debby.render(), 'Enable discussion').props.checked, true);
  find(debby.render(), 'Enable discussion').props.onChange({ target: { checked: true } });
  assert.equal(changes.at(-1).parameters.rounds, 1);
  const enabled = ui(api, 'TemplateControls', { ...props, selection: changes.at(-1) }).render();
  assert.equal(find(enabled, 'Discussion rounds').props.min, 1);
  assert.equal(find(enabled, 'Discussion rounds').props.max, 5);
  assert.match(words(enabled), /own engine, model and prompt/);
});

test('template manager copies builtins, edits roles and definitions, and saves a separate revision', async () => {
  const { api, manager, calls } = await templateSetup();
  const view = ui(api, 'TemplateManager', { manager, hostId: 'local' });
  assert.equal(find(view.render(), 'Template name').props.disabled, true);
  assert.equal(button(view.render(), 'Save template').props.disabled, true);
  button(view.render(), 'Duplicate template').props.onClick();
  let tree = view.render();
  assert.equal(find(tree, 'Template ID').props.value, 'polly-copy');
  find(tree, 'Template name').props.onChange({ target: { value: 'My coordinator' } });
  find(view.render(), 'Role planner engine').props.onChange({ target: { value: 'codex' } });
  find(view.render(), 'Role planner prompt').props.onChange({ target: { value: 'Coordinate this work.' } });
  button(view.render(), 'Add parameter').props.onClick();
  assert.ok(find(view.render(), 'Parameter parameter type'));
  await button(view.render(), 'Save template').props.onClick();
  const saved = calls.findLast(call => call.method === 'engine/templates/save').params.template;
  assert.equal(saved.id, 'polly-copy'); assert.equal(saved.name, 'My coordinator');
  assert.equal(saved.roles.planner.engine, 'codex'); assert.equal(saved.roles.planner.prompt, 'Coordinate this work.');
  assert.equal(saved.builtin, false); assert.equal(saved.revision, undefined);
  assert.equal(find(view.render(), 'Template ID').props.value, 'polly-copy');
  await button(view.render(), 'Export template').props.onClick();
  assert.match(find(view.render(), 'Exported template').props.value, /id: polly-copy/);
  await button(view.render(), 'Delete template').props.onClick();
  assert.equal(calls.findLast(call => call.method === 'engine/templates/delete').params.id, 'polly-copy');
});

test('new dual template is schema-valid and advanced import preserves optimistic revision and errors', async () => {
  const { validateTemplate } = await import('../../runtime/agent-modes/templates/schema.mjs');
  const { api, manager, calls } = await templateSetup();
  const view = ui(api, 'TemplateManager', { manager, hostId: 'local' });
  button(view.render(), 'New dual template').props.onClick();
  await button(view.render(), 'Save template').props.onClick();
  assert.doesNotThrow(() => validateTemplate(calls.findLast(call => call.method === 'engine/templates/save').params.template));
  button(view.render(), 'Advanced YAML / JSON').props.onClick();
  let advanced = JSON.parse(find(view.render(), 'Advanced YAML or JSON').props.value);
  assert.equal(advanced.revision, 1); advanced.description = 'Changed description';
  find(view.render(), 'Advanced YAML or JSON').props.onChange({ target: { value: JSON.stringify(advanced) } });
  await button(view.render(), 'Save template').props.onClick();
  assert.equal(JSON.parse(calls.findLast(call => call.method === 'engine/templates/import').params.text).revision, 1);
  find(view.render(), 'Import YAML or JSON').props.onChange({ target: { value: JSON.stringify({ ...advanced, name: '' }) } });
  await button(view.render(), 'Import template').props.onClick();
  assert.match(words(view.render()), /\$\.name: must not be empty/);
});

test('both source panel attributes roles, keeps unreported models absent and stops or retries runs', async () => {
  const { api } = setup(), calls = [];
  const manager = { getHostId: () => 'local', sendRequest: async (method, params) => {
    calls.push({ method, params });
    return method === 'engine/runs/read' ? { workflows: [{ turnId: 't', workflowId: 'w', status: 'blocked', runs: [
      { id: 'c', roleId: 'planner', stepId: 'plan', engine: 'claude', status: 'failed', requestedModel: 'claude-selected', text: 'partial plan', error: 'Network failure' },
      { id: 'x', roleId: 'worker', stepId: 'task-1', engine: 'codex', status: 'running', requestedModel: 'gpt-selected', actualModel: 'gpt-actual', text: 'code output' },
    ] }] } : {};
  } };
  api.registerManager(manager);
  await api.refreshRuns('chat', 'local', 't');
  api.observe(manager, 'engine/turns/read', { threadId: 'chat' }, { turns: { t: 'both' } });
  api.observe(manager, 'engine/mode/set', { threadId: 'chat' }, { engineMode: 'codex', models: {} });
  const view = ui(api, 'SourceBadge', { threadId: 'chat', hostId: 'local', turnId: 't', raw: {} });
  let tree = view.render();
  assert.equal(tree.props['data-cdx-engine-source'], 'both');
  assert.ok(nodes(tree).some(node => node.type === 'details'));
  assert.match(words(tree), /Multi-agent \(Codex \/ Claude\)/);
  assert.match(words(tree), /Planner/); assert.match(words(tree), /task-1/);
  assert.match(words(tree), /partial plan/); assert.match(words(tree), /Requested model: claude-selected/);
  assert.equal((words(tree).match(/Actual model:/g) ?? []).length, 1);
  assert.match(words(tree), /Dependent work is blocked/);
  await find(tree, 'Retry run c').props.onClick();
  await find(view.render(), 'Stop run x').props.onClick();
  await button(view.render(), 'End turn').props.onClick();
  assert.deepEqual(plain(calls.find(call => call.method === 'engine/runs/retry').params), { threadId: 'chat', turnId: 't', runId: 'c' });
  assert.deepEqual(plain(calls.find(call => call.method === 'engine/runs/interrupt').params), { threadId: 'chat', turnId: 't', runId: 'x' });
  assert.deepEqual(plain(calls.find(call => call.method === 'turn/interrupt').params), { threadId: 'chat', turnId: 't' });
});

test('template manager exposes a native import disclosure and editable named parameter definitions', async () => {
  const { api, manager, calls } = await templateSetup(), view = ui(api, 'TemplateManager', { manager, hostId: 'local' });
  const disclosure = nodes(view.render()).find(node => node.type === 'details');
  assert.equal(disclosure.props.children[0].type, 'summary');
  button(view.render(), 'New dual template').props.onClick();
  button(view.render(), 'Add parameter').props.onClick();
  find(view.render(), 'Parameter parameter name').props.onBlur({ target: { value: 'depth' } });
  assert.ok(find(view.render(), 'Parameter depth type'));
  find(view.render(), 'Parameter depth type').props.onChange({ target: { value: 'boolean' } });
  find(view.render(), 'Parameter depth default').props.onChange({ target: { checked: true } });
  await button(view.render(), 'Save template').props.onClick();
  assert.deepEqual(calls.findLast(call => call.method === 'engine/templates/save').params.template.parameters.depth, { type: 'boolean', default: true, description: '' });
  assert.equal(nodes(view.render()).some(node => node.props?.multiline !== undefined), false);
});

test('advanced YAML edits cannot be silently discarded by switching to the basic form', async () => {
  const { api, manager } = await templateSetup(), view = ui(api, 'TemplateManager', { manager, hostId: 'local' });
  button(view.render(), 'New dual template').props.onClick();
  button(view.render(), 'Advanced YAML / JSON').props.onClick();
  find(view.render(), 'Advanced YAML or JSON').props.onChange({ target: { value: 'id: custom\nrevision: 2\n' } });
  button(view.render(), 'Basic form').props.onClick();
  assert.equal(find(view.render(), 'Advanced YAML or JSON').props.value, 'id: custom\nrevision: 2\n');
  assert.match(words(view.render()), /Save.*YAML.*before.*basic form/);
});

test('synchronous template and run failures can be retried on each registered host', async () => {
  const { api } = setup(); let count = 0;
  const manager = { getHostId: () => 'local', sendRequest: () => { count++; throw Error('Offline'); } };
  await api.refreshTemplates(manager); await api.refreshTemplates(manager);
  assert.equal(count, 2);
  api.registerManager(manager);
  await api.refreshRuns('chat', 'local', 'turn'); await api.refreshRuns('chat', 'local', 'turn');
  assert.equal(count, 4);
  api.registerManager(manager, 'remote');
  await api.refreshTemplates(manager, 'remote'); await api.refreshRuns('chat', 'remote', 'turn');
  assert.equal(count, 6);
});

test('custom template parameters use schema types and describe a selected Codex coordinator', async () => {
  const { api, manager, templates } = await templateSetup();
  const custom = plain(templates[1]); custom.id = 'custom'; custom.roles.host.engine = 'codex'; custom.revision = 1;
  custom.parameters = { flag: { type: 'boolean', default: false }, note: { type: 'string', default: 'test' }, count: { type: 'integer', min: 1, max: 4, default: 2 } };
  templates.push(custom); await api.refreshTemplates(manager, 'local', true);
  const changes = [], view = ui(api, 'TemplateControls', { manager, selection: { id: 'custom', revision: 1, parameters: {} }, onChange: value => changes.push(value) });
  assert.match(words(view.render()), /own engine, model and prompt/);
  find(view.render(), 'Template parameter flag').props.onChange({ target: { checked: true } });
  assert.equal(changes.at(-1).parameters.flag, true);
  find(view.render(), 'Template parameter count').props.onChange({ target: { value: '5' } });
  assert.equal(changes.length, 1);
  find(view.render(), 'Template parameter count').props.onChange({ target: { value: '3' } });
  assert.equal(changes.at(-1).parameters.count, 3);
});

test('template manager round-trips real YAML and reports revision conflicts from the template store', async t => {
  const { TemplateStore } = await import('../../runtime/agent-modes/templates/store.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'dual-template-ui-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new TemplateStore(directory), { api } = setup(), calls = [];
  const manager = { sendRequest: async (method, params) => {
    params = plain(params); // The production RPC serializes across renderer/gateway realms.
    calls.push({ method, params: plain(params) });
    if (method.endsWith('/list')) return { templates: store.list() };
    if (method.endsWith('/save')) return { template: store.save(params.template) };
    if (method.endsWith('/import')) return { template: store.import(params.text) };
    if (method.endsWith('/export')) return { text: store.export(params.id, params.revision, params.format) };
    throw Error(method);
  } };
  await api.refreshTemplates(manager);
  const view = ui(api, 'TemplateManager', { manager, hostId: 'local', initialId: 'polly' });
  button(view.render(), 'Duplicate template').props.onClick();
  await button(view.render(), 'Save template').props.onClick();
  assert.equal(store.read('polly-copy').revision, 1);
  const yaml = store.export('polly-copy', 1, 'yaml').replace('name: Polly', 'name: Edited Polly');
  button(view.render(), 'Advanced YAML / JSON').props.onClick();
  find(view.render(), 'Advanced YAML or JSON').props.onChange({ target: { value: yaml } });
  await button(view.render(), 'Save template').props.onClick();
  assert.equal(calls.findLast(call => call.method.endsWith('/import')).params.text, yaml);
  assert.equal(store.read('polly-copy').revision, 2);
  store.save({ ...store.read('polly-copy'), description: 'Updated in another window' });
  button(view.render(), 'Advanced YAML / JSON').props.onClick();
  await button(view.render(), 'Save template').props.onClick();
  assert.match(words(view.render()), /\$\.revision: revision conflict/);
  assert.equal(store.read('polly-copy').description, 'Updated in another window');
});

test('completed historical workflows read once without persistent polling', async () => {
  const { api } = setup(); let reads = 0;
  api.registerManager({ getHostId: () => 'local', sendRequest: async () => { reads++; return { workflows: [{ turnId: 't', status: 'completed', runs: [] }] }; } });
  await api.refreshRuns('chat', 'local', 't');
  const effects = [];
  const React = { useSyncExternalStore: (_subscribe, read) => read(), useEffect: fn => effects.push(fn) };
  api.SourceBadge({ React, jsx, threadId: 'chat', hostId: 'local', turnId: 't', raw: { cdxEngineSource: 'both' } });
  const cleanup = effects[1]();
  if (typeof cleanup === 'function') cleanup();
  assert.equal(cleanup, undefined);
});

test('refreshing a loaded template catalog keeps its picker usable', async () => {
  const { api, manager } = await templateSetup();
  let resolve;
  manager.sendRequest = () => new Promise(done => { resolve = done; });
  const pending = api.refreshTemplates(manager, 'local', true);
  await tick();
  const tree = ui(api, 'TemplateControls', { manager, selection: { id: 'polly', revision: 1, parameters: {} }, onChange: () => {} }).render();
  assert.equal(find(tree, 'Workflow template').props.disabled, false);
  resolve({ templates: [] }); await pending;
});

test('saving a template waits out an older catalog read before refreshing the new revision', async () => {
  const { api, manager, templates } = await templateSetup();
  const original = manager.sendRequest; let resolve;
  manager.sendRequest = (method, params) => method === 'engine/templates/list' && !resolve ? new Promise(done => { resolve = done; }) : original(method, params);
  const stale = api.refreshTemplates(manager, 'local', true); await tick();
  const view = ui(api, 'TemplateManager', { manager, hostId: 'local', initialId: 'polly' });
  button(view.render(), 'Duplicate template').props.onClick();
  const saving = button(view.render(), 'Save template').props.onClick(); await tick();
  resolve({ templates: templates.filter(template => template.id !== 'polly-copy') });
  await stale; await saving;
  assert.equal(find(view.render(), 'Managed template').props.value, 'polly-copy');
});

test('queued and approval-waiting scheduler runs expose per-run stop controls', async () => {
  const { api } = setup(), calls = [];
  api.registerManager({ getHostId: () => 'local', sendRequest: async (method, params) => {
    calls.push({ method, params: plain(params) });
    return method === 'engine/runs/read' ? { workflows: [{ turnId: 't', status: 'running', runs: ['queued', 'awaitingApproval', 'running', 'completed'].map(status => ({ id: status, roleId: 'worker', stepId: status, engine: 'claude', status, requestedModel: 'claude-selected' })) }] } : {};
  } });
  await api.refreshRuns('chat', 'local', 't');
  const view = ui(api, 'SourceBadge', { threadId: 'chat', hostId: 'local', turnId: 't', raw: { cdxEngineSource: 'both' } });
  for (const status of ['queued', 'awaitingApproval', 'running']) {
    const control = find(view.render(), `Stop run ${status}`);
    assert.ok(control, `Missing stop control for ${status}`);
    await control.props.onClick();
    assert.deepEqual(calls.findLast(call => call.method === 'engine/runs/interrupt').params, { threadId: 'chat', turnId: 't', runId: status });
  }
  assert.equal(find(view.render(), 'Stop run completed'), undefined);
});

test('both keeps the actual native model picker when the upstream width gate hides single-mode controls', () => {
  const { api, scope } = setup(), manager = { getHostId: () => 'local' };
  api.setDraftSelection(scope, selection());
  const bothNativeModelPicker = { native: 'ungated-model-and-effort-controls' };
  const props = selectorProps(scope, manager, { nativeModelPicker: false, bothNativeModelPicker });
  const both = ui(api, 'Selector', props).render();
  assert.ok(nodes(both).includes(bothNativeModelPicker));
  api.setDraftSelection(scope, { engineMode: 'codex' });
  const codex = ui(api, 'Selector', props).render();
  assert.equal(codex.props.children[1], false);
  assert.equal(nodes(codex).includes(bothNativeModelPicker), false);
});

test('retry controls track latest eligible scheduler attempts and keep earlier output readable', async t => {
  const { WorkflowScheduler } = await import('../../runtime/agent-modes/orchestration/scheduler.mjs');
  const { BUILTIN_TEMPLATE_REVISIONS } = await import('../../runtime/agent-modes/templates/builtins.mjs');
  const calls = [], { api } = setup();
  const runner = { start(options) { let finish; const done = new Promise(resolve => { finish = resolve; }); calls.push({ ...options, finish }); return { done, interrupt: async () => { finish({ status: 'interrupted', text: 'partial' }); return done; } }; } };
  const handle = new WorkflowScheduler({ runner }).start({ runId: 'workflow', template: BUILTIN_TEMPLATE_REVISIONS.find(template => template.id === 'debby' && template.revision === 1), parameters: { rounds: 0 }, models: { codex: 'gpt-selected', claude: 'claude-selected' }, cwd: '/tmp', input: 'Compare' });
  t.after(() => handle.interrupt());
  const until = async predicate => { for (let count = 0; count < 80; count++) { if (predicate()) return; await tick(); } assert.fail('Scheduler did not settle'); };
  await until(() => calls.length === 2);
  calls[0].finish({ status: 'failed', text: 'Original failed answer', error: 'Try again' });
  calls[1].finish({ status: 'completed', text: 'Other answer' });
  await until(() => handle.snapshot().status === 'blocked');
  const failedId = handle.snapshot().runs.find(run => run.status === 'failed').id;
  api.registerManager({ getHostId: () => 'local', sendRequest: async () => { const state = handle.snapshot(); return { workflows: [{ turnId: 't', status: state.status, runs: state.runs, state }] }; } });
  const view = ui(api, 'SourceBadge', { threadId: 'chat', hostId: 'local', turnId: 't', raw: { cdxEngineSource: 'both' } });
  await api.refreshRuns('chat', 'local', 't');
  assert.ok(find(view.render(), `Retry run ${failedId}`));
  assert.equal(handle.retry(failedId), true);
  await until(() => calls.length === 3);
  calls[2].finish({ status: 'completed', text: 'Recovered answer' });
  await until(() => calls.length === 4);
  await api.refreshRuns('chat', 'local', 't');
  assert.equal(handle.retry(failedId), false);
  assert.equal(find(view.render(), `Retry run ${failedId}`), undefined);
  assert.match(words(view.render()), /Original failed answer/);
  calls[3].finish({ status: 'failed', text: 'Summary failed', error: 'Summary retry needed' });
  await until(() => handle.snapshot().status === 'blocked');
  await api.refreshRuns('chat', 'local', 't');
  const summaryId = handle.snapshot().runs.find(run => run.roleId === 'moderator').id;
  assert.ok(find(view.render(), `Retry run ${summaryId}`));
  assert.equal(find(view.render(), `Retry run ${failedId}`), undefined);
});

test('both passes a scoped live native selection guard that includes host busy atoms', () => {
  const { api, scope } = setup(), manager = { getHostId: () => 'local' };
  api.setDraftSelection(scope, selection());
  const native = { type: 'actual-native-picker', props: { conversationId: undefined } };
  const props = selectorProps(scope, manager, { bothNativeModelPicker: native, useAtom: () => true });
  const tree = ui(api, 'Selector', props).render();
  const picker = nodes(tree).find(node => node.type === 'actual-native-picker');
  assert.equal(picker.props.cdxEngineSelectionContext.scope, scope);
  assert.equal(api.permitsNativeModelSelection(picker.props), false);
  ui(api, 'Selector', { ...props, useAtom: () => false }).render();
  assert.equal(api.permitsNativeModelSelection(picker.props), true);
});

test('recoverable workflows with no unfinished latest role expose explicit Continue', async () => {
  const completed = { id: 'completed', roleId: 'answer', stepId: 'answer', round: 0, attempt: 2, status: 'completed', engine: 'codex', text: 'Preserved answer' };
  for (const [status, runs, expected] of [
    ['interrupted', [], true], ['failed', [completed], true],
    ['interrupted', [{ ...completed, id: 'old', attempt: 1, status: 'failed' }, completed], true],
    ['interrupted', [{ ...completed, status: 'interrupted' }], false], ['completed', [completed], false], ['running', [], false],
  ]) {
    const { api } = setup(), calls = [];
    api.registerManager({ getHostId: () => 'local', sendRequest: async (method, params) => {
      calls.push({ method, params: plain(params) });
      return method === 'engine/runs/read' ? { workflows: [{ turnId: 't', status, runs }] } : {};
    } });
    await api.refreshRuns('chat', 'local', 't');
    const tree = ui(api, 'SourceBadge', { threadId: 'chat', hostId: 'local', turnId: 't', raw: { cdxEngineSource: 'both' } }).render();
    const resume = button(tree, 'Continue workflow');
    assert.equal(Boolean(resume), expected, `${status}: ${JSON.stringify(runs)}`);
    if (resume) {
      await resume.props.onClick();
      assert.deepEqual(calls.find(call => call.method === 'engine/runs/retry').params, { threadId: 'chat', turnId: 't' });
    }
  }
});

test('authoritatively older workflows keep outputs but hide retry and continuation actions', async () => {
  for (const runs of [[], [{ id: 'failed', engine: 'codex', roleId: 'answer', stepId: 'answer', attempt: 1, status: 'failed', text: 'Retained old output' }]]) {
    const { api } = setup();
    api.registerManager({ getHostId: () => 'local', sendRequest: async () => ({ workflows: [{ turnId: 'old', status: 'failed', isLatestTurn: false, runs }] }) });
    await api.refreshRuns('chat', 'local', 'old');
    const tree = ui(api, 'SourceBadge', { threadId: 'chat', hostId: 'local', turnId: 'old', raw: { cdxEngineSource: 'both' } }).render();
    assert.equal(button(tree, 'Continue workflow'), undefined);
    assert.equal(find(tree, 'Retry run failed'), undefined);
    if (runs.length) assert.match(words(tree), /Retained old output/);
  }
});

test('a new turn acknowledgment immediately removes cached older workflow recovery controls', async () => {
  for (const runs of [[], [{ id: 'failed', engine: 'codex', roleId: 'answer', stepId: 'answer', attempt: 1, status: 'failed', text: 'Old evidence' }]]) {
    const { api } = setup();
    const manager = { getHostId: () => 'local', sendRequest: async (_method, params) => ({ workflows: [{ turnId: params.turnId, isLatestTurn: true, status: params.turnId === 'old' ? 'interrupted' : 'running', runs: params.turnId === 'old' ? runs : [] }] }) };
    api.registerManager(manager); await api.refreshRuns('chat', 'local', 'old');
    const view = ui(api, 'SourceBadge', { threadId: 'chat', hostId: 'local', turnId: 'old', raw: { cdxEngineSource: 'both' } });
    assert.ok(button(view.render(), 'Continue workflow') || find(view.render(), 'Retry run failed'));
    api.observe(manager, 'turn/start', { threadId: 'chat' }, {}); // No acknowledgment yet.
    assert.equal(api.getSnapshot(null, 'chat').workflows.old.isLatestTurn, true);
    api.observe(manager, 'turn/start', { threadId: 'chat', engineMode: 'codex' }, { turn: { id: 'new' } });
    assert.equal(api.getSnapshot(null, 'chat').workflows.old.isLatestTurn, false);
    assert.equal(button(view.render(), 'Continue workflow'), undefined);
    assert.equal(find(view.render(), 'Retry run failed'), undefined);
    await api.refreshRuns('chat', 'local', 'new');
    assert.deepEqual(Object.values(api.getSnapshot(null, 'chat').workflows).filter(workflow => workflow.isLatestTurn).map(workflow => workflow.turnId), ['new']);
    if (runs.length) assert.match(words(view.render()), /Old evidence/);
  }
});

test('an authoritative latest workflow read invalidates older cached eligibility without an acknowledgment', async () => {
  const { api } = setup();
  api.registerManager({ getHostId: () => 'local', sendRequest: async (_method, params) => ({ workflows: [{ turnId: params.turnId, isLatestTurn: true, status: 'interrupted', runs: [] }] }) });
  await api.refreshRuns('chat', 'local', 'old');
  await api.refreshRuns('chat', 'local', 'new');
  assert.equal(api.getSnapshot(null, 'chat').workflows.old.isLatestTurn, false);
  assert.equal(api.getSnapshot(null, 'chat').workflows.new.isLatestTurn, true);
});

test('an old in-flight workflow read cannot restore recovery after a newer acknowledged turn', async () => {
  const { api } = setup(); let oldReads = 0, resolveOld;
  const oldWorkflow = { turnId: 'old', isLatestTurn: true, status: 'interrupted', runs: [] };
  const manager = { getHostId: () => 'local', sendRequest: async (_method, params) => {
    if (params.turnId === 'old') { oldReads++; return oldReads === 1 ? { workflows: [oldWorkflow] } : new Promise(resolve => { resolveOld = resolve; }); }
    return { workflows: [{ turnId: 'new', isLatestTurn: true, status: 'running', runs: [] }] };
  } };
  api.registerManager(manager); await api.refreshRuns('chat', 'local', 'old');
  const stale = api.refreshRuns('chat', 'local', 'old'); await tick();
  api.observe(manager, 'turn/start', { threadId: 'chat', engineMode: 'both' }, { turn: { id: 'new' } });
  await api.refreshRuns('chat', 'local', 'new');
  resolveOld({ workflows: [oldWorkflow] }); await stale;
  assert.equal(api.getSnapshot(null, 'chat').workflows.old.isLatestTurn, false);
  assert.equal(api.getSnapshot(null, 'chat').workflows.new.isLatestTurn, true);
});

test('newer-started authoritative workflow reads win when their responses arrive out of order', async () => {
  const { api } = setup(), responses = new Map();
  api.registerManager({ getHostId: () => 'local', sendRequest: (_method, params) => new Promise(resolve => { responses.set(params.turnId, resolve); }) });
  const old = api.refreshRuns('chat', 'local', 'old');
  const latest = api.refreshRuns('chat', 'local', 'new'); await tick();
  responses.get('new')({ workflows: [{ turnId: 'new', isLatestTurn: true, status: 'running', runs: [] }] }); await latest;
  responses.get('old')({ workflows: [{ turnId: 'old', isLatestTurn: true, status: 'interrupted', runs: [] }] }); await old;
  assert.equal(api.getSnapshot(null, 'chat').workflows.old.isLatestTurn, false);
  assert.equal(api.getSnapshot(null, 'chat').workflows.new.isLatestTurn, true);
});

test('role controls independently configure both participants and host including same-engine same-model choices', async () => {
  const { api, manager } = await templateSetup();
  manager.sendRequest = async method => method === 'model/list' ? { data: [{ model: 'gpt-a', displayName: 'GPT A' }, { model: 'gpt-b', displayName: 'GPT B' }], nextCursor: null } : { engines: ['codex', 'claude'], bothAvailable: true, claudeModels: [{ value: 'claude-a' }, { value: 'claude-b' }] };
  await api.refreshCapabilities(manager); await api.refreshCodexModels(manager);
  const changes = [], props = { manager, hostId: 'local', selection: { id: 'debby', revision: 2, parameters: {} }, roleOverrides: {}, models: { codex: 'gpt-a', claude: 'claude-a' }, onChange: value => { changes.push(plain(value)); props.roleOverrides = value; } };
  const view = ui(api, 'RoleControls', props);
  assert.ok(find(view.render(), 'Participant A engine')); assert.ok(find(view.render(), 'Participant B engine')); assert.ok(find(view.render(), 'Host engine'));
  find(view.render(), 'Participant B engine').props.onChange({ target: { value: 'codex' } });
  find(view.render(), 'Participant A model').props.onChange({ target: { value: 'gpt-b' } });
  find(view.render(), 'Participant B model').props.onChange({ target: { value: 'gpt-b' } });
  find(view.render(), 'Host engine').props.onChange({ target: { value: 'codex' } });
  find(view.render(), 'Host model').props.onChange({ target: { value: 'gpt-a' } });
  find(view.render(), 'Host prompt').props.onBlur({ target: { value: 'Host a careful debate.' } });
  assert.equal(changes.at(-1).participant_a.model, 'gpt-b');
  assert.deepEqual(changes.at(-1).participant_b, { engine: 'codex', model: 'gpt-b' });
  assert.deepEqual(changes.at(-1).host, { engine: 'codex', model: 'gpt-a', prompt: 'Host a careful debate.' });
  assert.ok(find(view.render(), 'Participant B model').props.children.some(option => option.props.value === 'gpt-b'));
  props.disabled = true;
  for (const label of ['Participant A engine', 'Participant B model', 'Host prompt']) assert.equal(find(view.render(), label).props.disabled, true);
});

test('Polly worker and reviewer engines remain fixed while every role model and prompt is editable', async () => {
  const { api, manager } = await templateSetup(), changes = [];
  const view = ui(api, 'RoleControls', { manager, selection: { id: 'polly', revision: 1, parameters: {} }, roleOverrides: {}, models: {}, onChange: value => changes.push(value) });
  assert.equal(find(view.render(), 'Planner engine').props.disabled, false);
  assert.equal(find(view.render(), 'Summary engine').props.disabled, false);
  for (const role of ['Codex worker', 'Claude worker', 'Codex reviewer', 'Claude reviewer']) {
    assert.equal(find(view.render(), `${role} engine`).props.disabled, true);
    assert.equal(find(view.render(), `${role} model`).props.disabled, false);
    assert.equal(find(view.render(), `${role} prompt`).props.disabled, false);
    find(view.render(), `${role} engine`).props.onChange({ target: { value: 'claude' } });
  }
  assert.equal(changes.length, 0);
});

test('new Debby exposes bounded discussion and a host mode enum while legacy saved revisions remain usable', async () => {
  const { api, manager } = await templateSetup(), changes = [];
  const props = { manager, selection: { id: 'debby', revision: 2, parameters: {} }, onChange: value => changes.push(value) };
  const tree = ui(api, 'TemplateControls', props).render();
  assert.equal(find(tree, 'Discussion rounds').props.value, 2);
  const mode = find(tree, 'Host mode');
  assert.equal(mode.type, 'select'); assert.equal(mode.props.value, 'per-round');
  assert.deepEqual(plain(mode.props.children.map(node => node.props.value)), ['per-round', 'final-only']);
  mode.props.onChange({ target: { value: 'final-only' } });
  assert.equal(changes.at(-1).parameters.host_mode, 'final-only');
  const legacy = ui(api, 'TemplateControls', { ...props, selection: { id: 'debby', revision: 1, parameters: { rounds: 0 } } }).render();
  assert.equal(find(legacy, 'Workflow template').props.value, 'debby@1');
});

test('new template uses schema 2 hosted participants and editor persists per-role models', async () => {
  const { validateTemplate } = await import('../../runtime/agent-modes/templates/schema.mjs');
  const { api, manager, calls } = await templateSetup(), view = ui(api, 'TemplateManager', { manager });
  button(view.render(), 'New dual template').props.onClick();
  find(view.render(), 'Role participant_a model').props.onChange({ target: { value: 'gpt-a' } });
  find(view.render(), 'Role participant_b engine').props.onChange({ target: { value: 'codex' } });
  find(view.render(), 'Role participant_b model').props.onChange({ target: { value: 'gpt-a' } });
  find(view.render(), 'Role host model').props.onChange({ target: { value: 'claude-b' } });
  await button(view.render(), 'Save template').props.onClick();
  const saved = calls.findLast(call => call.method === 'engine/templates/save').params.template;
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.steps[0].type, 'hostedDebate');
  assert.equal(saved.roles.participant_a.model, 'gpt-a');
  assert.equal(saved.roles.participant_b.model, 'gpt-a');
  assert.equal(saved.roles.host.model, 'claude-b');
  assert.doesNotThrow(() => validateTemplate(saved));
});

test('role override wire validation rejects malformed models, engines and prompts', () => {
  const { api } = setup();
  for (const roleOverrides of [null, [], { host: { model: 'bad model' } }, { host: { engine: 'other' } }, { host: { prompt: ' ' } }, { host: { prompt: 'a'.repeat(100001) } }, { host: { unexpected: true } }]) {
    assert.throws(() => api.requestFields({ ...selection(), roleOverrides }), /role|Role/);
  }
});

test('role Codex options follow native hidden-model, provider and saved-selection availability', async () => {
  const { api, manager } = await templateSetup();
  const rawModels = [
    { model: 'public', hidden: false }, { model: 'hidden-allowed', hidden: true },
    { model: 'hidden-denied', hidden: true }, { model: 'hidden-saved', hidden: true },
    { model: 'codex-auto-review', hidden: false },
  ];
  const requests = [];
  manager.sendRequest = async (_method, params) => { requests.push(params); return { data: rawModels.filter(model => params.includeHidden || !model.hidden), nextCursor: null }; };
  await api.refreshCodexModels(manager);
  let policy = { authMethod: 'chatgpt', availableModels: new Set(['public', 'hidden-allowed']), useHiddenModels: true, isCustomModelProvider: false };
  // Pinned native Wqa predicate: the renderer calls this rule with native policy.
  const isAvailable = ({ additionalAvailableModels, authMethod, availableModels, isCustomModelProvider, model, useHiddenModels }) => additionalAvailableModels?.has(model.model) === true || model.model !== 'codex-auto-review' && (useHiddenModels && !isCustomModelProvider && authMethod !== 'amazonBedrock' ? availableModels.has(model.model) : !model.hidden);
  api.configureCodexAvailability({ usePolicy: hostId => { assert.equal(hostId, 'local'); return policy; }, isAvailable });
  const view = ui(api, 'RoleControls', { manager, hostId: 'local', selection: { id: 'debby', revision: 2, parameters: {} }, roleOverrides: { participant_a: { model: 'hidden-saved' }, participant_b: { engine: 'codex' } }, models: { codex: 'public' }, onChange: () => {} });
  const options = label => plain(find(view.render(), label).props.children.map(option => option.props.value).filter(value => value && value !== '__inherit__'));
  assert.deepEqual(options('Participant A model'), ['public', 'hidden-allowed', 'hidden-saved']);
  assert.deepEqual(options('Participant B model'), ['public', 'hidden-allowed']);
  policy = { ...policy, isCustomModelProvider: true };
  assert.deepEqual(options('Participant B model'), ['public']);
  policy = { ...policy, isCustomModelProvider: false, authMethod: 'amazonBedrock' };
  assert.deepEqual(options('Participant B model'), ['public']);
  policy = { ...policy, authMethod: 'chatgpt', useHiddenModels: false };
  assert.deepEqual(options('Participant B model'), ['public']);
  assert.equal(requests[0].includeHidden, true);
});
