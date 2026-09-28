import { mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationStore } from './store.mjs';
import { ClaudeAdapter } from './claude-adapter.mjs';
import { EngineRouter } from './router.mjs';
import { NativeClient } from './upstream.mjs';
import { TemplateStore } from './templates/store.mjs';
import { RoleRunner } from './orchestration/role-runner.mjs';
import { WorkflowScheduler } from './orchestration/scheduler.mjs';
import { GitWorkspaceManager } from './workspaces/manager.mjs';

export function createEngineRuntime({ command, args = ['app-server'], codexRoleArgs, codexReadRoleArgs, directory, emit, onExit, environment, claudePath, remote = false }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.gateway.lock');
  function acquire() {
    try { const fd = openSync(lockPath, 'wx', 0o600); try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); } }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid engine gateway lock.');
      try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { unlinkSync(lockPath); return acquire(); } throw probe; }
      throw Error('Another engine gateway is using this conversation store.');
    }
  }
  acquire();
  const release = () => { try { if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath); } catch {} };
  process.on('exit', release);
  let router, native, closing;
  try {
    const store = new ConversationStore(directory);
    native = new NativeClient({ command, args, env: process.env, onNotification: message => router?.nativeNotification(message), onRequest: emit, onExit });
    const adapter = new ClaudeAdapter({ executablePath: claudePath, ...(environment ? { environment } : {}) });
    const templates = new TemplateStore(join(directory, 'templates'));
    const runner = new RoleRunner({ claudeAdapter: adapter, codexCommand: command, codexArgs: codexRoleArgs, codexReadArgs: codexReadRoleArgs });
    const workspaces = new GitWorkspaceManager(join(directory, 'workspaces'));
    const operationsFactory = async context => (await import('./orchestration/polly.mjs')).createPollyOperations(context);
    router = new EngineRouter({ store, native, adapter, emit, templates, remote,
      workflowFactory: callbacks => new WorkflowScheduler({ ...callbacks, runner, workspaces, operationsFactory }) });
    // Explicit runtime ownership, rather than an untrusted wire host parameter.
    router.remote = remote;
    return { router, native,
      isBusy: () => store.list().some(chat => chat.activeTurn || chat.activeRun),
      request: (method, params) => router.request(method, params),
      respond: message => router.respond(message) || native.respond(message),
      notify: message => native.notify(message),
      close: () => closing ??= Promise.all([router.close(), native.close()]).finally(() => { release(); process.removeListener('exit', release); }),
    };
  } catch (error) { void native?.close(); release(); process.removeListener('exit', release); throw error; }
}
