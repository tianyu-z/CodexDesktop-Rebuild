import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const implementation = await import('../../runtime/agent-modes/claude-commands.mjs').catch(() => ({}));
const test = (name, fn) => nodeTest(name, { timeout: 6000 }, fn);
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [
  { name: 'model', description: 'Set model', argumentHint: '<model>', builtin: true },
  { name: 'config', description: 'Set a setting', argumentHint: 'key=value', aliases: ['settings'], builtin: true },
  { name: 'future:skill', description: 'A dynamically installed skill', argumentHint: '<instruction>', aliases: ['future'] },
];
function catalog(queryImpl, options = {}) {
  assert.equal(typeof implementation.ClaudeCommandCatalog, 'function', 'command catalog is implemented');
  return new implementation.ClaudeCommandCatalog({ executablePath: '/fixture/claude', environment: () => ({ FIXTURE_PROVIDER: 'one' }), queryImpl, ...options });
}
function metadataQuery(commands = rows, observed = {}) {
  return request => {
    observed.calls = (observed.calls ?? 0) + 1;
    observed.request = request;
    observed.input = request.prompt[Symbol.asyncIterator]().next();
    return {
      supportedCommands: async () => typeof commands === 'function' ? commands(request) : commands,
      close() { observed.closed = true; },
      async return() { observed.returned = true; return { done: true }; },
    };
  };
}

test('discovers all native commands without sending a model prompt and adds explicit host command metadata', async () => {
  const observed = {};
  const service = catalog(metadataQuery(rows, observed));
  const result = await service.list({ cwd: '/fixture/project' });
  assert.equal(result.source, 'claude-sdk');
  assert.deepEqual(result.commands.filter(row => row.origin !== 'app').map(row => row.name), rows.map(row => row.name));
  assert.equal(result.commands.find(row => row.name === 'future:skill').execution, 'native');
  assert.equal(result.commands.find(row => row.name === 'permissions').execution, 'control');
  assert.equal(result.commands.find(row => row.name === 'resume').execution, 'local');
  const options = observed.request.options;
  assert.equal(options.cwd, '/fixture/project');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.hooks, {});
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.settings.disableAllHooks, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.permissionMode, 'default');
  assert.deepEqual(await observed.input, { done: true, value: undefined });
  assert.equal(observed.closed, true);
  assert.equal(observed.returned, true);
  await service.close();
});

test('preserves native name/alias precedence and dispatches no-argument settings panels separately', async () => {
  const service = catalog(metadataQuery([...rows,
    { name: 'cost', description: 'Custom exact name', argumentHint: '' },
    { name: 'usage', description: 'Native usage', argumentHint: '', aliases: ['cost', 'stats'], builtin: true },
    { name: 'duplicate', description: 'Custom', argumentHint: '' },
    { name: 'duplicate', description: 'Native', argumentHint: '', builtin: true },
    { name: 'status', description: 'Custom status skill', argumentHint: '' },
  ]));
  const result = await service.list();
  const resolve = text => implementation.resolveClaudeCommand(result, text);
  assert.equal(resolve('/cost').name, 'cost');
  assert.equal(resolve('/stats').name, 'usage');
  assert.equal(resolve('/duplicate').builtin, true);
  assert.equal(resolve('/status').execution, 'native');
  assert.equal(resolve('/config').execution, 'control');
  assert.equal(resolve('/settings model=opus').execution, 'native');
  assert.equal(resolve('/future  fix the bug').args, 'fix the bug');
  assert.equal(resolve('/future  fix the bug').input, '/future  fix the bug');
  assert.equal(resolve('ordinary prompt'), undefined);
  assert.equal(resolve('/not-installed'), undefined);
  assert.equal(resolve('/allowed-tools').control, 'permissions');
  await service.close();
});

test('invalid metadata cannot invent slash routes and exact duplicate rows are removed', () => {
  assert.equal(typeof implementation.normalizeClaudeCommands, 'function');
  const result = implementation.normalizeClaudeCommands([...rows, rows[0], { name: '../bad path' }, null, { name: 'valid', aliases: ['good', '/bad', 'has space', 'good'] }]);
  assert.deepEqual(result.map(row => row.name), ['model', 'config', 'future:skill', 'valid']);
  assert.deepEqual(result.at(-1).aliases, ['good']);
  assert.throws(() => implementation.normalizeClaudeCommands(null), /metadata/i);
});

test('skills named config or mcp remain exact native commands without panel interception', () => {
  for (const name of ['config', 'mcp']) {
    const catalog = { commands: implementation.normalizeClaudeCommands([{ name }]) };
    assert.equal(implementation.resolveClaudeCommand(catalog, `/${name}`).execution, 'native');
  }
});

test('read access permits inspections and skills but guards direct control writes', async () => {
  for (const command of [
    { name: 'config', origin: 'builtin', execution: 'native', args: 'help' },
    { name: 'mcp', origin: 'builtin', execution: 'native', args: 'status' },
    { name: 'model', origin: 'builtin', execution: 'native', args: 'opus' },
    { name: 'config', origin: 'skill', execution: 'native', args: 'disableAllHooks=false' },
  ]) assert.doesNotThrow(() => implementation.assertClaudeCommandAccess(command, 'read'));
  let rewinds = 0;
  const query = { rewindFiles: async (_, options) => { rewinds++; assert.equal(options.dryRun, true); return { canRewind: true }; } };
  const checkpoint = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await implementation.executeClaudeControl(query, 'rewind', checkpoint, { access: 'read' });
  await assert.rejects(implementation.executeClaudeControl(query, 'rewind', `${checkpoint} --apply`, { access: 'read' }), /read-only|write access/);
  assert.equal(rewinds, 1);
});

test('same-name skills with different qualified aliases remain individually invokable', async () => {
  const service = catalog(metadataQuery([
    { name: 'review', aliases: ['one:review'], description: 'One review' },
    { name: 'review', aliases: ['two:review'], description: 'Two review' },
  ]));
  const result = await service.list();
  assert.equal(result.commands.filter(row => row.name === 'review').length, 2);
  assert.equal(implementation.resolveClaudeCommand(result, '/two:review').description, 'Two review');
  assert.deepEqual(result.commands.filter(row => row.name === 'review').map(row => row.invocation), ['one:review', 'two:review']);
  await service.close();
});

test('native status output redacts labeled credentials while retaining token counts', async () => {
  const query = { async getStatus() { return { sections: [{ rows: [{ label: 'API key', value: 'fixture-secret' }, { label: 'Usage', tokens: 123 }] }] }; } };
  const result = await implementation.executeClaudeControl(query, 'status');
  assert.doesNotMatch(result.text, /fixture-secret/);
  assert.match(result.text, /123/);
});

test('deduplicates discovery, isolates returned values, and refreshes after provider rotation', async () => {
  const pending = deferred(), observed = {};
  let key = 'first';
  const service = catalog(metadataQuery(() => pending.promise, observed), { environment: () => ({ ANTHROPIC_API_KEY: key }) });
  const left = service.list({ cwd: '/same' }), right = service.list({ cwd: '/same' });
  await delay(0);
  assert.equal(observed.calls, 1);
  pending.resolve(rows);
  const [a, b] = await Promise.all([left, right]);
  a.commands[0].name = 'mutated';
  assert.equal(b.commands[0].name, 'model');
  assert.equal((await service.list({ cwd: '/same' })).commands[0].name, 'model');
  key = 'second';
  await service.list({ cwd: '/same' });
  await service.list({ cwd: '/same', refresh: true });
  assert.equal(observed.calls, 3);
  await service.close();
});

test('close cancels unresolved environment lookup and prevents late process startup', async () => {
  const pending = deferred(), entered = deferred();
  let calls = 0;
  const service = catalog(() => { calls++; }, { environment: () => { entered.resolve(); return pending.promise; } });
  const listing = service.list();
  const rejected = assert.rejects(listing, /closed/i);
  await entered.promise;
  await service.close();
  pending.resolve({});
  await rejected;
  assert.equal(calls, 0);
});

test('native failures are redacted and timeouts clean up the SDK query', async () => {
  const observed = {};
  const service = catalog(metadataQuery(() => new Promise(() => {}), observed), { timeoutMs: 15 });
  await assert.rejects(service.list(), /timed out/i);
  assert.equal(observed.closed, true);
  assert.equal(observed.returned, true);
  await service.close();
  const failed = catalog(metadataQuery(() => { throw Error('Authorization: Bearer fixture-secret'); }));
  await assert.rejects(failed.list(), error => /discovery/i.test(error.message) && !error.message.includes('fixture-secret'));
  await failed.close();
});

test('discovery owns and reclaims a stubborn native subprocess even if SDK close does nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-command-child-'));
  const script = join(directory, 'child.mjs');
  await writeFile(script, 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
  let child;
  const service = catalog(request => {
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: [script], cwd: directory, env: process.env });
    return { supportedCommands: async () => { await new Promise(resolve => child.stdout.once('data', resolve)); return rows; }, close() {}, async return() { return { done: true }; } };
  });
  try {
    await service.list({ cwd: directory });
    assert.notEqual(child.signalCode, null);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reads native status, permissions, skills and MCP through feature-detected control APIs', async () => {
  assert.equal(typeof implementation.executeClaudeControl, 'function');
  const query = {
    async getStatus() { return { sections: [{ title: 'Session', rows: [{ label: 'Model', value: 'opus' }] }] }; },
    async listPermissionRules() { return { state: { rules: [{ behavior: 'allow', rule: 'Read(*)' }] } }; },
    async getSkillsDialog() { return { skills: [{ name: 'future:skill', state: 'enabled' }] }; },
    async mcpServerStatus() { return [{ name: 'server', status: 'connected' }]; },
  };
  for (const [command, expected] of [['status', /opus/], ['permissions', /Read/], ['skills', /future:skill/], ['mcp', /connected/]]) {
    assert.match((await implementation.executeClaudeControl(query, command)).text, expected);
  }
});

test('config output excludes connection secrets and native failures cannot leak credentials', async () => {
  const query = { async getSettings() { return { effective: { model: 'opus', env: { ANTHROPIC_API_KEY: 'fixture-secret' }, apiKeyHelper: 'secret command', permissions: { allow: ['Read(*)', 'Bash(API_TOKEN=fixture-token curl x)'] } }, applied: { model: 'opus' } }; } };
  const result = await implementation.executeClaudeControl(query, 'config');
  assert.match(result.text, /opus/);
  assert.match(result.text, /Read/);
  assert.doesNotMatch(result.text, /fixture-secret|secret command|fixture-token/);
  await assert.rejects(implementation.executeClaudeControl({ getStatus() { throw Error('Bearer fixture-secret'); } }, 'status'), error => !error.message.includes('fixture-secret'));
});

test('unavailable UI capabilities report errors rather than pretend a slash command ran', async () => {
  for (const command of ['status', 'tasks', 'rewind', 'resume', 'feedback', 'remote-control']) {
    await assert.rejects(implementation.executeClaudeControl({}, command), error => error.code === 'CLAUDE_COMMAND_UNSUPPORTED');
  }
  await assert.rejects(implementation.executeClaudeControl({}, 'permissions', 'allow everything'), /argument/i);
});

test('plan control changes native permission mode and returns the setting for host persistence', async () => {
  const modes = [];
  const result = await implementation.executeClaudeControl({ async setPermissionMode(mode) { modes.push(mode); } }, 'plan');
  assert.deepEqual(modes, ['plan']);
  assert.deepEqual(result.settingsPatch, { permissionMode: 'plan' });
  assert.match(result.text, /Plan mode/i);
});

test('help lists the actual live catalog and export downloads the full native transcript', async () => {
  const transcript = `user: Hello\nassistant: Hi\n${'A long conversation. '.repeat(500)}\nAPI_TOKEN=literal-conversation-text`;
  const query = { async supportedCommands() { return rows; }, async exportConversation() { return { text: transcript, default_filename: 'conversation.txt' }; } };
  assert.match((await implementation.executeClaudeControl(query, 'help')).text, /future:skill/);
  assert.deepEqual(await implementation.executeClaudeControl(query, 'export'), {
    text: 'Native Claude transcript ready to download.',
    clientAction: { type: 'download', text: transcript, filename: 'conversation.txt' },
  });
  assert.equal((await implementation.executeClaudeControl(query, 'export', 'My transcript.md')).clientAction.filename, 'My transcript.md');
});

test('export validates requested filenames before invoking Claude and sanitizes invalid native defaults', async () => {
  let calls = 0;
  const query = { async exportConversation() { calls++; return { text: 'Transcript', default_filename: '../../private.txt' }; } };
  for (const name of ['../private.txt', '/tmp/private.txt', 'dir\\private.txt', '.', '..', 'bad\nname.txt', 'bad\x00name.txt', 'bad\x7fname.txt']) {
    await assert.rejects(implementation.executeClaudeControl(query, 'export', name), /filename/i);
  }
  assert.equal(calls, 0);
  assert.equal((await implementation.executeClaudeControl(query, 'export')).clientAction.filename, 'conversation.txt');
});

test('native side questions use the SDK side channel and report missing answers', async () => {
  const asked = [];
  const query = { async askSideQuestion(question) { asked.push(question); return { response: 'The side answer', synthetic: false }; } };
  assert.match((await implementation.executeClaudeControl(query, 'btw')).text, /question/i);
  assert.deepEqual(asked, []);
  assert.equal((await implementation.executeClaudeControl(query, 'btw', 'What changed?')).text, 'The side answer');
  assert.deepEqual(asked, ['What changed?']);
  await assert.rejects(implementation.executeClaudeControl({ askSideQuestion: async () => null }, 'btw', 'question'), /answer/i);
});

test('Chrome command reads the native dialog without mutating browser settings', async () => {
  const result = await implementation.executeClaudeControl({ getChromeDialog: async () => ({ enabled: false, browsers: [] }) }, 'chrome');
  assert.match(result.text, /false/);
});

test('feedback submits only the typed report and explicitly excludes the conversation', async () => {
  const sent = [];
  const query = { async submitFeedback(...args) { sent.push(args); return { feedback_id: 'fixture-report' }; } };
  assert.match((await implementation.executeClaudeControl(query, 'feedback')).text, /report/i);
  assert.deepEqual(sent, []);
  const result = await implementation.executeClaudeControl(query, 'feedback', 'The panel\nis clipped.');
  assert.deepEqual(sent, [['The panel\nis clipped.', { attach_transcript: false }]]);
  assert.match(result.text, /fixture-report/);
});

test('rewind previews a validated checkpoint and requires explicit apply to restore files', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', calls = [];
  const query = { async rewindFiles(...args) { calls.push(args); return { canRewind: true, filesChanged: ['app.js'] }; } };
  assert.match((await implementation.executeClaudeControl(query, 'rewind')).text, /--apply/);
  assert.deepEqual(calls, []);
  assert.match((await implementation.executeClaudeControl(query, 'rewind', id)).text, /preview/i);
  await implementation.executeClaudeControl(query, 'rewind', `${id} --dry-run`);
  assert.match((await implementation.executeClaudeControl(query, 'rewind', `${id} --apply`)).text, /files/i);
  assert.deepEqual(calls, [[id, { dryRun: true }], [id, { dryRun: true }], [id, { dryRun: false }]]);
  for (const argument of ['last', `${id} --force`, `${id} --apply --dry-run`]) await assert.rejects(implementation.executeClaudeControl(query, 'rewind', argument), /Usage/);
  assert.equal(calls.length, 3);
});

test('failed native file rewind does not claim files were restored', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await assert.rejects(implementation.executeClaudeControl({ rewindFiles: async () => ({ canRewind: false, error: 'No checkpoint' }) }, 'rewind', `${id} --apply`), /could not rewind/i);
});

test('new native control capabilities are exposed as controls while discovered builtins win', async () => {
  const service = catalog(metadataQuery([{ name: 'plan', builtin: true }]));
  const result = await service.list();
  for (const name of ['btw', 'chrome', 'feedback', 'rewind', 'remote-control', 'rc']) assert.equal(implementation.resolveClaudeCommand(result, `/${name}`).execution, 'control');
  assert.equal(implementation.resolveClaudeCommand(result, '/plan').execution, 'native');
  await service.close();
});

test('remote control enables the native worker without detaching its lifetime from the host', async () => {
  const enabled = [];
  const response = await implementation.executeClaudeControl({ async enableRemoteControl(...args) { enabled.push(args); return { url: 'https://claude.ai/code/session-fixture', bridge_session_id: 'session-fixture', work_secret: 'fixture-secret' }; } }, 'remote-control');
  assert.deepEqual(enabled, [[true]]);
  assert.equal(response.keepAlive, true);
  assert.match(response.text, /Stop/);
  assert.match(response.text, /https:\/\/claude.ai/);
  assert.doesNotMatch(response.text, /fixture-secret/);
});
