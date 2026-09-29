const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rows = value => Array.isArray(value) ? value.filter(record) : [];
const secretLabel = /(?:api.?key|auth|password|secret|credential|(?:access|refresh|bearer)[_-]?token)|^(?:env|headers|token)$/i;
const count = value => Number.isFinite(value) ? value.toLocaleString('en-US') : 'unknown';
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '';
const list = (items, empty) => items.length ? items.map(item => `- ${item}`).join('\n') : empty;

export function safeClaudeControlText(value) {
  return String(value)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b([\w-]*(?:token|secret|password|api[_-]?key|authorization)[\w-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,)]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:key|token|secret|password|api[_-]?key|access_token)=)[^&#\s]*/gi, '$1[redacted]');
}

export const unsupportedClaudeControl = (name, method) => Object.assign(new Error(`/${name} requires ${method ? `the native ${method} capability` : 'a native capability'} unavailable on this host. Check the selected host's Claude version and update its runtime if needed.`), { code: 'CLAUDE_COMMAND_UNSUPPORTED' });

/** Keep native gates useful without copying arbitrary diagnostics or configuration. */
export async function callClaudeNativeControl(query, name, method, values = [], { signal } = {}) {
  signal?.throwIfAborted();
  if (typeof query?.[method] !== 'function') throw unsupportedClaudeControl(name, method);
  let onAbort;
  const aborted = signal && new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const request = query[method](...values);
    const result = await (aborted ? Promise.race([request, aborted]) : request);
    signal?.throwIfAborted();
    if (record(result) && result.error && method !== 'rewindFiles') throw Error(typeof result.error === 'string' ? result.error : 'Native control rejected the request.');
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    const message = typeof error?.message === 'string' ? error.message.split('\n')[0].slice(0, 800) : '';
    const gate = /requires?|unavailable|not (?:available|supported|enabled|allowed)|unsupported|disabled|policy|permission|denied|not logged|sign.?in|log.?in/i.test(message);
    throw Object.assign(new Error(`Claude could not complete /${name}.${gate ? ` ${safeClaudeControlText(message)}` : ''} Check the selected native session and its account or policy, then retry.`), { code: 'CLAUDE_COMMAND_CONTROL_FAILED' });
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** Allowlist presentation fields; settings sources, hook commands and MCP configs stay private. */
export function formatClaudeNativeControl(name, data) {
  let title, body;
  switch (name) {
    case 'status':
      title = 'Claude status';
      body = rows(data?.sections).map(section => `**${scalar(section.title) || 'Session'}**\n\n${list(rows(section.rows).map(row => `${scalar(row.label) || 'Status'}: ${secretLabel.test(row.label) ? '[redacted]' : scalar(row.value) || (Number.isFinite(row.tokens) ? `${count(row.tokens)} tokens` : 'Not reported')}`), 'No status fields reported.')}`).join('\n\n') || 'No status fields reported.';
      break;
    case 'plan':
      title = 'Claude plan';
      body = data?.exists === true && typeof data.content === 'string' && data.content.trim() ? data.content : 'No native plan is available in this session.';
      break;
    case 'permissions': {
      title = 'Claude permissions';
      const state = data?.state ?? {};
      body = list(rows(state.rules).map(row => `${scalar(row.behavior)}: ${scalar(row.rule)}${row.source ? ` (${scalar(row.source)})` : ''}`), 'No explicit permission rules reported.');
      if (state.originalCwd) body += `\n\nWorking directory: ${scalar(state.originalCwd)}`;
      if (Array.isArray(state.workspaceDirectories) && state.workspaceDirectories.length) body += `\n\nWorkspace directories\n\n${list(state.workspaceDirectories.map(row => scalar(row) || scalar(row?.path)), '')}`;
      if (state.managedOnly === true) body += '\n\nOnly managed permission rules are allowed by native policy.';
      body += '\n\nChoose a permission mode in the composer. Claude applies these rules to tool requests.';
      break;
    }
    case 'skills':
      title = 'Claude skills';
      body = list(rows(data?.skills).map(row => `${scalar(row.name)}${row.state ? ` — ${scalar(row.state)}` : ''}${row.description ? `: ${scalar(row.description)}` : ''}${row.source ? ` (${scalar(row.source)})` : ''}`), 'No skills are available in this native session.');
      break;
    case 'memory':
      title = 'Claude memory';
      body = list([...rows(data?.files), ...rows(data?.folders), ...rows(data?.memories)].map(row => `${scalar(row.label) || scalar(row.name) || scalar(row.kind) || 'Memory'}: ${scalar(row.path)}${typeof row.exists === 'boolean' ? row.exists ? ' (exists)' : ' (not created)' : ''}${row.description ? ` — ${scalar(row.description)}` : ''}`), 'No memory files reported.');
      for (const [key, label] of [['auto_memory', 'Auto-memory'], ['auto_dream', 'Auto-dream']]) if (record(data?.[key]) && data[key].shown !== false) body += `\n\n${label}: ${scalar(data[key].status) || (data[key].enabled ? 'on' : 'off')}${data[key].toggleable === false ? ' (controlled by native policy)' : ''}`;
      break;
    case 'hooks':
      title = 'Claude hooks';
      body = list(rows(data?.hooks).map(row => `${scalar(row.event) || scalar(row.eventName) || 'Hook'}${row.matcher ? ` — ${scalar(row.matcher)}` : ''}${row.type ? ` (${scalar(row.type)})` : ''}${row.sourceLabel || row.source ? ` — ${scalar(row.sourceLabel || row.source)}` : ''}${typeof row.disabled === 'boolean' ? row.disabled ? '; disabled' : '; enabled' : ''}`), 'No configured hooks reported.');
      if (data?.policy?.allDisabled) body += '\n\nAll hooks are disabled in this session.';
      if (data?.policy?.disabledByPolicy) body += '\n\nHooks are disabled by managed policy.';
      if (data?.policy?.managedOnly) body += '\n\nOnly managed hooks are allowed.';
      if (data?.policy?.pluginOnly) body += '\n\nOnly plugin hooks are allowed.';
      break;
    case 'mcp':
      title = 'Claude MCP servers';
      body = list(rows(data).map(row => `${scalar(row.name)} — ${scalar(row.status)}${row.scope ? ` (${scalar(row.scope)})` : ''}${Array.isArray(row.tools) ? `; ${row.tools.length} tools` : ''}${row.status === 'needs-auth' ? '; authenticate this server in native Claude' : ''}${row.status === 'failed' ? '; check the native server configuration' : ''}`), 'No MCP servers are configured in this session.');
      body += '\n\nUse /mcp reconnect|enable|disable <server> to manage a server.';
      break;
    case 'plugins':
      title = 'Configured Claude plugins';
      body = list(Object.entries(record(data?.effective?.enabledPlugins) ? data.effective.enabledPlugins : {}).filter(([, enabled]) => typeof enabled === 'boolean').map(([plugin, enabled]) => `${plugin} — ${enabled ? 'enabled' : 'disabled'}`), 'No configured plugins reported.');
      body += '\n\nUse /reload-plugins to apply plugin changes to this session.';
      break;
    case 'context':
      title = 'Claude context';
      body = `Model: ${scalar(data?.model) || 'not reported'}\n\n${count(data?.totalTokens)} / ${count(data?.rawMaxTokens ?? data?.maxTokens)} tokens (${count(data?.percentage)}%).\n\n${list(rows(data?.categories).map(row => `${scalar(row.name)}: ${count(row.tokens)} tokens${row.kind ? ` (${scalar(row.kind)})` : ''}`), 'No category breakdown reported.')}`;
      break;
    case 'usage': {
      title = 'Claude usage';
      const session = data?.session ?? {};
      body = `Session cost: ${Number.isFinite(session.total_cost_usd) ? `$${session.total_cost_usd.toFixed(4)}` : 'not reported'}`;
      body += `\n\n${list(Object.entries(record(session.model_usage) ? session.model_usage : {}).map(([model, usage]) => `${model}: ${count(usage?.inputTokens)} input tokens; ${count(usage?.outputTokens)} output tokens; ${count(usage?.cacheReadInputTokens ?? 0)} cache-read tokens`), 'No model usage reported.')}`;
      if (data?.rate_limits_available === true) body += `\n\nPlan rate limits\n\n${list(Object.entries(record(data.rate_limits) ? data.rate_limits : {}).filter(([, value]) => record(value) && Number.isFinite(value.utilization)).map(([window, value]) => `${window.replaceAll('_', ' ')}: ${count(value.utilization)}% used${value.resets_at ? `; resets ${scalar(value.resets_at)}` : ''}`), 'No utilization windows reported.')}`;
      else body += '\n\nPlan rate limits are unavailable for this native session/provider.';
      break;
    }
    case 'config': {
      title = 'Claude configuration';
      const settings = data?.effective ?? {}, applied = data?.applied ?? {};
      body = list([['Model', applied.model ?? settings.model], ['Effort', applied.effort ?? settings.effortLevel], ['Output style', applied.outputStyle ?? settings.outputStyle], ['Thinking enabled', settings.alwaysThinkingEnabled], ['Fast mode', settings.fastMode], ['Language', settings.language], ['Hooks disabled', settings.disableAllHooks]].filter(([, value]) => scalar(value) !== '').map(([label, value]) => `${label}: ${scalar(value)}`), 'No display settings reported.');
      for (const behavior of ['allow', 'ask', 'deny']) if (Array.isArray(settings.permissions?.[behavior])) body += `\n\nPermission ${behavior}\n\n${list(settings.permissions[behavior].filter(value => typeof value === 'string'), '')}`;
      body += '\n\nNative /config key=value changes native settings. Session controls are stored for this chat and selected role.';
      break;
    }
    default: throw unsupportedClaudeControl(name);
  }
  return { text: safeClaudeControlText(`${title}\n\n${body}`) };
}

export function formatClaudeTasks(tasks = []) {
  const nativeTasks = structuredClone(rows(tasks));
  const text = nativeTasks.length ? `Native Claude tasks\n\n${nativeTasks.map(task => {
    const state = task.processEnded ? `${task.status}${task.lastStatus ? ` (last seen ${task.lastStatus})` : ' (process-ended)'}` : task.status;
    return `- ${task.id}: ${task.description ?? task.taskType ?? 'Task'} — ${state}${task.ambient ? ' (ambient)' : ''}${task.summary ? `; ${task.summary}` : ''}`;
  }).join('\n')}` : 'No native tasks have been observed in this Claude process.';
  return { text: safeClaudeControlText(text), nativeTasks };
}

const taskUsage = 'Usage: /tasks [stop <taskId>]. Stop accepts an active task observed in the selected live Claude process.';
export function validateClaudeTaskArguments(args = '') {
  if (typeof args !== 'string') throw new TypeError(taskUsage);
  const argument = args.trim();
  if (!argument) return;
  const match = /^stop ([A-Za-z0-9_-]{1,128})$/.exec(argument);
  if (!match) throw new TypeError(taskUsage);
  return match[1];
}

/** The adapter must pass the current selected worker's normalizer.nativeTasks. */
export async function executeClaudeTaskControl(query, command, { nativeTasks, signal } = {}) {
  signal?.throwIfAborted();
  const taskId = validateClaudeTaskArguments(typeof command === 'string' ? command : command?.args ?? '');
  if (!taskId) return formatClaudeTasks(nativeTasks);
  const matches = rows(nativeTasks).filter(task => task.id === taskId);
  if (matches.length !== 1) throw Error('Task stop requires a task ID observed in the selected native process. Run /tasks to list it.');
  if (matches[0].processEnded || !['running', 'pending', 'paused'].includes(matches[0].status)) throw Error('This task is no longer known to be active in the selected native process. Refresh /tasks.');
  await callClaudeNativeControl(query, 'tasks', 'stopTask', [taskId], { signal });
  return { text: `Native task stop requested: ${taskId}. Claude will report its final task status.` };
}

const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
const validStyle = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\/\\\x00-\x1f\x7f]/.test(value) && value.trim() === value;

/** This app-owned object is deliberately smaller than Claude's native settings. */
export function normalizeClaudeSessionOptions(value = {}, { modelInfo, availableOutputStyles } = {}) {
  if (!record(value) || Object.keys(value).some(key => !['effort', 'thinking', 'outputStyle'].includes(key))) throw new TypeError('Unsupported Claude session option. Use effort, thinking or outputStyle.');
  const result = {};
  if ('effort' in value) {
    if (value.effort !== null && !effortLevels.includes(value.effort)) throw new TypeError('Claude effort must be low, medium, high, xhigh, max, or null for auto.');
    if (value.effort !== null && (modelInfo?.supportsEffort === false || Array.isArray(modelInfo?.supportedEffortLevels) && !modelInfo.supportedEffortLevels.includes(value.effort))) throw new TypeError('The selected model does not support this effort level. Choose one of its supported effort levels.');
    result.effort = value.effort;
  }
  if ('thinking' in value) {
    const thinking = value.thinking;
    if (!record(thinking) || !['adaptive', 'enabled', 'disabled'].includes(thinking.type) || Object.keys(thinking).some(key => !['type', 'budgetTokens', 'display'].includes(key))
      || 'display' in thinking && (!['summarized', 'omitted'].includes(thinking.display) || thinking.type === 'disabled')
      || 'budgetTokens' in thinking && (thinking.type !== 'enabled' || !Number.isSafeInteger(thinking.budgetTokens) || thinking.budgetTokens < 1024)) throw new TypeError('Invalid Claude thinking option. Use enabled, disabled or adaptive, with a supported display and an integer budget of at least 1024 tokens.');
    if (thinking.type === 'adaptive' && modelInfo?.supportsAdaptiveThinking === false) throw new TypeError('The selected model does not support adaptive thinking.');
    result.thinking = structuredClone(thinking);
  }
  if ('outputStyle' in value) {
    if (!validStyle(value.outputStyle)) throw new TypeError('Invalid Claude output-style name.');
    if (Array.isArray(availableOutputStyles) && !availableOutputStyles.includes(value.outputStyle)) throw new TypeError('This output-style is not available in the selected native session.');
    result.outputStyle = value.outputStyle;
  }
  return result;
}

export function claudeSessionQueryOptions(value) {
  const options = normalizeClaudeSessionOptions(value), result = {};
  if (options.effort != null) result.effort = options.effort;
  if (options.thinking) result.thinking = options.thinking;
  if (options.outputStyle) result.settings = { outputStyle: options.outputStyle };
  return result;
}

/** Await after initialization and before releasing the first input to query(). */
export async function applyClaudeSessionResets(query, value, { signal } = {}) {
  const options = normalizeClaudeSessionOptions(value);
  if (options.effort === null) await callClaudeNativeControl(query, 'effort', 'applyFlagSettings', [{ effortLevel: null }], { signal });
}

export async function captureClaudeSessionOptions(query, { command, args, currentOptions = {}, signal } = {}) {
  const result = normalizeClaudeSessionOptions(currentOptions);
  if (!['effort', 'output-style', 'thinking'].includes(command)) return result;
  const data = await callClaudeNativeControl(query, command, 'getSettings', [], { signal });
  // Native applied.effort resolves auto to the current model's default (e.g.
  // high). Retain an explicitly accepted auto choice instead of pinning it.
  if (command === 'effort' && (data?.applied?.effort === null || effortLevels.includes(data?.applied?.effort))) result.effort = args?.trim() === 'auto' ? null : data.applied.effort;
  if (command === 'output-style') {
    const style = data?.applied?.outputStyle ?? data?.effective?.outputStyle;
    if (validStyle(style)) result.outputStyle = style;
  }
  return result;
}

/** Only call this for an explicit app session control, never to replace a discovered builtin. */
export async function executeClaudeSessionOptionControl(query, name, args = '', { currentOptions = {}, modelInfo, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof args !== 'string') throw new TypeError('Claude session option arguments must be text.');
  const argument = args.trim();
  let patch;
  if (name === 'effort') patch = { effort: argument === 'auto' ? null : argument };
  else if (name === 'thinking') {
    if (['on', 'auto', 'enabled'].includes(argument)) patch = { thinking: { type: 'enabled' } };
    else if (['off', 'disabled'].includes(argument)) patch = { thinking: { type: 'disabled' } };
    else if (argument === 'adaptive') patch = { thinking: { type: 'adaptive' } };
    else if (/^\d+$/.test(argument)) patch = { thinking: { type: 'enabled', budgetTokens: Number(argument) } };
    else throw new TypeError('Usage: /thinking on|off|adaptive|<budgetTokens>.');
  } else if (name === 'output-style') patch = { outputStyle: argument };
  else throw unsupportedClaudeControl(name);
  let availableOutputStyles;
  if (name === 'output-style') availableOutputStyles = (await callClaudeNativeControl(query, name, 'initializationResult', [], { signal }))?.available_output_styles;
  if (name === 'output-style' && !Array.isArray(availableOutputStyles)) throw unsupportedClaudeControl(name, 'available_output_styles');
  patch = normalizeClaudeSessionOptions(patch, { modelInfo, availableOutputStyles });
  if (patch.thinking?.type === 'adaptive' && modelInfo?.supportsAdaptiveThinking !== true) throw unsupportedClaudeControl(name, 'adaptive-thinking model capability');
  let next = normalizeClaudeSessionOptions({ ...normalizeClaudeSessionOptions(currentOptions), ...patch });
  if (name === 'thinking') {
    if (typeof query?.setMaxThinkingTokens === 'function') await callClaudeNativeControl(query, name, 'setMaxThinkingTokens', [patch.thinking.type === 'disabled' ? 0 : patch.thinking.budgetTokens ?? null], { signal });
    else if (!patch.thinking.budgetTokens && patch.thinking.type !== 'adaptive') await callClaudeNativeControl(query, name, 'applyFlagSettings', [{ alwaysThinkingEnabled: patch.thinking.type !== 'disabled' }], { signal });
    else throw unsupportedClaudeControl(name, 'setMaxThinkingTokens');
  }
  else await callClaudeNativeControl(query, name, 'applyFlagSettings', [name === 'effort' ? { effortLevel: patch.effort } : { outputStyle: patch.outputStyle }], { signal });
  if (name !== 'thinking' && typeof query?.getSettings === 'function') next = await captureClaudeSessionOptions(query, { command: name, args: argument, currentOptions: next, signal });
  const applied = name === 'effort' ? next.effort ?? 'auto' : name === 'output-style' ? next.outputStyle : argument;
  return { text: `Claude ${name}: ${applied} for this chat's selected session or role.${String(applied) !== argument ? ` Native Claude reported ${applied} for the requested ${argument}.` : ''} Native user and project settings were not changed.`, settingsPatch: { claudeOptions: next } };
}
