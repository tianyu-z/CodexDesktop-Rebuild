// Opt-in native Claude lifecycle test; all chats/workspaces are disposable.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../runtime/agent-modes/claude-adapter.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';

if (process.env.CDX_LIVE_CLAUDE_GOAL !== '1') throw Error('Set CDX_LIVE_CLAUDE_GOAL=1 to invoke real Claude Code.');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = mkdtempSync(join(root, '.artifacts/claude-native-goal-live-'));
const cwd = join(dir, 'workspace'); mkdirSync(cwd);
mkdirSync(join(cwd, '.claude'));
writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions: { ask: ['Bash'] } }));
const store = new ConversationStore(join(dir, 'store')), events = [], calls = [], approvals = [], turns = new Map();
const thread = { id: 'native-goal-fixture', cwd, turns: [], status: { type: 'idle' } };
const adapter = new ClaudeAdapter();
const router = new EngineRouter({ store, adapter, native: { async request(method, params) {
  calls.push({ method, params });
  if (['thread/start', 'thread/read', 'thread/resume'].includes(method)) return { thread: structuredClone(thread) };
  assert.ok(!['turn/start', 'turn/steer'].includes(method) && !method.startsWith('thread/goal/'), 'Claude goals must never invoke Codex inference/goals');
  return {};
} }, emit(event) {
  events.push(event);
  if (event.id != null && (event.method?.includes('Approval') || event.method === 'item/tool/requestUserInput')) approvals.push(event);
  if (event.method === 'turn/completed') turns.set(event.params.turn.id, event.params.turn);
} });
const waitFor = async (read, label) => {
  const end = Date.now() + 90000;
  while (Date.now() < end) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timed out: ${label}`);
};
const send = async text => (await router.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] })).turn;
const complete = async turn => {
  const final = await waitFor(() => turns.get(turn.id), 'native turn completion');
  assert.equal(final.status, 'completed', JSON.stringify(final.error));
  return final.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
};
const session = () => store.get(thread.id).bindings.claude.sessionId;
let report;
try {
  await router.request('thread/start', { engineMode: 'claude', engineModel: process.env.CDX_CLAUDE_GOAL_MODEL ?? 'claude-opus-4-6', cwd, claudePermissionMode: 'default' });
  const achieved = await complete(await send('/goal The final assistant reply contains NATIVE-GOAL-583. Reply with that codeword immediately, without tools.'));
  assert.match(achieved, /NATIVE-GOAL-583/);
  const nativeSession = session(); assert.ok(nativeSession);
  assert.match(await complete(await send('/goal')), /No goal set/i);
  assert.equal(session(), nativeSession);
  console.log('Native goal achievement and automatic clearing: PASS');

  let turn = await send('/goal Remember codeword GOAL-RESUME-684. Request Bash permission for exactly sleep 91. This goal is met only after that command succeeds. Do not use other tools.');
  await waitFor(() => approvals.shift(), 'goal tool permission');
  await router.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, clientUserMessageId: 'goal-steering', input: [{ type: 'text', text: 'Remember second codeword GOAL-STEER-795. Do not retry a denied command.' }] });
  const start = Date.now(); await router.request('turn/interrupt', { threadId: thread.id, turnId: turn.id });
  assert.equal((await waitFor(() => turns.get(turn.id), 'goal Stop')).status, 'interrupted');
  const stopMs = Date.now() - start;
  assert.equal(store.get(thread.id).activeRun, null);
  const restored = await complete(await send('/goal'));
  assert.match(restored, /Goal active:/i); assert.match(restored, /GOAL-RESUME-684/);
  assert.equal(session(), nativeSession);
  console.log('Goal Stop and native transcript restoration: PASS');
  assert.match(await complete(await send('/goal clear')), /Goal cleared:/i);
  assert.match(await complete(await send('/goal')), /No goal set/i);
  assert.match(await complete(await send('Continue without tools. Reply GOAL-CONTINUE-806 only.')), /GOAL-CONTINUE-806/);
  console.log('Goal clear and ordinary continuation in the same native session: PASS');

  turn = await send('/goal Request Bash permission for exactly sleep 92. This goal is met only after that command succeeds. Do not use other tools.');
  const approval = await waitFor(() => approvals.shift(), 'second goal tool permission');
  await router.request('turn/steer', { threadId: thread.id, expectedTurnId: turn.id, clientUserMessageId: 'live-goal-clear', input: [{ type: 'text', text: '/goal clear' }] });
  router.respond({ id: approval.id, result: { answers: { permission: { answers: ['Deny'] } } } });
  await complete(turn);
  assert.match(await complete(await send('/goal')), /No goal set/i);
  assert.equal(store.get(thread.id).turns.find(row => row.turn.id === turn.id).turn.items.filter(item => item.clientId === 'live-goal-clear').length, 1);
  console.log('Live native goal clear preserves the owned turn: PASS');
  report = { passed: true, nativeSession, stopMs, turnIds: [...turns.keys()], codexInferenceCalls: 0 };
} finally {
  await router.close(); await adapter.close();
  writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2));
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report ?? { passed: false, nativeSession: session() }, null, 2));
  console.log(`Evidence: ${dir}`);
}
