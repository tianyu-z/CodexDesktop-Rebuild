import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeEventNormalizer } from '../../runtime/agent-modes/claude-events.mjs';

const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let sequence = 0;
const stream = (event, parent = null) => ({ type: 'stream_event', uuid: `stream-${++sequence}`, session_id: session, parent_tool_use_id: parent, event });
const assistant = (id, content, extra = {}) => ({
  type: 'assistant', uuid: `assistant-${++sequence}`, session_id: session, parent_tool_use_id: null,
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } }, ...extra,
});
const text = (text) => ({ type: 'text', text });
function fixture() {
  const events = [];
  return { events, normalizer: new ClaudeEventNormalizer({ onEvent: (event) => events.push(event) }) };
}
function startText(normalizer, id, index = 0, parent = null) {
  normalizer.consume(stream({ type: 'message_start', message: { id, content: [] } }, parent));
  normalizer.consume(stream({ type: 'content_block_start', index, content_block: text('') }, parent));
}

test('role results retain public text, structured output, and actual main model evidence', () => {
  const { normalizer } = fixture();
  normalizer.consume({ type: 'system', subtype: 'init', session_id: session, model: 'claude-native-resolved' });
  normalizer.consume(assistant('main', [text('Report'), { type: 'thinking', thinking: 'secret', signature: 'opaque' }]));
  normalizer.consume(assistant('child', [text('Child')], { parent_tool_use_id: 'child-tool' }));
  const result = normalizer.consume({ type: 'result', subtype: 'success', is_error: false, structured_output: { verdict: 'pass' } });
  assert.equal(result.text, 'Report');
  assert.equal(result.actualModel, 'claude-sonnet-4-6');
  assert.deepEqual(result.structuredOutput, { verdict: 'pass' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('terminal text can arrive without assistant blocks and unknown actual model stays absent', () => {
  const { normalizer } = fixture();
  const result = normalizer.consume({ type: 'result', subtype: 'success', is_error: false, result: 'Final only' });
  assert.equal(result.text, 'Final only');
  assert.equal(result.actualModel, undefined);
});

test('a side result neither acknowledges main input nor hides its result-only reply', () => {
  const { events, normalizer } = fixture();
  normalizer.consume({ type: 'result', uuid: 'goal-side', subtype: 'success', is_error: false, local_command: 'goal', result: 'Goal cleared' }, { sideResult: true });
  assert.equal(normalizer.inputAcknowledged, false);
  assert.equal(normalizer.text, '');
  normalizer.consume({ type: 'result', uuid: 'main-result', subtype: 'success', is_error: false, result: 'Main answer' });
  assert.deepEqual(events.filter(event => event.type === 'message-completed').map(event => event.text), ['Goal cleared', 'Main answer']);
  assert.equal(events.filter(event => event.type === 'input-acknowledged').length, 1);
});

for (const outputType of ['synthetic-assistant', 'local-command-output']) {
  test(`a side result does not repeat its ${outputType} receipt`, () => {
    const { events, normalizer } = fixture();
    for (let i = 0; i < 2; i++) {
      const content = 'Goal active: test';
      if (outputType === 'synthetic-assistant') {
        const local = assistant(`goal-${i}`, [text(content)]);
        local.message.model = '<synthetic>';
        normalizer.consume(local);
      } else normalizer.consume({ type: 'system', subtype: 'local_command_output', uuid: `goal-${i}`, content });
      normalizer.consume({ type: 'result', uuid: `side-${i}`, subtype: 'success', is_error: false, local_command: 'goal', result: content }, { sideResult: true });
    }
    assert.equal(normalizer.inputAcknowledged, false);
    assert.deepEqual(events.filter(event => event.type === 'message-completed').map(event => event.text), ['Goal active: test', 'Goal active: test']);
  });
  for (const order of ['side-first', 'main-first']) {
    test(`${outputType} with ${order} results preserves a result-only main reply`, () => {
      const { events, normalizer } = fixture();
      const content = 'Goal active: test';
      if (outputType === 'synthetic-assistant') {
        const local = assistant('goal-receipt', [text(content)]);
        local.message.model = '<synthetic>';
        normalizer.consume(local);
      } else normalizer.consume({ type: 'system', subtype: 'local_command_output', uuid: 'goal-receipt', content });
      const side = () => normalizer.consume({ type: 'result', uuid: 'goal-side', subtype: 'success', is_error: false, local_command: 'goal', result: content }, { sideResult: true });
      if (order === 'side-first') side();
      normalizer.consume({ type: 'result', uuid: 'main-result', subtype: 'success', is_error: false, result: 'Main answer' });
      if (order === 'main-first') side();
      normalizer.consume({ type: 'result', uuid: 'steered-result', subtype: 'success', is_error: false, result: 'Follow-up answer' });
      assert.deepEqual(events.filter(event => event.type === 'message-completed').map(event => event.text), [content, 'Main answer', 'Follow-up answer']);
    });
  }
}

test('resumed main session still emits its native identity once for role ownership', () => {
  const { normalizer, events } = fixture();
  normalizer.nativeSessionId = session;
  normalizer.consume({ type: 'system', subtype: 'init', session_id: session });
  normalizer.consume({ type: 'result', subtype: 'success', is_error: false, session_id: session });
  assert.deepEqual(events.filter(e => e.type === 'session'), [{ type: 'session', sessionId: session }]);
});

test('acknowledges main model input once at the first real text delta', () => {
  const { events, normalizer } = fixture();
  normalizer.consume({ type: 'system', subtype: 'init', session_id: session });
  startText(normalizer, 'received');
  assert.equal(events.some((event) => event.type === 'input-acknowledged'), false);
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }));
  normalizer.consume(assistant('received', [text('Hello')]));
  normalizer.consume({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(events.filter((event) => event.type === 'input-acknowledged'), [{ type: 'input-acknowledged' }]);
  assert.ok(events.findIndex((event) => event.type === 'input-acknowledged') < events.findIndex((event) => event.type === 'text-delta'));
});

test('acknowledges model tool input deltas before tool execution', () => {
  const { events, normalizer } = fixture();
  normalizer.consume(stream({ type: 'message_start', message: { id: 'tool-input', usage: { input_tokens: 0 } } }));
  normalizer.consume(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-ack', name: 'Read', input: {} } }));
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }));
  assert.deepEqual(events.filter((event) => event.type === 'input-acknowledged'), [{ type: 'input-acknowledged' }]);
  assert.equal(events.some((event) => event.type === 'tool-start'), false);
});

test('positive main message input usage acknowledges receipt without exposing reasoning', () => {
  const { events, normalizer } = fixture();
  for (const input_tokens of [0, -1, '10', NaN]) normalizer.consume(stream({ type: 'message_start', message: { id: 'unreceived', usage: { input_tokens } } }));
  assert.equal(events.some((event) => event.type === 'input-acknowledged'), false);
  normalizer.consume(stream({ type: 'message_start', message: { id: 'received', usage: { input_tokens: 10 } } }));
  assert.deepEqual(events.filter((event) => event.type === 'input-acknowledged'), [{ type: 'input-acknowledged' }]);
  assert.equal(events.some((event) => event.type === 'text-delta'), false);
});

test('valid non-error main assistant blocks acknowledge receipt, including hidden thinking', () => {
  for (const block of [text('Hello'), { type: 'tool_use', id: 'tool-received', name: 'Read', input: { file_path: '/test' } }, { type: 'thinking', thinking: 'Private reasoning', signature: 'opaque-signature' }]) {
    const { events, normalizer } = fixture();
    normalizer.consume(assistant('received', [block]));
    assert.deepEqual(events.filter((event) => event.type === 'input-acknowledged'), [{ type: 'input-acknowledged' }]);
    if (block.type === 'thinking') assert.equal(events.some((event) => event.type === 'text-delta'), false);
  }
});

test('local authentication/API errors never acknowledge main input', () => {
  for (const error of ['authentication_failed', 'billing_error', 'rate_limit', 'server_error']) {
    const { events, normalizer } = fixture();
    const localError = assistant('local-error', [text('Not logged in')], { error });
    localError.message.model = '<synthetic>';
    localError.message.usage = { input_tokens: 0, output_tokens: 0 };
    normalizer.consume(localError);
    normalizer.consume({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', usage: { input_tokens: 0, output_tokens: 0 } });
    assert.equal(events.some((event) => event.type === 'input-acknowledged'), false);
  }
});

test('malformed or synthetic assistant content does not acknowledge model receipt', () => {
  const { events, normalizer } = fixture();
  const synthetic = assistant('synthetic', [text('Local command output')]);
  synthetic.message.model = '<synthetic>';
  synthetic.message.usage = { input_tokens: 0, output_tokens: 0 };
  normalizer.consume(synthetic);
  const missingModel = assistant('missing-model', [text('Unknown origin')]);
  delete missingModel.message.model;
  normalizer.consume(missingModel);
  normalizer.consume(assistant('malformed', [null, text(''), { type: 'text', text: 12 }, { type: 'tool_use', id: 'incomplete' }, { type: 'thinking', thinking: 'missing signature' }]));
  assert.equal(events.some((event) => event.type === 'input-acknowledged'), false);
});

test('synthetic stream output cannot acknowledge input', () => {
  const { events, normalizer } = fixture();
  normalizer.consume(stream({ type: 'message_start', message: { id: 'synthetic-stream', model: '<synthetic>', usage: { input_tokens: 0 } } }));
  normalizer.consume(stream({ type: 'content_block_start', index: 0, content_block: text('') }));
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local command output' } }));
  assert.equal(events.some((event) => event.type === 'input-acknowledged'), false);
});

test('child-agent evidence cannot acknowledge the main input', () => {
  const { events, normalizer } = fixture();
  normalizer.consume(stream({ type: 'message_start', message: { id: 'child', usage: { input_tokens: 20 } } }, 'agent-parent'));
  normalizer.consume(stream({ type: 'content_block_start', index: 0, content_block: text('') }, 'agent-parent'));
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Child output' } }, 'agent-parent'));
  normalizer.consume(assistant('child', [text('Child output')], { parent_tool_use_id: 'agent-parent' }));
  normalizer.consume({ type: 'result', subtype: 'success', is_error: false, parent_tool_use_id: 'agent-parent' });
  assert.equal(events.some((event) => event.type === 'input-acknowledged'), false);
});

test('successful main terminal result acknowledges input when no partial messages were delivered', () => {
  const { events, normalizer } = fixture();
  normalizer.consume({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(events.filter((event) => event.type === 'input-acknowledged'), [{ type: 'input-acknowledged' }]);
});

test('reconciles streamed text with final assistant blocks without duplicate text', () => {
  const { events, normalizer } = fixture();
  startText(normalizer, 'msg-1');
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }));
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }));
  normalizer.consume(stream({ type: 'content_block_stop', index: 0 }));
  const final = assistant('msg-1', [text('Hello world')]);
  normalizer.consume(final);
  normalizer.consume(final);
  normalizer.consume(stream({ type: 'message_stop' }));
  normalizer.finish();
  assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.delta).join(''), 'Hello world');
  assert.deepEqual(events.filter((event) => event.type === 'message-completed').map((event) => event.text), ['Hello world']);
  const ids = events.filter((event) => event.type.startsWith('message-') || event.type === 'text-delta').map((event) => event.id);
  assert.equal(new Set(ids).size, 1);
  assert.deepEqual(events.filter((event) => event.type === 'session'), [{ type: 'session', sessionId: session }]);
});

test('handles consecutive completed blocks sharing a message ID, including identical text', () => {
  const { events, normalizer } = fixture();
  normalizer.consume(assistant('msg-2', [text('Same')]));
  normalizer.consume(assistant('msg-2', [text('Same')]));
  normalizer.finish();
  assert.deepEqual(events.filter((event) => event.type === 'message-completed').map((event) => event.text), ['Same', 'Same']);
  assert.equal(new Set(events.filter((event) => event.type === 'message-start').map((event) => event.id)).size, 2);
});

test('uses a late final block to recover missing partial text after message_stop', () => {
  const { events, normalizer } = fixture();
  startText(normalizer, 'late-final');
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }));
  normalizer.consume(stream({ type: 'message_stop' }));
  normalizer.consume(assistant('late-final', [text('Hello world')]));
  normalizer.finish();
  assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.delta).join(''), 'Hello world');
  assert.deepEqual(events.filter((event) => event.type === 'message-completed').map((event) => event.text), ['Hello world']);
});

test('a complete final snapshot does not repeat already delivered content blocks', () => {
  const { events, normalizer } = fixture();
  startText(normalizer, 'snapshot');
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }));
  normalizer.consume(assistant('snapshot', [text('Hello')]));
  const snapshot = assistant('snapshot', [text('Hello')]);
  snapshot.message.stop_reason = 'end_turn';
  normalizer.consume(snapshot);
  normalizer.finish();
  assert.deepEqual(events.filter((event) => event.type === 'message-completed').map((event) => event.text), ['Hello']);
  assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.delta).join(''), 'Hello');
});

test('pairs tool input assembled from partial JSON with its final block and tool result', () => {
  const { events, normalizer } = fixture();
  normalizer.consume(stream({ type: 'message_start', message: { id: 'msg-tools', content: [] } }));
  normalizer.consume(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }));
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } }));
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"pwd"}' } }));
  normalizer.consume(stream({ type: 'content_block_stop', index: 0 }));
  normalizer.consume(assistant('msg-tools', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }]));
  const result = { type: 'user', uuid: 'result-1', session_id: session, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '/workspace', is_error: false }] } };
  normalizer.consume(result);
  normalizer.consume(result);
  assert.deepEqual(events.filter((event) => event.type.startsWith('tool-')), [
    { type: 'tool-start', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool-completed', id: 'tool-1', name: 'Bash', input: { command: 'pwd' }, output: '/workspace', isError: false },
  ]);
});

test('preserves structured tool output, errors, and child message identity', () => {
  const { events, normalizer } = fixture();
  normalizer.consume(assistant('msg-tools', [{ type: 'tool_use', id: 'tool-child', name: 'Read', input: { file_path: '/no' } }]));
  const output = [{ type: 'text', text: 'ENOENT' }];
  normalizer.consume({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-child', content: output, is_error: true }] } });
  startText(normalizer, 'same-id', 0, 'parent-A');
  startText(normalizer, 'same-id', 0, 'parent-B');
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } }, 'parent-A'));
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'B' } }, 'parent-B'));
  normalizer.finish();
  assert.deepEqual(events.find((event) => event.type === 'tool-completed'), { type: 'tool-completed', id: 'tool-child', name: 'Read', input: { file_path: '/no' }, output, isError: true });
  assert.deepEqual(events.filter((event) => event.type === 'message-completed').map((event) => event.text), ['A', 'B']);
  assert.equal(new Set(events.filter((event) => event.type === 'message-completed').map((event) => event.id)).size, 2);
});

test('child-agent metadata does not replace the resumable main session', () => {
  const { events, normalizer } = fixture();
  normalizer.consume({ type: 'system', subtype: 'init', session_id: session });
  normalizer.consume(assistant('child-message', [text('Child report')], { parent_tool_use_id: 'agent-tool', session_id: 'child-session' }));
  normalizer.finish();
  assert.equal(normalizer.nativeSessionId, session);
  assert.deepEqual(events.filter((event) => event.type === 'session'), [{ type: 'session', sessionId: session }]);
});

test('ignores unknown content and malformed known events conservatively', () => {
  const { events, normalizer } = fixture();
  for (const event of [null, {}, { type: 'stream_event' }, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } }), assistant('unknown', [null, { type: 'thinking', thinking: 'private' }, { type: 'text', text: 12 }, { type: 'tool_use' }]), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'orphan' }] } }]) {
    assert.doesNotThrow(() => normalizer.consume(event));
  }
  normalizer.finish();
  assert.equal(events.some((event) => event.type === 'text-delta' || event.type.startsWith('tool-')), false);
});

test('finishes partial text on shutdown and normalizes terminal result conservatively', () => {
  const { events, normalizer } = fixture();
  startText(normalizer, 'partial');
  normalizer.consume(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } }));
  const result = normalizer.consume({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, errors: ['Unavailable'], usage: { input_tokens: 4 } });
  normalizer.finish();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Unavailable');
  assert.equal(result.nativeSessionId, session);
  assert.equal(result.usage.input_tokens, 4);
  assert.deepEqual(events.filter((event) => event.type === 'message-completed').map((event) => event.text), ['Partial']);
  assert.equal(normalizer.consume({ type: 'result', subtype: 'unexpected' }).status, 'failed');
});
