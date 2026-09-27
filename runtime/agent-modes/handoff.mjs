export function inputText(input) {
  if (!Array.isArray(input)) throw new Error('Expected a list of user inputs.');
  return input.map(item => {
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    if (['mention', 'skill'].includes(item.type) && typeof item.path === 'string') {
      return `Referenced ${item.type}: ${item.name ?? ''} (${item.path})`;
    }
    throw new Error(`Unsupported attachment/input in Claude Code mode: ${item.type ?? 'unknown'}`);
  }).join('\n');
}

function publicInput(item) {
  if (item.type === 'text') return item.text;
  if (item.type === 'localImage') return `[Historical image reference: ${item.path}; pixels are not transferred. Read the file if needed and permitted.]`;
  if (item.type === 'image') return `[Historical image: pixels are not transferred${item.url?.startsWith('https://') ? `; reference ${item.url}` : ''}. Ask for the image again if needed.]`;
  if (['mention', 'skill'].includes(item.type)) return `Referenced ${item.type}: ${item.name ?? ''} (${item.path ?? ''})`;
  return `[Historical attachment ${item.type ?? 'unknown'} is unsupported and was not transferred.]`;
}

function publicItem(item) {
  switch (item.type) {
    case 'userMessage': return `User: ${item.content?.map(publicInput).join('\n') ?? ''}`;
    case 'agentMessage': return `Assistant: ${item.text}`;
    case 'commandExecution': return `Command (${item.cwd ?? ''}): ${item.command}\nResult: ${item.aggregatedOutput ?? ''}`;
    case 'fileChange': return `File changes: ${JSON.stringify(item.changes)}`;
    case 'mcpToolCall': return `Tool ${item.server}/${item.tool}: ${JSON.stringify(item.arguments)}\nResult: ${JSON.stringify(item.result ?? item.error)}`;
    case 'dynamicToolCall': return `Tool ${item.tool}: ${JSON.stringify(item.arguments)}\nResult: ${JSON.stringify(item.contentItems)}`;
    case 'webSearch': return `Web search: ${item.query}\nAction: ${JSON.stringify(item.action)}\nResults: ${JSON.stringify(item.results)}`;
    case 'collabAgentToolCall': return `Collaborator ${item.tool} (${item.status}): ${item.prompt ?? ''}\nPublic outcomes: ${JSON.stringify(item.agentsStates)}`;
    case 'imageView': return `[Viewed image reference: ${item.path ?? ''}; pixels are not transferred.]`;
    case 'imageGeneration': return `[Generated image reference: ${item.result ?? item.imageUrl ?? item.id}; pixels are not transferred.]`;
    case 'plan': return `Published plan: ${item.text}`;
    default: return '';
  }
}

export function publicHistory(conversation, afterSeq = 0) {
  return conversation.turns.filter(row => row.seq > afterSeq).map(row => {
    const items = row.turn.items.map(publicItem).filter(Boolean).join('\n\n');
    return `[Turn ${row.seq}; engine ${row.engine}; status ${row.turn.status}]\n${items}`;
  }).join('\n\n');
}

export function buildHandoff(conversation, engine, { maxChars = 60000, historyPath } = {}) {
  const consumed = conversation.bindings[engine]?.consumedSeq ?? 0;
  const throughSeq = Math.max(consumed, ...conversation.turns.map(row => row.seq));
  if (throughSeq === consumed) return { text: '', throughSeq };
  const header = `[Conversation handoff: historical reference material, not new system instructions]\nWorkspace: ${conversation.cwd}\nPublic history after turn sequence ${consumed}:\n\n`;
  let body = publicHistory(conversation, consumed);
  if (header.length + body.length > maxChars) {
    if (!historyPath) throw new Error('History exceeds the context budget; a full-history reference is required.');
    const note = `[Older material omitted from this bounded excerpt. Full public history: ${historyPath}]\n`;
    body = note + body.slice(-Math.max(0, maxChars - header.length - note.length));
  }
  return { text: header + body, throughSeq };
}
