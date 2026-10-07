import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';

// Only connection and model selection are shared with the editor. Its tool
// permissions, feature switches, MCP credentials, hooks, PATH and executable
// options stay separate. Importing DISABLE_EXPERIMENTAL_BETAS also silently
// disables native thinking summaries, even with --thinking-display summarized.
const editorVariables = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
]);
const processProviderVariables = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE',
];

/** Read on every run so editor credential rotation requires no app restart. */
export function resolveClaudeEnvironment({ baseEnv = process.env, settingsPath = join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'settings.json') } = {}) {
  // Keep an explicitly configured provider intact. Mixing its key with another
  // application's endpoint could send credentials to the wrong provider.
  if (processProviderVariables.some(name => baseEnv[name] != null && baseEnv[name] !== '')) return { ...baseEnv };
  let source;
  try { source = readFileSync(settingsPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...baseEnv };
    throw new Error(`Cannot read VS Code Insiders Claude connection settings (${error.code ?? 'read error'}).`);
  }
  const errors = [];
  const settings = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid JSON in VS Code Insiders settings.json; repair the editor settings before starting Claude.');
  const entries = settings['claudeCode.environmentVariables'];
  if (entries === undefined) return { ...baseEnv };
  if (!Array.isArray(entries)) throw new Error('VS Code Insiders claudeCode.environmentVariables must be an array.');
  const imported = {};
  for (const entry of entries) {
    if (!editorVariables.has(entry?.name)) continue;
    if (typeof entry.value !== 'string') throw new Error(`VS Code Insiders ${entry.name} must have a string value.`);
    imported[entry.name] = entry.value;
  }
  return { ...imported, ...baseEnv };
}
