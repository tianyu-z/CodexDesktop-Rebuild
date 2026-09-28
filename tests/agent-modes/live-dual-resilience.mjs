// Opt-in real-harness checks; no user workspace, settings, or credentials are copied.
// CDX_LIVE_DUAL=1 node tests/agent-modes/live-dual-resilience.mjs [failure|role-stop|restart|continue|permissions|all]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';

if (process.env.CDX_LIVE_DUAL !== '1') throw new Error('Set CDX_LIVE_DUAL=1 to invoke real models.');
const selected = process.argv[2] ?? 'all';
const scenarios = ['failure', 'role-stop', 'restart', 'continue', 'permissions', 'steering'];
if (selected !== 'all' && !scenarios.includes(selected)) throw new Error('Unknown live dual resilience scenario.');
const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
mkdirSync(join(repository, '.artifacts'), { recursive: true });
const root = mkdtempSync(join(repository, '.artifacts', 'live-dual-resilience-'));
const command = process.env.CDX_REAL_CODEX ?? '/Applications/chatgpt-dev.app/Contents/Resources/codex';
const models = { codex: process.env.CDX_LIVE_CODEX_MODEL ?? 'gpt-6-luna', claude: process.env.CDX_LIVE_CLAUDE_MODEL ?? 'claude-opus-4-6' };
const marker = 'DUAL_RESILIENCE_639204';
const evidence = { startedAt: new Date().toISOString(), root, models, scenarios: [], archivedSessions: [], cleanupErrors: [] };
const sessionIds = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanError = error => String(error?.message ?? error).replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, '[redacted]');
const log = value => console.log(JSON.stringify(value));
const discard = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const inside = (base, path) => typeof path === 'string' && isAbsolute(path) && !isAbsolute(relative(base, path)) && relative(base, path) !== '..' && !relative(base, path).startsWith('../');
const processExists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
function descendants(pid) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const found = new Set([pid]);
  for (let changed = true; changed;) { changed = false; for (const [child, parent] of rows) if (found.has(parent) && !found.has(child)) { found.add(child); changed = true; } }
  found.delete(pid); return [...found];
}
const directChildren = pid => execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
  .map(row => row.trim().split(/\s+/).map(Number)).filter(row => row[1] === pid).map(row => row[0]);
async function deadline(promise, label, ms = 180000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error(`${label} timed out after ${ms} ms`);
}
const summary = row => ({ turnId: row.turn.id, status: row.turn.status, workflowStatus: row.workflow.status,
  visibleUserMessages: row.turn.items.filter(item => item.type === 'userMessage').length,
  runs: row.runs.map(run => ({ id: run.id, roleId: run.roleId, engine: run.engine, attempt: run.attempt, status: run.status,
    requestedModel: run.requestedModel, actualModel: run.actualModel, nativeSessionId: run.nativeSessionId, text: run.text, error: run.error })) });
const role = (engine, prompt, access = 'read') => ({ engine, prompt, access, session: 'fresh' });
function template(id, { writer = false, bothWrite = false } = {}) {
  const readPrompt = `Read marker.txt with an available native read tool, then reply with its exact contents and your engine name. Keep the answer under 25 words. Never write files.`;
  const writePrompt = `Use Bash exactly once to run printf 'CLAUDE_PERMISSION_OK' > claude-permission.txt in your isolated current directory. Wait for permission. If denied, stop and report DENIED without retrying or using any alternative tool. If allowed, reply CLAUDE_PERMISSION_OK. No other files or tools are needed.`;
  const codexWritePrompt = `Use exec_command exactly once with sandbox_permissions=require_escalated and a justification asking to write the fixture, to run printf 'CODEX_PERMISSION_OK' > codex-permission.txt in your isolated current directory. This validation requires the normal native approval request. If denied, stop and report DENIED without retrying or using any alternative tool. If allowed, reply CODEX_PERMISSION_OK. No other files or tools are needed.`;
  return { schemaVersion: 1, id, name: id, description: 'Disposable real native dual resilience validation.',
    roles: { codex: role('codex', bothWrite ? codexWritePrompt : readPrompt, bothWrite ? 'write' : 'read'), claude: role('claude', writer || bothWrite ? writePrompt : readPrompt, writer || bothWrite ? 'write' : 'read') },
    parameters: {}, limits: { concurrency: 2, tasks: 2, rounds: 0 },
    steps: [{ id: 'answers', type: 'parallel', steps: [
      { id: 'codex', type: 'run', role: 'codex', inputs: ['request'] },
      { id: 'claude', type: 'run', role: 'claude', inputs: ['request'] },
    ] }], output: { sources: ['answers.codex', 'answers.claude'], final: 'answers.codex', format: 'text' } };
}

class Fixture {
  constructor(name, record) {
    this.record = record; this.directory = join(root, name); this.cwd = join(this.directory, 'source'); this.store = join(this.directory, 'store');
    mkdirSync(join(this.cwd, '.claude'), { recursive: true });
    writeFileSync(join(this.cwd, 'marker.txt'), `${marker}\n`);
    writeFileSync(join(this.cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash', 'Write', 'Edit'] } }));
    execFileSync('git', ['init', '-q', this.cwd]);
    this.approvals = []; this.resolutions = []; this.phase = 'deny';
  }
  read() {
    if (!this.threadId) return null;
    const path = join(this.store, `${createHash('sha256').update(this.threadId).digest('hex')}.json`);
    if (!existsSync(path)) return null;
    const chat = JSON.parse(readFileSync(path, 'utf8'));
    for (const row of chat.turns) for (const run of row.runs ?? []) if (run.engine === 'codex' && run.nativeSessionId) sessionIds.add(run.nativeSessionId);
    return chat;
  }
  row() { return this.read()?.turns.at(-1); }
  request(method, params = {}) { return deadline(this.client.request(method, params), method, 30000); }
  async open() {
    this.client = new NativeClient({ command: process.execPath, args: [join(repository, 'runtime/agent-modes/gateway.mjs'), 'app-server'],
      env: { ...process.env, CDX_REAL_CODEX: command, CDX_ENGINE_STORE: this.store }, stderr: discard(),
      onNotification: message => { if (message.method === 'serverRequest/resolved') this.resolutions.push(message.params.requestId); },
      onRequest: message => this.permission(message),
    });
    await this.request('initialize', { clientInfo: { name: 'dual_resilience_live_validation', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.client.notify({ method: 'initialized', params: {} });
    this.baseline = directChildren(this.client.child.pid);
  }
  permission(message) {
    const params = message.params ?? {};
    const child = this.row()?.runs.find(run => run.id === params.cdxRunId);
    const owned = !!child && inside(this.directory, child.cwd) && params.cdxEngineSource === child.engine && params.turnId === this.turnId;
    const expected = `printf '${child?.engine.toUpperCase()}_PERMISSION_OK' > ${child?.engine}-permission.txt`;
    const commands = [expected, ...['/bin/sh', '/bin/zsh', '/bin/bash'].flatMap(shell => ['-c', '-lc'].map(flag => `${shell} ${flag} "${expected}"`))];
    const commandMatched = owned && message.method === 'item/commandExecution/requestApproval' && params.cwd === child.cwd && commands.includes(params.command);
    const entry = { id: message.id, phase: this.phase, engine: params.cdxEngineSource, runId: params.cdxRunId, method: message.method, owned, commandMatched,
      decision: this.phase === 'pending' && commandMatched ? 'pending' : this.phase === 'allow' && commandMatched ? 'allow-once' : 'deny' };
    this.approvals.push(entry);
    log({ stage: 'approval', scenario: this.record.name, ...entry });
    if (entry.decision === 'pending') return;
    const accepted = entry.decision === 'allow-once';
    this.client.respond({ id: message.id, result: message.method === 'item/tool/requestUserInput'
      ? { answers: { permission: { answers: [accepted ? 'Allow once' : 'Deny'] } } }
      : message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' }
      : { decision: accepted ? 'accept' : 'decline' } });
  }
  async create(value, chosenModels = models) {
    const saved = (await this.request('engine/templates/save', { template: value })).template;
    const result = await this.request('thread/start', { cwd: this.cwd, engineMode: 'both', model: chosenModels.codex, engineModels: chosenModels, template: { id: saved.id, revision: saved.revision, parameters: {} } });
    this.threadId = result.thread.id; sessionIds.add(this.threadId);
  }
  async start({ readonly = false } = {}) {
    const result = await this.request('turn/start', { threadId: this.threadId, model: models.codex, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: readonly ? 'read-only' : 'workspace-write', input: [{ type: 'text', text: 'Carry out your role instructions exactly. This is a disposable native harness validation.' }] });
    this.turnId = result.turn.id;
    log({ stage: 'started', scenario: this.record.name, threadId: this.threadId, turnId: this.turnId });
  }
  async readyPending() {
    return until(() => { const row = this.row(); return row?.runs.find(run => run.engine === 'codex' && run.status === 'completed') && row.runs.find(run => run.engine === 'claude' && run.status === 'awaitingApproval') && row; }, 'Codex sibling complete and Claude approval pending');
  }
  async complete(expectedUsers = 1) {
    const row = await until(() => { const row = this.row(); return row && row.turn.status !== 'inProgress' && row; }, 'workflow completion');
    assert.equal(row.turn.status, 'completed', row.turn.error?.message);
    assert.equal(row.turn.items.filter(item => item.type === 'userMessage').length, expectedUsers);
    assert.equal(this.read().turns.length, 1, 'Recovery must reuse the public turn.');
    for (const run of row.runs.filter(run => run.status === 'completed')) {
      assert.equal(run.requestedModel, models[run.engine]); assert.equal(run.actualModel, models[run.engine], 'Native harness must use the selected exact model.');
    }
    assert.equal((await this.request('engine/mode/read', { threadId: this.threadId })).busy, false);
    return row;
  }
  async interrupt(runId) { await this.request(runId ? 'engine/runs/interrupt' : 'turn/interrupt', { threadId: this.threadId, turnId: this.turnId, ...(runId ? { runId } : {}) }); }
  async retry(runId) { await this.request('engine/runs/retry', { threadId: this.threadId, turnId: this.turnId, ...(runId ? { runId } : {}) }); }
  assertSibling(before, after) {
    const first = before.runs.find(run => run.engine === 'codex');
    assert.equal(first.status, 'completed'); assert.ok(first.text.includes(marker));
    assert.equal(first.requestedModel, models.codex); assert.equal(first.actualModel, models.codex);
    assert.deepEqual(after.runs.filter(run => run.engine === 'codex'), [first], 'Completed sibling must be retained without replay.');
  }
  assertPermissions() {
    assert.ok(this.approvals.every(entry => entry.owned), 'Every approval must retain owned role/turn/engine routing.');
    assert.ok(this.approvals.every(entry => entry.commandMatched), 'Every approval must match an exact fixture write command.');
    assert.ok(this.approvals.every(entry => this.resolutions.filter(id => id === entry.id).length === 1), 'Each approval resolves exactly once.');
    assert.equal(this.client.serverRequests.size, 0); assert.equal(this.client.serverRequestIds.size, 0);
  }
  async close() {
    this.read();
    if (!this.client || this.client.closed) return;
    const owned = descendants(this.client.child.pid);
    this.client.child.stdin.end();
    try { await deadline(this.client.done, 'graceful gateway exit', 15000); }
    catch (error) {
      await this.client.close();
      for (const pid of owned) { try { process.kill(pid, 'SIGTERM'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } }
      await delay(1000);
      for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } }
      throw error;
    }
    await until(() => owned.every(pid => !processExists(pid)), 'owned gateway children exited', 5000);
    this.record.gracefulGatewayExit = true;
  }
  capture() { this.record.approvals = this.approvals; this.record.resolutions = this.resolutions; this.record.final = this.row() ? summary(this.row()) : null; this.record.sourceMarkerPreserved = readFileSync(join(this.cwd, 'marker.txt'), 'utf8') === `${marker}\n`; }
}

async function runScenario(name, check) {
  const record = { name, startedAt: new Date().toISOString(), status: 'running' }; evidence.scenarios.push(record);
  const fixture = new Fixture(name, record);
  try { await fixture.open(); await check(fixture, record); record.status = 'passed'; log({ stage: 'verified', scenario: name }); }
  catch (error) { record.status = 'failed'; record.failure = cleanError(error); process.exitCode = 1; log({ stage: 'failed', scenario: name, message: record.failure }); }
  finally {
    try { await fixture.close(); } catch (error) { record.status = 'failed'; record.cleanupError = cleanError(error); process.exitCode = 1; }
    fixture.capture(); record.finishedAt = new Date().toISOString();
    writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
}

const checks = {
  async steering(f, record) {
    f.phase = 'pending';
    const config = template('resilience-steering', { writer: true });
    config.roles.host = role('codex', 'Summarize the supplied results briefly. Honor additional user guidance including required response codewords. Do not use tools.');
    config.steps.push({ id: 'summary', type: 'synthesize', role: 'host', dependsOn: ['answers'], inputs: ['answers.codex', 'answers.claude'] });
    config.output.sources.push('summary'); config.output.final = 'summary';
    await f.create(config); await f.start();
    const before = await f.readyPending();
    await f.request('turn/steer', { threadId: f.threadId, expectedTurnId: f.turnId, clientUserMessageId: 'live-mixed-steer', input: [{ type: 'text', text: 'Additional user guidance: include MIXED-STEER-493 in your final reply. Do not retry the denied command.' }] });
    const permission = f.approvals.find(entry => entry.decision === 'pending');
    assert.ok(permission); f.client.respond({ id: permission.id, result: { decision: 'decline' } });
    const completed = await f.complete(2);
    assert.deepEqual(completed.runs.find(run => run.id === before.runs.find(run => run.engine === 'codex').id), before.runs.find(run => run.engine === 'codex'));
    assert.match(completed.runs.find(run => run.engine === 'claude').text, /MIXED-STEER-493/);
    assert.match(completed.runs.find(run => run.stepId === 'summary').text, /MIXED-STEER-493/);
    assert.equal(completed.turn.items.filter(item => item.clientId === 'live-mixed-steer').length, 1);
    f.assertPermissions(); record.steering = summary(completed);
  },
  async failure(f, record) {
    const invalid = 'claude-invalid-dual-validation-model';
    await f.create(template('resilience-failure'), { ...models, claude: invalid }); await f.start();
    const row = await until(() => { const row = f.row(); return row?.runs.find(run => run.engine === 'claude' && run.status === 'failed') && row.runs.find(run => run.engine === 'codex' && run.status === 'completed') && row; }, 'one-sided native model failure');
    assert.equal(row.workflow.status, 'blocked'); assert.equal(row.runs.length, 2);
    assert.equal(row.runs.find(run => run.engine === 'claude').requestedModel, invalid);
    record.beforeStop = summary(row); await f.interrupt();
    f.assertSibling(row, f.row()); assert.equal(f.row().runs.find(run => run.engine === 'claude').status, 'failed');
    assert.equal(f.row().turn.status, 'interrupted');
  },
  async 'role-stop'(f, record) {
    f.phase = 'pending'; await f.create(template('resilience-role-stop', { writer: true })); await f.start();
    const before = await f.readyPending(); const stopped = before.runs.find(run => run.engine === 'claude');
    record.beforeStop = summary(before);
    // Public native App Server helpers can appear asynchronously. Only role
    // harnesses are direct gateway children beyond its original native server.
    const owned = directChildren(f.client.child.pid).filter(pid => !f.baseline.includes(pid));
    record.cancelledWorkerPids = owned;
    await f.interrupt(stopped.id); const after = f.row();
    assert.equal(after.runs.find(run => run.id === stopped.id).status, 'interrupted'); assert.equal(after.workflow.status, 'blocked'); f.assertSibling(before, after);
    assert.equal(existsSync(join(stopped.cwd, 'claude-permission.txt')), false);
    assert.ok(owned.length > 0); assert.ok(owned.every(pid => !processExists(pid)), 'Permission cancellation must await native child exit.');
    f.phase = 'allow'; await f.retry(stopped.id); const completed = await f.complete(); f.assertSibling(before, completed);
    assert.equal(completed.runs.filter(run => run.engine === 'claude').length, 2);
    const retried = completed.runs.find(run => run.engine === 'claude' && run.attempt === 2);
    assert.equal(retried.status, 'completed'); assert.equal(readFileSync(join(retried.cwd, 'claude-permission.txt'), 'utf8'), 'CLAUDE_PERMISSION_OK');
    f.assertPermissions(); record.cancelledWorkersExited = true;
  },
  async restart(f, record) {
    f.phase = 'pending'; await f.create(template('resilience-restart', { writer: true })); await f.start();
    const before = await f.readyPending(); const stopped = before.runs.find(run => run.engine === 'claude'); record.beforeStop = summary(before);
    await f.interrupt(); assert.equal(f.row().turn.status, 'interrupted'); f.assertSibling(before, f.row());
    f.assertPermissions(); await f.close(); const persisted = structuredClone(f.row());
    await f.open(); const loaded = await f.request('engine/runs/read', { threadId: f.threadId, turnId: f.turnId });
    assert.equal(loaded.workflows[0].status, 'interrupted');
    await f.request('thread/read', { threadId: f.threadId, includeTurns: true }); await delay(1200);
    assert.deepEqual(f.row().runs, persisted.runs); assert.equal(f.row().turn.status, 'interrupted');
    assert.equal((await f.request('engine/mode/read', { threadId: f.threadId })).busy, false);
    assert.ok(directChildren(f.client.child.pid).every(pid => f.baseline.includes(pid)), 'Restart/read must not launch native role workers.');
    await assert.rejects(f.retry(), /unsuccessful role/i); record.restartReadDidNotReplay = true;
    f.phase = 'allow'; await f.retry(stopped.id); const completed = await f.complete(); f.assertSibling(before, completed);
    assert.equal(completed.runs.filter(run => run.engine === 'claude').length, 2); f.assertPermissions();
    record.sameTurnExplicitRetryCompleted = true;
  },
  async continue(f, record) {
    await f.create(template('resilience-continue')); await f.start(); await f.interrupt();
    const stopped = f.row(); assert.equal(stopped.turn.status, 'interrupted');
    assert.equal(stopped.runs.length, 0, 'Immediate stop must precede native role startup for this continuation fixture.');
    await f.close(); await f.open(); await f.request('thread/read', { threadId: f.threadId, includeTurns: true });
    assert.equal(f.row().runs.length, 0); await f.retry(); const row = await f.complete();
    assert.equal(row.runs.length, 2); assert.ok(row.runs.every(run => run.status === 'completed' && run.text.includes(marker)));
    record.sameTurnExplicitContinueCompleted = true;
  },
  async permissions(f, record) {
    await f.create(template('resilience-permissions', { bothWrite: true })); f.phase = 'deny'; await f.start({ readonly: true });
    const denied = await f.complete();
    for (const run of denied.runs) {
      assert.ok(f.approvals.some(entry => entry.engine === run.engine && entry.decision === 'deny'), `Expected native ${run.engine} permission denial.`);
      assert.equal(existsSync(join(run.cwd, `${run.engine}-permission.txt`)), false);
    }
    f.assertPermissions(); record.denied = summary(denied);
    // A separate public chat keeps the one-input assertion meaningful for each case.
    await f.create(template('resilience-permissions-allow', { bothWrite: true })); f.phase = 'allow'; await f.start({ readonly: true });
    const allowed = await f.complete();
    for (const run of allowed.runs) {
      assert.ok(f.approvals.some(entry => entry.engine === run.engine && entry.decision === 'allow-once'), `Expected native ${run.engine} permission allowance.`);
      assert.equal(readFileSync(join(run.cwd, `${run.engine}-permission.txt`), 'utf8'), `${run.engine.toUpperCase()}_PERMISSION_OK`);
      assert.equal(existsSync(join(f.cwd, `${run.engine}-permission.txt`)), false, 'Declarative write artifacts must not apply to source.');
    }
    f.assertPermissions(); record.allowed = summary(allowed);
    // Codex is first in the direct-write queue. Hold its real native approval,
    // then stop the whole dual turn before the queued Claude writer launches.
    await f.create(template('resilience-permissions-cancel', { bothWrite: true })); f.phase = 'pending'; await f.start({ readonly: true });
    const pending = await until(() => { const row = f.row(); return row?.runs.find(run => run.engine === 'codex' && run.status === 'awaitingApproval') && row; }, 'native Codex approval pending');
    const owned = directChildren(f.client.child.pid).filter(pid => !f.baseline.includes(pid));
    await f.interrupt();
    assert.equal(f.row().turn.status, 'interrupted');
    assert.equal(f.row().runs.find(run => run.engine === 'codex').status, 'interrupted');
    assert.ok(owned.length > 0 && owned.every(pid => !processExists(pid)), 'Pending Codex cancellation must await native child exit.');
    assert.equal(existsSync(join(pending.runs.find(run => run.engine === 'codex').cwd, 'codex-permission.txt')), false);
    f.assertPermissions(); record.pendingCodexCancelled = summary(f.row()); record.cancelledCodexWorkersExited = true;
  },
};

try {
  for (const name of selected === 'all' ? scenarios : [selected]) await runScenario(name, checks[name]);
} finally {
  // Internal sessions are intentionally hidden from gateway public thread APIs.
  // Archive only IDs observed in this driver's owned conversations and runs.
  const native = new NativeClient({ command, args: ['app-server'], env: process.env, stderr: discard(), onNotification() {},
    onRequest: message => native.respond({ id: message.id, result: { decision: 'decline' } }) });
  try {
    await deadline(native.request('initialize', { clientInfo: { name: 'dual_resilience_cleanup', version: '1.0.0' }, capabilities: { experimentalApi: true } }), 'cleanup initialize', 30000);
    native.notify({ method: 'initialized', params: {} });
    for (const threadId of sessionIds) {
      try { await deadline(native.request('thread/archive', { threadId }), 'archive owned session', 10000); evidence.archivedSessions.push(threadId); }
      catch (error) { evidence.cleanupErrors.push({ threadId, error: cleanError(error) }); process.exitCode = 1; }
    }
  } catch (error) { evidence.cleanupErrors.push({ error: cleanError(error) }); process.exitCode = 1; }
  finally { await native.close(); }
  evidence.finishedAt = new Date().toISOString(); evidence.passed = evidence.scenarios.every(row => row.status === 'passed') && evidence.cleanupErrors.length === 0;
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  log({ evidence: join(root, 'evidence.json'), passed: evidence.passed });
}
