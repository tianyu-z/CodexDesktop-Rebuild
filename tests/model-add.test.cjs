const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');

const script = fs.readFileSync(require.resolve('../scripts/patch-model-add.js'), 'utf8');
const entry = (model, label, effort) => `{id:\`${model}:${effort}\`,model:\`${model}\`,modelLabel:\`${label}\`,reasoningEffort:\`${effort}\`}`;
const astra = ['low', 'medium', 'high', 'xhigh'].map(e => entry('gpt-6-astra', '6 Astra', e)).join(',');
const oldClone = v => `(!${v}.length||${v}.some(o=>o&&o.model===\`gpt-6-astra\`)?${v}:${v}.concat([{...${v}[0],model:\`gpt-6-astra\`,slug:\`gpt-6-astra\`,id:\`gpt-6-astra\`,displayName:\`6 Astra\`,isDefault:!1,hidden:!1}]))`;
function fixture(legacy = false) {
  return `var primary=[${entry('gpt-5.6-sol', '5.6 Sol', 'xhigh')}${legacy ? ',' + astra : ''}];
var fallback=[${entry('gpt-5.6-terra', '5.6 Terra', 'xhigh')}${legacy ? ',' + astra : ''}];
function pick(n,f){return build({scope:1,models:${legacy ? oldClone('n') : 'n'},useHiddenModels:f.useHiddenModels})}
function pickOther(r,o){return build({scope:2,models:${legacy ? oldClone('r') : 'r'},useHiddenModels:o.useHiddenModels})}`;
}
function patch(source) {
  let result = source;
  vm.runInNewContext(script, {
    require(name) {
      if (name === 'fs') return { readFileSync: () => result, writeFileSync: (_, next) => { result = next; } };
      if (name === './patch-util') return { locateBundles: () => [{ path: 'app-initial-fixture.js' }], relPath: p => p };
      throw Error('Unexpected dependency ' + name);
    },
    process: { argv: [], exit(code) { throw Error('Patch exited ' + code); } },
    console: { log() {}, error() {} },
  });
  acorn.parse(result, { ecmaVersion: 'latest' });
  return result;
}
function evaluate(source) {
  const context = { build: value => value.models };
  vm.runInNewContext(source, context);
  return context;
}
const sol = { model: 'gpt-6-sol', id: 'gpt-6-sol', displayName: '6 Sol', isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], contextWindow: 200000 };

for (const legacy of [false, true]) {
  test(`adds 6.1 Sol to both pickers and effort lists (${legacy ? 'installed patch' : 'fresh bundle'})`, () => {
    const source = patch(fixture(legacy));
    const ctx = evaluate(source);
    assert.equal(patch(source), source, 'reapplying the patch must be a no-op');
    for (const pick of [ctx.pick, ctx.pickOther]) {
      const input = [{ ...sol, model: 'unrelated', contextWindow: 1 }, sol];
      const result = pick(input, {});
      const added = result.find(m => m.model === 'gpt-6.1-sol');
      assert.ok(added, '6.1 Sol must be selectable');
      assert.equal(added.id, 'gpt-6.1-sol');
      assert.equal(added.slug, 'gpt-6.1-sol');
      assert.equal(added.displayName, '6.1 Sol');
      assert.equal(added.contextWindow, sol.contextWindow, 'inherit from Sol when available');
      assert.equal(added.supportedReasoningEfforts, sol.supportedReasoningEfforts);
      assert.equal(added.isDefault, false);
      assert.equal(added.hidden, false);
      assert.equal(input.length, 2, 'do not mutate the native catalog');
      assert.equal(result.filter(m => m.model === 'gpt-6-astra').length, 1);
    }
    for (const list of [ctx.primary, ctx.fallback]) {
      assert.equal(list.filter(m => m.model === 'gpt-6.1-sol').length, 4);
      assert.equal(new Set(list.map(m => m.id)).size, list.length);
    }
  });
}

test('preserves authoritative backend metadata and handles an empty catalog', () => {
  const ctx = evaluate(patch(fixture(true)));
  const native = { ...sol, model: 'gpt-6.1-sol', displayName: 'Backend Sol', contextWindow: 300000 };
  const result = ctx.pick([sol, native], {});
  assert.equal(result.filter(m => m.model === native.model).length, 1);
  assert.equal(result.find(m => m.model === native.model), native);
  const empty = [];
  assert.equal(ctx.pick(empty, {}), empty);
});
