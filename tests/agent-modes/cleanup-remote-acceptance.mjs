// Plan only (local files): node tests/agent-modes/cleanup-remote-acceptance.mjs
// After review and all tests stop, archive one host's exact reviewed IDs:
// CDX_REMOTE_ACCEPTANCE_ARCHIVE=1 node tests/agent-modes/cleanup-remote-acceptance.mjs \
//   --execute --host rno --manifest .artifacts/remote-acceptance-archive-manifest.json
// This never prepares/stops gateways, starts turns, deletes files, or lists chats.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { nativeLoginWrapper } from './live-remote-login.mjs';

const hosts = new Set(['rno', 'blc', 'blc-2', 'bar', 'ala', 'sko']);
const evidenceName = /^remote-(?:live|lifecycle)-[a-z0-9-]+\.json$/;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'skipped']);
const lifecycleStages = ['pending-approval', 'reconnect-same-approval-denied', 'pending-approval-interrupted',
  'gateway-restart-native-session-recovered', 'claude-to-codex-context', 'codex-to-claude-context'];
const key = row => row.host + '/' + row.threadId;

function explicitIds(evidence) {
  if (!hosts.has(evidence?.host)) return [];
  return [evidence.threadId, ...(Array.isArray(evidence.workflow?.runs)
    ? evidence.workflow.runs.filter(run => run?.engine === 'codex').map(run => run.nativeSessionId) : [])]
    .filter(uuid).map(threadId => ({ host: evidence.host, threadId }));
}

function inspectEvidence(file, evidence, modifiedAt) {
  if (!evidence || !hosts.has(evidence.host) || !uuid(evidence.threadId) || !timestamp(evidence.startedAt)) return 'Malformed or incomplete evidence';
  const lifecycle = file === 'remote-lifecycle-' + evidence.host + '.json';
  if (!lifecycle && !file.startsWith('remote-live-' + evidence.host + '-')) return 'Host does not match evidence filename';
  const fixture = lifecycle ? /^\/tmp\/cdx-lifecycle-[a-zA-Z0-9_-]+$/ : /^\/tmp\/cdx-remote-acceptance-[a-zA-Z0-9_-]+$/;
  if (typeof evidence.cwd !== 'string' || !fixture.test(evidence.cwd)) return 'Missing acceptance-owned fixture path';
  if (evidence.activeTurn || evidence.activeRun || evidence.active === true) return 'Active evidence';
  if (lifecycle) {
    if (evidence.passed !== true || evidence.error || !Array.isArray(evidence.stages)
      || !lifecycleStages.every(name => evidence.stages.some(stage => stage?.name === name))
      || evidence.stages.at(-1)?.name !== 'codex-to-claude-context') return 'Incomplete lifecycle evidence';
    // The original lifecycle driver writes evidence only in finally, without finishedAt.
    if (Date.parse(modifiedAt) < Date.parse(evidence.startedAt)) return 'Invalid lifecycle completion time';
  } else {
    const workflow = evidence.workflow;
    if (!timestamp(evidence.finishedAt) || Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt)
      || !terminal.has(workflow?.status) || !Array.isArray(workflow.runs) || workflow.runs.length === 0
      || workflow.runs.some(run => !run || !['codex', 'claude'].includes(run.engine) || !terminal.has(run.status)
        || (run.nativeSessionId != null && !uuid(run.nativeSessionId))
        || (run.status === 'completed' && !uuid(run.nativeSessionId))
        || (run.engine === 'codex' && run.nativeSessionId && (typeof run.cwd !== 'string' || !isAbsolute(run.cwd))))) {
      return 'Incomplete or active workflow evidence';
    }
  }
  return null;
}

export function collectManifest(evidenceRoot) {
  const root = resolve(evidenceRoot), sources = [], candidates = new Map(), blocked = new Set();
  for (const file of readdirSync(root).filter(name => evidenceName.test(name)).sort()) {
    const source = { file }, path = join(root, file), stat = lstatSync(path);
    let evidence;
    if (!stat.isFile() || stat.isSymbolicLink()) source.reason = 'Evidence must be a regular file';
    else {
      const bytes = readFileSync(path);
      source.sha256 = createHash('sha256').update(bytes).digest('hex');
      source.modifiedAt = stat.mtime.toISOString();
      try { evidence = JSON.parse(bytes); source.reason = inspectEvidence(file, evidence, source.modifiedAt); }
      catch { source.reason = 'Malformed JSON evidence'; }
    }
    sources.push(source);
    if (source.reason) { for (const row of explicitIds(evidence)) blocked.add(key(row)); continue; }
    const completedAt = evidence.finishedAt ?? source.modifiedAt;
    const add = (threadId, cwd, provenance) => {
      const id = key({ host: evidence.host, threadId });
      const prior = candidates.get(id);
      if (prior && prior.cwd !== cwd) { blocked.add(id); return; }
      const row = prior ?? { host: evidence.host, threadId, cwd, completedAt, sources: [] };
      if (Date.parse(completedAt) > Date.parse(row.completedAt)) row.completedAt = completedAt;
      row.sources.push({ file, ...provenance }); candidates.set(id, row);
    };
    add(evidence.threadId, evidence.cwd, { kind: 'top-level-thread' });
    for (const run of evidence.workflow?.runs ?? []) if (run.engine === 'codex' && uuid(run.nativeSessionId)) {
      add(run.nativeSessionId, run.cwd, { kind: 'codex-native-session', runId: run.id, roleId: run.roleId });
    }
  }
  return { version: 1, createdAt: new Date().toISOString(), evidenceRoot: root, sources,
    candidates: [...candidates.values()].filter(row => !blocked.has(key(row))).sort((a, b) => key(a).localeCompare(key(b))),
    excludedIds: [...blocked].sort() };
}

export function verifyManifest(manifest) {
  assert.equal(manifest?.version, 1, 'Unknown cleanup manifest version');
  assert.ok(typeof manifest.evidenceRoot === 'string' && isAbsolute(manifest.evidenceRoot), 'Invalid manifest evidence root');
  const current = collectManifest(manifest.evidenceRoot);
  assert.deepEqual(manifest.sources, current.sources, 'Acceptance evidence changed; generate and review a new manifest');
  assert.deepEqual(manifest.candidates, current.candidates, 'Cleanup manifest candidate set changed');
  assert.deepEqual(manifest.excludedIds, current.excludedIds, 'Cleanup manifest exclusions changed');
  return current;
}

function checkNative(candidate, thread) {
  if (thread?.id !== candidate.threadId || thread.cwd !== candidate.cwd) return 'Native ID or workspace does not match evidence';
  if (!['idle', 'notLoaded'].includes(thread.status?.type) || thread.status?.activeFlags?.length) return 'Native state is active or unknown';
  if (!Number.isFinite(thread.updatedAt)) return 'Native update time is unavailable';
  const updated = thread.updatedAt > 1e12 ? thread.updatedAt : thread.updatedAt * 1000;
  if (updated > Date.parse(candidate.completedAt) + 1000) return 'Native history changed after acceptance evidence';
  return null;
}

export async function archiveCandidate(candidate, rpc) {
  try {
    let thread;
    try { ({ thread } = await rpc('thread/read', { threadId: candidate.threadId, includeTurns: true })); }
    catch (error) {
      if (!/paginated|full.history|includeTurns|list_turns is not supported yet/i.test(error.message)) throw error;
      ({ thread } = await rpc('thread/read', { threadId: candidate.threadId, includeTurns: false }));
    }
    let reason = checkNative(candidate, thread);
    if (reason) return { status: 'skipped', reason };
    if (thread.historyMode === 'paginated' || !Array.isArray(thread.turns)) {
      thread.turns = []; let cursor; const visited = new Set();
      do {
        const page = await rpc('thread/turns/list', { threadId: candidate.threadId, limit: 100,
          itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) throw Error('Native turns page is incomplete');
        thread.turns.push(...page.data); cursor = page.nextCursor;
        if (cursor && (visited.has(cursor) || visited.size >= 10)) throw Error('Native history pagination is incomplete');
        visited.add(cursor);
      } while (cursor);
    }
    if (thread.turns.some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status))) return { status: 'skipped', reason: 'Native turn is active or unknown' };
    const latest = (await rpc('thread/read', { threadId: candidate.threadId, includeTurns: false })).thread;
    reason = checkNative(candidate, latest);
    if (reason || latest.updatedAt !== thread.updatedAt) return { status: 'skipped', reason: reason ?? 'Native history changed during inspection' };
    await rpc('thread/archive', { threadId: candidate.threadId });
    return { status: 'archived' };
  } catch (error) { return { status: 'skipped', reason: error.message }; }
}

async function connectNative(host) {
  assert.ok(hosts.has(host), 'Host is outside the acceptance matrix');
  const marker = randomBytes(24), pending = new Map(); let sequence = 0, failure;
  const child = spawn('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host,
    nativeLoginWrapper()('exec codex app-server', marker)], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let framed = false, boundary = Buffer.alloc(0);
  const output = new Transform({ transform(bytes, encoding, callback) {
    if (!framed) {
      const combined = Buffer.concat([boundary, bytes]), index = combined.indexOf(marker);
      if (index < 0) { boundary = combined.subarray(Math.max(0, combined.length - marker.length + 1)); callback(); return; }
      framed = true; bytes = combined.subarray(index + marker.length); boundary = Buffer.alloc(0);
    }
    callback(null, bytes);
  } });
  const fail = error => { failure = error; for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); };
  const exited = new Promise(resolve => child.once('close', resolve));
  child.on('error', fail); child.stdin.on('error', fail);
  child.once('close', () => fail(Error('Owned native cleanup connection closed')));
  const lines = createInterface({ input: child.stdout.pipe(output) });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(Error('Invalid native RPC response')); return; }
    // Archival never starts inference or answers permissions belonging to another run.
    if (message.method && message.id != null) { fail(Error('Unexpected native request; refusing to continue')); return; }
    if (message.id == null) return;
    const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Native RPC timed out: ' + method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const close = async () => {
    child.stdin.end(); let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer); lines.close(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    fail(Error('Owned native cleanup connection released'));
  };
  try {
    await rpc('initialize', { clientInfo: { name: 'remote_acceptance_archive', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return { rpc, close };
  } catch (error) { await close(); throw error; }
}

async function main() {
  const { values } = parseArgs({ options: { execute: { type: 'boolean', default: false },
    host: { type: 'string' }, manifest: { type: 'string' }, 'evidence-root': { type: 'string' } } });
  const manifestPath = resolve(values.manifest ?? '.artifacts/remote-acceptance-archive-manifest.json');
  if (!values.execute) {
    assert.ok(!values.host, '--host is only used with --execute; the manifest covers every explicit evidence host');
    const manifest = collectManifest(values['evidence-root'] ?? '.artifacts');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ mode: 'plan-only', manifestPath, proposed: manifest.candidates.length,
      hosts: Object.fromEntries([...hosts].map(host => [host, manifest.candidates.filter(row => row.host === host).length])),
      skippedEvidence: manifest.sources.filter(source => source.reason).map(source => ({ file: source.file, reason: source.reason })) }));
    return;
  }
  assert.equal(process.env.CDX_REMOTE_ACCEPTANCE_ARCHIVE, '1', 'Set CDX_REMOTE_ACCEPTANCE_ARCHIVE=1 only after reviewing the manifest and stopping acceptance tests');
  assert.ok(hosts.has(values.host), '--execute requires one acceptance --host');
  assert.ok(!values['evidence-root'], '--execute uses the evidence root pinned in the reviewed manifest');
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const candidates = manifest.candidates.filter(row => row.host === values.host);
  assert.ok(candidates.length, 'No reviewed IDs for this host');
  const resultPath = join(manifest.evidenceRoot, 'remote-acceptance-archive-result-' + values.host + '-' + Date.now() + '.json');
  const result = { host: values.host, manifestPath, startedAt: new Date().toISOString(), results: [] };
  const save = () => writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  let client;
  try {
    client = await connectNative(values.host);
    for (const candidate of candidates) {
      verifyManifest(manifest);
      const row = { threadId: candidate.threadId, ...await archiveCandidate(candidate, client.rpc) };
      result.results.push(row); save(); console.log(JSON.stringify(row));
    }
  } catch (error) { result.error = error.message; process.exitCode = 1; }
  finally { await client?.close(); result.finishedAt = new Date().toISOString(); save(); }
  console.log(JSON.stringify({ resultPath, archived: result.results.filter(row => row.status === 'archived').length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
