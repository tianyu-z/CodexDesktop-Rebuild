import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const nativeUI = { Button: 'NativeButton', Label: 'NativeLabel', Dropdown: 'NativeDropdown', PowerMenu: 'NativePowerMenu', Menu: { Item: 'NativeItem', Separator: 'NativeSeparator' }, Check: 'NativeCheck' };
function load() { const context = {}; vm.runInNewContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8'), context); return context.__cdxEngineModes; }
const React = { useState: initial => [initial, () => {}] };
const model = { value: 'claude-opus-4-6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] };

test('Claude uses native model/effort/advanced controls with only supported levels', () => {
  const api = load(), saved = [];
  const tree = api.ClaudeModelPicker({ React, jsx, nativeUI, value: model.value, models: [model], effort: 'max', onEffort: e => saved.push(e), onChange: () => {}, children: [] });
  assert.equal(tree.type, nativeUI.Dropdown);
  assert.equal(tree.props.triggerButton.type, nativeUI.Button);
  const menu = tree.props.children;
  assert.equal(menu.type, nativeUI.PowerMenu);
  assert.deepEqual(Array.from(menu.props.advancedConfig.effort.options, row => row.id), ['auto', 'low', 'medium', 'high', 'max']);
  assert.equal(menu.props.selectedPowerSelection.reasoningEffort, 'max');
  menu.props.advancedConfig.effort.options[0].onSelect();
  menu.props.onSelectPower(menu.props.powerSelections[3]);
  assert.deepEqual(saved, [null, 'high']);
});

test('unknown model capability and multi-agent do not advertise an effort override', () => {
  const api = load();
  for (const props of [{ models: [{ value: 'custom' }], value: 'custom' }, { models: [model], value: model.value, modelOnly: true }]) {
    const tree = api.ClaudeModelPicker({ React, jsx, nativeUI, ...props, onChange: () => {}, children: [] });
    assert.equal(tree.props.children.props.advancedConfig.effort, null);
    assert.equal(tree.props.children.props.showViewControls, false);
  }
});

test('engine menu shares native primitives and preserves availability guards', () => {
  const api = load(), changes = [];
  const tree = api.ComposerSelect({ React, jsx, nativeUI, value: 'codex', onChange: event => changes.push(event.target.value), children: [jsx.jsx('option', { value: 'codex', children: 'Only Codex' }), jsx.jsx('option', { value: 'both', disabled: true, children: 'Multi-agent' })] });
  assert.equal(tree.type, nativeUI.Dropdown);
  assert.equal(tree.props.children[1].props.disabled, true);
  tree.props.children[0].props.onSelect();
  assert.deepEqual(changes, ['codex']);
});

test('an older gateway cannot advertise an effort change it will not save', () => {
  const api = load(), saved = [];
  const tree = api.ClaudeModelPicker({ React, jsx, nativeUI, value: model.value, models: [model], effort: 'high', effortAvailable: false, onEffort: value => saved.push(value), children: [] });
  const menu = tree.props.children;
  assert.equal(menu.props.advancedConfig.effort.disabled, true);
  assert.equal(menu.props.showViewControls, false);
  menu.props.advancedConfig.effort.options[0].onSelect();
  assert.deepEqual(saved, []);
});
