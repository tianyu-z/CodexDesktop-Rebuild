import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url), acorn = require('acorn');
const patcher = () => require('../../scripts/patch-edit-sessions.js');
const fixture = name => readFileSync(new URL(`./fixtures/edit-sessions/${name}.txt`, import.meta.url), 'utf8');

test('installed edit callback keeps the selected mode across failure and exposes the cause', async () => {
  const { patchThreadEdit } = patcher(), original = fixture('installed-edit-callback');
  const patched = patchThreadEdit(original); assert.equal(patchThreadEdit(patched), patched);
  const toasts = [], context = { console: { warn() {} }, localStorage: { getItem() {}, setItem() {} } };
  runInNewContext(readFileSync(new URL('../../scripts/assets/cdx-branch.js', import.meta.url), 'utf8').replace(/export default[^;]+;/, ''), context);
  let edits = 0, forks = 0;
  Object.assign(context, { e: 'chat', y: { get: () => ({ danger: value => toasts.push(value) }) }, Te: { getHostId: () => 'rno' }, M: '/code', te: {}, Fe: {}, Ie: true, Zc: {}, Pe: { formatMessage: ({ defaultMessage }) => defaultMessage }, Le: async () => null, Ss: () => 'title', Ca: async () => { forks++; return 'snapshot'; }, cf: () => ({ setThreadTitle: async () => {}, editLastUserTurn: async () => { if (++edits === 1) throw Error('Only the most recent message can be edited.'); } }) });
  const edit = runInNewContext('(' + patched + ')', context);
  context.__cdxBranch.beginEdit({ hostId: 'rno', threadId: 'chat', turnId: 'old', mode: 'inplace' });
  await assert.rejects(edit({ turnId: 'old', params: {} }, 'changed'), /most recent/);
  await edit({ turnId: 'old', params: {} }, 'changed');
  assert.equal(edits, 2); assert.equal(forks, 0); assert.match(toasts[0], /Only the most recent/);
});

test('both edit buttons, double click and cancel bind the resolved editor scope', () => {
  const { patchMessageEditor } = patcher(), original = fixture('installed-user-message');
  const patched = patchMessageEditor(original);
  assert.equal(patchMessageEditor(patched), patched);
  acorn.parse(patched, { ecmaVersion: 'latest' });
  assert.doesNotMatch(patched, /__cdxBranch\.mode/);
  const events = [], context = { w: 'rno', L: 'chat', S: 'old', fe: () => events.push('open'), ce: value => events.push(value), __cdxBranch: { beginEdit: value => events.push(JSON.parse(JSON.stringify(value))), cancelEdit: value => events.push(JSON.parse(JSON.stringify(value))) } };
  for (const mode of ['branch', 'inplace']) {
    const index = patched.indexOf('onClick:()=>{globalThis.__cdxBranch.beginEdit({hostId:w,threadId:L,turnId:S,mode:`' + mode + '`');
    assert.ok(index >= 0);
    const parsed = acorn.parseExpressionAt(patched, index + 'onClick:'.length, { ecmaVersion: 'latest' });
    const node = parsed.type === 'SequenceExpression' ? parsed.expressions[0] : parsed;
    runInNewContext('(' + patched.slice(node.start, node.end) + ')()', context);
    assert.deepEqual(events.splice(0), [{ hostId: 'rno', threadId: 'chat', turnId: 'old', mode }, 'open']);
  }
  assert.match(patched, /onDoubleClick:U\?\(\)=>\{globalThis\.__cdxBranch.beginEdit/);
  const index = patched.indexOf('onCancel:');
  const parsed = acorn.parseExpressionAt(patched, index + 'onCancel:'.length, { ecmaVersion: 'latest' });
  const node = parsed.type === 'SequenceExpression' ? parsed.expressions[0] : parsed;
  runInNewContext('(' + patched.slice(node.start, node.end) + ')()', context);
  assert.deepEqual(events, [{ hostId: 'rno', threadId: 'chat', turnId: 'old' }, null]);
});
