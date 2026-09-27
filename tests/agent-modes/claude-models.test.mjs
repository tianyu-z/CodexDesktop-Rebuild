import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeModelCatalog, assertClaudeModel } from '../../runtime/agent-modes/claude-models.mjs';
import { ClaudeAdapter } from '../../runtime/agent-modes/claude-adapter.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 6000 }, fn);
const deferred = () => { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = [
  { value: 'opus', resolvedModel: 'claude-opus-4-8', displayName: 'Opus', description: 'Available from the configured provider', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true },
  ...['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5', 'vendor/future-9.1:build+v2@[1m]'].map((value) => ({ value, displayName: value, description: '' })),
];
function catalog(queryImpl, options = {}) {
  return new ClaudeModelCatalog({ executablePath: '/fixture/claude', environment: () => ({ FIXTURE_PROVIDER: 'one' }), queryImpl, ...options });
}
function metadataQuery(models = rows, observed = {}) {
  return (request) => {
    observed.calls = (observed.calls ?? 0) + 1;
    observed.request = request;
    const input = request.prompt[Symbol.asyncIterator]();
    observed.input = input.next();
    return {
      supportedModels: async () => typeof models === 'function' ? models(request) : models,
      close() { observed.closed = true; },
      async return() { observed.returned = true; return { done: true }; },
    };
  };
}

test('discovers exact SDK model IDs using metadata without yielding a user prompt', async () => {
  const observed = {};
  const models = catalog(metadataQuery(rows, observed));
  assert.deepEqual(await models.list({ cwd: '/fixture/project' }), rows);
  const options = observed.request.options;
  assert.equal(options.cwd, '/fixture/project');
  assert.equal(options.pathToClaudeCodeExecutable, '/fixture/claude');
  assert.deepEqual(options.env, { FIXTURE_PROVIDER: 'one' });
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.hooks, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.settings.disableAllHooks, true);
  assert.equal(options.persistSession, false);
  assert.notEqual(options.permissionMode, 'bypassPermissions');
  assert.deepEqual(await observed.input, { value: undefined, done: true });
  assert.equal(observed.closed, true);
  assert.equal(observed.returned, true);
  await models.close();
});

test('validates arbitrary model IDs without a fixed enumeration', () => {
  for (const value of rows.map((row) => row.value).concat(['custom/new-model-v42', 'x'.repeat(256)])) assert.equal(assertClaudeModel(value), value);
  for (const value of ['', '--help', 'space model', 'sonnet\n', 'x'.repeat(257), null, 42, 'bad$(command)']) assert.throws(() => assertClaudeModel(value), /model/i);
});

test('deduplicates in-flight discovery and caches successful results without sharing mutable rows', async () => {
  const pending = deferred();
  const observed = {};
  const models = catalog(metadataQuery(() => pending.promise, observed));
  const first = models.list({ cwd: '/same' });
  const second = models.list({ cwd: '/same' });
  await delay(0);
  assert.equal(observed.calls, 1);
  pending.resolve(rows);
  const [left, right] = await Promise.all([first, second]);
  left[0].displayName = 'Changed by UI';
  assert.equal(right[0].displayName, 'Opus');
  assert.equal((await models.list({ cwd: '/same' }))[0].displayName, 'Opus');
  assert.equal(observed.calls, 1);
  await models.close();
});

test('cwd, provider rotation, explicit refresh and TTL expiration trigger fresh discovery', async () => {
  const observed = {};
  let credential = 'fixture-first';
  const models = catalog(metadataQuery(rows, observed), { environment: () => ({ ANTHROPIC_API_KEY: credential }), cacheTtlMs: 30 });
  await models.list({ cwd: '/one' });
  await models.list({ cwd: '/two' });
  assert.equal(observed.calls, 2);
  credential = 'fixture-rotated';
  await models.list({ cwd: '/one' });
  assert.equal(observed.calls, 3);
  await models.list({ cwd: '/one', refresh: true });
  assert.equal(observed.calls, 4);
  await delay(40);
  await models.list({ cwd: '/one' });
  assert.equal(observed.calls, 5);
  await models.close();
});

test('executable replacement invalidates cached model metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-model-catalog-'));
  const executablePath = join(directory, 'claude');
  const observed = {};
  const models = catalog(metadataQuery(rows, observed), { executablePath });
  try {
    await writeFile(executablePath, 'fixture first version');
    await models.list();
    await writeFile(executablePath, 'fixture second version with changed size');
    await models.list();
    assert.equal(observed.calls, 2);
  } finally { await models.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed discovery can be retried and does not expose provider secrets', async () => {
  let attempts = 0;
  const models = catalog(metadataQuery(() => { if (++attempts === 1) throw new Error('failed with fixture-secret'); return rows; }), { environment: () => ({ ANTHROPIC_API_KEY: 'fixture-secret' }) });
  await assert.rejects(models.list(), (error) => !error.message.includes('fixture-secret'));
  assert.deepEqual(await models.list(), rows);
  assert.equal(attempts, 2);
  await models.close();
});

test('a failed refresh is retried instead of silently reusing the older successful cache', async () => {
  let attempts = 0;
  const models = catalog(metadataQuery(() => { if (++attempts === 2) throw new Error('refresh failed'); return rows; }));
  await models.list();
  await assert.rejects(models.list({ refresh: true }));
  await models.list();
  assert.equal(attempts, 3);
  await models.close();
});

test('each in-flight probe uses a snapshot of its provider configuration', async () => {
  const env = { FIXTURE_MODEL: 'custom/model-a' };
  const pending = deferred();
  const models = catalog(metadataQuery(async (request) => {
    await pending.promise;
    return [{ value: request.options.env.FIXTURE_MODEL, displayName: 'Configured model', description: '' }];
  }), { environment: () => env });
  const first = models.list();
  await delay(0);
  env.FIXTURE_MODEL = 'custom/model-b';
  const second = models.list();
  pending.resolve();
  assert.equal((await first)[0].value, 'custom/model-a');
  assert.equal((await second)[0].value, 'custom/model-b');
  await models.close();
});

test('normalization drops unsafe metadata and malformed or duplicate model rows', async () => {
  const models = catalog(metadataQuery([
    { ...rows[0], apiKey: 'must-not-escape', unsupportedObject: { token: 'secret' } },
    { ...rows[0], displayName: 'duplicate' },
    { value: 'future-model', supportsFastMode: true },
    { value: '--not-a-model' }, null,
  ]));
  assert.deepEqual(await models.list(), [rows[0], { value: 'future-model', displayName: 'future-model', description: '', supportsFastMode: true }]);
  await models.close();
});

test('discovery times out, releases prompt input and remains retryable', async () => {
  let attempts = 0;
  const observed = {};
  const models = catalog(metadataQuery(() => ++attempts === 1 ? new Promise(() => {}) : rows, observed), { timeoutMs: 20 });
  await assert.rejects(models.list(), /timed out/i);
  assert.deepEqual(await observed.input, { value: undefined, done: true });
  assert.equal(observed.closed, true);
  assert.deepEqual(await models.list(), rows);
  await models.close();
});

test('close cancels all in-flight metadata requests and prevents later launches', async () => {
  const observed = {};
  const models = catalog(metadataQuery(() => new Promise(() => {}), observed));
  const left = models.list({ cwd: '/left' });
  const right = models.list({ cwd: '/right' });
  const rejections = Promise.all([assert.rejects(left, /closed/i), assert.rejects(right, /closed/i)]);
  await delay(0);
  await models.close();
  await rejections;
  assert.equal(observed.calls, 2);
  await assert.rejects(models.list(), /closed/i);
  const neverLaunched = {};
  const immediate = catalog(metadataQuery(rows, neverLaunched));
  const pending = immediate.list();
  const rejected = assert.rejects(pending, /closed/i);
  await immediate.close();
  await rejected;
  assert.equal(neverLaunched.calls, undefined);
});

test('aborted metadata awaits the owned child even when it ignores SIGTERM', async () => {
  let child;
  const ready = deferred();
  const models = catalog((request) => {
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
    child.stdout.once('data', ready.resolve);
    return { supportedModels: async () => {
      await ready.promise;
      // Abort only after the child has installed its handler. A short wall-clock
      // deadline can otherwise kill it before startup on a busy build machine.
      request.options.abortController.abort(new Error('Fixture metadata cancellation'));
      return new Promise(() => {});
    }, close() {}, async return() {} };
  }, { timeoutMs: 5000 });
  await assert.rejects(models.list(), /Fixture metadata cancellation/);
  assert.equal(child.signalCode, 'SIGKILL');
  await models.close();
});

test('catalog close and initialization failure both await their own subprocess', async () => {
  for (const fail of [false, true]) {
    let child;
    const spawned = deferred();
    const models = catalog((request) => {
      child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
      spawned.resolve();
      if (fail) throw new Error('fixture SDK initialization failure');
      return { supportedModels: () => new Promise(() => {}), close() {}, async return() {} };
    });
    const pending = models.list();
    const rejection = assert.rejects(pending);
    await spawned.promise;
    await models.close();
    await rejection;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
});

test('successful metadata discovery awaits its child despite an unresponsive SDK return', async () => {
  let child;
  const models = catalog((request) => {
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
    return { supportedModels: async () => rows, close() {}, return: () => new Promise(() => {}) };
  });
  assert.deepEqual(await models.list(), rows);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await models.close();
});

test('close reports failure if its captured process cannot be terminated', async () => {
  let child;
  let killFixture;
  const spawned = deferred();
  const models = catalog((request) => {
    child = request.options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: request.options.abortController.signal });
    killFixture = child.kill.bind(child);
    child.kill = () => false;
    spawned.resolve();
    return { supportedModels: () => new Promise(() => {}), close() {}, async return() {} };
  });
  const pending = models.list();
  const rejected = assert.rejects(pending, /did not exit/);
  try {
    await spawned.promise;
    await assert.rejects(models.close(), /did not exit/);
    await rejected;
  } finally {
    child.kill = killFixture;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killFixture('SIGKILL');
    await exited;
    await models.close();
  }
});

test('adapter exposes lazy model discovery and rejects invalid explicit models before startup', async () => {
  const observed = {};
  const adapter = new ClaudeAdapter({ executablePath: '/fixture/claude', environment: () => ({ FIXTURE_PROVIDER: 'adapter' }), queryImpl: metadataQuery(rows, observed) });
  assert.equal(observed.calls, undefined);
  assert.deepEqual(await adapter.listModels({ cwd: '/adapter' }), rows);
  assert.equal(observed.request.options.env.FIXTURE_PROVIDER, 'adapter');
  const summary = await adapter.start({ prompt: 'Not submitted', cwd: '/adapter', model: '--malformed', onEvent() {} }).done;
  assert.equal(summary.status, 'failed');
  assert.match(summary.error, /model/i);
  assert.equal(observed.calls, 1);
  await adapter.close();
  await assert.rejects(adapter.listModels(), /closed/i);
});
