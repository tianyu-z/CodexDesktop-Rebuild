import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { page, presentTurn } from '../../runtime/agent-modes/codex-events.mjs';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';

const params = (sortDirection, cursor) => ({ threadId: 'history', sortDirection, limit: 20, byteTargetBytes: 180, ...(cursor ? { cursor } : {}) });

test('byte pages visit every entry once in either direction and preserve an indivisible oversized entry', () => {
  const entries = ['a', 'b', 'c', 'huge', 'e', 'f'].map(key => ({ key, value: { id: key, text: key === 'huge' ? 'H'.repeat(300) : 'x'.repeat(50) } }));
  for (const direction of ['asc', 'desc']) {
    const seen = [];
    let cursor;
    do {
      const result = page(entries, params(direction, cursor), 'turns');
      assert.ok(result.data.length > 0);
      const bytes = Buffer.byteLength(JSON.stringify(result.data));
      assert.ok(bytes <= 180 || (result.data.length === 1 && result.data[0].id === 'huge'));
      seen.push(...result.data.map(row => row.id));
      cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, direction === 'asc' ? entries.map(row => row.key) : entries.map(row => row.key).reverse());
  }
});

test('page presents selected entries only', () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({ key: String(index), value: { id: String(index), text: 'x'.repeat(70) } }));
  const presented = [];
  const result = page(entries, params('asc'), 'turns', row => {
    presented.push(row.key);
    return structuredClone(row.value);
  });
  assert.ok(result.nextCursor);
  assert.deepEqual(presented, result.data.map(row => row.id));
  assert.ok(presented.length < entries.length);
});

test('default byte target returns a larger entry alone and advances its cursor', () => {
  const entries = [{ key: 'huge', value: { id: 'huge', text: 'h'.repeat(9 * 1024 * 1024) } }, { key: 'tail', value: { id: 'tail' } }];
  const first = page(entries, { threadId: 'history', sortDirection: 'asc' }, 'turns');
  assert.deepEqual(first.data.map(row => row.id), ['huge']);
  assert.ok(first.nextCursor);
  const second = page(entries, { threadId: 'history', sortDirection: 'asc', cursor: first.nextCursor }, 'turns');
  assert.deepEqual(second.data.map(row => row.id), ['tail']);
});

test('anchor cursors remain stable when later entries are appended', () => {
  const entries = ['a', 'b', 'c'].map(key => ({ key, value: { id: key } }));
  const first = page(entries, { threadId: 'history', sortDirection: 'asc', limit: 1 }, 'turns');
  entries.push({ key: 'd', value: { id: 'd' } });
  const second = page(entries, { threadId: 'history', sortDirection: 'asc', limit: 1, cursor: first.nextCursor }, 'turns');
  assert.deepEqual(second.data.map(row => row.id), ['b']);
  const reverse = page(entries, { threadId: 'history', sortDirection: 'desc', limit: 1, cursor: second.backwardsCursor }, 'turns');
  assert.deepEqual(reverse.data.map(row => row.id), ['b']);
});

test('notLoaded turns retain metadata while omitting the full item body', () => {
  const turn = { id: 't', status: 'completed', metadata: { source: 'native' }, items: [{ id: 'i', type: 'agentMessage', text: 'private body' }] };
  const unloaded = presentTurn(turn, 'codex', 'notLoaded');
  assert.deepEqual(unloaded.items, []);
  assert.equal(unloaded.itemsView, 'notLoaded');
  assert.deepEqual(unloaded.metadata, turn.metadata);
  assert.equal(JSON.stringify(unloaded).includes('private body'), false);
  assert.equal(presentTurn(turn, 'codex').items[0].text, 'private body');
  assert.equal(turn.items[0].text, 'private body');
  turn.items[0].noncloneable = () => {};
  assert.deepEqual(presentTurn(turn, 'codex', 'notLoaded').items, []);
});

test('paged router reads hydrate once, while explicit read and resume refresh native history', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'large-history-'));
  const store = new ConversationStore(directory);
  const thread = { id: 'history', cwd: directory, status: { type: 'idle' }, turns: [{ id: 'first', status: 'completed', items: [{ id: 'body', type: 'agentMessage', text: 'complete content' }] }] };
  store.ensureThread({ ...thread, turns: [] });
  const calls = [];
  const native = { async request(method, requestParams) {
    calls.push({ method, params: requestParams });
    if (['thread/read', 'thread/resume'].includes(method)) return { thread: structuredClone(thread) };
    throw new Error(`Unexpected native request: ${method}`);
  } };
  const router = new EngineRouter({ store, native, adapter: {}, emit() {} });
  t.after(async () => { await router.close(); rmSync(directory, { recursive: true, force: true }); });
  const readCount = () => calls.filter(call => call.method === 'thread/read').length;
  const first = await router.request('thread/turns/list', { threadId: 'history', itemsView: 'notLoaded' });
  assert.deepEqual(first.data[0].items, []);
  assert.equal(first.data[0].itemsView, 'notLoaded');
  const second = await router.request('thread/turns/list', { threadId: 'history', itemsView: 'full' });
  assert.equal(second.data[0].items[0].text, 'complete content');
  const item = await router.request('thread/items/list', { threadId: 'history', turnId: 'first' });
  assert.equal(item.data[0].item.text, 'complete content');
  router.nativeNotification({ method: 'item/completed', params: { threadId: 'history', turnId: 'first', item: { id: 'later', type: 'agentMessage', text: 'live content' } } });
  const live = await router.request('thread/items/list', { threadId: 'history', turnId: 'first' });
  assert.equal(live.data[1].item.text, 'live content');
  assert.equal(readCount(), 1);
  await router.request('thread/read', { threadId: 'history', includeTurns: true });
  assert.equal(readCount(), 3);
  await router.request('thread/resume', { threadId: 'history', includeTurns: true });
  assert.equal(readCount(), 4);
  router.nativeNotification({ method: 'thread/deleted', params: { threadId: 'history' } });
  store.ensureThread({ ...thread, turns: [] });
  const recreated = await router.request('thread/turns/list', { threadId: 'history' });
  assert.equal(recreated.data[0].id, 'first');
  assert.equal(readCount(), 5);
});
