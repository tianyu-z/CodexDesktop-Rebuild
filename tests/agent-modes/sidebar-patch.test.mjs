import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { patchSidebarCode } = require('../../scripts/patch-sidebar-navigation.js');
const bridge = readFileSync(new URL('../../scripts/assets/sidebar-navigation-bridge.js', import.meta.url), 'utf8');
const fixture = 'function GSl(e){return e}function BKl(e){return jsx("nav",{className:RKl.Navigation,children:jsx("native-chats",{})})}function Qpl(e){return false}const gate=()=>{if(!e(vb,`3085093835`))return`legacy`;};var $pl=45;';
const element = (type, props) => ({ type, props });
test('appearance patch is syntactically valid, idempotent and rejects structural drift', () => {
  const output = patchSidebarCode(fixture);
  assert.equal(patchSidebarCode(output), output);
  assert.match(output, /__cdxContextualNavigation,\{nativeContent:jsx\("native-chats",\{\}\)\}/);
  for (const anchor of ['function GSl(', 'function BKl(', 'RKl.Navigation', 'function Qpl(e){', '$pl=45', 'if(!e(vb,`3085093835`))return`legacy`;']) {
    assert.throws(() => patchSidebarCode(fixture.replace(anchor, anchor.replace(/.$/, 'X'))));
  }
  assert.throws(() => patchSidebarCode(fixture + 'function GSl(){}'), /unsupported/);
  assert.throws(() => patchSidebarCode('/* cdx-appearance-2026-09-v1 */' + fixture), /incomplete/);
});
const pinned = new URL('../../src/mac-arm64/_asar/webview/assets/app-initial-CX2pZp2Q.js', import.meta.url);
test('all existing engine seams remain byte-identical in the real pinned bundle', { skip: !existsSync(pinned) }, () => {
  const source = require('../../scripts/patch-agent-modes.js').patchAppBundle(readFileSync(pinned, 'utf8'));
  const output = patchSidebarCode(source);
  const acorn = require('acorn');
  // Capture each whole enclosing function containing an engine seam. This catches
  // accidental memo, closure, or prop changes around a still-present method name.
  const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let protectedCount = 0, coveredSeams = 0;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ExpressionStatement'].includes(node.type)) {
      const body = source.slice(node.start, node.end);
      if (body.includes('__cdxEngineModes.')) {
        assert.ok(output.includes(body), 'Engine function modified at ' + node.start);
        protectedCount++;
        coveredSeams += body.split('__cdxEngineModes.').length - 1;
        return;
      }
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (typeof value === 'object') walk(value);
  }
  walk(tree);
  assert.ok(protectedCount > 0, 'Expected the existing Claude and multi-agent seams');
  assert.equal(coveredSeams, source.split('__cdxEngineModes.').length - 1, 'Every engine seam must be protected by an unchanged function');
});
function scheduledContext({ cloudAccount = 'current', currentAccount = 'current' } = {}) {
  const calls = [], local = { data: { items: [{ id: 'same', name: 'Local task', status: 'ACTIVE' }] } };
  const cloud = { data: { accountId: cloudAccount, items: [{ automation: { id: 'same', title: 'Cloud task' } }] } };
  const queries = { local, cloud, account: currentAccount };
  const context = {
    kCn() {}, kfl() {}, Hfl() {}, ols() {}, Qz() {}, DCn: 'local', bfl: 'cloud', yfl: 'account', Y: key => queries[key],
    Ifl: () => ({ items: [], markRead: id => calls.push(['read', id]) }),
    Lf: () => url => calls.push(url), Ff: () => ({ search: '?automationId=same&automationSource=cloud' }), pd: () => ({}), Zz: () => id => calls.push(['thread', id]),
    lcs: () => 'Every day', Jdl: item => item.automation.title, Xdl: () => 'active', Zdl: () => 'Every week',
    URLSearchParams, GKl: {}, g7: { jsx: element }, __cdxSidebarNavigation: { Scheduled: 'Scheduled' },
  };
  vm.runInNewContext(bridge, context);
  return { calls, props: context.__cdxScheduledNavigation().props };
}
test('scheduled bridge isolates cloud accounts and namespaces local/cloud task identities', () => {
  const { calls, props } = scheduledContext({});
  assert.deepEqual(Array.from(props.rows, row => row.key), ['local:same', 'cloud:same']);
  assert.equal(props.selectedKey, 'cloud:same');
  props.rows[0].onSelect(); props.rows[1].onSelect(); props.onCreate();
  assert.deepEqual(calls, ['/automations?automationId=same', '/automations?automationId=same&automationSource=cloud', '/automations?automationMode=create']);
  assert.equal(scheduledContext({ cloudAccount: 'previous' }).props.rows.length, 1);
  assert.equal(scheduledContext({ currentAccount: null }).props.rows.length, 1);
});
test('plugin navigation retains the shared selected host, tab and native source-bearing URL', () => {
  const calls = [], queryCalls = [], entry = { displayName: 'Sample', plugin: { id: 'one', name: 'sample', enabled: true } };
  const context = {
    A_l() {}, f5i() {}, u5i: () => true, xC: () => ({ value: {} }), O_l: () => ({ hiddenPluginIds: [] }), xEc: entries => entries,
    Ff: () => ({ pathname: '/plugins', search: '', key: 'history', state: {} }), Lf: () => (url, options) => calls.push({ url, options }),
    lni: () => ({}), ss: key => ({ saved: { selectedHostId: 'rno' }, host: 'rno', tab: 'plugins' })[key],
    jU: value => value, Y: () => [{ hostId: 'rno', displayName: 'RNO' }], GS: {}, dCs: host => host,
    ej: () => true, fj: options => { queryCalls.push(options); return { data: [entry], refetch() {} }; }, gEc: ({ plugins }) => plugins,
    f9i: (plugin, { hostId }) => { assert.equal(plugin, entry); return '/skills/plugins/one?hostId=' + hostId + '&marketplacePath=native'; },
    URLSearchParams, GKl: {}, g7: { jsx: element }, __cdxSidebarNavigation: { Customize: 'Customize' },
  };
  vm.runInNewContext(bridge, context);
  const { props } = context.__cdxLoadedCustomizeNavigation({ page: { d: 'saved', u: 'host', c: 'tab' } });
  assert.equal(queryCalls[0].hostId, 'rno'); assert.equal(props.hostLabel, 'RNO');
  props.plugins[0].onSelect(); props.onSkills();
  assert.equal(calls[0].url, '/skills/plugins/one?hostId=rno&marketplacePath=native');
  assert.equal(calls[1].options.state.initialHostId, 'rno'); assert.equal(calls[1].options.state.initialTab, 'skills');
});
