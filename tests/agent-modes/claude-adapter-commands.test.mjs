import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../../runtime/agent-modes/claude-adapter.mjs';
import { ClaudeEventNormalizer } from '../../runtime/agent-modes/claude-events.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 4000 }, fn);
const oldSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const newSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const result = extra => ({ type: 'result', subtype: 'success', is_error: false, session_id: oldSession, result: 'Done', num_turns: 0, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function runWith(queryImpl, options = {}, adapterOptions = {}) {
  const events = [];
  const adapter = new ClaudeAdapter({ environment: () => ({}), queryImpl, ...adapterOptions });
  return { adapter, events, run: adapter.start({ cwd: '/tmp', prompt: 'Hello', onEvent: event => events.push(event), ...options }) };
}
function sequence(envelopes, observed = {}, methods = {}) {
  return request => {
    observed.request = request;
    const stream = (async function* () { yield* envelopes; })();
    stream.close = () => { observed.closed = true; };
    return Object.assign(stream, methods);
  };
}

test('native context accounting times out and reclaims its query without fabricating usage', async () => {
  const observed = { interrupted: 0, closed: 0, returned: 0 };
  const { run, events } = runWith(() => ({
    next: () => new Promise(() => {}),
    async interrupt() { observed.interrupted++; },
    close() { observed.closed++; },
    async return() { observed.returned++; return { done: true }; },
  }), { nativeSessionId: oldSession, command: { name: 'context', origin: 'builtin', execution: 'native', input: '/context' } }, { contextTimeoutMs: 15 });
  const summary = await run.done;
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /native context accounting.*timed out/i);
  assert.equal(summary.nativeSessionId, oldSession);
  assert.equal(summary.usage, undefined);
  assert.deepEqual(observed, { interrupted: 1, closed: 1, returned: 1 });
  assert.equal(events.filter(event => event.type === 'result').length, 1);
});

for (const originalSessionId of [undefined, oldSession]) {
  test(`unacknowledged context timeout restores ${originalSessionId ? 'the existing' : 'an empty'} native binding`, async () => {
    let initialized = false;
    const { run } = runWith(() => ({
      next() {
        if (!initialized) { initialized = true; return Promise.resolve({ value: { type: 'system', subtype: 'init', session_id: newSession } }); }
        return new Promise(() => {});
      },
      async interrupt() {}, close() {}, async return() { return { done: true }; },
    }), { nativeSessionId: originalSessionId, command: { name: 'context', origin: 'builtin', execution: 'native', input: '/context' } }, { contextTimeoutMs: 15 });
    const summary = await run.done;
    assert.equal(summary.status, 'failed');
    assert.equal(summary.sessionIdToRestore, originalSessionId ?? null);
  });
}

test('failed acknowledged commands retain their materialized native session', async () => {
  const { run } = runWith(sequence([
    { type: 'system', subtype: 'init', session_id: newSession },
    { type: 'assistant', session_id: newSession, message: { id: 'answer', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Started the review' }] } },
    result({ session_id: newSession, subtype: 'error_during_execution', is_error: true, errors: ['Review failed'] }),
  ]), { command: { name: 'review', origin: 'skill', execution: 'native', input: '/review' } });
  const summary = await run.done;
  assert.equal(summary.status, 'failed');
  assert.equal(summary.nativeSessionId, newSession);
  assert.equal(Object.hasOwn(summary, 'sessionIdToRestore'), false);
});

test('interrupted unacknowledged commands restore their original native session', async () => {
  let release, initialized;
  const waiting = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { initialized = resolve; });
  const { run } = runWith(() => {
    const stream = (async function* () { yield { type: 'system', subtype: 'init', session_id: newSession }; initialized(); await waiting; })();
    stream.interrupt = async () => { release(); };
    stream.close = () => { release(); };
    return stream;
  }, { nativeSessionId: oldSession, command: { name: 'review', origin: 'skill', execution: 'native', input: '/review' } });
  await ready;
  const summary = await run.interrupt();
  assert.equal(summary.status, 'interrupted');
  assert.equal(summary.sessionIdToRestore, oldSession);
});

test('the context accounting deadline does not limit inference or a skill named context', async () => {
  for (const command of [undefined, { name: 'context', origin: 'skill', execution: 'native', input: '/context' }]) {
    const { run } = runWith(() => {
      const stream = (async function* () { await new Promise(resolve => setTimeout(resolve, 30)); yield result(); })();
      stream.close = () => {};
      return stream;
    }, { command }, { contextTimeoutMs: 5 });
    assert.equal((await run.done).status, 'completed');
  }
});

for (const command of [
  { name: 'rewind', execution: 'control', args: `${oldSession} --apply` },
  { name: 'config', origin: 'builtin', execution: 'native', args: 'disableAllHooks=false' },
  { name: 'mcp', origin: 'builtin', execution: 'native', args: 'enable server' },
  { name: 'reload-plugins', origin: 'builtin', execution: 'native', args: '' },
  { name: 'output-style', origin: 'builtin', execution: 'native', args: 'Concise' },
]) {
  test(`read roles reject mutating /${command.name} commands before native startup`, async () => {
    let calls = 0;
    const { run } = runWith(() => {
      calls++;
      const stream = (async function* () { yield result(); })();
      return Object.assign(stream, { initializationResult: async () => ({}), rewindFiles: async () => ({ canRewind: true }), close() {} });
    }, { access: 'read', permissionMode: 'bypassPermissions', command });
    const summary = await run.done;
    assert.equal(summary.status, 'failed');
    assert.match(summary.error, /read.only|write access/i);
    assert.equal(calls, 0);
  });
}

test('control commands initialize without a user turn and retain only the existing session identity', async () => {
  const observed = {};
  const { run, events } = runWith(request => {
    observed.request = request;
    observed.input = request.prompt[Symbol.asyncIterator]().next();
    return {
      async initializationResult() { observed.initialized = true; return {}; },
      async getStatus() { assert.equal(observed.initialized, true); return { sections: [{ title: 'Claude status' }] }; },
      next() { throw Error('A control query must not wait for a model turn'); },
      close() { observed.closed = true; }, async return() { return { done: true }; },
    };
  }, { nativeSessionId: oldSession, prompt: '/status', command: { name: 'status', control: 'status', execution: 'control', args: '' } });
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.equal(summary.nativeSessionId, oldSession);
  assert.equal((await observed.input).done, true);
  assert.equal(events.filter(event => event.type === 'message-completed').length, 1);
  assert.equal(events.some(event => event.type === 'session'), false);
  assert.equal(observed.closed, true);
});

test('fresh control command does not fabricate a resumable native session', async () => {
  const { run } = runWith(() => ({ initializationResult: async () => ({}), getStatus: async () => ({ sections: [] }), close() {}, async return() { return { done: true }; } }),
    { prompt: '/status', command: { name: 'status', execution: 'control' } });
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.equal(summary.nativeSessionId, undefined);
});

test('export passes its full transcript download through the terminal summary', async () => {
  const transcript = 'Native conversation. '.repeat(500);
  const { run, events } = runWith(() => ({ initializationResult: async () => ({}), exportConversation: async () => ({ text: transcript, default_filename: 'native.txt' }), close() {}, async return() { return { done: true }; } }),
    { command: { name: 'export', execution: 'control', args: 'chosen.txt' } });
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.deepEqual(summary.clientAction, { type: 'download', text: transcript, filename: 'chosen.txt' });
  assert.equal(summary.text, 'Native Claude transcript ready to download.');
  assert.deepEqual(events.find(event => event.type === 'result').clientAction, summary.clientAction);
});

test('repeated controls create distinct transcript item IDs', async () => {
  const ids = [];
  for (let index = 0; index < 2; index++) {
    const { run, events } = runWith(() => ({ initializationResult: async () => ({}), getStatus: async () => ({ sections: [] }), close() {}, async return() { return { done: true }; } }), { command: { name: 'status', execution: 'control' } });
    await run.done;
    ids.push(events.find(event => event.type === 'message-completed').id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('control initialization errors do not expose provider credentials', async () => {
  const { run } = runWith(() => ({ initializationResult() { throw Error('Authorization: Bearer fixture-secret'); }, close() {}, async return() { return { done: true }; } }), { command: { name: 'status', execution: 'control' } });
  const summary = await run.done;
  assert.equal(summary.status, 'failed');
  assert.doesNotMatch(summary.error, /fixture-secret/);
});

test('native commands preserve the exact resolved input without workflow wrapping', async () => {
  let input;
  const { run } = runWith(request => {
    const stream = (async function* () { input = await request.prompt[Symbol.asyncIterator]().next(); yield result({ local_command: 'context' }); })();
    stream.close = () => {};
    return stream;
  }, { prompt: 'wrapped workflow prompt', command: { name: 'context', execution: 'native', input: '/context  exact arguments' } });
  await run.done;
  assert.equal(input.value?.message.content, '/context  exact arguments');
});

test('Claude session options reach query without weakening read-role hook isolation', async () => {
  const observed = {}, claudeOptions = { effort: 'high', thinking: { type: 'disabled' }, outputStyle: 'Concise' };
  const { run } = runWith(sequence([result()], observed), { access: 'read', claudeOptions });
  assert.equal((await run.done).status, 'completed');
  assert.equal(observed.request.options.effort, 'high');
  assert.deepEqual(observed.request.options.thinking, { type: 'disabled' });
  assert.deepEqual(observed.request.options.settings, { outputStyle: 'Concise', disableAllHooks: true });
  assert.deepEqual(claudeOptions, { effort: 'high', thinking: { type: 'disabled' }, outputStyle: 'Concise' });
});

test('explicit auto effort initializes and resets before the first native input is released', async () => {
  const order = []; let initialize, reset, input;
  const initialized = new Promise(resolve => { initialize = resolve; });
  const resetDone = new Promise(resolve => { reset = resolve; });
  const { run } = runWith(request => {
    input = request.prompt[Symbol.asyncIterator]().next().then(value => { order.push(value.done ? 'input-closed' : 'input'); return value; });
    const stream = (async function* () { await input; yield result(); })();
    return Object.assign(stream, { initializationResult: async () => { order.push('initialize'); await initialized; return {}; }, applyFlagSettings: async value => { assert.deepEqual(value, { effortLevel: null }); order.push('reset'); await resetDone; }, close() { order.push('close'); } });
  }, { claudeOptions: { effort: null } });
  await tick(); assert.deepEqual(order, ['initialize']);
  initialize(); await tick(); assert.deepEqual(order, ['initialize', 'reset']);
  reset(); assert.equal((await run.done).status, 'completed');
  assert.deepEqual(order, ['initialize', 'reset', 'input', 'close']);
});

test('Stop while auto-effort initialization is pending closes input without sending a prompt', async () => {
  let input, resets = 0;
  const { run } = runWith(request => {
    input = request.prompt[Symbol.asyncIterator]().next();
    return { initializationResult: () => new Promise(() => {}), applyFlagSettings: async () => resets++, close() {}, async interrupt() {}, async return() { return { done: true }; }, next() { throw Error('first input was released'); } };
  }, { claudeOptions: { effort: null } });
  await tick(); await run.interrupt();
  assert.equal((await run.done).status, 'interrupted');
  assert.equal((await input).done, true);
  assert.equal(resets, 0);
});

test('only successful builtin effort and output-style results capture native settings before close', async () => {
  for (const name of ['effort', 'output-style']) {
    const order = [];
    const { run } = runWith(request => {
      const stream = (async function* () { await request.prompt[Symbol.asyncIterator]().next(); order.push('result'); yield result({ local_command: name === 'output-style' ? 'output_style' : name }); })();
      return Object.assign(stream, { initializationResult: async () => ({ available_output_styles: ['default', 'Concise'] }), getSettings: async () => { order.push('settings'); return { applied: { effort: 'xhigh' }, effective: { outputStyle: 'Concise', env: { SECRET: 'fixture-secret' } } }; }, close() { order.push('close'); } });
    }, { claudeOptions: { thinking: { type: 'disabled' } }, command: { name, origin: 'builtin', execution: 'native', input: `/${name} ${name === 'effort' ? 'max' : 'concise'}` } });
    const summary = await run.done;
    assert.equal(summary.status, 'completed');
    assert.deepEqual(summary.settingsPatch.claudeOptions, { thinking: { type: 'disabled' }, ...(name === 'effort' ? { effort: 'xhigh' } : { outputStyle: 'Concise' }) });
    assert.deepEqual(order, ['result', 'settings', 'close']);
    assert.doesNotMatch(JSON.stringify(summary), /fixture-secret/);
  }
  for (const extra of [{ origin: 'skill', terminal: result({ local_command: 'effort' }) }, { origin: 'builtin', terminal: result({ local_command: 'effort', is_error: true, subtype: 'error_during_execution', errors: ['failure'] }) }]) {
    let reads = 0;
    const { run } = runWith(sequence([extra.terminal], {}, { getSettings: async () => { reads++; return { applied: { effort: 'high' } }; } }), { command: { name: 'effort', origin: extra.origin, execution: 'native', input: '/effort high' } });
    const summary = await run.done;
    assert.equal(reads, 0);
    assert.equal(summary.settingsPatch?.claudeOptions, undefined);
  }
});

test('fallback session controls merge options from their frozen native binding', async () => {
  const { run } = runWith(() => ({ initializationResult: async () => ({}), setMaxThinkingTokens: async value => assert.equal(value, 0), close() {}, async return() { return { done: true }; } }),
    { claudeOptions: { effort: 'high' }, command: { name: 'thinking', origin: 'app', execution: 'control', args: 'off' } });
  assert.deepEqual((await run.done).settingsPatch.claudeOptions, { effort: 'high', thinking: { type: 'disabled' } });
});

test('native option inspections and invalid arguments never create app session overrides', async () => {
  for (const name of ['effort', 'output-style']) {
    for (const args of ['', 'current', 'status', 'help', 'list', 'not-a-setting']) {
    let reads = 0;
    const { run } = runWith(sequence([result({ local_command: name === 'output-style' ? 'output_style' : name })], {}, {
      initializationResult: async () => ({ available_output_styles: ['default', 'Concise'] }),
      getSettings: async () => { reads++; return { applied: { effort: 'high' }, effective: { outputStyle: 'Concise' } }; },
    }), { command: { name, origin: 'builtin', execution: 'native', args, input: `/${name}${args ? ` ${args}` : ''}` } });
    const summary = await run.done;
    assert.equal(summary.status, 'completed');
    assert.equal(summary.settingsPatch?.claudeOptions, undefined);
    assert.equal(reads, 0);
    }
  }
});

test('a native output-style change does not shadow its file setting with the previous app flag', async () => {
  const order = []; let fileStyle = 'default';
  const { run } = runWith(request => {
    assert.equal(request.options.settings?.outputStyle, undefined);
    const flag = request.options.settings?.outputStyle;
    const stream = (async function* () { await request.prompt[Symbol.asyncIterator]().next(); order.push('input'); fileStyle = 'Explanatory'; yield result({ local_command: 'output_style' }); })();
    return Object.assign(stream, { initializationResult: async () => { order.push('initialized'); return { available_output_styles: ['default', 'Concise', 'Explanatory'] }; }, applyFlagSettings: async () => assert.fail('native null cannot clear initial inline settings in this installed version'), getSettings: async () => ({ effective: { outputStyle: flag ?? fileStyle } }), close() {} });
  }, { claudeOptions: { outputStyle: 'Concise' }, command: { name: 'output-style', origin: 'builtin', execution: 'native', args: 'explanatory', input: '/output-style explanatory' } });
  assert.equal((await run.done).settingsPatch.claudeOptions.outputStyle, 'Explanatory');
  assert.deepEqual(order, ['initialized', 'input']);
});

test('a native output-style file write failure cannot replace the existing app override', async () => {
  const { run } = runWith(sequence([result({ local_command: 'output_style', result: 'Could not save output style: policy denied' })], {}, {
    initializationResult: async () => ({ available_output_styles: ['default', 'Concise', 'Explanatory'] }),
    applyFlagSettings: async () => {}, getSettings: async () => ({ effective: { outputStyle: 'default' } }),
  }), { claudeOptions: { outputStyle: 'Concise' }, command: { name: 'output-style', origin: 'builtin', execution: 'native', args: 'Explanatory', input: '/output-style Explanatory' } });
  const summary = await run.done;
  assert.equal(summary.settingsPatch?.claudeOptions, undefined);
  assert.match(summary.text, /Could not save/);
});

test('read-role output-style inspection aliases cannot hide a configured style mutation', async () => {
  let input, calls = 0;
  const { run } = runWith(request => {
    input = request.prompt[Symbol.asyncIterator]().next();
    return { initializationResult: async () => ({ available_output_styles: ['default', 'help'] }), applyFlagSettings: async () => calls++, next() { throw Error('native input should remain gated'); }, close() {}, async return() { return { done: true }; } };
  }, { access: 'read', command: { name: 'output-style', origin: 'builtin', execution: 'native', args: 'help', input: '/output-style help' } });
  const summary = await run.done;
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /read.only|write access/);
  assert.equal(calls, 0);
  assert.equal((await input).done, true);
});

test('synthetic workflow prompts retain native provenance metadata', async () => {
  let input;
  const { run } = runWith(request => {
    const stream = (async function* () { input = await request.prompt[Symbol.asyncIterator]().next(); yield result(); })();
    stream.close = () => {};
    return stream;
  }, { prompt: '/clear is quoted workflow input', synthetic: true });
  await run.done;
  assert.equal(input.value.isSynthetic, true);
  assert.equal(input.value.client_composed, undefined);
  assert.equal(input.value.message.content, '/clear is quoted workflow input');
});

test('headless model changes are read from native applied settings before process shutdown', async () => {
  const order = [];
  const { run } = runWith(request => {
    const stream = (async function* () { yield { type: 'system', subtype: 'init', session_id: oldSession, model: 'claude-old' }; order.push('result'); yield result({ local_command: 'model', result: 'Set model for this session only' }); })();
    stream.getSettings = async () => { order.push('settings'); return { applied: { model: 'claude-new' }, effective: { model: 'claude-old', env: { API_KEY: 'secret' } } }; };
    stream.close = () => { order.push('close'); };
    return stream;
  }, { prompt: '/model new', command: { name: 'model', execution: 'native' } });
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.deepEqual(summary.settingsPatch, { model: 'claude-new' });
  assert.equal(summary.actualModel, 'claude-new');
  assert.deepEqual(order, ['result', 'settings', 'close']);
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
});

test('config model changes follow applied native state and mode status survives per-run queries', async () => {
  const { run } = runWith(sequence([
    { type: 'system', subtype: 'init', session_id: oldSession, permissionMode: 'default' },
    { type: 'system', subtype: 'status', session_id: oldSession, status: null, permissionMode: 'plan' },
    result({ local_command: 'config' }),
  ], {}, { getSettings: async () => ({ applied: { model: 'sonnet' } }) }),
  { prompt: '/config model=sonnet', command: { name: 'config', execution: 'native', args: 'model=sonnet' } });
  const summary = await run.done;
  assert.deepEqual(summary.settingsPatch, { model: 'sonnet', permissionMode: 'plan' });
});

test('plan controls return a native permission setting for the host to persist', async () => {
  const { run } = runWith(() => ({ initializationResult: async () => ({}), setPermissionMode: async mode => assert.equal(mode, 'plan'), close() {}, async return() { return { done: true }; } }),
    { command: { name: 'plan', execution: 'control' } });
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.deepEqual(summary.settingsPatch, { permissionMode: 'plan' });
  assert.equal(summary.actualPermissionMode, 'plan');
});

test('unavailable native slash commands fail even when CLI marks a zero-turn result successful', async () => {
  const { run } = runWith(sequence([result({ result: "/status isn't available in this environment." })]), { prompt: '/status', command: { name: 'status', execution: 'native' } });
  const summary = await run.done;
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /available/);
});

test('interrupt during control initialization closes input and settles without calling a control', async () => {
  let created = false, called = false, release;
  const pending = new Promise(resolve => { release = resolve; });
  const { run } = runWith(() => { created = true; return {
    initializationResult: () => pending, getStatus: async () => { called = true; return {}; },
    close() { release({}); }, async return() { return { done: true }; }, async interrupt() {},
  }; }, { command: { name: 'status', execution: 'control' } });
  while (!created) await tick();
  const summary = await run.interrupt();
  assert.equal(summary.status, 'interrupted');
  assert.equal(called, false);
});

test('SDK file checkpointing is enabled for future native rewind', async () => {
  const observed = {};
  await runWith(sequence([result()], observed)).run.done;
  assert.equal(observed.request.options.enableFileCheckpointing, true);
});

test('conversation reset remaps session ownership and emits one context-reset event', () => {
  const events = [], normalizer = new ClaudeEventNormalizer({ onEvent: event => events.push(event) });
  normalizer.nativeSessionId = oldSession;
  const reset = { type: 'conversation_reset', uuid: 'reset', session_id: oldSession, new_conversation_id: newSession, trigger: 'clear', user_message_uuid: 'clear-user' };
  normalizer.consume(reset); normalizer.consume(reset);
  const summary = normalizer.consume(result({ session_id: newSession, local_command: 'clear', result: '' }));
  assert.equal(summary.nativeSessionId, newSession);
  assert.equal(summary.contextReset, true);
  assert.equal(events.filter(event => event.type === 'context-reset').length, 1);
  assert.equal(events.find(event => event.type === 'context-reset').sessionId, newSession);
});

test('native result-only and local-command output render once without duplicating assistant text', () => {
  const events = [], normalizer = new ClaudeEventNormalizer({ onEvent: event => events.push(event) });
  normalizer.consume({ type: 'system', subtype: 'local_command_output', uuid: 'local', content: 'Native output' });
  normalizer.consume(result({ result: 'Native output', local_command: 'usage' }));
  assert.deepEqual(events.filter(event => event.type === 'message-completed').map(event => event.text), ['Native output']);
  const second = [], other = new ClaudeEventNormalizer({ onEvent: event => second.push(event) });
  other.consume(result({ result: 'Result only' }));
  assert.deepEqual(second.filter(event => event.type === 'message-completed').map(event => event.text), ['Result only']);
});

test('adapter command catalogs close together with model catalogs', async () => {
  const adapter = new ClaudeAdapter({ environment: () => ({}), queryImpl: () => ({ supportedCommands: async () => [{ name: 'new-command' }], close() {}, async return() { return { done: true }; } }) });
  assert.equal(typeof adapter.listCommands, 'function');
  assert.ok((await adapter.listCommands({ cwd: '/tmp' })).commands.some(row => row.name === 'new-command'));
  await adapter.close();
  await assert.rejects(adapter.listCommands({ cwd: '/tmp' }), /closed/);
});

test('Remote Control keeps its owned query active across native turn results until Stop', async () => {
  let closed = false, release, reached;
  const waiting = new Promise(resolve => { release = resolve; });
  const streamed = new Promise(resolve => { reached = resolve; });
  const { run, events } = runWith(() => {
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: oldSession };
      yield result({ uuid: 'remote-first', result: 'First remote answer' });
      yield result({ uuid: 'remote-second', result: 'Second remote answer' });
      reached();
      await waiting;
    })();
    stream.initializationResult = async () => ({});
    stream.enableRemoteControl = async () => ({ url: 'https://claude.ai/code/session-fixture' });
    stream.interrupt = async () => { release(); };
    stream.close = () => { closed = true; release(); };
    return stream;
  }, { command: { name: 'remote-control', execution: 'control' } }, { contextTimeoutMs: 5 });
  let settled = false;
  run.done.then(() => { settled = true; });
  await Promise.race([streamed, run.done]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(closed, false);
  assert.equal(events.some(event => event.type === 'result'), false);
  const texts = events.filter(event => event.type === 'message-completed').map(event => event.text);
  assert.ok(texts.some(text => text.includes('https://claude.ai')));
  assert.ok(texts.includes('First remote answer'));
  assert.ok(texts.includes('Second remote answer'));
  const summary = await run.interrupt();
  assert.equal(summary.status, 'interrupted');
  assert.equal(closed, true);
});
