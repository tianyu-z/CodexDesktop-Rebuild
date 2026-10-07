import { normalizeClaudeSessionOptions } from './claude-native-controls.mjs';

/** Validate before mutating either the session binding or shared workflow choice. */
export async function prepareClaudeEffort(adapter, params, chat, workflowSelection) {
  const explicit = params.claudeEffort !== undefined;
  const mode = params.engineMode ?? chat?.mode ?? 'codex';
  if (!['claude', 'both'].includes(mode)) {
    if (explicit) throw new Error('Claude effort requires Only Claude Code or Both.');
    return undefined;
  }
  const previous = (mode === 'both' ? chat?.claudeWorkflowOptions : chat?.bindings.claude.claudeOptions) ?? {};
  const model = params.engineModel ?? chat?.models.claude ?? 'default';
  const changed = chat && (mode === 'both'
    ? chat.mode !== 'both' || params.engineModels !== undefined || params.template !== undefined || params.roleOverrides !== undefined
    : model !== chat.models.claude || chat.mode !== 'claude');
  if (!explicit && (!changed || previous.effort == null)) return undefined;
  const effort = explicit ? normalizeClaudeSessionOptions({ effort: params.claudeEffort }).effort : previous.effort;
  if (effort === null) return { ...previous, effort: null };
  let models;
  try { models = await adapter.listModels({ cwd: chat?.cwd ?? params.cwd }); }
  catch { throw new Error('Could not verify Claude effort support. Refresh models and retry.'); }
  const selectedModels = mode === 'both'
    ? [...new Set(Object.values(workflowSelection?.template.roles ?? {}).filter(role => role.engine === 'claude').map(role => role.model ?? 'default'))]
    : [model];
  const supported = selectedModels.length > 0 && selectedModels.every(value => {
    const modelInfo = models.find(row => row.value === value);
    if (modelInfo?.supportsEffort !== true || !modelInfo.supportedEffortLevels?.includes(effort)) return false;
    try { normalizeClaudeSessionOptions({ effort }, { modelInfo }); return true; }
    catch { return false; }
  });
  if (!supported) {
    if (explicit) throw new Error('This model does not advertise support for the selected Claude effort. Refresh models and choose a supported level.');
    return { ...previous, effort: null };
  }
  return { ...previous, effort };
}
