import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const helper = new URL('../../scripts/assets/sidebar-navigation-ui.js', import.meta.url);
const load = () => {
  const context = { console };
  if (existsSync(helper)) vm.runInNewContext(readFileSync(helper, 'utf8'), context);
  assert.ok(context.__cdxSidebarNavigation, 'The independent sidebar helper must be available');
  return context.__cdxSidebarNavigation;
};
const plain = value => JSON.parse(JSON.stringify(value));
const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
const React = { useState: initial => [initial, () => {}], useEffect() {}, useMemo: fn => fn() };
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];

test('route selection distinguishes contextual destinations and returns chat routes to Home', () => {
  const api = load();
  for (const route of ['/', '/thread/test', '/local/thread', '/projects', '/archived', '/work/conversation/a', '/hotkey-window', '/hotkey-window/thread/a', '/hotkey-window/remote/a']) assert.equal(api.areaForPath(route), 'home');
  for (const route of ['/automations', '/automations/task', '/scheduled', '/scheduled/task']) assert.equal(api.areaForPath(route), 'scheduled');
  for (const route of ['/plugins', '/plugins/plugin-one', '/skills', '/skills/one', '/customize']) assert.equal(api.areaForPath(route), 'customize');
  for (const route of ['/pull-requests', '/library', '/sites']) assert.equal(api.areaForPath(route), 'more');
  assert.equal(api.areaForPath('/plugins-unrelated'), 'more');
});

test('closing Scheduled search clears the filter and restores all task rows', () => {
  const api = load(), states = ['needle', 'all', true]; let cursor = 0;
  const hooks = { useState: () => { const index = cursor++; return [states[index], value => { states[index] = value; }]; }, useRef: () => ({ current: null }), useId: () => 'search-test' };
  const props = { React: hooks, jsx, rows: [{ key: 'a', title: 'Other task', status: 'active' }], loading: false, onCreate() {} };
  const before = api.Scheduled(props);
  const input = nodes(before).find(node => node.type === 'input');
  input.props.onKeyDown({ key: 'Escape', preventDefault() {} });
  cursor = 0;
  const after = api.Scheduled(props);
  assert.equal(nodes(after).some(node => node.type === 'input'), false);
  assert.ok(nodes(after).some(node => node.props?.children === 'Other task'));
});

test('a retained plugin search stays editable when the plugin count decreases', () => {
  const api = load();
  const tree = api.Customize({ React: { useState: () => ['needle', () => {}] }, jsx, plugins: [{ id: 'a', title: 'Other plugin', enabled: true }], pluginsAllowed: true });
  assert.ok(nodes(tree).some(node => node.type === 'input' && node.props.value === 'needle'));
});

test('fixed destinations remain available and More preserves all remaining native actions', () => {
  const api = load(), rows = ['projects', 'pull-requests', 'automations', 'skills', 'archive'].map(name => ({ id: 'builtin:' + name, label: name, onSelect() {} }));
  const result = api.partitionDestinations(rows);
  assert.deepEqual(plain(result.primary.map(row => row.id)), ['builtin:automations', 'builtin:skills']);
  assert.deepEqual(plain(result.more.map(row => row.id)), ['builtin:projects', 'builtin:pull-requests', 'builtin:archive']);
  assert.equal(result.more[1], rows[1]);
  const restricted = api.partitionDestinations([rows[0]]);
  assert.equal(restricted.primary.length, 0, 'Unavailable capabilities must not be invented');
});

test('rail selection invokes native navigation and retains native context menus', () => {
  const api = load(), calls = [], renders = [];
  const rows = [{ id: 'builtin:automations', label: 'Scheduled', onSelect: () => calls.push('scheduled'), onPrefetch: () => {}, contextMenuItems: [{ id: 'mark-all-read' }] }, { id: 'builtin:skills', label: 'Plugins', onSelect: () => calls.push('plugins') }, { id: 'builtin:pull-requests', label: 'Pull requests', onSelect: () => calls.push('pull-requests') }];
  const tree = api.Rail({ React, jsx, pathname: '/automations', availableDestinations: rows,
    home: { id: 'builtin:home', onSelect: () => calls.push('home') }, onNavigate: () => calls.push('before'),
    renderItem: item => { renders.push(item); return jsx.jsx('native-item', { item }); },
    renderMore: items => jsx.jsx('native-more', { items }), onSettings: () => calls.push('settings') });
  assert.deepEqual(renders.map(row => row.label), ['Home', 'Scheduled', 'Customize', 'Settings']);
  assert.deepEqual(renders.map(row => row.isCurrentDestination), [false, true, false, false]);
  renders[1].onSelect();
  assert.deepEqual(calls, ['before', 'scheduled']);
  assert.equal(renders[1].contextMenuItems, rows[0].contextMenuItems);
  const more = nodes(tree).find(node => node.type === 'native-more');
  assert.equal(more.props.items[0].id, 'builtin:pull-requests');
  more.props.items[0].onSelect();
  assert.deepEqual(calls, ['before', 'scheduled', 'before', 'pull-requests']);
});

test('Home preserves native sidebar content and only destination routes receive contextual panels', () => {
  const api = load(), nativeContent = { type: 'existing-projects-and-chats' }, scheduled = { type: 'scheduled-data' }, customize = { type: 'plugin-data' };
  const props = { React, jsx, nativeContent, renderScheduled: () => scheduled, renderCustomize: () => customize };
  assert.equal(api.Panel({ ...props, pathname: '/thread/a' }), nativeContent);
  assert.equal(api.Panel({ ...props, pathname: '/automations' }), scheduled);
  assert.equal(api.Panel({ ...props, pathname: '/plugins/id' }), customize);
  assert.equal(api.Panel({ ...props, pathname: '/pull-requests' }), nativeContent);
  assert.equal(api.hasPanel({ routeTemplate: '/automations/:id' }), true);
  assert.equal(api.hasPanel({ routeTemplate: '/plugins' }), true);
  assert.equal(api.hasPanel({ routeTemplate: '/security' }), false);
});
