import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveClaudeEnvironment } from './claude-environment.mjs';

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

/** Read model metadata through the SDK without submitting a model prompt. */
export class ClaudeModelCatalog {
  constructor({ executablePath = join(homedir(), '.local', 'bin', 'claude'), environment = resolveClaudeEnvironment, queryImpl, timeoutMs = 12000, cacheTtlMs = 60000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError('Invalid Claude model discovery timeout or cache duration.');
    this.executablePath = executablePath;
    this.environment = environment;
    this.queryImpl = queryImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
    this.inFlight = new Map();
    this.closed = false;
  }

  async list({ cwd = homedir(), refresh = false } = {}) {
    if (this.closed) throw new Error('Claude model catalog is closed.');
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new TypeError('Invalid Claude model discovery working directory.');
    const directory = resolve(cwd);
    const resolvedEnv = this.environment();
    if (!record(resolvedEnv)) throw new TypeError('Claude environment must be an object.');
    const env = { ...resolvedEnv };
    const key = discoveryIdentity(directory, this.executablePath, env);
    const now = Date.now();
    for (const [entryKey, entry] of this.cache) if (entry.expires <= now) this.cache.delete(entryKey);
    if (this.inFlight.has(key)) return structuredClone(await this.inFlight.get(key).promise);
    if (!refresh && this.cache.has(key)) return structuredClone(this.cache.get(key).models);
    this.cache.delete(key);
    const probe = { controller: new AbortController() };
    probe.promise = Promise.resolve().then(() => this.probe(directory, env, probe.controller)).then((models) => {
      if (this.closed) throw new Error('Claude model catalog is closed.');
      this.cache.set(key, { models, expires: Date.now() + this.cacheTtlMs });
      return models;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, probe);
    return structuredClone(await probe.promise);
  }

  async probe(cwd, env, controller) {
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
    const probes = [...this.inFlight.values()];
    for (const probe of probes) probe.controller.abort(new Error('Claude model catalog is closed.'));
    const results = await Promise.allSettled(probes.map((probe) => probe.promise));
    const cleanupFailure = results.find((result) => result.status === 'rejected' && result.reason?.code === 'CLAUDE_MODEL_PROCESS_EXIT_FAILED');
    if (cleanupFailure) throw cleanupFailure.reason;
  }
}
