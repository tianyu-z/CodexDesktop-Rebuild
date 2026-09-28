// Opt-in acceptance test. Creates and archives only its own disposable chats.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = mkdtempSync(join(root, '.artifacts/history-edit-live-'));
const workspace = join(dir, 'workspace'); mkdirSync(workspace);
const completed = new Map(), waiting = new Map(), owned = [], evidence = [];
const stderr = createWriteStream(join(dir, 'native.log'));
let client;
function connect() {
  return new NativeClient({ command: process.execPath, args: [join(root, 'runtime/agent-modes/gateway.mjs'), 'app-server'],
    env: { ...process.env, CDX_REAL_CODEX: '/Applications/chatgpt-dev.app/Contents/Resources/codex', CDX_ENGINE_STORE: join(dir, 'store') }, stderr,
    onNotification(message) {
      if (message.method !== 'turn/completed') return;
      const turn = message.params.turn; completed.set(turn.id, turn); waiting.get(turn.id)?.(turn);
    },
    onRequest(message) { client.respond({ id: message.id, result: message.method.includes('requestUserInput') ? { answers: { permission: { answers: ['Deny'] } } } : { decision: 'decline' } }); },
  });
}
async function initialize() {
  await client.request('initialize', { clientInfo: { name: 'claude-history-edit-acceptance', version: '1' }, capabilities: { experimentalApi: true } });
  client.notify({ method: 'initialized' });
}
async function send(threadId, text) {
  const { turn } = await client.request('turn/start', { threadId, input: [{ type: 'text', text }], effort: 'low' });
  let timer;
  const result = await Promise.race([completed.get(turn.id) ?? new Promise(resolve => waiting.set(turn.id, resolve)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Turn timed out')), 90000); })]).finally(() => { clearTimeout(timer); waiting.delete(turn.id); });
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  const answer = result.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  evidence.push({ threadId, turnId: turn.id, text, answer });
  console.log(JSON.stringify({ threadId, turnId: turn.id, answer }));
  return { turnId: turn.id, answer };
}
async function create(mode) {
  const { thread } = await client.request('thread/start', { cwd: workspace, engineMode: mode, engineModel: 'haiku' }); owned.push(thread.id); return thread.id;
}
async function fork(threadId, extra = {}) {
  const result = await client.request('thread/fork', { threadId, excludeTurns: true, ...extra }); owned.push(result.thread.id); return result.thread.id;
}
async function select(threadId, mode) { await client.request('engine/mode/set', { threadId, engineMode: mode, ...(mode === 'claude' ? { engineModel: 'haiku' } : {}) }); }
try {
  client = connect(); await initialize();
  const claude = await create('claude');
  await send(claude, 'Remember base code BASE-RIVER-713. Reply with the code only. No tools.');
  await send(claude, 'Remember secondary code OLD-ORANGE-824. Reply with the code only. No tools.');
  const snapshot = await fork(claude);
  await client.request('thread/rollback', { threadId: claude, numTurns: 1 });
  const edited = await send(claude, 'Set the secondary code to NEW-TEAL-935. List the base and secondary codes. No tools.');
  assert.match(edited.answer, /BASE-RIVER-713/); assert.match(edited.answer, /NEW-TEAL-935/); assert.doesNotMatch(edited.answer, /OLD-ORANGE-824/);
  const old = await send(snapshot, 'What base and secondary codes did I give you? List them only. No tools.');
  assert.match(old.answer, /BASE-RIVER-713/); assert.match(old.answer, /OLD-ORANGE-824/); assert.doesNotMatch(old.answer, /NEW-TEAL-935/);
  const read = await client.request('thread/read', { threadId: claude, includeTurns: true });
  await client.request('thread/rollback', { threadId: claude, numTurns: read.thread.turns.length });
  const first = await send(claude, 'What codes did I give you earlier in this conversation? Reply NONE if no earlier messages exist. No tools.');
  assert.match(first.answer, /NONE/); assert.doesNotMatch(first.answer, /BASE-RIVER|OLD-ORANGE|NEW-TEAL/);
  console.log('Claude snapshot, edited continuation and first-message reset: PASS');

  const mixed = await create('codex');
  await send(mixed, 'Remember base code COD-BASE-146. Reply with the code only. No tools.');
  await select(mixed, 'claude');
  await send(mixed, 'Remember secondary code CLAUDE-KEEP-257. Reply with both codes. No tools.');
  await select(mixed, 'codex');
  const discard = await send(mixed, 'Remember extra code REMOVED-NATIVE-368. Reply with the code only. No tools.');
  await select(mixed, 'claude');
  await send(mixed, 'Remember another code REMOVED-CLAUDE-479. Reply with the code only. No tools.');
  const mixedSnapshot = await fork(mixed);
  await client.request('thread/revert', { threadId: mixed, beforeTurnId: discard.turnId });
  await select(mixed, 'codex');
  const continued = await send(mixed, 'List all conversation codes I have given you so far. No tools.');
  assert.match(continued.answer, /COD-BASE-146/); assert.match(continued.answer, /CLAUDE-KEEP-257/); assert.doesNotMatch(continued.answer, /REMOVED-NATIVE|REMOVED-CLAUDE/);
  console.log('Mixed-engine native rollback and retained Claude handoff: PASS');
  const before = await client.request('thread/read', { threadId: mixedSnapshot, includeTurns: true });
  assert.equal(before.thread.turns.length, 4);
  await client.close(); client = connect(); await initialize();
  const resumed = await client.request('thread/resume', { threadId: mixedSnapshot, excludeTurns: false });
  assert.deepEqual(resumed.thread.turns.map(turn => turn.id), before.thread.turns.map(turn => turn.id));
  assert.equal(resumed.engineState.engineMode, 'claude');
  console.log('Snapshot history after gateway restart: PASS');
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ passed: true, owned, evidence }, null, 2));
} catch (error) {
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ passed: false, error: error.stack, owned, evidence }, null, 2));
  throw error;
} finally {
  if (client) { for (const threadId of owned) await client.request('thread/archive', { threadId }).catch(() => {}); await client.close(); }
  stderr.end(); console.log(`Evidence: ${dir}`);
}
