import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const fixture = readFileSync(new URL('./fixtures/native-thread-catalog.js', import.meta.url), 'utf8');
const { patchCatalogBundle: patch, patchCatalogBuild } = require('../../scripts/patch-agent-catalog.js');
function setup(t, internal = ['child']) {
  const directory = mkdtempSync(join(tmpdir(), 'engine-catalog-'));
  const registry = join(directory, 'internal-native-threads.json');
  writeFileSync(registry, JSON.stringify(internal));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE local_thread_catalog (
    host_id TEXT, thread_id TEXT, display_title TEXT, source_kind TEXT,
    source_created_at REAL, source_updated_at REAL, source_recency_at REAL,
    cwd TEXT, missing_candidate INTEGER DEFAULT 0);
    CREATE INDEX local_thread_catalog_cwd_created_idx ON local_thread_catalog(host_id,cwd,source_created_at);
    CREATE INDEX local_thread_catalog_cwd_updated_idx ON local_thread_catalog(host_id,cwd,source_recency_at);`);
  const insert = db.prepare('INSERT INTO local_thread_catalog VALUES (?,?,?,?,?,?,?,?,0)');
  for (const [id, time] of [['child', 30], ['first', 20], ['second', 10]]) insert.run('local', id, id, 'vscode', time, time, time, '/project');
  insert.run('remote', 'child', 'remote child', 'vscode', 5, 5, 5, '/remote');
  const context = { process: { env: { CDX_ENGINE_STORE: directory } }, require: name => name === './agent-modes-catalog.cjs' ? require('../../scripts/assets/agent-modes-catalog.cjs') : require(name),
    Sx: row => ({ threadId: row.thread_id, hostId: row.host_id, sourceCreatedAt: row.source_created_at, sourceUpdatedAt: row.source_updated_at, sourceRecencyAt: row.source_recency_at }),
    bx: () => null, xx: values => values };
  const Catalog = vm.runInNewContext(`${patch(fixture)}; NativeThreadCatalog`, context);
  return { db, registry, directory, Catalog, local: new Catalog(db, 'local'), remote: new Catalog(db, 'remote') };
}
const ids = entries => Array.from(entries, entry => entry.threadId);

test('cached internal catalog rows are excluded before pagination without changing shared data', t => {
  const { db, local, remote } = setup(t);
  const page = local.readPage({ limit: 1, sortKey: 'updated_at' });
  assert.deepEqual(ids(page.entries), ['first']);
  assert.equal(page.nextCursor.threadId, 'first');
  assert.deepEqual(ids(local.readPage({ limit: 1, sortKey: 'updated_at', cursor: page.nextCursor }).entries), ['second']);
  assert.deepEqual(ids(remote.readPage({ limit: 1, sortKey: 'updated_at' }).entries), ['child']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_thread_catalog').get().n, 4);
});

test('catalog exact, pinned and host lookup reads hide only locally owned internal sessions', t => {
  const { local, remote } = setup(t);
  assert.equal(local.readEntry('child'), null);
  assert.deepEqual(ids(local.readEntries(['child', 'first'])), ['first']);
  assert.equal(local.readThreadHostId('child'), 'remote');
  assert.equal(remote.readEntry('child').threadId, 'child');
  const manual = local.readPage({ limit: 1, sortKey: 'updated_at', manualOrder: { threadIds: ['child', 'first', 'second'], startIndex: 0 } });
  assert.deepEqual(ids(manual.entries), ['first']);
  assert.equal(manual.nextManualIndex, 2);
});

test('new registry ownership is honored by subsequent catalog reads without a restart', t => {
  const { local, registry } = setup(t, []);
  assert.equal(local.readPage({ limit: 1, sortKey: 'updated_at' }).entries[0].threadId, 'child');
  writeFileSync(registry, JSON.stringify(['child']));
  assert.equal(local.readPage({ limit: 1, sortKey: 'updated_at' }).entries[0].threadId, 'first');
  const filter = { cwdValues: ['/project'], cwdPrefixes: [], includeThreadIds: ['child'], excludeThreadIds: ['first'] };
  assert.deepEqual(ids(local.readPage({ limit: 5, sortKey: 'updated_at', filter }).entries), ['second']);
  assert.deepEqual(filter.excludeThreadIds, ['first']);
});

test('catalog patches are exact, idempotent and installed with their helper', t => {
  const patched = patch(fixture);
  assert.ok(patched !== fixture);
  assert.equal(patch(patched), patched);
  for (const anchor of ['LIMIT 100`).all(e).sort((e,t)=>t.source_recency_at', 'readEntry(e){let t=this.db.prepare(`SELECT * FROM local_thread_catalog', 'readEntries(e){if(e.length>100)throw Error(`Thread catalog entry request exceeds 100`);if(e.length===0)return[];', 'readPage({limit:e,cursor:t,filter:n,manualOrder:r,sortKey:i}){']) {
    assert.throws(() => patch(fixture.replace(anchor, 'UPSTREAM_CHANGED')), /expected|match/);
    assert.throws(() => patch(fixture + anchor), /expected|match/);
  }
  const directory = mkdtempSync(join(tmpdir(), 'engine-catalog-build-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'main-fixture.js'), fixture);
  patchCatalogBuild(directory);
  assert.equal(readFileSync(join(directory, 'main-fixture.js'), 'utf8'), patched);
  assert.equal(readFileSync(join(directory, 'agent-modes-catalog.cjs'), 'utf8'), readFileSync(new URL('../../scripts/assets/agent-modes-catalog.cjs', import.meta.url), 'utf8'));
  assert.match(readFileSync(new URL('../../scripts/build-agent-modes-preview.js', import.meta.url), 'utf8'), /patchCatalogBuild\(path\.join\(stagedAsar, '\.vite', 'build'\)\)/);
});
