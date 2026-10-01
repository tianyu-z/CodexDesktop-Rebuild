import { normalizeClaudeSessionOptions } from './claude-native-controls.mjs';

/** Validate before mutating the chat; effort belongs to the Only Claude binding. */
export async function prepareClaudeEffort(adapter, params, chat) {
  const explicit = params.claudeEffort !== undefined;
  const mode = params.engineMode ?? chat?.mode ?? 'codex';
  if (mode !== 'claude') {
    if (explicit) throw new Error('Claude effort requires Only Claude Code.');
    return undefined;
  }
  const previous = chat?.bindings.claude.claudeOptions ?? {};
  const model = params.engineModel ?? chat?.models.claude ?? 'default';
  const changed = chat && (model !== chat.models.claude || chat.mode !== 'claude');
  if (!explicit && (!changed || previous.effort == null)) return undefined;
  const effort = explicit ? normalizeClaudeSessionOptions({ effort: params.claudeEffort }).effort : previous.effort;
  if (effort === null) return { ...previous, effort: null };
  let models;
  try { models = await adapter.listModels({ cwd: chat?.cwd ?? params.cwd }); }
  catch { throw new Error('Could not verify Claude effort support. Refresh models and retry.'); }
  const modelInfo = models.find(row => row.value === model);
  if (modelInfo?.supportsEffort !== true || !modelInfo.supportedEffortLevels?.includes(effort)) {
    if (explicit) throw new Error('This model does not advertise support for the selected Claude effort. Refresh models and choose a supported level.');
    return { ...previous, effort: null };
  }
  try { normalizeClaudeSessionOptions({ effort }, { modelInfo }); }
  catch (error) {
    if (explicit) throw error;
    return { ...previous, effort: null };
  }
  return { ...previous, effort };
}
