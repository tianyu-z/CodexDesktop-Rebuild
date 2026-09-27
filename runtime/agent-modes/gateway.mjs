#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConversationStore } from './store.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { EngineRouter } from './router.mjs';
import { NativeClient } from './upstream.mjs';
import { TemplateStore } from './templates/store.mjs';
import { RoleRunner } from './orchestration/role-runner.mjs';
import { WorkflowScheduler } from './orchestration/scheduler.mjs';
import { GitWorkspaceManager } from './workspaces/manager.mjs';

const args = process.argv.slice(2);
const command = process.env.CDX_REAL_CODEX;
if (!command) throw new Error('CDX_REAL_CODEX must name the original Codex executable.');
const serverIndex = args.indexOf('app-server');
const subcommand = serverIndex >= 0 ? args[serverIndex + 1] : null;
if (serverIndex < 0 || (subcommand && !subcommand.startsWith('-'))) {
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
} else {
  const directory = process.env.CDX_ENGINE_STORE ?? join(homedir(), 'Library', 'Application Support', 'chatgpt-dev', 'engine-conversations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.gateway.lock');
  function acquire() {
    try { const fd = openSync(lockPath, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid gateway lock. Close the app and inspect its engine-conversations directory.');
      try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { unlinkSync(lockPath); return acquire(); } throw probe; }
      throw new Error('Another engine gateway is using this conversation store.');
    }
  }
  acquire();
  const release = () => { try { if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); } catch {} };
  process.on('exit', release);
  const store = new ConversationStore(directory);
  const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  let router, stopping;
  const native = new NativeClient({ command, args, env: process.env,
    onNotification: message => router?.nativeNotification(message), onRequest: emit,
    onExit: () => { void shutdown(); } });
  const adapter = new ClaudeAdapter({ executablePath: process.env.CDX_CLAUDE_PATH });
  const templates = new TemplateStore(join(directory, 'templates'));
  const runner = new RoleRunner({ claudeAdapter: adapter, codexCommand: command });
  const workspaces = new GitWorkspaceManager(join(directory, 'workspaces'));
  const operationsFactory = async context => (await import('./orchestration/polly.mjs')).createPollyOperations(context);
  router = new EngineRouter({ store, native, adapter, emit, templates,
    workflowFactory: callbacks => new WorkflowScheduler({ ...callbacks, runner, workspaces, operationsFactory }) });
  const input = createInterface({ input: process.stdin });
  const tasks = new Set();
  input.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { emit({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
    if (message.method == null) { if (!router.respond(message)) native.respond(message); return; }
    if (message.id == null) { native.notify(message); return; }
    const task = router.request(message.method, message.params).then(result => emit({ id: message.id, result }), error => emit({ id: message.id, error: { code: error.code ?? -32000, message: error.message, ...(error.data ? { data: error.data } : {}) } }));
    tasks.add(task); task.finally(() => tasks.delete(task));
  });
  async function shutdown() {
    if (stopping) return stopping;
    // Reject pending native RPCs while waiting for Claude runs that may be
    // materializing their thread through that same transport.
    stopping = Promise.resolve().then(async () => { input.close(); await Promise.all([router.close(), native.close()]); await Promise.allSettled([...tasks]); release(); });
    return stopping;
  }
  input.on('close', () => { void shutdown(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
  process.stdout.on('error', () => { void shutdown(); });
}
