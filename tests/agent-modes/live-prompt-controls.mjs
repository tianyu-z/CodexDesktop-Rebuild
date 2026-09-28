// Opt-in, disposable chats only. Exercises the actual SDK/CLI, never a provider API.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';
if (process.env.CDX_LIVE_PROMPT_CONTROLS !== '1') throw Error('Set CDX_LIVE_PROMPT_CONTROLS=1 to run the live fixture.');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = mkdtempSync(join(root, '.artifacts/prompt-controls-'));
const workspace = join(dir, 'workspace'); mkdirSync(workspace);
mkdirSync(join(workspace, '.claude')); writeFileSync(join(workspace, '.claude/settings.json'), JSON.stringify({ permissions: { ask: ['Bash'] } }));
const events = [], approvals = [], turns = new Map(); let client, threadId;
const waitFor = async (read, name) => {
  const end = Date.now() + 90000;
  while (Date.now() < end) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timed out: ${name}`);
};
const send = async text => (await client.request('turn/start', { threadId, input: [{ type: 'text', text }] })).turn;
const finish = turn => waitFor(() => turns.get(turn.id), 'turn completion');
try {
  client = new NativeClient({ command: process.execPath, args: [join(root, 'runtime/agent-modes/gateway.mjs'), 'app-server'],
    env: { ...process.env, CDX_REAL_CODEX: '/Applications/chatgpt-dev.app/Contents/Resources/codex', CDX_ENGINE_STORE: join(dir, 'store') },
    onNotification(message) { events.push(message); if (message.method === 'turn/completed') turns.set(message.params.turn.id, message.params.turn); },
    onRequest(message) { approvals.push(message); },
  });
  await client.request('initialize', { clientInfo: { name: 'prompt-controls-fixture', version: '1' }, capabilities: { experimentalApi: true } }); client.notify({ method: 'initialized' });
  const started = await client.request('thread/start', { cwd: workspace, engineMode: 'claude', engineModel: 'claude-opus-4-6', claudePermissionMode: 'default' }); threadId = started.thread.id;
  let turn = await send('This is a disposable lifecycle test. Remember codeword MAPLE-481. Request Bash permission to run exactly sleep 90. Do not use other tools or touch any files. After approval or denial, give a short reply.');
  let permission = await waitFor(() => approvals.shift(), 'Claude permission');
  await client.request('turn/steer', { threadId, expectedTurnId: turn.id, clientUserMessageId: 'live-steer', input: [{ type: 'text', text: 'New instruction: do not retry the command after denial. Reply with STEERING-926 and remember it for our next turn.' }] });
  client.respond({ id: permission.id, result: { decision: 'decline' } });
  const steered = await finish(turn); assert.equal(steered.status, 'completed', JSON.stringify(steered.error));
  assert.match(steered.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n'), /STEERING-926/);
  assert.equal(steered.items.filter(i => i.clientId === 'live-steer').length, 1); console.log('Claude live steering: PASS');
  turn = await send('The previous no-retry instruction applied only to that completed test. This NEW and separately authorized stop test requires a new Bash permission request for exactly sleep 91. Do not reuse or retry the previous command; do not use any other tools.');
  permission = await waitFor(() => approvals.shift(), 'second permission');
  await client.request('turn/interrupt', { threadId, turnId: turn.id });
  assert.equal((await finish(turn)).status, 'interrupted'); console.log('Claude stop during pending permission: PASS');
  const stopped = await client.request('engine/mode/read', { threadId });
  turn = await send('Continue our conversation without tools. What were the two codewords from before the stop? Reply with those two only.');
  const resumed = await finish(turn); assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error));
  const text = resumed.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n'); assert.match(text, /MAPLE-481/); assert.match(text, /STEERING-926/);
  console.log('Claude continue after stop preserves context: PASS');
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ passed: true, threadId, stopped, turnIds: [...turns.keys()] }, null, 2));
} finally {
  if (client) { if (threadId) try { await client.request('thread/archive', { threadId }); } catch {} await client.close(); }
  writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2)); console.log(`Evidence: ${dir}`);
}
