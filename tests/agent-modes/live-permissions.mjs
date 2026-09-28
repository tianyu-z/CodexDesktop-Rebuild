// Opt-in real Claude permission/cancellation checks. Writes only disposable
// fixtures; never grants session-wide access or changes user permission settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runDir = mkdtempSync(join(root, '.artifacts', 'live', 'permissions-'));
const workspace = join(runDir, 'workspace');
mkdirSync(join(workspace, '.claude'), { recursive: true });
writeFileSync(join(workspace, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash', 'Write', 'Edit'] } }));
const childPids = pid => execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
  .map(line => line.trim().split(/\s+/).map(Number)).filter(row => row[1] === pid).map(row => row[0]);
const processExists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const completions = new Map(), waiters = new Map(), approvals = [], resolutions = [];
let phase, threadId, interruptReply, handlerError, baselineChildren, cancelledWorkers = [];
const allowCommand = "printf 'ALLOW_572' > allowed.txt";
const client = new NativeClient({
  command: process.execPath,
  args: [join(root, 'runtime', 'agent-modes', 'gateway.mjs'), 'app-server'],
  env: { ...process.env, CDX_REAL_CODEX: '/Applications/chatgpt-dev.app/Contents/Resources/codex', CDX_ENGINE_STORE: join(runDir, 'store') },
  onNotification(message) {
    if (message.method === 'serverRequest/resolved') resolutions.push(message.params.requestId);
    if (message.method !== 'turn/completed') return;
    const turn = message.params.turn;
    completions.set(turn.id, turn); waiters.get(turn.id)?.(turn);
  },
  onRequest(message) {
    const command = message.params?.command;
    approvals.push({ id: message.id, phase, method: message.method, command });
    if (phase === 'cancel') {
      cancelledWorkers = childPids(client.child.pid).filter(pid => !baselineChildren.includes(pid));
      interruptReply = client.request('turn/interrupt', { threadId, turnId: message.params.turnId }).catch(error => { handlerError = error; });
      return;
    }
    const accepted = phase === 'allow' && message.method === 'item/commandExecution/requestApproval' && command === allowCommand;
    client.respond({ id: message.id, result: message.method === 'item/tool/requestUserInput'
      ? { answers: { permission: { answers: ['Deny'] } } }
      : { decision: accepted ? 'accept' : 'decline' } });
  },
});

async function turn(prompt) {
  const result = await client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
  let timer;
  try {
    return await Promise.race([
      completions.has(result.turn.id) ? completions.get(result.turn.id) : new Promise(resolve => waiters.set(result.turn.id, resolve)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Live ${phase} check timed out`)), 90000); }),
    ]);
  } finally { clearTimeout(timer); }
}

try {
  await client.request('initialize', { clientInfo: { name: 'engine-permission-smoke', version: '1' }, capabilities: { experimentalApi: true } });
  client.notify({ method: 'initialized' });
  const started = await client.request('thread/start', { cwd: workspace, engineMode: 'claude', engineModel: 'haiku' });
  threadId = started.thread.id;
  baselineChildren = childPids(client.child.pid);
  phase = 'allow';
  const allowed = await turn(`Use Bash to run exactly this one command in the current directory: ${allowCommand}. Do not use other tools. Then reply ALLOWED_DONE.`);
  assert.equal(allowed.status, 'completed', JSON.stringify(allowed.error));
  assert.ok(approvals.some(approval => approval.phase === 'allow' && approval.command === allowCommand), 'Expected a real Bash approval request.');
  assert.equal(readFileSync(join(workspace, 'allowed.txt'), 'utf8'), 'ALLOW_572');
  console.log('Real Claude permission allow and file write: PASS');

  phase = 'deny';
  const denied = await turn("Use Bash to run exactly printf 'DENY_573' > denied.txt once. If permission is declined, stop and report DENIED; do not retry or use another tool.");
  assert.equal(denied.status, 'completed', JSON.stringify(denied.error));
  assert.ok(approvals.some(approval => approval.phase === 'deny'), 'Expected a real denied permission request.');
  assert.equal(existsSync(join(workspace, 'denied.txt')), false);
  console.log('Real Claude permission deny prevents file write: PASS');

  phase = 'cancel';
  const interrupted = await turn("Use Bash to run exactly printf 'CANCEL_574' > interrupted.txt once, waiting for normal permission approval first.");
  await interruptReply;
  if (handlerError) throw handlerError;
  assert.equal(interrupted.status, 'interrupted', JSON.stringify(interrupted.error));
  assert.equal(existsSync(join(workspace, 'interrupted.txt')), false);
  assert.ok(cancelledWorkers.length > 0, 'Expected an owned Claude child while permission was pending.');
  assert.ok(cancelledWorkers.every(pid => !processExists(pid)), 'Claude worker must exit before interruption completes.');
  assert.equal((await client.request('engine/mode/read', { threadId })).busy, false);
  assert.ok(approvals.every(approval => resolutions.filter(id => id === approval.id).length === 1), 'Each frontend approval must resolve exactly once with its remapped ID.');
  assert.equal(client.serverRequests.size, 0);
  assert.equal(client.serverRequestIds.size, 0);
  await client.request('engine/mode/set', { threadId, engineMode: 'codex' });
  console.log('Real Claude pending approval cancellation, child exit and mode switch: PASS');
  writeFileSync(join(runDir, 'report.json'), JSON.stringify({ passed: true, threadId, approvals, resolutions, cancelledWorkersExited: true }, null, 2));
  console.log(`Evidence: ${runDir}`);
} finally {
  if (threadId) {
    try { await client.request('thread/archive', { threadId }); } catch { /* active failures are interrupted by gateway shutdown */ }
  }
  await client.close();
}
