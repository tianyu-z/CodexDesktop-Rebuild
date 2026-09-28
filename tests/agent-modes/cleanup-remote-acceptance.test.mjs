import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectManifest, verifyManifest, archiveCandidate } from './cleanup-remote-acceptance.mjs';

const chat = '01a0e665-48a6-7120-8bdc-99c4e5f1c030';
const codex = '01a0e665-4d12-7c63-acf0-5e571934085c';
const claude = '1e6ca424-5d2c-4502-a26f-302dcf1f00a7';
const cwd = '/tmp/cdx-remote-acceptance-test';
const finishedAt = '2026-09-28T05:03:46.100Z';
const makeEvidence = () => ({ host: 'rno', threadId: chat, cwd,
  startedAt: '2026-09-28T05:03:03.605Z', finishedAt,
  workflow: { status: 'completed', runs: [
    { id: 'run-a', roleId: 'participant_a', engine: 'codex', status: 'completed', nativeSessionId: codex, cwd },
    { id: 'run-b', roleId: 'participant_b', engine: 'claude', status: 'completed', nativeSessionId: claude, cwd },
  ] } });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'acceptance-cleanup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, write: (name, value) => writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value)) };
}

test('manifest includes only explicit top-level and Codex session IDs, deduplicated', t => {
  const f = fixture(t), e = makeEvidence();
  e.workflow.runs.push({ ...e.workflow.runs[0], id: 'run-critique' });
  f.write('remote-live-rno-mixed.json', e);
  const manifest = collectManifest(f.root);
  assert.deepEqual(manifest.candidates.map(row => row.threadId), [chat, codex].sort());
  assert.equal(manifest.candidates.find(row => row.threadId === codex).sources.length, 2);
  assert.ok(!JSON.stringify(manifest.candidates).includes(claude));
  assert.deepEqual(verifyManifest(manifest).candidates, manifest.candidates);
});

test('malformed, incomplete, active and conflicting evidence cannot contribute IDs', t => {
  const f = fixture(t), e = makeEvidence();
  f.write('remote-live-rno-complete.json', e);
  f.write('remote-live-rno-active.json', { ...e, workflow: { ...e.workflow, status: 'running' } });
  f.write('remote-live-ala-broken.json', '{');
  f.write('remote-live-bar-incomplete.json', { host: 'bar', threadId: claude });
  const manifest = collectManifest(f.root);
  assert.equal(manifest.candidates.length, 0);
  assert.equal(manifest.sources.filter(row => row.reason).length, 3);
});

test('legacy completed lifecycle evidence needs all terminal stages and ignores Claude stage IDs', t => {
  const f = fixture(t);
  const stages = ['pending-approval', 'reconnect-same-approval-denied', 'pending-approval-interrupted',
    'gateway-restart-native-session-recovered', 'claude-to-codex-context', 'codex-to-claude-context'];
  f.write('remote-lifecycle-rno.json', { host: 'rno', threadId: chat, cwd: '/tmp/cdx-lifecycle-test',
    startedAt: '2026-09-28T05:03:03.605Z', passed: true,
    stages: stages.map(name => ({ name, nativeSessionId: claude })) });
  assert.deepEqual(collectManifest(f.root).candidates.map(row => row.threadId), [chat]);
});

test('edited evidence or a forged candidate invalidates a reviewed manifest', t => {
  const f = fixture(t);
  f.write('remote-live-rno-mixed.json', makeEvidence());
  const manifest = collectManifest(f.root), forged = structuredClone(manifest);
  forged.candidates[0].threadId = claude;
  assert.throws(() => verifyManifest(forged), /manifest|candidate/i);
  f.write('remote-live-rno-mixed.json', { ...makeEvidence(), finishedAt: '2026-09-28T05:04:00Z' });
  assert.throws(() => verifyManifest(manifest), /changed|manifest/i);
});

test('native archival refuses active, changed, unknown and wrong-workspace threads', async () => {
  const candidate = { host: 'rno', threadId: chat, cwd, completedAt: finishedAt };
  for (const changed of [ { status: { type: 'active' } }, { cwd: '/home/user/project' },
    { status: { type: 'unknown' } }, { updatedAt: Date.parse(finishedAt) / 1000 + 5 },
    { turns: [{ status: 'inProgress' }] } ]) {
    const calls = [];
    const result = await archiveCandidate(candidate, async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: chat, cwd, status: { type: 'notLoaded' }, turns: [],
        updatedAt: Date.parse(finishedAt) / 1000 - 2, ...changed } };
    });
    assert.equal(result.status, 'skipped');
    assert.ok(!calls.some(call => call.method === 'thread/archive'));
  }
});

test('archival makes only exact-ID reads and one preserving native archive request', async () => {
  const calls = [], candidate = { host: 'rno', threadId: chat, cwd, completedAt: finishedAt };
  const result = await archiveCandidate(candidate, async (method, params) => {
    calls.push({ method, params });
    return method === 'thread/read' ? { thread: { id: chat, cwd, status: { type: 'notLoaded' },
      turns: [{ status: 'completed' }], updatedAt: Date.parse(finishedAt) / 1000 - 2 } } : {};
  });
  assert.equal(result.status, 'archived');
  assert.ok(calls.every(call => call.params.threadId === chat));
  assert.deepEqual(calls.map(call => call.method), ['thread/read', 'thread/read', 'thread/archive']);
});

test('CLI remains local by default and refuses execution without its explicit opt-in', t => {
  const f = fixture(t), script = fileURLToPath(new URL('./cleanup-remote-acceptance.mjs', import.meta.url));
  f.write('remote-live-rno-mixed.json', makeEvidence());
  const manifestPath = join(f.root, 'review.json');
  const planned = spawnSync(process.execPath, [script, '--evidence-root', f.root, '--manifest', manifestPath],
    { encoding: 'utf8', env: { ...process.env, CDX_REMOTE_ACCEPTANCE_ARCHIVE: '1' } });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).mode, 'plan-only');
  const env = { ...process.env }; delete env.CDX_REMOTE_ACCEPTANCE_ARCHIVE;
  const refused = spawnSync(process.execPath, [script, '--execute', '--host', 'rno', '--manifest', manifestPath], { encoding: 'utf8', env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Set CDX_REMOTE_ACCEPTANCE_ARCHIVE=1/);
});
