import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

const providerKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE'];
const read = path => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('Cannot read remote provider configuration.'); } };
const explicit = env => providerKeys.some(key => env[key] != null && env[key] !== '');

/** Credentials are resolved afresh inside the remote host; never sent to the desktop. */
export function resolveRemoteClaudeEnvironment({ baseEnv = process.env, codexHome = baseEnv.CODEX_HOME ?? join(homedir(), '.codex'), effectiveSettings, claudeSettings = join(baseEnv.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json') } = {}) {
  if (explicit(baseEnv)) return { ...baseEnv };
  if (effectiveSettings && (explicit(effectiveSettings.env ?? {}) || effectiveSettings.apiKeyHelper)) return { ...baseEnv };
  const settingsText = read(claudeSettings);
  if (settingsText) {
    let settings; try { settings = JSON.parse(settingsText); } catch { throw Error('Invalid remote Claude settings.'); }
    // Native Claude itself applies these settings, including its provider.
    if (explicit(settings.env ?? {}) || settings.apiKeyHelper) return { ...baseEnv };
  }
  const text = read(join(codexHome, 'config.toml'));
  if (!text) return { ...baseEnv };
  let config; try { config = parse(text); } catch { throw Error('Invalid remote Codex provider configuration.'); }
  const provider = config.model_providers?.[config.model_provider];
  if (!provider?.base_url) return { ...baseEnv };
  let endpoint; try { endpoint = new URL(provider.base_url); } catch { throw Error('Invalid remote provider URL.'); }
  // This route is the verified Foundry OpenAI-compatible layout. Never guess
  // an Anthropic route for an arbitrary OpenAI service or change its origin.
  if (!endpoint.pathname.replace(/\/$/, '').endsWith('/openai/v1') || !/foundry/i.test([endpoint.hostname, config.model_provider, provider.name].join(' '))) return { ...baseEnv };
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Invalid remote Foundry provider URL.');
  let auth = {};
  const authText = read(join(codexHome, 'auth.json'));
  if (authText) { try { auth = JSON.parse(authText); } catch { throw Error('Invalid remote Codex authentication file.'); } }
  const key = provider.env_key ? baseEnv[provider.env_key] : auth.OPENAI_API_KEY;
  if (typeof key !== 'string' || !key) throw Error('Remote Foundry provider has no usable API key.');
  const headers = { ...provider.http_headers };
  for (const [name, variable] of Object.entries(provider.env_http_headers ?? {})) {
    if (typeof baseEnv[variable] === 'string') headers[name] = baseEnv[variable];
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw Error('Invalid remote provider header.');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '').slice(0, -'/openai/v1'.length) + '/anthropic';
  return { ...baseEnv, CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: endpoint.href.replace(/\/$/, ''),
    ANTHROPIC_FOUNDRY_API_KEY: key, ANTHROPIC_CUSTOM_HEADERS: Object.entries(headers).map(([name, value]) => name + ': ' + value).join('\n'),
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' };
}
export async function remoteClaudeEnvironment({ cwd = homedir(), resolveSettingsImpl, effectiveSettings, ...options } = {}) {
  if (effectiveSettings) return resolveRemoteClaudeEnvironment({ ...options, effectiveSettings });
  const resolveSettings = resolveSettingsImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).resolveSettings;
  const { effective } = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
  return resolveRemoteClaudeEnvironment({ ...options, effectiveSettings: effective });
}
