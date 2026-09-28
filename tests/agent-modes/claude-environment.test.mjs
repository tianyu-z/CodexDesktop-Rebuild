import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeEnvironment } from '../../runtime/agent-modes/claude-environment.mjs';

function fixture(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-environment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, 'settings.json');
  const write = value => writeFileSync(settingsPath, typeof value === 'string' ? value : JSON.stringify({ 'claudeCode.environmentVariables': value }));
  if (entries !== undefined) write(entries);
  return { settingsPath, write };
}
const foundry = [
  { name: 'CLAUDE_CODE_USE_FOUNDRY', value: '1' },
  { name: 'ANTHROPIC_FOUNDRY_BASE_URL', value: 'https://foundry.example.test/anthropic' },
  { name: 'ANTHROPIC_FOUNDRY_API_KEY', value: 'fixture-key' },
  { name: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', value: '1' },
];

test('reads VS Code Insiders provider variables without modifying the parent environment', t => {
  const { settingsPath } = fixture(t, foundry);
  const baseEnv = { PATH: '/native/bin', HOME: '/home/example' };
  const resolved = resolveClaudeEnvironment({ baseEnv, settingsPath });
  assert.equal(resolved.ANTHROPIC_FOUNDRY_API_KEY, 'fixture-key');
  assert.equal(resolved.ANTHROPIC_FOUNDRY_BASE_URL, 'https://foundry.example.test/anthropic');
  assert.equal(resolved.CLAUDE_CODE_USE_FOUNDRY, '1');
  assert.equal(resolved.PATH, '/native/bin');
  assert.deepEqual(baseEnv, { PATH: '/native/bin', HOME: '/home/example' });
});

test('rereads credentials on each run without copying them to another file', t => {
  const { settingsPath, write } = fixture(t, foundry);
  assert.equal(resolveClaudeEnvironment({ baseEnv: {}, settingsPath }).ANTHROPIC_FOUNDRY_API_KEY, 'fixture-key');
  write(foundry.map(entry => entry.name.endsWith('API_KEY') ? { ...entry, value: 'rotated-fixture-key' } : entry));
  assert.equal(resolveClaudeEnvironment({ baseEnv: {}, settingsPath }).ANTHROPIC_FOUNDRY_API_KEY, 'rotated-fixture-key');
});

test('explicit process provider config wins as a group, without mixing its key with the editor endpoint', t => {
  const { settingsPath } = fixture(t, foundry);
  for (const baseEnv of [{ ANTHROPIC_API_KEY: 'explicit' }, { ANTHROPIC_BASE_URL: 'https://explicit.example.test' }, { CLAUDE_CODE_USE_VERTEX: '1' }, { ANTHROPIC_FOUNDRY_API_KEY: 'explicit-foundry' }]) {
    assert.deepEqual(resolveClaudeEnvironment({ baseEnv, settingsPath }), baseEnv);
  }
});

test('alternate provider selectors preserve their environment without importing Foundry credentials', t => {
  const { settingsPath } = fixture(t, foundry);
  for (const flag of ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE']) {
    const baseEnv = { [flag]: '1' };
    assert.deepEqual(resolveClaudeEnvironment({ baseEnv, settingsPath }), baseEnv);
  }
});

test('editor API custom headers are part of its connection configuration', t => {
  const { settingsPath } = fixture(t, [...foundry, { name: 'ANTHROPIC_CUSTOM_HEADERS', value: 'X-User: fixture-user' }]);
  assert.equal(resolveClaudeEnvironment({ baseEnv: {}, settingsPath }).ANTHROPIC_CUSTOM_HEADERS, 'X-User: fixture-user');
});

test('supports editor JSONC and imports only connection/model settings', t => {
  const { settingsPath, write } = fixture(t);
  write(`{
    // The editor accepts comments and trailing commas.
    "claudeCode.allowDangerouslySkipPermissions": true,
    "claudeCode.environmentVariables": [
      {"name":"ANTHROPIC_BASE_URL","value":"https://example.test//proxy"},
      {"name":"ANTHROPIC_API_KEY","value":"fixture"},
      {"name":"ANTHROPIC_DEFAULT_HAIKU_MODEL","value":"custom-haiku"},
      {"name":"PATH","value":"/untrusted"},
      {"name":"NODE_OPTIONS","value":"--import /untrusted.mjs"},
      {"name":"CLAUDE_CODE_SKIP_PERMISSIONS","value":"1"},
    ],
    "claude.mcpServers":{"unrelated":{"headers":{"Authorization":"unrelated-secret"}}},
  }`);
  const resolved = resolveClaudeEnvironment({ baseEnv: { PATH: '/safe' }, settingsPath });
  assert.deepEqual(resolved, { PATH: '/safe', ANTHROPIC_BASE_URL: 'https://example.test//proxy', ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku' });
});

test('missing optional settings leave native Claude authentication available', t => {
  const { settingsPath } = fixture(t);
  assert.deepEqual(resolveClaudeEnvironment({ baseEnv: { HOME: '/example' }, settingsPath }), { HOME: '/example' });
});

test('malformed settings report their source without exposing credential values', t => {
  const { settingsPath, write } = fixture(t);
  write('{ "claudeCode.environmentVariables": [{"value":"secret-must-not-leak"}');
  assert.throws(() => resolveClaudeEnvironment({ baseEnv: {}, settingsPath }), error => /VS Code Insiders/.test(error.message) && !/secret-must-not-leak/.test(error.message));
  write({ unexpected: 'not an array' });
  assert.throws(() => resolveClaudeEnvironment({ baseEnv: {}, settingsPath }), /environmentVariables.*array/);
});

test('provider variables must have string values; duplicate entries follow editor last-value semantics', t => {
  const { settingsPath, write } = fixture(t, [{ name: 'ANTHROPIC_API_KEY', value: 12 }]);
  assert.throws(() => resolveClaudeEnvironment({ baseEnv: {}, settingsPath }), /ANTHROPIC_API_KEY.*string/);
  write([{ name: 'ANTHROPIC_API_KEY', value: 'old' }, { name: 'ANTHROPIC_API_KEY', value: 'new' }]);
  assert.equal(resolveClaudeEnvironment({ baseEnv: {}, settingsPath }).ANTHROPIC_API_KEY, 'new');
});
