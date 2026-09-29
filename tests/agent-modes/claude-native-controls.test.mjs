import test from 'node:test';
import assert from 'node:assert/strict';

const controls = await import('../../runtime/agent-modes/claude-native-controls.mjs').catch(() => ({}));
const commands = await import('../../runtime/agent-modes/claude-commands.mjs');
const requireHelper = name => { assert.equal(typeof controls[name], 'function', `${name} is implemented`); return controls[name]; };

test('native status renders labeled sections and excludes secret fields', async () => {
  const result = await commands.executeClaudeControl({ getStatus: async () => ({ sections: [{ title: 'Session', rows: [
    { label: 'Model', value: 'claude-sonnet-5' }, { label: 'API key', value: 'fixture-secret' }, { label: 'Usage', tokens: 123 },
  ] }], env: { UNLABELED: 'private-value' } }) }, 'status');
  assert.match(result.text, /\*\*Session\*\*/);
  assert.match(result.text, /Model: claude-sonnet-5/);
  assert.match(result.text, /123/);
  assert.doesNotMatch(result.text, /```|fixture-secret|private-value/);
});

test('native plan renders the actual markdown content and reports absent plans', async () => {
  const content = '# Native plan\n\n1. Inspect the queue.\n2. Repair the worker.';
  const result = await commands.executeClaudeControl({ getPlan: async () => ({ exists: true, content, path: '/work/plan.md' }) }, 'plan', 'open');
  assert.match(result.text, /# Native plan\n\n1\. Inspect/);
  assert.doesNotMatch(result.text, /```json|\\n/);
  assert.match((await commands.executeClaudeControl({ getPlan: async () => ({ exists: false }) }, 'plan', 'open')).text, /No native plan/i);
});

test('permission, skill, memory and hook panels use native lists without configuration dumps', async () => {
  const fixtures = [
    ['permissions', 'listPermissionRules', { state: { originalCwd: '/work', managedOnly: true, rules: [{ behavior: 'allow', rule: 'Read(*)', source: 'projectSettings' }], workspaceDirectories: ['/work/other'] } }, /allow: Read\(\*\).*projectSettings/],
    ['skills', 'getSkillsDialog', { skills: [{ name: 'review', description: 'Review changed code', state: 'on', source: 'projectSettings', filePath: '/work/SKILL.md' }] }, /review.*on.*Review changed code/],
    ['memory', 'getMemoryDialog', { files: [{ label: 'Project instructions', path: '/work/CLAUDE.md', exists: true }], folders: [{ label: 'Auto-memory', path: '/work/memory' }], memories: [], auto_memory: { enabled: true, status: 'on' } }, /Project instructions.*\/work\/CLAUDE.md/],
    ['hooks', 'getHooksListing', { events: ['PreToolUse'], hooks: [{ event: 'PreToolUse', matcher: 'Bash', source: 'projectSettings', type: 'command', command: 'env UNLABELED_SECRET=private-hook' }], policy: { allDisabled: true, managedOnly: false } }, /PreToolUse.*Bash/],
  ];
  for (const [name, method, response, expected] of fixtures) {
    const result = await commands.executeClaudeControl({ [method]: async () => response }, name);
    assert.match(result.text, expected);
    assert.doesNotMatch(result.text, /```json|private-hook/);
  }
});

test('MCP and plugin panels show safe names, states and counts without endpoints or environment', async () => {
  const mcp = await commands.executeClaudeControl({ mcpServerStatus: async () => [{ name: 'issues', status: 'needs-auth', scope: 'project', tools: [{ name: 'search' }], config: { url: 'https://secret-endpoint/?key=private', env: { PLAIN: 'private-env' } } }] }, 'mcp');
  assert.match(mcp.text, /issues.*needs-auth.*project/);
  assert.doesNotMatch(mcp.text, /secret-endpoint|private-env|```json/);
  const plugins = await commands.executeClaudeControl({ getSettings: async () => ({ effective: { enabledPlugins: { 'review@market': true, 'disabled@market': false }, env: { PLAIN: 'private-env' } } }) }, 'plugins');
  assert.match(plugins.text, /review@market.*enabled/);
  assert.match(plugins.text, /disabled@market.*disabled/);
  assert.doesNotMatch(plugins.text, /private-env|```json/);
});

test('context and usage controls request bounded summaries and present native totals', async () => {
  const context = await commands.executeClaudeControl({ getContextUsage: async options => {
    assert.deepEqual(options, { detail: 'summary' });
    return { model: 'sonnet', totalTokens: 1500, rawMaxTokens: 200000, percentage: 1, categories: [{ name: 'Messages', tokens: 1000, kind: 'used' }] };
  } }, 'context');
  assert.match(context.text, /1,500.*200,000/);
  assert.match(context.text, /Messages.*1,000/);
  const usage = await commands.executeClaudeControl({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async options => {
    assert.deepEqual(options, { skipBehaviors: true });
    return { session: { total_cost_usd: 0.123, total_duration_ms: 2400, total_api_duration_ms: 1000, model_usage: { sonnet: { inputTokens: 300, outputTokens: 50 } } }, rate_limits_available: false, rate_limits: null };
  } }, 'usage');
  assert.match(usage.text, /\$0\.123/);
  assert.match(usage.text, /300.*50/);
  assert.match(usage.text, /plan rate limits.*unavailable/i);
  assert.doesNotMatch(usage.text, /```json/);
});

test('native method capability and policy gates remain actionable and redact credentials', async () => {
  await assert.rejects(commands.executeClaudeControl({}, 'status'), error => error.code === 'CLAUDE_COMMAND_UNSUPPORTED' && /host|version|update/i.test(error.message));
  await assert.rejects(commands.executeClaudeControl({ getStatus: async () => { throw Error('This feature requires a Claude.ai account. Authorization: Bearer fixture-secret'); } }, 'status'), error => /requires a Claude.ai account/.test(error.message) && !/fixture-secret/.test(error.message));
});

test('task stop requires an observed live task from the selected worker', async () => {
  const execute = requireHelper('executeClaudeTaskControl');
  const stopped = [], nativeTasks = [{ id: 'owned-1', status: 'running', description: 'Inspect repo' }, { id: 'done', status: 'completed' }];
  const query = { stopTask: async id => stopped.push(id) };
  const result = await execute(query, { name: 'tasks', args: 'stop owned-1' }, { nativeTasks });
  assert.deepEqual(stopped, ['owned-1']);
  assert.equal(nativeTasks[0].status, 'running', 'native task notification owns terminal state');
  assert.match(result.text, /stop requested.*owned-1/i);
  for (const args of ['stop foreign', 'stop done', 'stop owned-1 extra', 'kill owned-1', 'stop ../owned-1', 'stop']) {
    await assert.rejects(execute(query, { name: 'tasks', args }, { nativeTasks }), /observed|active|Usage/);
  }
  for (const task of [{ id: 'ended', status: 'running', processEnded: true }, { id: 'unknown', status: 'unknown' }]) {
    await assert.rejects(execute(query, { name: 'tasks', args: `stop ${task.id}` }, { nativeTasks: [task] }), /active/);
  }
  assert.deepEqual(stopped, ['owned-1']);
  const listing = await execute(query, { name: 'tasks', args: '' }, { nativeTasks });
  assert.match(listing.text, /owned-1/);
  assert.doesNotMatch(listing.text, /persists|continue.*background/i);
});

test('task stop observes cancellation and reports native errors without claiming success', async () => {
  const execute = requireHelper('executeClaudeTaskControl'), controller = new AbortController();
  controller.abort();
  let calls = 0;
  const nativeTasks = [{ id: 'owned', status: 'running' }];
  await assert.rejects(execute({ stopTask: async () => calls++ }, { name: 'tasks', args: 'stop owned' }, { nativeTasks, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(execute({}, { name: 'tasks', args: 'stop owned' }, { nativeTasks }), { code: 'CLAUDE_COMMAND_UNSUPPORTED' });
});

test('session options validate known keys and map to the SDK without file settings writes', () => {
  const normalize = requireHelper('normalizeClaudeSessionOptions'), toQuery = requireHelper('claudeSessionQueryOptions');
  const options = { effort: 'high', thinking: { type: 'enabled', budgetTokens: 2048, display: 'summarized' }, outputStyle: 'Concise' };
  assert.deepEqual(normalize(options), options);
  assert.deepEqual(toQuery(options), { effort: 'high', thinking: options.thinking, settings: { outputStyle: 'Concise' } });
  for (const value of [{ effort: 'ultracode' }, { thinking: { type: 'enabled', budgetTokens: -1 } }, { thinking: { type: 'enabled', budgetTokens: 1.5 } }, { thinking: { type: 'disabled', budgetTokens: 100 } }, { thinking: { type: 'adaptive', display: 'highlights' } }, { outputStyle: '../bad' }, { outputStyle: '' }, { env: { KEY: 'secret' } }]) {
    assert.throws(() => normalize(value), /effort|thinking|output.style|unsupported/i);
  }
  assert.throws(() => normalize({ effort: 'max' }, { modelInfo: { supportsEffort: true, supportedEffortLevels: ['low', 'high'] } }), /model.*support|supported.*model/i);
  assert.throws(() => normalize({ thinking: { type: 'adaptive' } }, { modelInfo: { supportsAdaptiveThinking: false } }), /adaptive/i);
  assert.throws(() => normalize({ outputStyle: 'Missing' }, { availableOutputStyles: ['default', 'Concise'] }), /available|supported/i);
});

test('session option mutations use only the native flag layer and return an app persistence patch', async () => {
  const execute = requireHelper('executeClaudeSessionOptionControl');
  const flags = [], thinking = [];
  const query = { applyFlagSettings: async value => flags.push(value), setMaxThinkingTokens: async (...value) => thinking.push(value), initializationResult: async () => ({ available_output_styles: ['default', 'Concise'] }) };
  const effort = await execute(query, 'effort', 'high');
  assert.deepEqual(flags, [{ effortLevel: 'high' }]);
  assert.deepEqual(effort.settingsPatch, { claudeOptions: { effort: 'high' } });
  assert.match(effort.text, /this chat|session/i);
  const style = await execute(query, 'output-style', 'Concise');
  assert.deepEqual(style.settingsPatch, { claudeOptions: { outputStyle: 'Concise' } });
  const result = await execute(query, 'thinking', '2048');
  assert.deepEqual(thinking, [[2048]]);
  assert.deepEqual(result.settingsPatch, { claudeOptions: { thinking: { type: 'enabled', budgetTokens: 2048 } } });
  for (const [name, args] of [['effort', 'invalid'], ['thinking', '-1'], ['thinking', '1.5'], ['output-style', 'Missing']]) await assert.rejects(execute(query, name, args));
  assert.equal(flags.length, 2);
  assert.equal(thinking.length, 1);
});

test('capture reads only whitelisted native applied options after builtin commands', async () => {
  const capture = requireHelper('captureClaudeSessionOptions');
  const result = await capture({ getSettings: async () => ({ applied: { effort: 'xhigh', model: 'sonnet', env: { API_KEY: 'secret' }, extra: 'private' }, effective: { outputStyle: 'Concise', alwaysThinkingEnabled: false, env: { API_KEY: 'secret' } } }) }, { command: 'effort', currentOptions: { thinking: { type: 'disabled' } } });
  assert.deepEqual(result, { thinking: { type: 'disabled' }, effort: 'xhigh' });
  const style = await capture({ getSettings: async () => ({ applied: {}, effective: { outputStyle: 'Concise' } }) }, { command: 'output-style' });
  assert.deepEqual(style, { outputStyle: 'Concise' });
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
});

test('explicit auto effort resets after native initialization while omitted effort inherits settings', async () => {
  const reset = requireHelper('applyClaudeSessionResets');
  const flags = [];
  assert.deepEqual(controls.claudeSessionQueryOptions({ effort: null }), {});
  await reset({ applyFlagSettings: async value => flags.push(value) }, {});
  assert.deepEqual(flags, []);
  await reset({ applyFlagSettings: async value => flags.push(value) }, { effort: null });
  assert.deepEqual(flags, [{ effortLevel: null }]);
});

test('successful explicit effort auto preserves reset intent when native applied effort resolves to high', async () => {
  const query = { getSettings: async () => ({ applied: { effort: 'high' } }), applyFlagSettings: async value => assert.deepEqual(value, { effortLevel: null }) };
  assert.deepEqual(await controls.captureClaudeSessionOptions(query, { command: 'effort', args: 'auto' }), { effort: null });
  const response = await controls.executeClaudeSessionOptionControl(query, 'effort', 'auto');
  assert.deepEqual(response.settingsPatch.claudeOptions, { effort: null });
});

test('session effort reports and persists the native applied value after model or policy clamping', async () => {
  const result = await controls.executeClaudeSessionOptionControl({
    applyFlagSettings: async () => {}, getSettings: async () => ({ applied: { effort: 'high' } }),
  }, 'effort', 'max');
  assert.equal(result.settingsPatch.claudeOptions.effort, 'high');
  assert.match(result.text, /native.*high|high.*native/i);
});

test('thinking on and off can use native flag settings only when the token control is absent', async () => {
  const applied = [], query = { applyFlagSettings: async value => applied.push(value) };
  const result = await controls.executeClaudeSessionOptionControl(query, 'thinking', 'off');
  assert.deepEqual(result.settingsPatch.claudeOptions.thinking, { type: 'disabled' });
  assert.deepEqual(applied, [{ alwaysThinkingEnabled: false }]);
  await assert.rejects(controls.executeClaudeSessionOptionControl(query, 'thinking', '2048'), { code: 'CLAUDE_COMMAND_UNSUPPORTED' });
  assert.equal(applied.length, 1);
});

test('native controls release an aborted waiter even when the query response never settles', async () => {
  const controller = new AbortController();
  const result = controls.callClaudeNativeControl({ getStatus: () => new Promise(() => {}) }, 'status', 'getStatus', [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('hook presentation uses native disabled state without exposing executable hook content', () => {
  const result = controls.formatClaudeNativeControl('hooks', { hooks: [{ event: 'PreToolUse', matcher: 'Bash', type: 'command', sourceLabel: 'Project settings', disabled: true, displayText: 'private-command', commandText: 'private-command', editable: { config: { command: 'private-command' } } }] });
  assert.match(result.text, /PreToolUse.*disabled/);
  assert.match(result.text, /Project settings/);
  assert.doesNotMatch(result.text, /private-command/);
});

test('adaptive live thinking requires affirmative model capability because the legacy setter only toggles old models', async () => {
  let calls = 0;
  await assert.rejects(controls.executeClaudeSessionOptionControl({ setMaxThinkingTokens: async () => calls++ }, 'thinking', 'adaptive'), /adaptive.*capability|capability.*adaptive/i);
  assert.equal(calls, 0);
  const result = await controls.executeClaudeSessionOptionControl({ setMaxThinkingTokens: async value => { calls++; assert.equal(value, null); } }, 'thinking', 'adaptive', { modelInfo: { supportsAdaptiveThinking: true } });
  assert.equal(calls, 1);
  assert.deepEqual(result.settingsPatch.claudeOptions.thinking, { type: 'adaptive' });
});
