const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && value.length > 0;
const indexValue = (value) => Number.isSafeInteger(value) && value >= 0;
const modelContent = (content) => record(content) && (
  (content.type === 'text' && identifier(content.text)) ||
  (content.type === 'tool_use' && identifier(content.id) && identifier(content.name) && record(content.input)) ||
  (content.type === 'thinking' && identifier(content.thinking) && identifier(content.signature))
);

/** Converts SDK envelopes into public text/tool events; never exposes thinking blocks. */
export class ClaudeEventNormalizer {
  constructor({ onEvent }) {
    this.onEvent = onEvent;
    this.messages = new Map();
    this.active = new Map();
    this.tools = new Map();
    this.seen = new Set();
    this.nativeSessionId = undefined;
    this.error = undefined;
    this.inputAcknowledged = false;
  }

  consume(envelope) {
    if (!record(envelope)) return;
    if (identifier(envelope.uuid)) {
      if (this.seen.has(envelope.uuid)) return;
      this.seen.add(envelope.uuid);
    }
    const scope = identifier(envelope.parent_tool_use_id) ? envelope.parent_tool_use_id : null;
    if (scope === null && identifier(envelope.session_id) && envelope.session_id !== this.nativeSessionId) {
      this.nativeSessionId = envelope.session_id;
      this.onEvent({ type: 'session', sessionId: this.nativeSessionId });
    }
    if (envelope.type === 'stream_event') this.consumePartial(envelope.event, scope);
    else if (envelope.type === 'assistant') {
      if (identifier(envelope.error)) this.error = `Claude assistant error: ${envelope.error}`;
      this.consumeAssistant(envelope.message, scope, envelope.error == null);
    } else if (envelope.type === 'user') this.consumeToolResults(envelope.message);
    else if (envelope.type === 'system' && envelope.subtype === 'status') {
      if (envelope.status === null || typeof envelope.status === 'string') this.onEvent({ type: 'status', status: envelope.status });
    } else if (envelope.type === 'result') {
      this.finish();
      const successful = envelope.subtype === 'success' && envelope.is_error === false;
      if (successful) this.acknowledgeInput(scope);
      const result = { nativeSessionId: this.nativeSessionId, status: successful ? 'completed' : 'failed' };
      if (!successful) {
        const errors = Array.isArray(envelope.errors) ? envelope.errors.filter(identifier) : [];
        result.error = errors.join('\n') || this.error || (identifier(envelope.result) ? envelope.result : `Claude execution failed (${envelope.subtype || 'unknown result'}).`);
      }
      if (record(envelope.usage)) result.usage = { ...envelope.usage };
      if (record(envelope.modelUsage) || typeof envelope.total_cost_usd === 'number') {
        result.usage ??= {};
        if (record(envelope.modelUsage)) result.usage.modelUsage = envelope.modelUsage;
        if (typeof envelope.total_cost_usd === 'number') result.usage.total_cost_usd = envelope.total_cost_usd;
      }
      return result;
    }
  }

  acknowledgeInput(scope) {
    if (scope !== null || this.inputAcknowledged) return;
    this.inputAcknowledged = true;
    this.onEvent({ type: 'input-acknowledged' });
  }

  message(id, scope) {
    if (!identifier(id)) return;
    const key = JSON.stringify([scope, id]);
    if (!this.messages.has(key)) this.messages.set(key, { id, scope, blocks: new Map(), nextIndex: 0 });
    return this.messages.get(key);
  }

  block(message, index, content, streamed = false) {
    if (!record(content) || !indexValue(index)) return;
    if (message.blocks.has(index)) return message.blocks.get(index);
    const block = { type: content.type, streamed, finalized: false, completed: false };
    if (content.type === 'text' && typeof content.text === 'string') {
      Object.assign(block, { id: `claude-message:${message.scope || 'main'}:${message.id}:${index}`, text: '' });
      message.blocks.set(index, block);
      this.onEvent({ type: 'message-start', id: block.id });
      this.appendText(block, content.text);
    } else if (content.type === 'tool_use' && identifier(content.id) && identifier(content.name)) {
      Object.assign(block, { id: content.id, name: content.name, input: record(content.input) ? content.input : {}, json: '' });
      message.blocks.set(index, block);
    } else return;
    message.nextIndex = Math.max(message.nextIndex, index + 1);
    return block;
  }

  appendText(block, delta) {
    if (block.completed || !delta) return;
    block.text += delta;
    this.onEvent({ type: 'text-delta', id: block.id, delta });
  }

  completeText(block) {
    if (block.type !== 'text' || block.completed) return;
    block.completed = true;
    this.onEvent({ type: 'message-completed', id: block.id, text: block.text });
  }

  startTool(block) {
    if (this.tools.has(block.id)) return;
    if (block.json) {
      try {
        const input = JSON.parse(block.json);
        if (!record(input)) return;
        block.input = input;
      } catch { return; }
    }
    const tool = { id: block.id, name: block.name, input: block.input, completed: false };
    this.tools.set(block.id, tool);
    this.onEvent({ type: 'tool-start', id: tool.id, name: tool.name, input: tool.input });
  }

  consumePartial(event, scope) {
    if (!record(event)) return;
    if (event.type === 'message_start') {
      const message = this.message(event.message?.id, scope);
      if (message) {
        this.active.set(scope, message);
        message.synthetic = event.message?.model === '<synthetic>';
        const inputTokens = event.message?.usage?.input_tokens;
        if (!message.synthetic && Number.isFinite(inputTokens) && inputTokens > 0) this.acknowledgeInput(scope);
      }
      return;
    }
    const message = this.active.get(scope);
    if (!message) return;
    if (event.type === 'content_block_start') this.block(message, event.index, event.content_block, true);
    else if (event.type === 'content_block_delta') {
      const block = message.blocks.get(event.index);
      if (!block || block.finalized || !record(event.delta)) return;
      if (block.type === 'text' && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
        if (!message.synthetic && event.delta.text) this.acknowledgeInput(scope);
        this.appendText(block, event.delta.text);
      } else if (block.type === 'tool_use' && event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        if (!message.synthetic && event.delta.partial_json) this.acknowledgeInput(scope);
        block.json += event.delta.partial_json;
      }
    } else if (event.type === 'content_block_stop') {
      const block = message.blocks.get(event.index);
      if (block?.type === 'tool_use') this.startTool(block);
    } else if (event.type === 'message_stop') {
      // The final assistant envelope may follow message_stop and can repair a
      // missing partial delta. Finalize there, or in finish() on result/abort.
      this.active.delete(scope);
    }
  }

  consumeAssistant(raw, scope, canAcknowledge) {
    if (!record(raw) || !Array.isArray(raw.content)) return;
    const message = this.message(raw.id, scope);
    if (!message) return;
    // Synthetic local/auth errors are still rendered, but they do not prove the
    // prompt reached a model and must not advance the persisted handoff cursor.
    if (canAcknowledge && raw.role === 'assistant' && identifier(raw.model) && raw.model !== '<synthetic>' && raw.content.some(modelContent)) this.acknowledgeInput(scope);
    for (const [index, content] of raw.content.entries()) {
      if (!record(content)) continue;
      // SDK 0.3 emits one envelope per completed block, sharing message.id.
      // Match the first unfinalized streaming block instead of appending its text twice.
      const snapshotBlock = raw.stop_reason != null ? message.blocks.get(index) : undefined;
      let block = snapshotBlock?.type === content.type ? snapshotBlock : undefined;
      block ??= [...message.blocks.values()].find((candidate) => candidate.streamed && !candidate.finalized && candidate.type === content.type && (content.type !== 'tool_use' || candidate.id === content.id));
      block ??= this.block(message, message.nextIndex, content);
      if (!block) continue;
      if (block.type === 'text' && typeof content.text === 'string') {
        if (content.text.startsWith(block.text)) this.appendText(block, content.text.slice(block.text.length));
        // The completed block is authoritative if a partial stream was incomplete.
        block.text = content.text;
        this.completeText(block);
      } else if (block.type === 'tool_use' && record(content.input)) {
        block.input = content.input;
        block.json = '';
        this.startTool(block);
        const tool = this.tools.get(block.id);
        if (tool) tool.input = content.input;
      }
      block.finalized = true;
    }
  }

  consumeToolResults(message) {
    if (!record(message) || !Array.isArray(message.content)) return;
    for (const content of message.content) {
      if (!record(content) || content.type !== 'tool_result') continue;
      const tool = this.tools.get(content.tool_use_id);
      if (!tool || tool.completed) continue;
      tool.completed = true;
      this.onEvent({ type: 'tool-completed', id: tool.id, name: tool.name, input: tool.input, output: content.content ?? '', isError: content.is_error === true });
    }
  }

  finish() {
    for (const message of this.messages.values()) for (const block of message.blocks.values()) this.completeText(block);
  }
}
