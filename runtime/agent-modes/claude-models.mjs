import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveClaudeEnvironment } from './claude-environment.mjs';
import { discoverProviderModels, providerCatalogInfo } from './claude-provider-models.mjs';

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,255}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validModel = (value) => typeof value === 'string' && modelPattern.exec(value)?.[0] === value;

/** Validate syntax, never a hardcoded list: providers may expose new/custom IDs. */
export function assertClaudeModel(value) {
  if (!validModel(value)) throw new TypeError('Invalid Claude model identifier.');
  return value;
}

function normalizeModels(value) {
  if (!Array.isArray(value)) throw new Error('Claude returned invalid model metadata.');
  const models = [];
  const seen = new Set();
  for (const row of value) {
    if (!record(row) || !validModel(row.value) || seen.has(row.value)) continue;
    seen.add(row.value);
    const model = {
      value: row.value,
      ...(validModel(row.resolvedModel) ? { resolvedModel: row.resolvedModel } : {}),
      displayName: typeof row.displayName === 'string' && row.displayName ? row.displayName : row.value,
      description: typeof row.description === 'string' ? row.description : '',
    };
    for (const key of ['supportsEffort', 'supportsAdaptiveThinking', 'supportsFastMode', 'supportsAutoMode']) {
      if (typeof row[key] === 'boolean') model[key] = row[key];
    }
    if (Array.isArray(row.supportedEffortLevels)) model.supportedEffortLevels = [...new Set(row.supportedEffortLevels.filter((level) => typeof level === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(level)))];
    models.push(model);
  }
  return models;
}

function mergeModels(sdkModels, apiModels) {
  const api = new Map(apiModels.map(model => [model.value, model]));
  const merged = new Map();
  const contextBase = value => value?.replace(/\[[^\]]+\]$/, '');
  for (const model of sdkModels) {
    const advertised = api.get(model.value);
    const isContext = contextBase(model.value) !== model.value;
    const isAlias = model.value === 'default' || (
      model.resolvedModel && model.resolvedModel !== model.value &&
      /^[A-Za-z][A-Za-z_-]*$/.test(model.value) && !/^claude(?:[-_]|$)/i.test(model.value)
    );
    const mappedContext = isContext && (api.has(contextBase(model.value)) || api.has(contextBase(model.resolvedModel)));
    if (!advertised && !isAlias && !mappedContext) continue;
    merged.set(model.value, advertised ? {
      ...advertised, ...model,
      description: [model.description, advertised.description].filter(Boolean).join(' '),
    } : model);
  }
  for (const model of apiModels) if (!merged.has(model.value)) merged.set(model.value, model);
  return [...merged.values()];
}

function discoveryIdentity(cwd, executablePath, env) {
  let executable = executablePath;
  try {
    const info = statSync(executablePath);
    executable = [realpathSync(executablePath), info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  } catch { /* The SDK will report an unavailable executable during discovery. */ }
  // Hash values only in memory. Cache keys must change on credential rotation
  // without retaining provider secrets in keys or exposing them in diagnostics.
  return createHash('sha256').update(JSON.stringify([cwd, executable, Object.entries(env).sort(([left], [right]) => left.localeCompare(right))])).digest('hex');
}

async function finishesWithin(promise, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timeout); }
}

/** Owns exactly the process created by one SDK metadata query. */
class MetadataChild {
  constructor(signal) {
    this.signal = signal;
    this.exited = false;
  }

  spawn = (options) => {
    this.signal.throwIfAborted();
    if (this.child) throw new Error('Claude metadata query attempted a second subprocess.');
    const child = this.child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stderr.resume();
    let resolveExit;
    let resolveDrain;
    let drainTimeout;
    this.exit = new Promise((resolve) => { resolveExit = resolve; });
    this.drained = new Promise((resolve) => { resolveDrain = resolve; });
    const drained = () => { clearTimeout(drainTimeout); resolveDrain(); };
    const exited = () => {
      if (this.exited) return;
      this.exited = true;
      resolveExit();
      // An inherited pipe does not extend our ownership to a descendant.
      drainTimeout = setTimeout(() => { this.destroyPipes(); drained(); }, 200);
    };
    child.once('exit', exited);
    child.once('close', () => { exited(); drained(); });
    child.on('error', () => { if (child.pid === undefined) exited(); });
    child.stdin.on('error', () => {});
    return child;
  };

  destroyPipes() {
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) pipe.destroy();
  }

  async stop() {
    if (!this.child) return;
    if (!this.exited) {
      this.child.stdin.end();
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
      if (!await finishesWithin(this.exit, 500)) {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
        if (!await finishesWithin(this.exit, 1000)) {
          this.destroyPipes();
          throw Object.assign(new Error('Claude model discovery subprocess did not exit.'), { code: 'CLAUDE_MODEL_PROCESS_EXIT_FAILED' });
        }
      }
    }
    await this.drained;
  }
}

/** Read provider catalogs and SDK options without submitting a model prompt. */
export class ClaudeModelCatalog {
  constructor({ executablePath = join(homedir(), '.local', 'bin', 'claude'), environment = resolveClaudeEnvironment, queryImpl, resolveSettingsImpl, fetchImpl = globalThis.fetch, timeoutMs = 12000, cacheTtlMs = 60000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError('Invalid Claude model discovery timeout or cache duration.');
    this.executablePath = executablePath;
    this.environment = environment;
    this.queryImpl = queryImpl;
    this.resolveSettingsImpl = resolveSettingsImpl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
    this.inFlight = new Map();
    this.settingsInFlight = new Set();
    this.closed = false;
  }

  async list(options) {
    return (await this.listCatalog(options)).models;
  }

  async listCatalog({ cwd = homedir(), refresh = false } = {}) {
    if (this.closed) throw new Error('Claude model catalog is closed.');
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new TypeError('Invalid Claude model discovery working directory.');
    const directory = resolve(cwd);
    const resolvedEnv = this.environment();
    if (!record(resolvedEnv)) throw new TypeError('Claude environment must be an object.');
    const env = { ...resolvedEnv };
    let providerEnv;
    try {
      const settings = await this.settingsFor(directory);
      const settingsEnv = settings.effective.env ?? {};
      if (!record(settingsEnv) || Object.values(settingsEnv).some(value => typeof value !== 'string')) throw new Error('Invalid settings environment.');
      // The CLI applies its settings cascade after options.env. Use that same
      // effective environment for HTTP discovery, while letting the SDK load
      // its settings normally. Include overrides in the cache identity.
      providerEnv = { ...env, ...settingsEnv };
    } catch {
      if (this.closed) throw new Error('Claude model catalog is closed.');
      throw new Error('Could not resolve Claude settings for model discovery.');
    }
    if (this.closed) throw new Error('Claude model catalog is closed.');
    const key = discoveryIdentity(directory, this.executablePath, providerEnv);
    const now = Date.now();
    for (const [entryKey, entry] of this.cache) if (entry.expires <= now) this.cache.delete(entryKey);
    if (this.inFlight.has(key)) return structuredClone(await this.inFlight.get(key).promise);
    if (!refresh && this.cache.has(key)) return structuredClone(this.cache.get(key).catalog);
    this.cache.delete(key);
    const probe = { controller: new AbortController() };
    probe.promise = Promise.resolve().then(() => this.probe(directory, env, probe.controller, providerEnv)).then((catalog) => {
      if (this.closed) throw new Error('Claude model catalog is closed.');
      this.cache.set(key, { catalog, expires: Date.now() + this.cacheTtlMs });
      return catalog;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, probe);
    return structuredClone(await probe.promise);
  }

  async settingsFor(cwd) {
    const entry = { controller: new AbortController() };
    const { signal } = entry.controller;
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener('abort', abortListener, { once: true });
    });
    const timeout = setTimeout(() => entry.controller.abort(new Error('Claude settings discovery timed out.')), this.timeoutMs);
    // The SDK settings API has no cancellation argument. Bound our wait and
    // discard late results, so close/timeout cannot launch a later probe.
    entry.promise = Promise.race([
      Promise.resolve().then(async () => {
        const resolveSettings = this.resolveSettingsImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).resolveSettings;
        signal.throwIfAborted();
        return await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
      }),
      aborted,
    ]);
    this.settingsInFlight.add(entry);
    try { return await entry.promise; }
    finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abortListener);
      this.settingsInFlight.delete(entry);
    }
  }

  async probe(cwd, env, controller, providerEnv) {
    controller.signal.throwIfAborted();
    // SDK cleanup aborts its own controller. Independent controllers prevent
    // that cleanup from cancelling a provider request that is still reading.
    const sdkController = new AbortController();
    const apiController = new AbortController();
    const abort = () => {
      sdkController.abort(controller.signal.reason);
      apiController.abort(controller.signal.reason);
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const [sdk, api] = await Promise.allSettled([
        this.probeSdk(cwd, env, sdkController),
        this.probeProvider(providerEnv, apiController),
      ]);
      // A provider result must never hide failure to reclaim our SDK child.
      if (sdk.status === 'rejected' && sdk.reason?.code === 'CLAUDE_MODEL_PROCESS_EXIT_FAILED') throw sdk.reason;
      controller.signal.throwIfAborted();
      const provider = api.status === 'fulfilled' ? api.value : {
        ...providerCatalogInfo(providerEnv), models: [], apiStatus: 'failed',
      };
      const apiSuccess = provider.apiStatus === 'success';
      if (!apiSuccess && sdk.status === 'rejected') throw sdk.reason;
      const sdkModels = sdk.status === 'fulfilled' ? sdk.value : [];
      return {
        models: apiSuccess ? mergeModels(sdkModels, provider.models) : sdkModels,
        source: apiSuccess ? (sdk.status === 'fulfilled' ? 'provider-api+sdk' : 'provider-api') : 'sdk-fallback',
        apiStatus: provider.apiStatus,
        provider: provider.provider,
        endpointPath: provider.endpointPath,
        apiModelCount: provider.models.length,
        sdkModelCount: sdkModels.length,
        advertised: true,
        warning: !apiSuccess
          ? provider.apiStatus === 'unsupported'
            ? 'Provider API model discovery is unsupported for this configuration; SDK options may be incomplete.'
            : 'Provider API model catalog is unavailable; SDK options may be incomplete.'
          : sdk.status === 'rejected'
            ? 'Claude SDK options are unavailable; showing provider-advertised models only.'
            : null,
      };
    } finally { controller.signal.removeEventListener('abort', abort); }
  }

  async probeProvider(env, controller) {
    let abortListener;
    const timeout = setTimeout(() => controller.abort(new Error('Provider model catalog timed out.')), this.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      return await Promise.race([
        discoverProviderModels({ env, signal: controller.signal, fetchImpl: this.fetchImpl }),
        aborted,
      ]);
    } finally {
      clearTimeout(timeout);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      controller.abort(new Error('Provider model discovery finished.'));
    }
  }

  async probeSdk(cwd, env, controller) {
    let query;
    let releaseInput;
    let abortListener;
    const inputReleased = new Promise((resolve) => { releaseInput = resolve; });
    const owner = new MetadataChild(controller.signal);
    const timeout = setTimeout(() => controller.abort(new Error('Claude model discovery timed out.')), this.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const metadata = (async () => {
        const queryImpl = this.queryImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
        controller.signal.throwIfAborted();
        // This iterator never yields, including on close. supportedModels()
        // needs initialization and an open control channel, not a user turn.
        const prompt = (async function* () { await inputReleased; })();
        query = queryImpl({ prompt, options: {
          cwd, env,
          pathToClaudeCodeExecutable: this.executablePath,
          settingSources: ['user', 'project', 'local'],
          tools: [], mcpServers: {}, strictMcpConfig: true, hooks: {},
          settings: { disableAllHooks: true },
          permissionMode: 'default',
          persistSession: false,
          abortController: controller,
          spawnClaudeCodeProcess: owner.spawn,
        } });
        return await query.supportedModels();
      })();
      return normalizeModels(await Promise.race([metadata, aborted]));
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      // SDK/provider errors can include connection secrets; do not expose them.
      throw new Error('Claude model discovery failed. Check the configured provider and Claude Code installation.');
    } finally {
      clearTimeout(timeout);
      releaseInput();
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      try { query?.close(); } catch { /* Owned-child cleanup still runs. */ }
      controller.abort(new Error('Claude model discovery finished.'));
      // SDK cleanup is bounded independently: a stalled control channel must
      // not prevent us from terminating and awaiting our captured subprocess.
      const cleanup = await Promise.allSettled([
        finishesWithin(Promise.resolve().then(() => query?.return()), 2000),
        owner.stop(),
      ]);
      if (cleanup[1].status === 'rejected') throw cleanup[1].reason;
    }
  }

  async close() {
    this.closed = true;
    this.cache.clear();
    const settings = [...this.settingsInFlight];
    for (const entry of settings) entry.controller.abort(new Error('Claude model catalog is closed.'));
    const probes = [...this.inFlight.values()];
    for (const probe of probes) probe.controller.abort(new Error('Claude model catalog is closed.'));
    const results = await Promise.allSettled([...settings.map(entry => entry.promise), ...probes.map(probe => probe.promise)]);
    const cleanupFailure = results.find((result) => result.status === 'rejected' && result.reason?.code === 'CLAUDE_MODEL_PROCESS_EXIT_FAILED');
    if (cleanupFailure) throw cleanupFailure.reason;
  }
}
