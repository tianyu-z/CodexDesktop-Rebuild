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
  assert.deepEqual(plain(captured), { ...selection(), skipAutoTitleGeneration: true });
  captured.template.parameters.rounds = 5;
  assert.equal(api.capture(scope, 'local').template.parameters.rounds, 1);
  api.setDraftSelection(scope, { engineMode: 'codex' });
  api.setDraftSelection(scope, { engineMode: 'both' });
  assert.deepEqual(plain(api.capture(scope, 'local').engineModels), selection().engineModels);
  assert.deepEqual(plain(api.capture(scope, 'remote')), {});
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
