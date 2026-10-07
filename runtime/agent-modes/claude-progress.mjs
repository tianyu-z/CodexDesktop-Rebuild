/** Native estimates/usage are live state, not durable conversation events. */
export function updateClaudeProgress(previous, event, now = Date.now()) {
  const startedAt = previous?.startedAt ?? now;
  if (event.type === 'token-usage') return { ...previous, inputTokens: event.inputTokens, outputTokens: event.outputTokens, startedAt, updatedAt: now };
  const { type, ...activity } = event;
  // Keep retry evidence until actual response/tool output, even when a retry's
  // delay is shorter than the UI polling interval.
  const lastRetry = activity.phase === 'retrying' ? { ...activity }
    : ['responding', 'preparingTool'].includes(activity.phase) ? undefined : previous?.lastRetry;
  return { ...activity, ...(lastRetry ? { lastRetry } : {}),
    ...(previous?.outputTokens !== undefined ? { inputTokens: previous.inputTokens, outputTokens: previous.outputTokens } : {}), startedAt, updatedAt: now };
}

/** Feed returned Claude thinking through the App's collapsible reasoning UI.
 * It never becomes assistant reply text or a workflow handoff. */
export function applyClaudeThinking(event, { turn, update, save, notify, threadId, source = {} }) {
  if (!['thinking-start', 'thinking-delta', 'thinking-completed'].includes(event.type)) return;
  const item = text => ({ id: event.id, type: 'reasoning', summary: [text], content: [] });
  if (event.type === 'thinking-start') update(item(''), false);
  else if (event.type === 'thinking-completed') update(item(event.text), true);
  else {
    let current = turn.items.find(i => i.id === event.id);
    if (!current) { update(item(''), false); current = turn.items.at(-1); }
    current.summary[0] += event.delta;
    save();
    notify('item/reasoning/summaryTextDelta', { threadId, turnId: turn.id, itemId: event.id, summaryIndex: 0, delta: event.delta, ...source });
  }
}
