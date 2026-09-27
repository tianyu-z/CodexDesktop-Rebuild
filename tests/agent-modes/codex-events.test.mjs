import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentItem, presentTurn } from '../../runtime/agent-modes/codex-events.mjs';

test('mixed-engine presentation preserves the engine of each attributed child item', () => {
  const turn = { id: 'both', status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [] },
    { id: 'c', type: 'agentMessage', text: 'C', cdxEngineSource: 'codex', cdxRunId: 'c-run' },
    { id: 'a', type: 'agentMessage', text: 'A', cdxEngineSource: 'claude', cdxRunId: 'a-run' },
  ] };
  const displayed = presentTurn(turn, 'both');
  assert.equal(displayed.cdxEngineSource, 'both');
  assert.deepEqual(displayed.items.map(item => item.cdxEngineSource), ['both', 'codex', 'claude']);
  assert.equal(displayed.items[2].cdxRunId, 'a-run');
  assert.equal(presentItem({ ...turn.items[1], cdxEngineSource: 'claude' }, 'codex').cdxEngineSource, 'codex');
  assert.equal(turn.items[0].cdxEngineSource, undefined);
});
