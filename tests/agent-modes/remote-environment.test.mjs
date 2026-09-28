import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRemoteClaudeEnvironment, remoteClaudeEnvironment } from '../../runtime/agent-modes/remote/environment.mjs';
test('derive only same-origin Foundry Anthropic endpoint and re-read rotated credentials', t => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-env-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'config.toml'), 'model_provider="foundry"\n[model_providers.foundry]\nbase_url="https://foundry.example/api/openai/v1"\n[model_providers.foundry.http_headers]\nX-User="fixture"\n[model_providers.foundry.env_http_headers]\nX-Session="FIXTURE_SESSION"\n');
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test-one' }));
  const env = () => resolveRemoteClaudeEnvironment({ codexHome: directory, baseEnv: { FIXTURE_SESSION: 'test-session' } });
  assert.equal(env().ANTHROPIC_FOUNDRY_BASE_URL, 'https://foundry.example/api/anthropic');
  assert.equal(env().ANTHROPIC_FOUNDRY_API_KEY, 'test-one');
  assert.equal(env().ANTHROPIC_CUSTOM_HEADERS, 'X-User: fixture\nX-Session: test-session');
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test-two' }));
  assert.equal(env().ANTHROPIC_FOUNDRY_API_KEY, 'test-two');
  assert.deepEqual(resolveRemoteClaudeEnvironment({ codexHome: directory, baseEnv: { ANTHROPIC_API_KEY: 'explicit' } }), { ANTHROPIC_API_KEY: 'explicit' });
  writeFileSync(join(directory, 'config.toml'), 'model_provider="other"\n[model_providers.other]\nbase_url="https://other.example/v1"\n');
  assert.deepEqual(env(), { FIXTURE_SESSION: 'test-session' });
});
test('effective project provider settings prevent injected Foundry mode', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-env-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'config.toml'), 'model_provider="foundry"\n[model_providers.foundry]\nbase_url="https://foundry.example/openai/v1"\n');
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture' }));
  let options;
  const result = await remoteClaudeEnvironment({ cwd: directory, codexHome: directory, baseEnv: {}, resolveSettingsImpl: async value => {
    options = value; return { effective: { env: { ANTHROPIC_API_KEY: 'project-key', ANTHROPIC_BASE_URL: 'https://project.example' } } };
  } });
  assert.deepEqual(options, { cwd: directory, settingSources: ['user', 'project', 'local'] });
  assert.deepEqual(result, {});
});
test('all supported explicit Claude cloud providers and apiKeyHelper take precedence', t => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-env-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'config.toml'), 'model_provider="foundry"\n[model_providers.foundry]\nbase_url="https://foundry.example/openai/v1"\n');
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture' }));
  const claudeSettings = join(directory, 'settings.json');
  for (const key of ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE']) {
    const baseEnv = { [key]: '1' };
    assert.deepEqual(resolveRemoteClaudeEnvironment({ codexHome: directory, baseEnv, claudeSettings }), baseEnv);
  }
  writeFileSync(claudeSettings, JSON.stringify({ apiKeyHelper: 'existing-user-helper' }));
  assert.deepEqual(resolveRemoteClaudeEnvironment({ codexHome: directory, baseEnv: {}, claudeSettings }), {});
});
test('preserve an existing internal Foundry HTTP origin and omit absent optional environment headers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-env-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'config.toml'), 'model_provider="azure"\n[model_providers.azure]\nname="Azure OpenAI"\nbase_url="http://codex-foundry-proxy.tenant-slurm/openai/v1"\n[model_providers.azure.env_http_headers]\nx-job="MISSING_SLURM_JOB_ID"\n');
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture' }));
  const env = resolveRemoteClaudeEnvironment({ codexHome: directory, baseEnv: {}, claudeSettings: join(directory, 'absent.json') });
  assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, 'http://codex-foundry-proxy.tenant-slurm/anthropic');
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, '');
  writeFileSync(join(directory, 'config.toml'), 'model_provider="azure"\n[model_providers.azure]\nbase_url="https://unrelated.example/openai/v1"\n');
  assert.deepEqual(resolveRemoteClaudeEnvironment({ codexHome: directory, baseEnv: {}, claudeSettings: join(directory, 'absent.json') }), {});
});
