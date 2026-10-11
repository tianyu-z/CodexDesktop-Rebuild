// Read-only integration fixture. Extracts installed IPC/client coordination code;
// all transport is in memory and the shared native app server is never touched.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const root = path.resolve(__dirname, '../..');
const source = ['installed-thread-coordination.txt', 'installed-ipc-client.txt'].map(name => fs.readFileSync(path.join(__dirname, 'fixtures/edit-sessions', name), 'utf8')).join('\n');
const { createThreadIpcScope } = require(path.join(root, 'scripts/assets/cdx-thread-ipc.cjs'));
function extract(marker, delta = 0) {
  const found = source.indexOf(marker);
  if (found < 0) throw Error(`Missing extraction marker ${marker}`);
  const start = found + delta;
  const parsed = acorn.parseExpressionAt(source, start, { ecmaVersion: 'latest' });
  return source.slice(start, parsed.end);
}
function extractFunction(name) {
  return extract((source.includes(`async function ${name}(`) ? 'async function ' : 'function ') + name + '(');
}
const router = {
  clients: [], discoveries: new Map(), wire: [],
  async accept(socket, envelope) {
    this.wire.push(envelope);
    if (envelope.type === 'client-discovery-response') {
      this.discoveries.get(envelope.requestId)?.(envelope.response.canHandle); return;
    }
    if (envelope.type === 'response') {
      this.clients.find(client => client.pendingResponses.has(envelope.requestId))?.handleMessage(envelope); return;
    }
    if (envelope.type === 'broadcast') {
      await Promise.all(this.clients.filter(client => client !== socket.client).map(client => client.handleBroadcast(envelope))); return;
    }
    if (envelope.type !== 'request') throw Error(envelope.type);
    let selected;
    // Controlled deterministic ordering substitutes for the real router's
    // Promise.any. Actual client discovery/version/predicate methods run below.
    for (const client of this.clients) {
      if (client === socket.client || envelope.targetClientId && envelope.targetClientId !== client.clientId) continue;
      const requestId = crypto.randomUUID();
      const accepted = await new Promise(resolve => {
        this.discoveries.set(requestId, resolve);
        void client.handleClientDiscoveryRequest({ type: 'client-discovery-request', requestId, request: envelope });
      });
      this.discoveries.delete(requestId);
      if (accepted) { selected = client; break; }
    }
    if (selected) await selected.handleRequest(envelope);
    else socket.client.handleMessage({ type: 'response', requestId: envelope.requestId, resultType: 'error', error: 'no-client-found' });
  },
};
const context = vm.createContext({
  Buffer, setTimeout, clearTimeout, console, h1: class {},
  s: { randomUUID: crypto.randomUUID },
  h9: (socket, envelope) => void router.accept(socket, envelope),
  g9: () => null, t: { i: () => ({ warning() {}, debug() {} }) },
});
vm.runInContext('var b9=5000,Mce=100,Nce=60000,Ace=5000,y9="initializing-client",x9=new WeakMap,n_=' + extract('n_={', 3) + ';' +
  ['r_', 'i_', 'a_', 'Fce', 'Ice', 'Lce', 'Rce', 'zce', 'C9', 'S9'].map(extractFunction).join(';') +
  ';var Pce=' + extract('Pce=class', 4) + ';var jce=' + extract('jce=class', 4) +
  ';globalThis.api={Pce,Fce,jce,r_,i_,a_,x9};', context);
const api = context.api;
const wrap = createThreadIpcScope({ broadcastVersion: api.r_, requestVersion: api.i_ });
const wireMethod = (method, version) => `cdx-dev-thread-v1/${version}/${method}`;
const hostId = 'remote-ssh-discovered:rno', conversationId = 'test-thread';
let assertions = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions++; }
function ok(value, message) { assert.ok(value, message); assertions++; }
function participant(id, scoped, role) {
  // Skip jce's real constructor, which would initiate socket connection.
  const raw = Object.create(api.jce.prototype);
  Object.assign(raw, {
    clientId: id, clientType: 'codex', logger: { warning() {}, debug() {} },
    requestHandlers: new Map(), broadcastHandlers: new Map(), anyBroadcastHandlers: new Set(),
    pendingResponses: new Map(), initializationWaiters: new Set(), disposed: false,
  });
  raw.socket = { client: raw, writable: true }; router.clients.push(raw);
  const ipc = scoped ? wrap(raw) : raw, events = [], requests = [];
  const view = {
    role,
    async getThreadRole({ hostId: host }) { equal(host, hostId, 'owner predicate retains host'); return this.role; },
    async requestThreadFollower({ hostId: host, request }) {
      equal(host, hostId, 'renderer dispatch retains host'); requests.push(request);
      return { method: request.method, result: { owner: id, ok: true } };
    },
  };
  for (const [method, kind] of Object.entries({
    threadStreamStateChanged: 'snapshot', threadStreamFollowingChanged: 'following',
    threadStreamFollowingStatusRequested: 'following-status', threadReadStateChanged: 'read',
    threadArchived: 'archive', threadUnarchived: 'unarchive', threadQueuedFollowUpsChanged: 'queue',
    clientStatusChanged: 'client', ipcConnectionReset: 'reset', invalidateQueryCache: 'query',
  })) view[method] = async event => { events.push({ kind, ...event }); };
  const coordinator = new api.Pce(ipc);
  api.Fce({ hostId, ipcClient: scoped ? wrap(raw) : raw, viewService: view });
  if (role === 'owner') coordinator.setThreadOwnership({ hostId, conversationId, ownsThread: true });
  return { raw, ipc, coordinator, view, events, requests };
}
const flush = () => new Promise(setImmediate);
async function main() {
  const official = participant('official', false, 'owner');
  const legacy = participant('legacy-dev', false, 'follower');
  equal(await legacy.coordinator.findThreadOwner({ hostId, conversationId }), 'official', 'unscoped dev discovers official');
  const request = { method: 'thread-follower-edit-last-user-turn', params: { conversationId, turnId: 'older', message: 'edit' } };
  const old = await legacy.coordinator.requestThreadFollower({ request, targetClientId: 'official' });
  equal(old.result.owner, 'official', 'unscoped edit reaches official');
  const a = participant('dev-a', true, 'follower');
  equal(wrap(a.ipc), a.ipc, 'wrapper is idempotent');
  equal(api.x9.get(a.ipc), a.coordinator.ownedThreads, 'wrapper identity retains ownership optimization');
  equal(await a.coordinator.findThreadOwner({ hostId, conversationId }), null, 'live official is excluded without corrupting no-client-found');
  const b = participant('dev-b', true, 'owner');
  equal(await a.coordinator.findThreadOwner({ hostId, conversationId }), 'dev-b', 'same-dev owner is discovered');
  const edited = await a.coordinator.requestThreadFollower({ request, targetClientId: 'dev-b' });
  equal(edited.method, request.method, 'reply method is restored');
  equal(edited.handledByClientId, 'dev-b', 'owner client ID retained');
  equal(b.requests.at(-1).method, request.method, 'renderer receives original method');
  equal(official.requests.length, 1, 'scoped edit bypasses official');
  const missing = await a.coordinator.requestThreadFollower({ request, targetClientId: 'official' });
  equal(missing.error, 'no-client-found', 'targeted unavailable owner error preserved');
  await official.coordinator.threadStreamStateChanged({ params: { hostId, conversationId, change: { type: 'snapshot', historyMode: 'paginated' } } });
  await flush();
  equal(a.events.length, 0, 'official snapshot filtered for dev A');
  equal(b.events.length, 0, 'official snapshot filtered for dev B');
  ok(legacy.events.some(event => event.kind === 'snapshot'), 'unscoped peer receives official snapshot');
  await b.coordinator.threadStreamStateChanged({ params: { hostId, conversationId, change: { type: 'snapshot', historyMode: 'legacy' } }, targetClientIds: ['dev-a'] });
  await flush();
  equal(a.events.at(-1).sourceClientId, 'dev-b', 'dev snapshot retains source ID');
  equal(a.events.at(-1).params.hostId, hostId, 'dev snapshot retains raw host');
  equal(official.events.length, 0, 'official ignores dev snapshot');
  await a.coordinator.setThreadOwnership({ hostId, conversationId, ownsThread: true }); a.view.role = 'owner';
  await b.coordinator.setThreadOwnership({ hostId, conversationId, ownsThread: false }); b.view.role = 'follower';
  equal(await b.coordinator.findThreadOwner({ hostId, conversationId }), 'dev-a', 'reverse discovery works');
  for (const params of [{ conversationId }, { conversationId, expectedTurnId: 'turn' }]) {
    const response = await b.coordinator.requestThreadFollower({ request: { method: 'thread-follower-interrupt-turn', params }, targetClientId: 'dev-a' });
    equal(response.method, 'thread-follower-interrupt-turn', 'interrupt reply restored');
  }
  for (const version of [3, 4]) ok(router.wire.some(event => event.type === 'request' && event.method === wireMethod('thread-follower-interrupt-turn', version) && event.version === 0), `interrupt schema ${version} encoded`);
  await official.raw.sendBroadcast('client-status-changed', { clientId: 'official', status: 'connected' });
  await official.raw.sendBroadcast('ipc-connection-reset', {});
  await a.coordinator.invalidateQueryCache({ keys: ['threads'] });
  await official.coordinator.threadArchived({ hostId, conversationId });
  await official.coordinator.threadUnarchived({ hostId, conversationId });
  await official.coordinator.threadReadStateChanged({ hostId, conversationId, read: true });
  await flush();
  for (const kind of ['client', 'reset', 'archive', 'unarchive', 'read']) ok(a.events.some(event => event.kind === kind), `${kind} remains global`);
  ok(official.events.some(event => event.kind === 'query'), 'query invalidation remains global');
  const before = a.events.length;
  await b.raw.sendBroadcast(wireMethod('thread-stream-state-changed', 999), { hostId, conversationId });
  await flush();
  equal(a.events.length, before, 'unknown broadcast schema dropped');
  const bad = await b.raw.sendRequest(wireMethod(request.method, 999), { conversationId }, { targetClientId: 'dev-a' });
  equal(bad.error, 'no-client-found', 'unknown request schema rejected');
  const original = a.raw.sendRequest;
  a.raw.sendRequest = async () => ({ resultType: 'success', method: 'wrong', handledByClientId: 'dev-b', result: {} });
  await assert.rejects(a.ipc.sendRequest(request.method, {}, {}), /method-mismatch/); assertions++;
  a.raw.sendRequest = original;
  console.log(JSON.stringify({ status: 'PASS', assertions, nativeRpcCalls: 0, fixture: 'actual Pce/Fce/Rce/jce extracted from main bundle; in-memory router; production cdx-thread-ipc.cjs adapter' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
