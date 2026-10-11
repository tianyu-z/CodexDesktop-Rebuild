import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const helper = () => require('../../scripts/assets/cdx-thread-ipc.cjs');
const broadcastVersion = method => method === 'thread-stream-state-changed' ? 4 : 0;
const requestVersion = (method, params) => method === 'thread-follower-interrupt-turn' ? (params && !params.expectedTurnId ? 3 : 4) : method.startsWith('thread-follower-') ? 2 : 0;
function bus() {
  const clients = [];
  return id => {
    const handlers = new Map(), broadcasts = new Set(), client = { id, handlers,
      waitUntilInitialized: async () => {},
      addRequestHandler(method, predicate, handler) { handlers.set(method, [predicate, handler]); return () => handlers.delete(method); },
      addAnyBroadcastHandler(handler) { broadcasts.add(handler); return () => broadcasts.delete(handler); },
      async sendRequest(method, params, options = {}) {
        for (const candidate of clients) {
          if (candidate === client || options.targetClientId && candidate.id !== options.targetClientId) continue;
          const entry = candidate.handlers.get(method);
          if (!entry || !await entry[0](params)) continue;
          return { resultType: 'success', method, handledByClientId: candidate.id, result: await entry[1]({ method, params, sourceClientId: id }) };
        }
        return { resultType: 'error', error: 'no-client-found' };
      },
      async sendBroadcast(method, params, options = {}) {
        for (const candidate of clients) if (candidate !== client && (!options.targetClientIds || options.targetClientIds.includes(candidate.id))) {
          for (const handler of candidate.broadcasts) await handler({ method, params, version: broadcastVersion(method), sourceClientId: id });
        }
      }, broadcasts,
    }; clients.push(client); return client;
  };
}

test('dev does not discover an official owner but coordinates between dev windows', async () => {
  const { createThreadIpcScope } = helper(), wrap = createThreadIpcScope({ broadcastVersion, requestVersion });
  const client = bus(), official = client('official'), dev1 = wrap(client('dev1')), raw2 = client('dev2'), dev2 = wrap(raw2);
  assert.equal(wrap(raw2), dev2); assert.equal(wrap(dev2), dev2);
  official.addRequestHandler('thread-owner-discovery', () => true, () => ({}));
  assert.equal((await dev1.sendRequest('thread-owner-discovery', { hostId: 'rno', conversationId: 'chat' })).error, 'no-client-found');
  dev2.addRequestHandler('thread-owner-discovery', p => p.hostId === 'rno', () => ({}));
  const owner = await dev1.sendRequest('thread-owner-discovery', { hostId: 'rno', conversationId: 'chat' });
  assert.equal(owner.handledByClientId, 'dev2'); assert.equal(owner.method, 'thread-owner-discovery');
  dev2.addRequestHandler('thread-follower-edit-last-user-turn', () => true, request => { assert.equal(request.method, 'thread-follower-edit-last-user-turn'); return { edited: request.params.turnId }; });
  const edit = await dev1.sendRequest('thread-follower-edit-last-user-turn', { conversationId: 'chat', turnId: 'old' }, { targetClientId: 'dev2' });
  assert.equal(edit.method, 'thread-follower-edit-last-user-turn'); assert.equal(edit.result.edited, 'old');
});

test('official snapshots cannot overwrite dev history; dev snapshots retain schema and routing', async () => {
  const { createThreadIpcScope } = helper(), wrap = createThreadIpcScope({ broadcastVersion, requestVersion });
  const client = bus(), official = client('official'), dev1 = wrap(client('dev1')), raw2 = client('dev2'), dev2 = wrap(raw2), received = [];
  dev2.addAnyBroadcastHandler(event => received.push(event));
  await official.sendBroadcast('thread-stream-state-changed', { cursor: 'native' });
  await official.sendBroadcast('thread-queued-followups-changed', { queued: 'official' });
  assert.equal(received.length, 0);
  await dev1.sendBroadcast('thread-stream-state-changed', { cursor: 'gateway', hostId: 'rno' }, { targetClientIds: ['dev2'] });
  assert.deepEqual(received[0], { method: 'thread-stream-state-changed', version: 4, params: { cursor: 'gateway', hostId: 'rno' }, sourceClientId: 'dev1' });
  await official.sendBroadcast('thread-archived', { conversationId: 'chat' });
  await official.sendBroadcast('ipc-connection-reset', {});
  assert.deepEqual(received.slice(1).map(e => e.method), ['thread-archived', 'ipc-connection-reset']);
  const scoped = [...raw2.broadcasts][0];
  await scoped({ method: 'cdx-dev-thread-v1/99/thread-stream-state-changed', version: 0, params: {} });
  await scoped({ method: 'cdx-dev-thread-v1/4/thread-stream-state-changed', version: 1, params: {} });
  assert.equal(received.length, 3);
});

test('both native interrupt schema variants work and disposal removes all registrations', async () => {
  const { createThreadIpcScope } = helper(), wrap = createThreadIpcScope({ broadcastVersion, requestVersion });
  const client = bus(), dev1 = wrap(client('dev1')), raw2 = client('dev2'), dev2 = wrap(raw2), method = 'thread-follower-interrupt-turn';
  const remove = dev2.addRequestHandler(method, () => true, e => e.params);
  for (const params of [{ conversationId: 'chat' }, { conversationId: 'chat', expectedTurnId: 'turn' }]) assert.deepEqual((await dev1.sendRequest(method, params)).result, params);
  remove(); assert.equal(raw2.handlers.size, 0);
});

test('installed owner coordinator uses the scoped client on both sides and preserves versioned broadcasts', async () => {
  const { patchThreadIpc } = require('../../scripts/patch-thread-ipc.js');
  const source = readFileSync(new URL('./fixtures/edit-sessions/installed-thread-coordination.txt', import.meta.url), 'utf8');
  const patched = patchThreadIpc(source);
  assert.equal(patchThreadIpc(patched), patched);
  const context = { require: path => { assert.equal(path, './cdx-thread-ipc.cjs'); return helper(); }, h1: class {}, setTimeout, clearTimeout };
  runInNewContext(patched, context);
  const client = bus(), official = client('official'), rawA = client('devA'), rawB = client('devB');
  official.addRequestHandler('thread-owner-discovery', () => true, () => ({}));
  const a = new context.Pce(rawA), b = new context.Pce(rawB), snapshots = [], edits = [];
  assert.equal(await a.findThreadOwner({ hostId: 'rno', conversationId: 'chat' }), null);
  const remove = context.Fce({ hostId: 'rno', ipcClient: rawB, viewService: {
    getThreadRole: async () => 'owner',
    requestThreadFollower: async ({ request }) => { edits.push(request); return { method: request.method, result: { ok: true } }; },
    threadStreamStateChanged: async event => snapshots.push(event),
  } });
  await b.setThreadOwnership({ hostId: 'rno', conversationId: 'chat', ownsThread: true });
  assert.equal(await a.findThreadOwner({ hostId: 'rno', conversationId: 'chat' }), 'devB');
  const request = { method: 'thread-follower-edit-last-user-turn', params: { conversationId: 'chat', turnId: 'old', message: 'edited' } };
  assert.equal((await a.requestThreadFollower({ request, targetClientId: 'devB' })).method, request.method);
  assert.equal(edits[0].params.turnId, 'old');
  await official.sendBroadcast('thread-stream-state-changed', { historyMode: 'paginated' });
  assert.equal(snapshots.length, 0);
  await a.threadStreamStateChanged({ params: { historyMode: 'legacy' }, targetClientIds: ['devB'] });
  assert.equal(snapshots.length, 1); assert.equal(snapshots[0].params.historyMode, 'legacy');
  remove(); assert.equal(rawB.handlers.size, 0);
});
