// Opt-in validation against both installed native harnesses, in an isolated fixture.
// CDX_LIVE_DUAL=1 node tests/agent-modes/live-dual.mjs polly|debby|custom
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { TemplateStore } from '../../runtime/agent-modes/templates/store.mjs';
import { ClaudeAdapter } from '../../runtime/agent-modes/claude-adapter.mjs';
import { RoleRunner } from '../../runtime/agent-modes/orchestration/role-runner.mjs';
import { WorkflowScheduler } from '../../runtime/agent-modes/orchestration/scheduler.mjs';
import { createPollyOperations } from '../../runtime/agent-modes/orchestration/polly.mjs';
import { GitWorkspaceManager } from '../../runtime/agent-modes/workspaces/manager.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';

if (process.env.CDX_LIVE_DUAL !== '1') throw new Error('Set CDX_LIVE_DUAL=1 to invoke real models.');
const scenario = process.argv[2] ?? 'debby';
if (!['debby', 'custom', 'polly'].includes(scenario)) throw new Error('Unknown live dual scenario.');
mkdirSync(resolve('.artifacts'), { recursive: true });
const recovering = !!process.env.CDX_LIVE_RESUME_ROOT;
const root = recovering ? resolve(process.env.CDX_LIVE_RESUME_ROOT) : mkdtempSync(resolve(`.artifacts/live-dual-${scenario}-`));
if (recovering && scenario !== 'polly') throw new Error('Saved-fixture recovery is currently supported for Polly.');
const cwd = join(root, 'source');
const marker = 'DUAL_NATIVE_MARKER_48372';
if (!recovering) {
  mkdirSync(cwd); writeFileSync(join(cwd, 'marker.txt'), `${marker}\n`);
  if (scenario === 'polly') execFileSync('git', ['init', '-q', cwd]);
}
const store = new ConversationStore(join(root, 'conversations'));
const templates = new TemplateStore(join(root, 'templates'));
const command = process.env.CDX_REAL_CODEX ?? '/Applications/chatgpt-dev.app/Contents/Resources/codex';
const models = { codex: process.env.CDX_LIVE_CODEX_MODEL ?? 'gpt-6-luna', claude: process.env.CDX_LIVE_CLAUDE_MODEL ?? 'claude-opus-4-6' };
const adapter = new ClaudeAdapter({ executablePath: process.env.CDX_CLAUDE_PATH });
const runner = new RoleRunner({ claudeAdapter: adapter, codexCommand: command });
const workspaces = new GitWorkspaceManager(join(root, 'workspaces'));
let router, chatId, timer;
const evidence = { scenario, recovering, root, cwd, models, startedAt: new Date().toISOString(), approvals: [] };
const inside = path => typeof path === 'string' && !isAbsolute(relative(root, path)) && !relative(root, path).startsWith('..');
const native = new NativeClient({ command, args: ['app-server'], env: process.env,
  onNotification: message => router?.nativeNotification(message),
  onRequest: message => native.respond({ id: message.id, result: { decision: 'decline' } }),
});
router = new EngineRouter({ store, templates, native, adapter,
  emit: message => {
    if (!message.id || !message.method) return;
    // Fixture-owned ordinary command approvals may proceed. Unrecognized requests
    // retain native denial; this driver never approves persistent permissions.
    const pending = router.workflow.approvals.get(message.id)?.request;
    const fileTool = pending?.engine === 'claude' && ['Write', 'Edit', 'MultiEdit'].includes(pending.name) && inside(pending.input?.file_path);
    const allow = fileTool || message.method === 'item/commandExecution/requestApproval' && inside(message.params?.cwd);
    evidence.approvals.push({ method: message.method, accepted: allow });
    router.respond({ id: message.id, result: fileTool ? { answers: { permission: { answers: ['Allow once'] } } } : allow ? { decision: 'accept' } : { decision: 'decline' } });
  },
  workflowFactory: callbacks => new WorkflowScheduler({ ...callbacks, runner, workspaces, operationsFactory: createPollyOperations }),
});
const stop = () => { evidence.stopped = true; void router.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await router.request('initialize', { clientInfo: { name: 'dual_workflow_live_validation', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  native.notify({ method: 'initialized', params: {} });
  let template = { id: scenario === 'polly' ? 'polly' : 'debby', revision: 1, parameters: scenario === 'debby' ? { rounds: 1 } : {} };
  if (scenario === 'custom') {
    const custom = templates.read('debby'); custom.id = 'custom-codex-summary'; custom.name = 'Codex synthesis validation'; custom.roles.moderator.engine = 'codex';
    const saved = templates.save(custom); template = { id: saved.id, revision: saved.revision, parameters: { rounds: 0 } };
  }
  const input = scenario === 'polly'
    ? 'Validate this collaboration workflow with exactly two independent implementation tasks. Assign Codex to create codex-result.txt containing exactly CODEX_POLLY_OK followed by a newline. Assign Claude to create claude-result.txt containing exactly CLAUDE_POLLY_OK followed by a newline. Each task owns only its named file, has no dependencies, and should check its own exact content. Preserve marker.txt. Opposite-engine review should check the immutable results. After integration, run actual checks for both exact contents and the preserved marker. No packages, installs, remote actions, or extra files are needed. Keep reports concise.'
    : 'Read marker.txt in this workspace. Give the exact marker and one short sentence explaining how you read it. This is a read-only validation. Keep answers and critique concise.';
  let turn;
  if (recovering) {
    const chat = store.list().find(chat => chat.turns.at(-1)?.workflow);
    assert.ok(chat, 'Saved fixture has no workflow'); chatId = chat.id;
    for (const threadId of [...router.workflow.internal, chatId]) await native.request('thread/unarchive', { threadId });
    const row = chat.turns.at(-1);
    const failed = row.runs.findLast(run => ['failed', 'interrupted', 'cancelled'].includes(run.status));
    await router.request('engine/runs/retry', { threadId: chatId, turnId: row.turn.id, ...(failed ? { runId: failed.id } : {}) });
    turn = row.turn; evidence.retriedRunId = failed?.id;
  } else {
    const created = await router.request('thread/start', { cwd, engineMode: 'both', model: models.codex, engineModels: models, template });
    chatId = created.thread.id;
    ({ turn } = await router.request('turn/start', { threadId: chatId, model: models.codex, approvalPolicy: 'on-request', sandbox: 'workspace-write', input: [{ type: 'text', text: input }] }));
  }
  console.log(JSON.stringify({ stage: 'started', scenario, threadId: chatId, turnId: turn.id }));
  timer = setTimeout(() => { evidence.timedOut = true; void router.close(); }, 600000);
  const active = router.workflow.active.get(store.get(chatId).activeTurn.id);
  let lastStatus = '';
  const progress = setInterval(() => {
    const row = store.get(chatId)?.turns.at(-1);
    const states = row?.runs.map(run => ({ engine: run.engine, step: run.stepId, status: run.status }));
    const status = JSON.stringify(states);
    if (status !== lastStatus) { lastStatus = status; console.log(JSON.stringify({ stage: 'roles', states })); }
    if (row?.workflow.status === 'blocked') { evidence.blocked = true; void router.close(); }
  }, 1000);
  try { await active.done; } finally { clearInterval(progress); }
  const row = store.get(chatId).turns.at(-1);
  Object.assign(evidence, { status: row.turn.status, error: row.turn.error,
    runs: row.runs.map(run => ({ id: run.id, roleId: run.roleId, engine: run.engine, stepId: run.stepId, status: run.status, requestedModel: run.requestedModel, actualModel: run.actualModel, nativeSessionId: run.nativeSessionId, text: run.text, error: run.error })),
    outputs: row.workflow.state?.outputs, visibleUserMessages: row.turn.items.filter(item => item.type === 'userMessage').length,
  });
  assert.equal(row.turn.status, 'completed', row.turn.error?.message);
  assert.equal(evidence.visibleUserMessages, 1);
  const latest = new Map(row.runs.map(run => [JSON.stringify([run.roleId, run.stepId, run.round]), run]));
  assert.ok([...latest.values()].every(run => run.status === 'completed' && run.requestedModel === models[run.engine]));
  for (const run of latest.values()) assert.equal(run.actualModel, models[run.engine], `Actual model for ${run.stepId}`);
  assert.equal(readFileSync(join(cwd, 'marker.txt'), 'utf8'), `${marker}\n`);
  if (scenario === 'polly') {
    assert.equal(readFileSync(join(cwd, 'codex-result.txt'), 'utf8'), 'CODEX_POLLY_OK\n');
    assert.equal(readFileSync(join(cwd, 'claude-result.txt'), 'utf8'), 'CLAUDE_POLLY_OK\n');
    assert.equal(evidence.outputs.sources.review.integration.application.status, 'applied');
  } else {
    assert.equal(row.runs.length, scenario === 'debby' ? 5 : 3);
    assert.ok(row.runs.every(run => run.text.includes(marker)));
    assert.equal(row.runs.at(-1).engine, scenario === 'custom' ? 'codex' : 'claude');
  }
  console.log(JSON.stringify({ stage: 'verified', scenario, roles: row.runs.length }));
} catch (error) {
  evidence.failure = error.message; process.exitCode = 1;
  console.log(JSON.stringify({ stage: 'failed', message: error.message }));
} finally {
  clearTimeout(timer); await router.close();
  for (const threadId of [...router.workflow.internal, ...(chatId ? [chatId] : [])]) {
    try { await native.request('thread/archive', { threadId }); } catch { /* Preserve evidence even if archival fails. */ }
  }
  await native.close(); evidence.finishedAt = new Date().toISOString();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  const path = join(root, recovering ? `recovery-evidence-${Date.now()}.json` : 'evidence.json'); writeFileSync(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidence: path }));
}
