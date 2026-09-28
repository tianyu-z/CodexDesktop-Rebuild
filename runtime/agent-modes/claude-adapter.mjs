import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ClaudeEventNormalizer } from './claude-events.mjs';
import { resolveClaudeEnvironment } from './claude-environment.mjs';
import { ClaudeModelCatalog, assertClaudeModel } from './claude-models.mjs';
import { CLAUDE_PERMISSION_MODES, assertClaudePermissionMode } from './claude-permissions.mjs';
import { ClaudeCommandCatalog, executeClaudeControl, assertClaudeLiveCommand, assertClaudeCommandAccess, formatClaudeTasks } from './claude-commands.mjs';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorText = (error) => error instanceof Error ? error.message : String(error);

/** One isolated SDK query per run; native Claude persists the resumable session. */
export class ClaudeAdapter {
  constructor({ executablePath = join(homedir(), '.local', 'bin', 'claude'), queryImpl, environment = resolveClaudeEnvironment, resolveSettingsImpl, fetchImpl = globalThis.fetch, contextTimeoutMs = 60000 } = {}) {
    if (!Number.isFinite(contextTimeoutMs) || contextTimeoutMs <= 0) throw new TypeError('Invalid native context accounting timeout.');
    this.executablePath = executablePath;
    this.queryImpl = queryImpl;
    this.environment = environment;
    this.resolveSettingsImpl = resolveSettingsImpl;
    this.fetchImpl = fetchImpl;
    this.contextTimeoutMs = contextTimeoutMs;
  }

  async listModels(options) {
    return (await this.listModelCatalog(options)).models;
  }

  async listModelCatalog(options) {
    if (this.modelsClosed) throw new Error('Claude model catalog is closed.');
    this.modelCatalog ??= new ClaudeModelCatalog({ executablePath: this.executablePath, environment: this.environment, queryImpl: this.queryImpl, resolveSettingsImpl: this.resolveSettingsImpl, fetchImpl: this.fetchImpl });
    return await this.modelCatalog.listCatalog(options);
  }

  async close() {
    this.modelsClosed = true;
    await Promise.all([this.modelCatalog?.close(), this.commandCatalog?.close()]);
  }

  async listCommands(options) {
    if (this.modelsClosed) throw new Error('Claude command catalog is closed.');
    this.commandCatalog ??= new ClaudeCommandCatalog({ executablePath: this.executablePath, environment: this.environment, queryImpl: this.queryImpl });
    return await this.commandCatalog.list(options);
  }

  start(options) {
    const cancellation = new AbortController();
    const sdkAbort = new AbortController();
    const normalizer = new ClaudeEventNormalizer({ onEvent: options.onEvent ?? (() => {}) });
    normalizer.nativeSessionId = options.nativeSessionId;
    let query;
    let actualPermissionMode;
    let changedPermissionMode;
    let keepControlAlive = false;
    let contextTimedOut = false;
    let contextTimeout;
    let nativeChild;
    let childExited;
    let pipesDrained;
    let hasChildExited = false;
    let interrupted = options.signal?.aborted === true;
    let settled = false;
    let shutdownPromise;
    let releaseInput;
    const inputClosed = new Promise((resolve) => { releaseInput = resolve; });
    let resolveQuery;
    const queryReady = new Promise(resolve => { resolveQuery = resolve; });
    if (interrupted) cancellation.abort();

    // Side controls share the owned worker, never its model-output normalizer.
    // Cancelling one control must not interrupt the main turn or other controls.
    const control = async (command, { signal } = {}) => {
      const selected = assertClaudeLiveCommand(command);
      if (settled || cancellation.signal.aborted) throw new Error('Claude control requires an active native process.');
      const requestController = new AbortController();
      const abort = () => requestController.abort();
      const sources = [cancellation.signal, signal].filter(Boolean);
      for (const source of sources) { source.addEventListener('abort', abort, { once: true }); if (source.aborted) abort(); }
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(Object.assign(new Error('Claude control aborted or its native process ended.'), { name: 'AbortError' })); });
      requestController.signal.addEventListener('abort', rejectAbort, { once: true });
      if (requestController.signal.aborted) rejectAbort();
      const active = promise => Promise.race([Promise.resolve(promise), cancelled]);
      try {
        const native = await active(queryReady);
        requestController.signal.throwIfAborted();
        if (!native || typeof native.initializationResult !== 'function') throw new Error('Live Claude controls are unavailable in this SDK.');
        await active(native.initializationResult());
        requestController.signal.throwIfAborted();
        const response = selected.name === 'tasks' ? formatClaudeTasks(normalizer.nativeTasks)
          : await active(executeClaudeControl(native, selected, '', { signal: requestController.signal }));
        requestController.signal.throwIfAborted();
        return response;
      } finally {
        requestController.signal.removeEventListener('abort', rejectAbort);
        for (const source of sources) source.removeEventListener('abort', abort);
      }
    };

    const spawnClaudeCodeProcess = (spawnOptions) => {
      if (cancellation.signal.aborted) throw new Error('Claude run was interrupted before process startup.');
      if (nativeChild) throw new Error('Claude query attempted to start a second native process.');
      nativeChild = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      // The SDK's custom-spawn hook delegates stderr consumption to its host.
      // Drain it so verbose native output cannot fill a pipe and stall a query.
      nativeChild.stderr.resume();
      let resolveExit;
      let resolveDrain;
      let drainTimeout;
      childExited = new Promise((resolve) => { resolveExit = resolve; });
      pipesDrained = new Promise((resolve) => { resolveDrain = resolve; });
      const finishDraining = () => { clearTimeout(drainTimeout); resolveDrain(); };
      const noteExit = () => {
        if (hasChildExited) return;
        hasChildExited = true;
        resolveExit();
        // A descendant can inherit these pipes after the native child exits.
        // Preserve the child's final output briefly, then release only our pipe
        // handles; waiting for ChildProcess.close would otherwise be unbounded.
        drainTimeout = setTimeout(() => {
          for (const stream of [nativeChild.stdin, nativeChild.stdout, nativeChild.stderr]) stream.destroy();
          finishDraining();
        }, 200);
      };
      nativeChild.once('exit', noteExit);
      nativeChild.once('close', () => { noteExit(); finishDraining(); });
      // The SDK also observes errors, but construction can throw before its
      // listener is installed. A failed spawn owns no live PID; runtime errors
      // (including AbortError) still require the actual child's exit event.
      nativeChild.on('error', () => { if (nativeChild.pid === undefined) noteExit(); });
      return nativeChild;
    };

    const stopNativeChild = async () => {
      if (!nativeChild) return;
      if (!hasChildExited) {
        nativeChild.stdin.end();
        if (nativeChild.exitCode === null && nativeChild.signalCode === null) nativeChild.kill('SIGTERM');
        let timeout;
        try {
          await Promise.race([childExited, new Promise((resolve) => { timeout = setTimeout(resolve, 1000); })]);
        } finally { clearTimeout(timeout); }
        if (!hasChildExited && nativeChild.exitCode === null && nativeChild.signalCode === null) nativeChild.kill('SIGKILL');
        await childExited;
      }
      await pipesDrained;
    };

    const canUseTool = async (name, input, request) => {
      const permission = new AbortController();
      const cancelPermission = () => permission.abort();
      const signals = [cancellation.signal, request.signal].filter(Boolean);
      for (const signal of signals) {
        signal.addEventListener('abort', cancelPermission, { once: true });
        if (signal.aborted) cancelPermission();
      }
      const deny = (message, isInterrupted = false) => ({ behavior: 'deny', message, toolUseID: request.toolUseID, ...(isInterrupted ? { interrupt: true } : {}) });
      let onAbort;
      try {
        if (permission.signal.aborted) return deny('Permission request interrupted.', true);
        // tools restricts the offered native tools; this is a second, fail-closed
        // gate if a future SDK or configured integration presents another tool.
        if (options.access === 'read' && !['Read', 'Grep', 'Glob', ...(options.outputSchema ? ['StructuredOutput'] : [])].includes(name)) return deny('This role has read-only access.');
        if (typeof options.onPermission !== 'function' || typeof request.toolUseID !== 'string') return deny('No permission handler is available.');
        const aborted = new Promise((resolve) => {
          onAbort = () => resolve(deny('Permission request interrupted.', true));
          permission.signal.addEventListener('abort', onAbort, { once: true });
        });
        const decision = Promise.resolve().then(async () => {
          if (permission.signal.aborted) return deny('Permission request interrupted.', true);
          const response = await options.onPermission({
            id: request.toolUseID, name, input, signal: permission.signal,
            ...(typeof request.decisionReason === 'string' ? { reason: request.decisionReason } : {}),
          });
          if (permission.signal.aborted) return deny('Permission request interrupted.', true);
          if (response?.decision === 'accept' && (response.updatedInput === undefined || record(response.updatedInput))) {
            return { behavior: 'allow', updatedInput: response.updatedInput ?? input, toolUseID: request.toolUseID };
          }
          return deny(response?.decision === 'decline' ? 'Permission declined by user.' : 'Permission decision was not accepted.');
        }).catch(() => deny('Permission handler failed; the tool was denied.'));
        return await Promise.race([decision, aborted]);
      } finally {
        if (onAbort) permission.signal.removeEventListener('abort', onAbort);
        for (const signal of signals) signal.removeEventListener('abort', cancelPermission);
      }
    };

    const shutdown = (requestInterrupt = false) => {
      if (!query && !nativeChild) return Promise.resolve();
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        try {
          if (requestInterrupt && typeof query?.interrupt === 'function') {
            // A worker stuck before initialization cannot acknowledge a control request.
            // Give it a bounded opportunity, then close and await the SDK's cleanup.
            let timeout;
            try {
              await Promise.race([
                Promise.resolve().then(() => query.interrupt()).catch(() => {}),
                new Promise((resolve) => { timeout = setTimeout(resolve, 1000); }),
              ]);
            } finally { clearTimeout(timeout); }
          }
          releaseInput();
          try { query?.close(); } finally {
            if (interrupted || contextTimedOut) sdkAbort.abort();
            // Query.return(), unlike its inner async iterator or close(), awaits
            // ProcessTransport.waitForExit (bounded by the SDK).
            await query?.return();
          }
        } finally {
          // SDK cleanup has a bounded wait and may resolve while its child is
          // still alive. Do not let the caller switch modes until it has exited.
          await stopNativeChild();
        }
      })();
      return shutdownPromise;
    };

    let done;
    const interrupt = async () => {
      if (!settled) {
        interrupted = true;
        cancellation.abort();
        releaseInput();
        try { await shutdown(true); } catch { /* run.done records cleanup failures */ }
      }
      return await done;
    };
    const onAbort = () => { void interrupt(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // Deferral makes immediate cancellation deterministic and avoids loading or
    // starting the SDK at all when the caller has already cancelled the run.
    done = Promise.resolve().then(async () => {
      let summary;
      let failure;
      let cleanupFailure;
      try {
        if (!interrupted) {
          if (typeof options.prompt !== 'string' || typeof options.cwd !== 'string' || !options.cwd) throw new TypeError('Claude requires a prompt string and working directory.');
          if (options.command !== undefined && (!record(options.command) || !['native', 'control'].includes(options.command.execution))) throw new TypeError('This Claude command requires an app action and cannot be sent as a model prompt.');
          if (options.synthetic && options.command) throw new TypeError('Synthetic workflow prompts cannot dispatch Claude commands.');
          assertClaudeCommandAccess(options.command, options.access);
          const controlOnly = options.command?.execution === 'control';
          if (options.model !== undefined) assertClaudeModel(options.model);
          const permissionMode = assertClaudePermissionMode(options.permissionMode === undefined ? 'default' : options.permissionMode);
          const accounting = options.command?.execution === 'native' && options.command.name === 'context' && options.command.origin !== 'skill';
          const contextDeadline = accounting ? new Promise((_, reject) => {
            contextTimeout = setTimeout(() => {
              contextTimedOut = true;
              reject(new Error('Native context accounting timed out. Claude did not return /context statistics; retry the command or continue the chat.'));
            }, this.contextTimeoutMs);
          }) : null;
          contextDeadline?.catch(() => {});
          const withinContextDeadline = promise => contextDeadline ? Promise.race([promise, contextDeadline]) : promise;
          const queryImpl = this.queryImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
          const environment = interrupted ? {} : await withinContextDeadline(Promise.race([
            Promise.resolve().then(() => this.environment({ cwd: options.cwd, signal: cancellation.signal })),
            inputClosed.then(() => { throw Error('Claude provider resolution interrupted.'); }),
          ]));
          if (!interrupted) {
            const prompt = (async function* () {
              if (cancellation.signal.aborted) return;
              if (!controlOnly) yield {
                type: 'user', message: { role: 'user', content: options.command?.execution === 'native' && typeof options.command.input === 'string' ? options.command.input : options.prompt },
                parent_tool_use_id: null, ...(options.nativeSessionId ? { session_id: options.nativeSessionId } : {}),
                ...(options.synthetic === true ? { isSynthetic: true } : {}),
              };
              // Keep stdin open so permission replies can still use the control protocol.
              await inputClosed;
            })();
            query = queryImpl({ prompt, options: {
              cwd: options.cwd,
              env: environment,
              ...(options.nativeSessionId ? { resume: options.nativeSessionId } : {}),
              ...(options.model ? { model: options.model } : {}),
              pathToClaudeCodeExecutable: this.executablePath,
              settingSources: ['user', 'project', 'local'],
              systemPrompt: { type: 'preset', preset: 'claude_code', ...(options.instructions ? { append: options.instructions } : {}) },
              ...(options.outputSchema ? { outputFormat: { type: 'json_schema', schema: options.outputSchema } } : {}),
              // Native tool restriction plus hooks/MCP isolation, not an OS
              // sandbox: externally managed hooks can have stronger precedence.
              ...(options.access === 'read' ? { tools: ['Read', 'Grep', 'Glob'], mcpServers: {}, strictMcpConfig: true, settings: { disableAllHooks: true } } : {}),
              permissionMode,
              ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
              includePartialMessages: true,
              enableFileCheckpointing: true,
              abortController: sdkAbort,
              canUseTool,
              spawnClaudeCodeProcess,
            } });
            resolveQuery(query);
            const whileActive = promise => Promise.race([promise, inputClosed.then(() => { throw Error('Claude command interrupted.'); })]);
            if (controlOnly) {
              if (typeof query.initializationResult !== 'function') throw new Error('Claude control commands are unavailable in this SDK.');
              try { await whileActive(query.initializationResult()); }
              catch { throw new Error('Claude control initialization failed. Check the native session and configured provider.'); }
              cancellation.signal.throwIfAborted();
              const response = await whileActive(executeClaudeControl(query, options.command, '', { access: options.access, signal: cancellation.signal }));
              cancellation.signal.throwIfAborted();
              normalizer.output(response.text, `control:${randomUUID()}`);
              summary = { nativeSessionId: normalizer.nativeSessionId, status: 'completed', text: response.text,
                ...(response.settingsPatch ? { settingsPatch: response.settingsPatch } : {}),
                ...(response.clientAction ? { clientAction: response.clientAction } : {}) };
              if (response.settingsPatch?.permissionMode) {
                actualPermissionMode = assertClaudePermissionMode(response.settingsPatch.permissionMode);
                options.onEvent?.({ type: 'permission-mode', requestedMode: permissionMode, actualMode: actualPermissionMode });
              }
              keepControlAlive = response.keepAlive === true;
              if (keepControlAlive) normalizer.beginTurn();
            }
            if (!controlOnly || keepControlAlive) while (true) {
              const next = keepControlAlive ? await whileActive(query.next()) : await withinContextDeadline(query.next());
              if (next.done) {
                if (keepControlAlive && !interrupted) throw new Error('Claude Remote Control session ended. Start /remote-control again to reconnect.');
                break;
              }
              if (next.value?.type === 'system' && ['init', 'status'].includes(next.value.subtype) &&
                next.value.parent_tool_use_id == null && CLAUDE_PERMISSION_MODES.includes(next.value.permissionMode) && next.value.permissionMode !== actualPermissionMode) {
                actualPermissionMode = next.value.permissionMode;
                if (next.value.subtype === 'status') changedPermissionMode = actualPermissionMode;
                options.onEvent?.({ type: 'permission-mode', requestedMode: permissionMode, actualMode: actualPermissionMode });
              }
              const terminal = normalizer.consume(next.value);
              if (terminal) {
                summary = terminal;
                // /model only changes a headless process. Read the accepted
                // native value before shutdown so the host can carry it forward.
                const changesModel = terminal.localCommand === 'model' || (terminal.localCommand === 'config' && /(?:^|\s)model\s*=/i.test(options.command?.args ?? options.prompt));
                if (terminal.status === 'completed' && changesModel) {
                  if (typeof query.getSettings !== 'function') throw new Error('Claude cannot report the model selected by this command.');
                  let settings;
                  try { settings = await whileActive(query.getSettings()); }
                  catch { throw new Error('Claude could not confirm the model selected by this command.'); }
                  cancellation.signal.throwIfAborted();
                  const model = assertClaudeModel(settings?.applied?.model);
                  summary.settingsPatch = { ...summary.settingsPatch, model };
                  summary.actualModel = normalizer.actualModel = model;
                }
                if (!keepControlAlive) break;
              }
            }
          }
        }
      } catch (error) { failure = errorText(error); }
      finally {
        clearTimeout(contextTimeout);
        releaseInput();
        cancellation.abort();
        resolveQuery(undefined);
        try { await shutdown(contextTimedOut); } catch (error) { cleanupFailure = failure = `Claude SDK cleanup failed: ${errorText(error)}`; }
        try { normalizer.finish(); } catch (error) { failure ??= errorText(error); }
        try { normalizer.endTasks(); } catch (error) { failure ??= errorText(error); }
        options.signal?.removeEventListener('abort', onAbort);
      }
      if (interrupted) summary = { nativeSessionId: normalizer.nativeSessionId, status: 'interrupted', ...(summary?.usage ? { usage: summary.usage } : {}), ...(cleanupFailure ? { error: cleanupFailure } : {}) };
      else if (failure || !summary) summary = { nativeSessionId: normalizer.nativeSessionId, status: 'failed', error: failure || normalizer.error || 'Claude stream ended without a terminal result.' };
      // Init can advertise an ID before the CLI creates a resumable transcript.
      // A failed command that never acknowledged input must not replace its
      // original binding with that transient ID; null deliberately clears it.
      if (options.command && ['failed', 'interrupted'].includes(summary.status) && !normalizer.inputAcknowledged) summary.sessionIdToRestore = options.nativeSessionId ?? null;
      summary.text ??= normalizer.text;
      summary.nativeTasks = normalizer.nativeTasks;
      if (normalizer.actualModel) summary.actualModel ??= normalizer.actualModel;
      if (actualPermissionMode) summary.actualPermissionMode = actualPermissionMode;
      if (summary.status === 'completed' && changedPermissionMode) summary.settingsPatch = { ...summary.settingsPatch, permissionMode: changedPermissionMode };
      settled = true;
      try { options.onEvent({ type: 'result', ...summary }); } catch { /* completion remains available through done */ }
      return summary;
    });
    return { done, interrupt, control };
  }
}
