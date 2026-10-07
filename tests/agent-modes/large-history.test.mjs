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

function liveHistory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'live-history-'));
  const store = new ConversationStore(directory);
  const thread = { id: 'history', cwd: directory, status: { type: 'active' }, turns: [
    { id: 'completed', status: 'completed', items: [{ id: 'done', type: 'agentMessage', text: 'stable' }] },
    { id: 'active', status: 'inProgress', items: [{ id: 'command', type: 'commandExecution', aggregatedOutput: 'before' }] },
  ] };
  store.ensureThread({ ...thread, turns: [] });
  let reads = 0;
  const native = { async request(method) {
    if (method !== 'thread/read') throw new Error(`Unexpected native request: ${method}`);
    reads++;
    return { thread: structuredClone(thread) };
  } };
  const router = new EngineRouter({ store, native, adapter: {}, emit() {} });
  t.after(async () => { await router.close(); rmSync(directory, { recursive: true, force: true }); });
  return { thread, router, native, reads: () => reads };
}

test('unpersisted output delta refreshes selected active content only', async t => {
  const f = liveHistory(t);
  const active = { threadId: 'history', turnId: 'active' };
  assert.equal((await f.router.request('thread/items/list', active)).data[0].item.aggregatedOutput, 'before');
  assert.equal(f.reads(), 1);
  f.thread.turns[1].items[0].aggregatedOutput = 'before after';
  f.router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: { ...active, itemId: 'command', delta: ' after' } });
  const completedPage = await f.router.request('thread/turns/list', { threadId: 'history', sortDirection: 'asc', limit: 1, itemsView: 'full' });
  assert.equal(completedPage.data[0].items[0].text, 'stable');
  const metadataPage = await f.router.request('thread/turns/list', { threadId: 'history', sortDirection: 'desc', limit: 1, itemsView: 'notLoaded' });
  assert.deepEqual(metadataPage.data[0].items, []);
  assert.equal(f.reads(), 1);
  const changed = await f.router.request('thread/items/list', active);
  assert.equal(changed.data[0].item.aggregatedOutput, 'before after');
  assert.equal(f.reads(), 2);
  const cached = await f.router.request('thread/turns/list', { threadId: 'history', sortDirection: 'desc', limit: 1, itemsView: 'full' });
  assert.equal(cached.data[0].items[0].aggregatedOutput, 'before after');
  assert.equal(f.reads(), 2);
  f.thread.turns[1].items[0].aggregatedOutput = 'before after latest';
  f.router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: { ...active, itemId: 'command', delta: ' latest' } });
  f.thread.turns[1].status = 'completed';
  f.router.nativeNotification({ method: 'turn/completed', params: { threadId: 'history', turn: structuredClone(f.thread.turns[1]) } });
  const finished = await f.router.request('thread/turns/list', { threadId: 'history', sortDirection: 'desc', limit: 1, itemsView: 'full' });
  assert.equal(finished.data[0].items[0].aggregatedOutput, 'before after latest');
  assert.equal(f.reads(), 2);
});

test('delta received during hydration remains dirty until a newer native snapshot is read', async t => {
  const f = liveHistory(t);
  const active = { threadId: 'history', turnId: 'active' };
  await f.router.request('thread/items/list', active);
  f.thread.turns[1].items[0].aggregatedOutput = 'before after';
  f.router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: { ...active, itemId: 'command', delta: ' after' } });
  let release;
  const original = f.native.request.bind(f.native);
  f.native.request = async method => {
    if (!release) {
      const snapshot = structuredClone(f.thread);
      return new Promise(resolve => { release = () => resolve({ thread: snapshot }); });
    }
    return original(method);
  };
  const pending = f.router.request('thread/items/list', active);
  for (let attempt = 0; attempt < 10 && !release; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release, 'dirty item read should refresh native history');
  f.thread.turns[1].items[0].aggregatedOutput = 'before after later';
  f.router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: { ...active, itemId: 'command', delta: ' later' } });
  release();
  const result = await pending;
  assert.equal(result.data[0].item.aggregatedOutput, 'before after later');
});

test('continuous output bounds refreshes per page and leaves later content dirty', async t => {
  const f = liveHistory(t);
  const active = { threadId: 'history', turnId: 'active' };
  await f.router.request('thread/items/list', active);
  f.thread.turns[1].items[0].aggregatedOutput = 'before 1';
  f.router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: { ...active, itemId: 'command', delta: ' 1' } });
  let refreshes = 0;
  const original = f.native.request.bind(f.native);
  f.native.request = async method => {
    refreshes++;
    const snapshot = structuredClone(f.thread);
    f.thread.turns[1].items[0].aggregatedOutput += ` ${refreshes + 1}`;
    f.router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: { ...active, itemId: 'command', delta: ` ${refreshes + 1}` } });
    return { thread: snapshot };
  };
  const bounded = await f.router.request('thread/items/list', active);
  assert.equal(refreshes, 2);
  assert.equal(bounded.data[0].item.aggregatedOutput, 'before 1 2');
  f.native.request = original;
  const latest = await f.router.request('thread/items/list', active);
  assert.equal(latest.data[0].item.aggregatedOutput, 'before 1 2 3');
});
