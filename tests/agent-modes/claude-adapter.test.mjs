import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ClaudeAdapter } from '../../runtime/agent-modes/claude-adapter.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);

const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cwd = '/workspace/project';
const executable = '/native/bin/claude';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; };
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, uuid: 'result-uuid', session_id: session, duration_ms: 12, duration_api_ms: 10, num_turns: 1, stop_reason: 'end_turn', result: 'Done', usage: { input_tokens: 12, output_tokens: 4 }, modelUsage: {}, total_cost_usd: 0, permission_denials: [], ...extra });
const init = { type: 'system', subtype: 'init', uuid: 'init-uuid', session_id: session, cwd, tools: ['Bash'], mcp_servers: [], model: 'claude-sonnet-4-6', permissionMode: 'default', apiKeySource: 'none', slash_commands: [], output_style: 'default', skills: [], plugins: [], claude_code_version: '2.1.283' };
function scripted(events, observed = {}) {
  return (request) => {
    observed.request = request;
    const iterator = (async function* () { for (const event of events) yield event; })();
    const originalReturn = iterator.return.bind(iterator);
    iterator.interrupt = async () => { observed.interrupted = true; };
    iterator.close = () => { observed.closed = true; };
    iterator.return = async () => { observed.returned = true; return originalReturn(); };
    return iterator;
  };
}
function startWith(queryImpl, extra = {}) {
  const events = [];
  const adapter = new ClaudeAdapter({ executablePath: executable, queryImpl });
  const run = adapter.start({ prompt: 'Hello', cwd, onEvent: (event) => events.push(event), onPermission: async () => ({ decision: 'decline' }), ...extra });
  return { adapter, run, events };
}

test('start synchronously returns a run and preserves native session, cwd, model, and SDK security defaults', async () => {
  const observed = {};
  const { run, events } = startWith(scripted([init, result()], observed), { nativeSessionId: session, model: 'claude-sonnet-4-6' });
  assert.equal(typeof run.interrupt, 'function');
  assert.ok(run.done instanceof Promise);
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.equal(summary.nativeSessionId, session);
  assert.equal(summary.usage.output_tokens, 4);
  const options = observed.request.options;
  assert.equal(options.cwd, cwd);
  assert.equal(options.resume, session);
  assert.equal(options.model, 'claude-sonnet-4-6');
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.pathToClaudeCodeExecutable, executable);
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.equal(options.allowedTools, undefined);
  assert.ok(options.abortController instanceof AbortController);
  assert.equal(typeof observed.request.prompt[Symbol.asyncIterator], 'function');
  assert.equal(observed.closed, true);
  assert.equal(observed.returned, true);
  assert.deepEqual(events.at(-1), { type: 'result', ...summary });
});

test('streaming input contains precisely the prompt and remains open through interactive permissions', async () => {
  const observed = {};
  const promptRead = deferred();
  let nextInput;
  const queryImpl = (request) => {
    const iterator = (async function* () {
      const input = request.prompt[Symbol.asyncIterator]();
      observed.first = await input.next();
      let ended = false;
      nextInput = input.next().then((value) => { ended = true; return value; });
      await tick();
      observed.endedBeforeResult = ended;
      promptRead.resolve();
      yield result();
    })();
    iterator.close = () => {};
    iterator.interrupt = async () => {};
    return iterator;
  };
  const { run } = startWith(queryImpl, { nativeSessionId: session });
  await promptRead.promise;
  assert.equal(observed.first.value.type, 'user');
  assert.deepEqual(observed.first.value.message, { role: 'user', content: 'Hello' });
  assert.equal(observed.first.value.parent_tool_use_id, null);
  assert.equal(observed.first.value.session_id, session);
  assert.equal(observed.endedBeforeResult, false);
  await run.done;
  assert.equal((await nextInput).done, true);
});

test('translates permission accept and decline using the exact SDK toolUseID', async () => {
  const decisions = [{ decision: 'accept', updatedInput: { command: 'pwd' } }, { decision: 'decline' }, { decision: 'accept' }];
  const prompts = [];
  const answers = [];
  const sdkSignal = new AbortController();
  const queryImpl = (request) => {
    const iterator = (async function* () {
      for (let index = 0; index < decisions.length; index += 1) {
        answers.push(await request.options.canUseTool('Bash', { command: 'ls' }, { toolUseID: `tool-${index}`, requestId: `request-${index}`, signal: sdkSignal.signal, decisionReason: 'Safety check', suggestions: [] }));
      }
      yield result();
    })();
    iterator.close = () => {};
    iterator.interrupt = async () => {};
    return iterator;
  };
  const { run } = startWith(queryImpl, { onPermission: async (request) => { prompts.push(request); return decisions[prompts.length - 1]; } });
  await run.done;
  assert.equal(prompts[0].id, 'tool-0');
  assert.equal(prompts[0].name, 'Bash');
  assert.deepEqual(prompts[0].input, { command: 'ls' });
  assert.equal(prompts[0].reason, 'Safety check');
  assert.ok(prompts[0].signal instanceof AbortSignal);
  assert.deepEqual(answers[0], { behavior: 'allow', updatedInput: { command: 'pwd' }, toolUseID: 'tool-0' });
  assert.equal(answers[1].behavior, 'deny');
  assert.equal(answers[1].toolUseID, 'tool-1');
  assert.ok(answers[1].message);
  assert.deepEqual(answers[2], { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'tool-2' });
  assert.equal(getEventListeners(sdkSignal.signal, 'abort').length, 0);
});

test('fails permissions closed for missing, thrown, or malformed permission decisions', async () => {
  for (const onPermission of [undefined, async () => { throw new Error('UI unavailable'); }, async () => null, async () => ({ decision: 'accept', updatedInput: 'bad input' })]) {
    let answer;
    const queryImpl = (request) => {
      const iterator = (async function* () {
        answer = await request.options.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'tool-deny', requestId: 'request-deny', signal: new AbortController().signal });
        yield result();
      })();
      iterator.close = () => {};
      iterator.interrupt = async () => {};
      return iterator;
    };
    await startWith(queryImpl, { onPermission }).run.done;
    assert.equal(answer.behavior, 'deny');
    assert.equal(answer.toolUseID, 'tool-deny');
  }
});

test('abort before startup and same-tick interrupt avoid launching SDK', async () => {
  let launches = 0;
  const queryImpl = () => { launches += 1; throw new Error('must not launch'); };
  const signal = new AbortController();
  signal.abort();
  assert.equal((await startWith(queryImpl, { signal: signal.signal, nativeSessionId: session }).run.done).status, 'interrupted');
  const { run } = startWith(queryImpl);
  await run.interrupt();
  assert.equal((await run.done).status, 'interrupted');
  assert.equal(launches, 0);
});

test('abort during SDK initialization prevents a delayed native spawn', async () => {
  const initialized = deferred();
  const delayedSpawn = deferred();
  const externalSignal = new AbortController();
  let spawnAttempted = false;
  let spawned = false;
  const queryImpl = (request) => {
    const iterator = (async function* () {
      initialized.resolve();
      await delayedSpawn.promise;
      spawnAttempted = true;
      request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
      spawned = true;
    })();
    iterator.interrupt = async () => delayedSpawn.resolve();
    iterator.close = () => delayedSpawn.resolve();
    return iterator;
  };
  const { run } = startWith(queryImpl, { signal: externalSignal.signal });
  await initialized.promise;
  externalSignal.abort();
  assert.equal((await run.done).status, 'interrupted');
  assert.equal(spawnAttempted, true);
  assert.equal(spawned, false);
  assert.equal(getEventListeners(externalSignal.signal, 'abort').length, 0);
});

test('interrupt cancels a pending permission, retains partial output, and waits for SDK shutdown', async () => {
  const permissionShown = deferred();
  const sdkStopped = deferred();
  const sdkSignal = new AbortController();
  let permissionRequest;
  let permissionAnswer;
  let closeCalls = 0;
  let returnCalls = 0;
  let interruptCalls = 0;
  const queryImpl = (request) => {
    const iterator = (async function* () {
      yield init;
      yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'partial-message' } } };
      yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } } };
      permissionAnswer = await request.options.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'tool-pending', requestId: 'permission-pending', signal: sdkSignal.signal });
    })();
    const originalReturn = iterator.return.bind(iterator);
    iterator.interrupt = async () => { interruptCalls += 1; };
    iterator.close = () => { closeCalls += 1; };
    iterator.return = async () => { returnCalls += 1; await sdkStopped.promise; return originalReturn(); };
    return iterator;
  };
  const { run, events } = startWith(queryImpl, { onPermission: (request) => { permissionRequest = request; permissionShown.resolve(); return new Promise(() => {}); } });
  await permissionShown.promise;
  let done = false;
  run.done.then(() => { done = true; });
  const interrupted = run.interrupt();
  await tick();
  assert.equal(permissionRequest.signal.aborted, true);
  assert.equal(permissionAnswer.behavior, 'deny');
  assert.equal(permissionAnswer.interrupt, true);
  assert.equal(done, false);
  assert.equal(interruptCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(returnCalls, 1);
  sdkStopped.resolve();
  await interrupted;
  assert.equal((await run.done).status, 'interrupted');
  assert.equal(events.find((event) => event.type === 'message-completed').text, 'Partial');
  assert.equal(getEventListeners(sdkSignal.signal, 'abort').length, 0);
});

test('reports startup, iteration, and terminal SDK errors, including missing results', async () => {
  const queries = [
    () => { throw new Error('CLI executable missing'); },
    scripted([result({ subtype: 'error_during_execution', is_error: true, errors: ['Authentication required'] })]),
    scripted([init]),
    () => { const iterator = (async function* () { yield init; throw new Error('transport closed'); })(); iterator.close = () => {}; return iterator; },
  ];
  for (const queryImpl of queries) {
    const { run, events } = startWith(queryImpl);
    const summary = await run.done;
    assert.equal(summary.status, 'failed');
    assert.ok(summary.error);
    assert.equal(events.at(-1).status, 'failed');
  }
});

test('an unresponsive interrupt is followed by forced close and awaited cleanup', async () => {
  const waiting = deferred();
  const closed = deferred();
  let returned = false;
  const queryImpl = () => {
    const iterator = (async function* () { yield init; waiting.resolve(); await closed.promise; })();
    const originalReturn = iterator.return.bind(iterator);
    iterator.interrupt = () => new Promise(() => {});
    iterator.close = () => closed.resolve();
    iterator.return = async () => { returned = true; return originalReturn(); };
    return iterator;
  };
  const { run } = startWith(queryImpl);
  await waiting.promise;
  await run.interrupt();
  assert.equal(returned, true);
  assert.equal((await run.done).status, 'interrupted');
});

test('interruption retains any cleanup failure in its result', async () => {
  const waiting = deferred();
  const closed = deferred();
  const queryImpl = () => {
    const iterator = (async function* () { yield init; waiting.resolve(); await closed.promise; })();
    iterator.interrupt = async () => {};
    iterator.close = () => closed.resolve();
    iterator.return = async () => { throw new Error('exit not observed'); };
    return iterator;
  };
  const { run } = startWith(queryImpl);
  await waiting.promise;
  const summary = await run.interrupt();
  assert.equal(summary.status, 'interrupted');
  assert.match(summary.error, /exit not observed/);
});

test('does not finish until the actual SDK subprocess has exited', async () => {
  let child;
  const queryImpl = (request) => {
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
    const iterator = (async function* () { yield result(); })();
    iterator.close = () => {};
    return iterator;
  };
  const { run } = startWith(queryImpl);
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.ok(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('cleans up a subprocess even if SDK initialization throws after spawning', async () => {
  let child;
  const queryImpl = (request) => {
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
    throw new Error('initialization failed');
  };
  const summary = await startWith(queryImpl).run.done;
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /initialization failed/);
  assert.ok(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('escalates termination only for the run child when it ignores SIGTERM', async () => {
  let child;
  const ready = deferred();
  const queryImpl = (request) => {
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
    child.stdout.once('data', ready.resolve);
    const iterator = (async function* () { await ready.promise; yield result(); })();
    iterator.close = () => {};
    return iterator;
  };
  const summary = await startWith(queryImpl).run.done;
  assert.equal(summary.status, 'completed');
  assert.equal(child.signalCode, 'SIGKILL');
});

test('finishes after the direct child exits when its descendant holds inherited stdio open', async () => {
  let child;
  let descendantPid;
  let stdout = '';
  let deadline;
  const queryImpl = (request) => {
    const code = `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      descendant.unref();
      console.log(JSON.stringify({ descendantPid: descendant.pid }));
      process.stdout.write('final direct-child output\\n', () => process.exit(0));
    `;
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', code], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
    child.stdout.on('data', (data) => {
      stdout += data;
      const firstLine = stdout.split('\n')[0];
      if (firstLine.endsWith('}')) descendantPid = JSON.parse(firstLine).descendantPid;
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const iterator = (async function* () { await exited; yield result(); })();
    iterator.close = () => {};
    return iterator;
  };
  const { run } = startWith(queryImpl);
  try {
    const summary = await Promise.race([
      run.done,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('run.done waited for inherited stdio after its child exited')), 1500); }),
    ]);
    assert.equal(summary.status, 'completed');
    assert.equal(child.exitCode, 0);
    assert.ok(stdout.includes('final direct-child output\n'));
    assert.ok(Number.isInteger(descendantPid));
    assert.doesNotThrow(() => process.kill(descendantPid, 0), 'the adapter must not terminate the descendant');
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  } finally {
    clearTimeout(deadline);
    // Only the fixture knows this descendant; production teardown targets its direct child.
    if (descendantPid) {
      try { process.kill(descendantPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await run.done;
  }
});

test('separate runs retain their own events, permissions, and signal listeners', async () => {
  const externalSignal = new AbortController();
  const observed = {};
  const adapter = new ClaudeAdapter({ executablePath: executable, queryImpl: scripted([init, result()], observed) });
  const left = [], right = [];
  const runs = [left, right].map((events) => adapter.start({ prompt: 'Hello', cwd, onEvent: (event) => events.push(event), signal: externalSignal.signal }));
  await Promise.all(runs.map((run) => run.done));
  assert.equal(left.filter((event) => event.type === 'result').length, 1);
  assert.equal(right.filter((event) => event.type === 'result').length, 1);
  assert.equal(getEventListeners(externalSignal.signal, 'abort').length, 0);
  externalSignal.abort();
  await runs[0].interrupt();
  assert.equal((await runs[0].done).status, 'completed');
});
