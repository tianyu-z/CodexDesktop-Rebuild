import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveClaudeEnvironment } from './claude-environment.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validName = value => typeof value === 'string' && /^[^\s/\\\x00-\x1f\x7f]{1,200}$/u.test(value);
const validFilename = value => typeof value === 'string' && /^[^/\\\x00-\x1f\x7f]{1,240}$/u.test(value) && !['.', '..'].includes(value);
const unsupported = name => Object.assign(new Error(`/${name} requires a Claude capability or app action that is unavailable in this session.`), { code: 'CLAUDE_COMMAND_UNSUPPORTED' });

// These are client-side commands in the official extension, not commands the
// headless CLI advertises. Keep that distinction in the public catalog.
const appRows = [
  ['status', 'Show native Claude session status', 'control'],
  ['permissions', 'View native permission rules and workspace directories', 'control', ['allowed-tools']],
  ['skills', 'List available skills', 'control'],
  ['help', 'Browse available slash commands', 'control'],
  ['memory', 'View Claude memory and instruction files', 'control'],
  ['hooks', 'View configured Claude hooks', 'control'],
  ['plugins', 'View configured Claude plugins', 'control', ['plugin', 'marketplace']],
  ['plan', 'Enable plan mode or view the current plan', 'control', [], '[open]'],
  ['copy', "Copy Claude's last response", 'local', [], '[N]'],
  ['export', 'Export the native conversation', 'control', [], '[filename]'],
  ['tasks', 'View tasks in this session', 'local', ['bashes']],
  ['btw', 'Ask a native side question', 'control', [], '[question]'],
  ['rewind', 'Preview or restore tracked files at a checkpoint', 'control', ['checkpoint', 'undo'], '[user-message-uuid] [--dry-run|--apply]'],
  ['resume', 'Resume an earlier Claude conversation', 'local', ['continue']],
  ['feedback', 'Send a feedback report to Anthropic', 'control', ['bug'], '[report]'],
  ['remote-control', 'Control this native Claude session remotely until Stop', 'control', ['rc']],
  ['chrome', 'View Claude in Chrome status and browser connections', 'control'],
  ['sandbox', 'View native command sandbox settings', 'control'],
];

export const CLAUDE_APP_COMMANDS = Object.freeze(appRows.map(([name, description, execution, aliases = [], argumentHint = '']) => Object.freeze({
  name, description, argumentHint, aliases: Object.freeze(aliases), origin: 'app', execution,
  ...(execution === 'control' ? { control: name } : {}),
})));

/** Retain every native name, including builtin/custom collisions. */
export function normalizeClaudeCommands(value) {
  if (!Array.isArray(value)) throw new Error('Claude returned invalid command metadata.');
  const seen = new Set(), commands = [];
  for (const row of value) {
    if (!record(row) || !validName(row.name)) continue;
    const command = {
      name: row.name,
      description: typeof row.description === 'string' ? row.description : '',
      argumentHint: typeof row.argumentHint === 'string' ? row.argumentHint : '',
      ...(row.builtin === true ? { builtin: true } : {}),
      ...(Array.isArray(row.aliases) ? { aliases: [...new Set(row.aliases.filter(validName))] } : {}),
      origin: row.builtin === true ? 'builtin' : 'skill', execution: 'native',
    };
    const key = JSON.stringify(command);
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(command);
  }
  const counts = new Map();
  for (const row of commands) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  return commands.map(row => ({
    ...row,
    invocation: counts.get(row.name) > 1 ? row.aliases?.find(alias => alias.endsWith(`:${row.name}`)) ?? row.name : row.name,
  }));
}

function withAppCommands(commands) {
  const nativeHandles = new Set(commands.flatMap(row => [row.name, ...(row.aliases ?? [])]));
  return [...commands, ...CLAUDE_APP_COMMANDS.filter(row => !nativeHandles.has(row.name)).map(row => ({
    ...row, aliases: row.aliases.filter(alias => !nativeHandles.has(alias)),
  }))];
}

/** Match native exact names before aliases and app fallbacks, as Claude does. */
export function resolveClaudeCommand(catalog, text) {
  if (typeof text !== 'string') return;
  const input = text.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return;
  const [, name, argumentText = ''] = match, args = argumentText.trim();
  const commands = Array.isArray(catalog) ? catalog : catalog?.commands;
  if (!Array.isArray(commands)) return;
  const native = commands.filter(row => row.origin !== 'app');
  const exact = native.filter(row => row.name === name);
  const row = exact.find(row => row.builtin) ?? exact[0]
    ?? native.find(row => row.aliases?.includes(name))
    ?? commands.find(row => row.origin === 'app' && row.name === name)
    ?? commands.find(row => row.origin === 'app' && row.aliases?.includes(name));
  if (!row) return;
  // The official extension deliberately opens these panels with no arguments,
  // while forwarding /config key=value and /mcp subcommands to the CLI.
  const panel = row.origin !== 'skill' && args === '' && ['config', 'mcp'].includes(row.name) ? row.name : undefined;
  return { ...row, args, input, ...(panel ? { execution: 'control', control: panel } : {}) };
}

/** Native local writes do not pass through canUseTool or the SDK tools ceiling. */
export function assertClaudeCommandAccess(command, access) {
  if (access !== 'read' || !command || command.origin === 'skill') return;
  const name = command.control ?? command.name, args = (command.args ?? '').trim();
  const native = command.execution === 'native';
  const inspection = /^(?:help|list|status|get)(?:\s|$)/i.test(args);
  const mutates = name === 'rewind' && /(?:^|\s)--apply(?:\s|$)/.test(args)
    || native && (
      ['reload-plugins', 'add-dir', 'terminal-setup', 'install-github-app'].includes(name)
      || ['config', 'mcp', 'plugin', 'plugins', 'marketplace', 'hooks', 'memory', 'sandbox', 'chrome', 'permissions'].includes(name) && args !== '' && !inspection
      || name === 'rewind' && args !== '' && !/(?:^|\s)--dry-run(?:\s|$)/.test(args)
    );
  if (mutates) throw new Error(`/${name} requires write access; this Claude role has read-only access.`);
}

async function settlesWithin(promise, milliseconds) {
  let timeout;
  try {
    return await Promise.race([Promise.resolve(promise).then(() => true, () => true), new Promise(accept => { timeout = setTimeout(() => accept(false), milliseconds); })]);
  } finally { clearTimeout(timeout); }
}

/** Own exactly our metadata process; descendants do not own our pipe lifetime. */
class CommandMetadataChild {
  constructor(signal) { this.signal = signal; this.exited = false; }
  spawn = options => {
    this.signal.throwIfAborted();
    if (this.child) throw new Error('Claude command discovery attempted a second process.');
    const child = this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    let resolveExit, resolveDrain, drainTimeout;
    this.exit = new Promise(accept => { resolveExit = accept; });
    this.drained = new Promise(accept => { resolveDrain = accept; });
    const drained = () => { clearTimeout(drainTimeout); resolveDrain(); };
    const exited = () => {
      if (this.exited) return;
      this.exited = true;
      resolveExit();
      drainTimeout = setTimeout(() => { this.destroyPipes(); drained(); }, 200);
    };
    child.once('exit', exited);
    child.once('close', () => { exited(); drained(); });
    child.on('error', () => { if (child.pid === undefined) exited(); });
    return child;
  };
  destroyPipes() { for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) pipe.destroy(); }
  async stop() {
    if (!this.child) return;
    if (!this.exited) {
      this.child.stdin.end();
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
      if (!await settlesWithin(this.exit, 500)) {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
        if (!await settlesWithin(this.exit, 1000)) {
          this.destroyPipes();
          throw Object.assign(new Error('Claude command discovery subprocess did not exit.'), { code: 'CLAUDE_COMMAND_PROCESS_EXIT_FAILED' });
        }
      }
    }
    await this.drained;
  }
}

function cacheIdentity(cwd, executablePath, environment) {
  let executable = executablePath;
  try {
    const stat = statSync(executablePath);
    executable = [realpathSync(executablePath), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch { /* Native startup reports missing executables. */ }
  return createHash('sha256').update(JSON.stringify([cwd, executable, Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))])).digest('hex');
}

/** Discover metadata without yielding a user message or running project tools. */
export class ClaudeCommandCatalog {
  constructor({ executablePath = join(homedir(), '.local', 'bin', 'claude'), environment = resolveClaudeEnvironment, queryImpl, timeoutMs = 12000, cacheTtlMs = 30000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError('Invalid Claude command discovery timeout or cache duration.');
    Object.assign(this, { executablePath, environment, queryImpl, timeoutMs, cacheTtlMs });
    this.cache = new Map();
    this.inFlight = new Map();
    this.requests = new Set();
    this.closed = false;
  }
  async list({ cwd = homedir(), refresh = false } = {}) {
    if (this.closed) throw new Error('Claude command catalog is closed.');
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new TypeError('Invalid Claude command working directory.');
    const directory = resolve(cwd), entry = { controller: new AbortController() };
    const { signal } = entry.controller;
    let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
    const timeout = setTimeout(() => entry.controller.abort(new Error('Claude command discovery timed out.')), this.timeoutMs);
    entry.promise = (async () => {
      try {
        const environment = await Promise.race([Promise.resolve().then(() => this.environment({ cwd: directory, signal })), aborted]);
        signal.throwIfAborted();
        if (!record(environment)) throw new TypeError('Invalid Claude environment.');
        const key = cacheIdentity(directory, this.executablePath, environment), now = Date.now();
        for (const [cacheKey, cached] of this.cache) if (cached.expires <= now) this.cache.delete(cacheKey);
        if (this.inFlight.has(key)) return structuredClone(await Promise.race([this.inFlight.get(key), aborted]));
        if (!refresh && this.cache.has(key)) return structuredClone(this.cache.get(key).value);
        this.cache.delete(key);
        const probing = this.probe(directory, environment, signal).then(commands => {
          signal.throwIfAborted();
          const value = { commands: withAppCommands(commands), source: 'claude-sdk' };
          this.cache.set(key, { value, expires: Date.now() + this.cacheTtlMs });
          return value;
        }).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, probing);
        return structuredClone(await probing);
      } catch (error) {
        if (error?.code === 'CLAUDE_COMMAND_PROCESS_EXIT_FAILED') throw error;
        if (signal.aborted) throw signal.reason;
        throw new Error('Claude command discovery failed. Check the Claude installation and configured provider.');
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        this.requests.delete(entry);
      }
    })();
    // This rejection is also raced during environment resolution; observing it
    // here prevents a late timeout while probe cleanup runs becoming unhandled.
    aborted.catch(() => {});
    this.requests.add(entry);
    return await entry.promise;
  }
  async probe(cwd, env, signal) {
    const sdkAbort = new AbortController(), owner = new CommandMetadataChild(signal);
    let query, releaseInput, onAbort;
    const inputClosed = new Promise(accept => { releaseInput = accept; });
    const aborted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
    aborted.catch(() => {});
    try {
      const queryImpl = this.queryImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      signal.throwIfAborted();
      query = queryImpl({ prompt: (async function* () { await inputClosed; })(), options: {
        cwd, env, pathToClaudeCodeExecutable: this.executablePath,
        settingSources: ['user', 'project', 'local'],
        tools: [], mcpServers: {}, strictMcpConfig: true, hooks: {}, settings: { disableAllHooks: true },
        permissionMode: 'default', persistSession: false, abortController: sdkAbort,
        spawnClaudeCodeProcess: owner.spawn,
      } });
      return normalizeClaudeCommands(await Promise.race([query.supportedCommands(), aborted]));
    } finally {
      signal.removeEventListener('abort', onAbort);
      releaseInput();
      try { query?.close(); } catch { /* Still reclaim the process we own. */ }
      sdkAbort.abort();
      const cleanup = await Promise.allSettled([settlesWithin(Promise.resolve().then(() => query?.return()), 1500), owner.stop()]);
      if (cleanup[1].status === 'rejected') throw cleanup[1].reason;
    }
  }
  async close() {
    this.closed = true;
    this.cache.clear();
    const requests = [...this.requests];
    for (const entry of requests) entry.controller.abort(new Error('Claude command catalog is closed.'));
    await Promise.allSettled(requests.map(entry => entry.promise));
  }
}

const secretKey = /^(?:env|headers|.*(?:api.?key|auth|password|secret|credential).*|(?:access|refresh|api|bearer)[_-]?token|token)$/i;
function safeText(value) {
  return String(value)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b([\w-]*(?:token|secret|password|api[_-]?key|authorization)[\w-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,)]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}
function safeData(value, depth = 0) {
  if (depth > 12) return '[nested value]';
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(row => safeData(row, depth + 1));
  if (!record(value)) return value;
  if (typeof value.label === 'string' && secretKey.test(value.label)) return { label: value.label, value: '[redacted]' };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[redacted]' : safeData(item, depth + 1)]));
}
const formatted = (title, data, hint = '') => ({ text: `${title}\n\n\`\`\`json\n${JSON.stringify(safeData(data), null, 2)}\n\`\`\`${hint ? `\n\n${hint}` : ''}` });

export function assertClaudeLiveCommand(command) {
  if (!record(command) || !['status', 'permissions', 'tasks', 'btw'].includes(command.name) || command.args !== undefined && typeof command.args !== 'string') throw new TypeError('This command is unavailable while Claude is active.');
  const args = (command.args ?? '').trim();
  if (command.name === 'btw' ? !args : args !== '') throw new TypeError(command.name === 'btw' ? 'Use /btw <question> while Claude is active.' : `/${command.name} arguments are unavailable while Claude is active.`);
  return { name: command.name, args };
}

export function formatClaudeTasks(tasks) {
  const nativeTasks = structuredClone(tasks);
  const text = nativeTasks.length ? `Native Claude tasks\n\n${nativeTasks.map(task => {
    const state = task.processEnded ? `${task.status}${task.lastStatus ? ` (last seen ${task.lastStatus})` : ' (process-ended)'}` : task.status;
    return `- ${task.id}: ${task.description ?? task.taskType ?? 'Task'} — ${state}${task.ambient ? ' (ambient)' : ''}${task.summary ? `; ${task.summary}` : ''}`;
  }).join('\n')}` : 'No native tasks have been observed in this Claude process.';
  return { text: safeText(text), nativeTasks };
}

/** Pinned SDK internals are guarded. Missing capabilities never become prompts. */
export async function executeClaudeControl(query, command, args = '', { signal, access } = {}) {
  const name = typeof command === 'string' ? command.replace(/^\//, '') : command?.control ?? command?.name;
  const argument = (typeof command === 'object' && command?.args !== undefined ? command.args : args).trim();
  assertClaudeCommandAccess({ ...(typeof command === 'object' ? command : {}), name, args: argument, execution: 'control' }, access);
  if (argument && !['btw', 'feedback', 'rewind', 'export'].includes(name) && !(name === 'plan' && argument === 'open')) throw Object.assign(new Error(`/${name} arguments must be handled by the native command or app action.`), { code: 'CLAUDE_COMMAND_UNSUPPORTED' });
  const requireMethod = method => { if (typeof query?.[method] !== 'function') throw unsupported(name); };
  const call = async (method, ...values) => {
    requireMethod(method);
    try { return await query[method](...values); }
    catch { throw Object.assign(new Error(`Claude could not complete /${name}. Check the native session and retry.`), { code: 'CLAUDE_COMMAND_CONTROL_FAILED' }); }
  };
  switch (name) {
    case 'status': return formatted('Claude status', await call('getStatus'));
    case 'permissions': return formatted('Claude permissions', await call('listPermissionRules'), 'Choose a permission mode in the composer. Claude applies the native permission rules to each tool request.');
    case 'skills': return formatted('Claude skills', await call('getSkillsDialog'));
    case 'mcp': return formatted('Claude MCP servers', await call('mcpServerStatus'), 'Use /mcp reconnect|enable|disable <server> to manage a server.');
    case 'memory': return formatted('Claude memory', await call('getMemoryDialog'));
    case 'hooks': return formatted('Claude hooks', await call('getHooksListing'));
    case 'sandbox': return formatted('Claude sandbox', await call('getSandboxDialog'));
    case 'chrome': return formatted('Claude in Chrome', await call('getChromeDialog'));
    case 'remote-control': {
      // Do not detach with keepSessionOnExit: the adapter owns this worker
      // until the user stops the active run, including all native tool gates.
      const response = await call('enableRemoteControl', true);
      if (!record(response) || response.enabled === false || response.error) throw Object.assign(new Error('Claude could not enable Remote Control for this session.'), { code: 'CLAUDE_COMMAND_CONTROL_FAILED' });
      const text = formatted('Remote Control is active until you press Stop.', response, 'Keep this chat running while using the remote session. Stop closes the native worker and ends Remote Control.').text;
      return { text, keepAlive: true };
    }
    case 'btw': {
      requireMethod('askSideQuestion');
      if (!argument) return { text: 'Use /btw <question> to ask Claude a side question about the current session.' };
      const response = await call('askSideQuestion', argument, ...(signal ? [{ signal }] : []));
      if (typeof response?.response !== 'string' || !response.response.trim()) throw Object.assign(new Error('Claude did not return an answer to the side question.'), { code: 'CLAUDE_COMMAND_CONTROL_FAILED' });
      return { text: `${response.synthetic ? 'Claude notice: ' : ''}${safeText(response.response)}` };
    }
    case 'feedback': {
      requireMethod('submitFeedback');
      if (!argument) return { text: 'Use /feedback <report> to send the report text to Anthropic. The conversation transcript is excluded.' };
      return formatted('Claude feedback response', await call('submitFeedback', argument, { attach_transcript: false }));
    }
    case 'rewind': {
      requireMethod('rewindFiles');
      const usage = 'Usage: /rewind <user-message-uuid> [--dry-run|--apply]. The default previews file changes; --apply restores tracked files. This command restores files only.';
      if (!argument) return { text: usage };
      const tokens = argument.split(/\s+/), id = tokens[0], flags = tokens.slice(1);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || flags.length > 1 || flags.some(flag => !['--dry-run', '--apply'].includes(flag))) throw new TypeError(usage);
      const dryRun = !flags.includes('--apply');
      const response = await call('rewindFiles', id, { dryRun });
      if (!dryRun && response?.canRewind !== true) throw Object.assign(new Error('Claude could not rewind files to that checkpoint.'), { code: 'CLAUDE_COMMAND_CONTROL_FAILED' });
      return formatted(dryRun ? 'File rewind preview' : 'Rewound tracked files', response, dryRun && response?.canRewind === true ? `Use /rewind ${id} --apply to restore these files.` : '');
    }
    case 'config': {
      const data = await call('getSettings');
      const settings = record(data?.effective) ? data.effective : {};
      const displayKeys = ['model', 'effortLevel', 'outputStyle', 'permissions', 'sandbox', 'disableAllHooks', 'fastMode', 'autoCompactWindow', 'language', 'enabledPlugins'];
      return formatted('Claude configuration', { effective: Object.fromEntries(displayKeys.filter(key => key in settings).map(key => [key, settings[key]])), applied: data?.applied }, 'Use /config key=value to change native Claude settings. Run /config help for the keys accepted by this Claude version.');
    }
    case 'plugins': {
      const data = await call('getSettings');
      return formatted('Configured Claude plugins', { enabledPlugins: data?.effective?.enabledPlugins ?? {} }, 'Use /reload-plugins to apply plugin changes to this session.');
    }
    case 'help': {
      const commands = withAppCommands(normalizeClaudeCommands(await call('supportedCommands')));
      return { text: commands.map(row => `/${row.invocation ?? row.name}${row.argumentHint ? ` ${row.argumentHint}` : ''} — ${safeText(row.description)}`).join('\n') };
    }
    case 'plan': {
      if (argument === 'open') return formatted('Claude plan', await call('getPlan'));
      await call('setPermissionMode', 'plan');
      return { text: 'Plan mode enabled.', settingsPatch: { permissionMode: 'plan' } };
    }
    case 'export': {
      if (argument && !validFilename(argument)) throw new TypeError('/export filename must be a simple basename without paths or control characters.');
      const data = await call('exportConversation');
      if (typeof data?.text !== 'string') throw unsupported(name);
      const filename = argument || (validFilename(data.default_filename) ? data.default_filename : 'conversation.txt');
      return { text: 'Native Claude transcript ready to download.', clientAction: { type: 'download', text: data.text, filename } };
    }
    default: throw unsupported(name);
  }
}
