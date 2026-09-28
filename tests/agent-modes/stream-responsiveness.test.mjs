import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';

test('tool output remains responsive with a large retained chat history', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cdx-stream-responsive-'));
  const store = new ConversationStore(directory), messages = [];
  const router = new EngineRouter({ store, native: {}, adapter: {}, emit: message => messages.push(message) });
  t.after(async () => { await router.close(); rmSync(directory, { recursive: true, force: true }); });
  store.ensureThread({ id: 'long-chat', cwd: directory, turns: [], createdAt: 1, updatedAt: 1 });
  const value = store.require('long-chat');
  // Comparable to the affected 277-turn, 29 MB remote conversation. Native
  // output deltas are forwarded; they must not traverse/copy all past turns.
  value.turns = Array.from({ length: 280 }, (_, i) => ({ seq: i + 1, engine: 'codex', turn: {
    id: 'turn-' + i, status: i === 279 ? 'inProgress' : 'completed',
    items: [{ id: 'message-' + i, type: 'agentMessage', text: String(i).padEnd(100000, 'x') }],
  } }));
  value.activeRun = { engine: 'codex', id: 'active-run', turnId: 'turn-279' };
  const started = performance.now();
  for (let i = 0; i < 100; i++) router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: {
    threadId: 'long-chat', turnId: 'turn-279', itemId: 'command', delta: String(i) + '\n',
  } });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `100 output events blocked the gateway for ${elapsed.toFixed(0)} ms`);
  assert.equal(messages.length, 100);
  assert.equal(messages.map(m => m.params.delta).join(''), Array.from({ length: 100 }, (_, i) => i + '\n').join(''));
  assert.equal(value.turns.length, 280);
  assert.equal(value.turns[0].turn.items[0].text, '0'.padEnd(100000, 'x'));
  // History edit tombstones must still suppress discarded native events.
  value.discardedNativeTurnIds = ['turn-279'];
  router.nativeNotification({ method: 'item/commandExecution/outputDelta', params: { threadId: value.id, turnId: 'turn-279', delta: 'discarded' } });
  assert.equal(messages.length, 100);
});
