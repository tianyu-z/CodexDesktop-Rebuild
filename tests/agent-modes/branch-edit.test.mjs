import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

function helper() {
  const context = { console, localStorage: { getItem() { return null; }, setItem() {} } };
  runInNewContext(readFileSync(new URL('../../scripts/assets/cdx-branch.js', import.meta.url), 'utf8').replace(/export default[^;]+;/, ''), context);
  return context.__cdxBranch;
}
const scope = { hostId: 'rno', threadId: 'source', turnId: 'older-turn' };

test('retrying failed in-place edit never creates a snapshot', async () => {
  const api = helper(); let forks = 0, edits = 0;
  // Exercise the installed v1 contract too, so this proves the original bug.
  if (api.beginEdit) api.beginEdit({ ...scope, mode: 'inplace' });
  else api.mode = 'inplace';
  const options = { ...scope, fork: async () => { forks++; return 'snapshot'; }, edit: async () => { if (++edits === 1) throw Error('Turn not found for edit.'); } };
  const submit = () => api.runEdit ? api.runEdit(options) : api.beforeEdit(options).then(options.edit);
  await assert.rejects(submit(), /Turn not found/);
  await submit();
  assert.equal(edits, 2);
  assert.equal(forks, 0);
});

test('branch retry reuses its snapshot after edit fails', async () => {
  const api = helper(); let forks = 0, edits = 0;
  api.beginEdit({ ...scope, mode: 'branch' });
  const options = { ...scope, fork: async () => 'snapshot-' + ++forks, edit: async () => { if (++edits < 3) throw Error('owner unavailable'); } };
  await assert.rejects(api.runEdit(options), /owner unavailable/);
  await assert.rejects(api.runEdit(options), /owner unavailable/);
  await api.runEdit(options);
  assert.equal(forks, 1);
});

test('mode is scoped to host, chat and turn, and cancel removes it', async () => {
  const api = helper(), forks = [];
  api.beginEdit({ ...scope, mode: 'inplace' });
  const submit = s => api.runEdit({ ...s, fork: async () => { forks.push(s); return 'snapshot'; }, edit: async () => {} });
  for (const s of [{ ...scope, hostId: 'bar' }, { ...scope, threadId: 'another' }, { ...scope, turnId: 'other-turn' }]) {
    api.beginEdit({ ...s, mode: 'branch' }); await submit(s);
  }
  await submit(scope); assert.equal(forks.length, 3);
  api.beginEdit({ ...scope, mode: 'inplace' }); api.cancelEdit(scope);
  api.beginEdit({ ...scope, mode: 'branch' }); await submit(scope);
  assert.equal(forks.length, 4);
});

test('duplicate submits share a single edit and a single snapshot', async () => {
  const api = helper(); let release, forks = 0, edits = 0;
  api.beginEdit({ ...scope, mode: 'branch' });
  const options = { ...scope, fork: async () => { forks++; return 'snapshot'; }, edit: async () => { edits++; await new Promise(resolve => { release = resolve; }); } };
  const first = api.runEdit(options), second = api.runEdit(options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(edits, 1); assert.equal(forks, 1);
  release(); await Promise.all([first, second]);
});

test('snapshot failure prevents edit and remains safe to retry', async () => {
  const api = helper(); let edits = 0, attempts = 0;
  api.beginEdit({ ...scope, mode: 'branch' });
  const options = { ...scope, fork: async () => { if (++attempts === 1) throw Error('snapshot unavailable'); return 'saved'; }, edit: async () => { edits++; } };
  await assert.rejects(api.runEdit(options), /snapshot unavailable/);
  assert.equal(edits, 0); await api.runEdit(options); assert.equal(edits, 1);
});
