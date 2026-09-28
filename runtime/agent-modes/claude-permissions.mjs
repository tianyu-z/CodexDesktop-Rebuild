/** Exact Claude Code / Agent SDK modes; these are unrelated to Codex approvals. */
export const CLAUDE_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']);

export function assertClaudePermissionMode(mode) {
  if (!CLAUDE_PERMISSION_MODES.includes(mode)) throw new TypeError(`Invalid Claude permission mode: expected one of ${CLAUDE_PERMISSION_MODES.join(', ')}.`);
  return mode;
}
