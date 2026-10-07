import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ClaudeEventNormalizer } from './claude-events.mjs';
import { resolveClaudeEnvironment } from './claude-environment.mjs';
import { ClaudeModelCatalog, assertClaudeModel } from './claude-models.mjs';
import { CLAUDE_PERMISSION_MODES, assertClaudePermissionMode } from './claude-permissions.mjs';
import { selectedClaudePermissionUpdates } from './claude-interactions.mjs';
import { claudeNativeContent } from './claude-input.mjs';
import { ClaudeCommandCatalog, executeClaudeControl, assertClaudeLiveCommand, assertClaudeCommandAccess, isNativeClaudeGoal } from './claude-commands.mjs';
import { normalizeClaudeSessionOptions, claudeSessionQueryOptions, applyClaudeSessionResets, captureClaudeSessionOptions, executeClaudeTaskControl, callClaudeNativeControl } from './claude-native-controls.mjs';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorText = (error) => error instanceof Error ? error.message : String(error);
const modelInputContent = content => {
  const blocks = claudeNativeContent(content);
  // Native CLI slash parsing also runs after host dispatch. A neutral leading
  // block keeps slash-looking text attached to its images on every CLI version.
  return blocks.some(block => block.type === 'image')
    ? claudeNativeContent([{ type: 'text', text: '[User input with attachments]' }, ...blocks]) : blocks;
};

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
    options = { ...options, claudeOptions: structuredClone(options.claudeOptions) };
    const suppliedContent = options.content === undefined ? undefined : structuredClone(options.content);
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
    const initialMessageId = randomUUID();
    const inputs = [], pendingInputs = new Map();
    let wakeInput, ending = false, initialAnswered = false, nativeGoalControls = false;
    const steer = async (text, { goalControl = false } = {}) => {
      if (typeof text !== 'string') text = modelInputContent(text);
      else if (!text.trim()) throw new Error('Steering requires a nonempty text prompt.');
      if (settled || ending || cancellation.signal.aborted || options.command && !isNativeClaudeGoal(options.command)) throw new Error('Claude steering requires an active model turn.');
      const id = randomUUID();
      let resolve, reject;
      const written = new Promise((yes, no) => { resolve = yes; reject = no; });
      const entry = { id, text, resolve, reject };
      nativeGoalControls ||= goalControl;
      pendingInputs.set(id, entry); inputs.push(entry); wakeInput?.();
      await written;
      return { messageId: id };
    };
    const closeInputs = () => {
      ending = true; wakeInput?.();
      for (const entry of pendingInputs.values()) entry.reject(new Error('Claude steering interrupted or its native process ended.'));
      inputs.length = 0;
    };
    if (interrupted) cancellation.abort();

    // Side controls share the owned worker. Native /goal replies arrive on
    // its output stream but must not settle or replace the main model result.
    // Cancelling one control must not interrupt the main turn or other controls.
    const control = async (command, { signal } = {}) => {
      const selected = assertClaudeLiveCommand(command);
      if (settled || cancellation.signal.aborted) throw new Error('Claude control requires an active native process.');
      if (isNativeClaudeGoal(selected)) {
        signal?.throwIfAborted();
        assertClaudeCommandAccess(selected, options.access);
        await steer(selected.input, { goalControl: true });
        return { nativeInput: true };
      }
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
        const response = selected.name === 'tasks' ? await active(executeClaudeTaskControl(native, selected, { nativeTasks: normalizer.nativeTasks, signal: requestController.signal }))
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
            id: request.toolUseID, name, input: structuredClone(input), signal: permission.signal,
            ...(typeof request.decisionReason === 'string' ? { reason: request.decisionReason } : {}),
            ...Object.fromEntries(['title', 'displayName', 'description', 'blockedPath'].filter(key => typeof request[key] === 'string').map(key => [key, request[key]])),
            ...Object.fromEntries(['defaultToNo', 'suppressAlwaysAllowRule'].filter(key => typeof request[key] === 'boolean').map(key => [key, request[key]])),
            ...(Array.isArray(request.suggestions) ? { suggestions: structuredClone(request.suggestions) } : {}),
            ...(record(request.mcpServer) ? { mcpServer: structuredClone(request.mcpServer) } : {}),
          });
          if (permission.signal.aborted) return deny('Permission request interrupted.', true);
          if (response?.decision === 'accept' && (response.updatedInput === undefined || record(response.updatedInput))) {
            const updatedPermissions = selectedClaudePermissionUpdates({ ...request, name, input }, response);
            return { behavior: 'allow', updatedInput: response.updatedInput ?? input, ...(updatedPermissions ? { updatedPermissions } : {}), toolUseID: request.toolUseID };
          }
          return deny(typeof response?.message === 'string' && response.message.trim() ? response.message : response?.decision === 'decline' ? 'Permission declined by user.' : 'Permission decision was not accepted.');
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
        closeInputs();
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
          const content = suppliedContent === undefined ? undefined : modelInputContent(suppliedContent);
          if (content && options.command) throw new Error('Image/content input cannot be dispatched as a Claude command.');
          if (options.command !== undefined && (!record(options.command) || !['native', 'control'].includes(options.command.execution))) throw new TypeError('This Claude command requires an app action and cannot be sent as a model prompt.');
          if (options.synthetic && options.command) throw new TypeError('Synthetic workflow prompts cannot dispatch Claude commands.');
          assertClaudeCommandAccess(options.command, options.access);
          const controlOnly = options.command?.execution === 'control';
          const claudeOptions = normalizeClaudeSessionOptions(options.claudeOptions);
          const sessionQueryOptions = claudeSessionQueryOptions(claudeOptions);
          const needsSessionReset = claudeOptions.effort === null;
          const nativeBuiltin = options.command?.origin === 'builtin' && options.command.execution === 'native';
          const nativeArgs = (options.command?.args ?? options.command?.input?.replace(/^\/\S+(?:\s+|$)/, '') ?? '').trim();
          let settingsIntent = nativeBuiltin && options.command.name === 'effort' && ['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(nativeArgs.toLowerCase())
            ? { name: 'effort', args: nativeArgs.toLowerCase() } : null;
          const nativeStyleCandidate = nativeBuiltin && options.command.name === 'output-style' && nativeArgs !== '';
          const needsStartupGate = needsSessionReset || nativeStyleCandidate;
          // The native setter writes project-local settings. An inline startup
          // outputStyle would shadow that write, and this CLI cannot clear that
          // original flag with applyFlagSettings(null). Leave it out of this
          // command-only process; the saved binding changes only after readback.
          if (nativeStyleCandidate) delete sessionQueryOptions.settings;
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
            let releaseStartup;
            const startupReady = needsStartupGate ? new Promise(resolve => { releaseStartup = resolve; }) : null;
            const prompt = (async function* () {
              // The native process can initialize with an empty streaming input.
              // Hold its first prompt until a session reset or style-change gate is applied.
              if (startupReady) await Promise.race([startupReady, inputClosed]);
              if (ending || cancellation.signal.aborted) return;
              if (!controlOnly) yield {
                type: 'user', uuid: initialMessageId, message: { role: 'user', content: options.command?.execution === 'native' && typeof options.command.input === 'string' ? options.command.input : content ?? options.prompt },
                parent_tool_use_id: null, ...(options.nativeSessionId ? { session_id: options.nativeSessionId } : {}),
                ...(options.synthetic === true ? { isSynthetic: true } : {}),
              };
              // A single SDK stream owns stdin. streamInput() on a second iterable
              // closes that stdin and breaks permissions when its iterable ends.
              while (!ending && !cancellation.signal.aborted) {
                const entry = inputs.shift();
                if (!entry) {
                  await Promise.race([new Promise(resolve => { wakeInput = resolve; }), inputClosed]);
                  wakeInput = undefined;
                  continue;
                }
                yield { type: 'user', uuid: entry.id, priority: 'now', parent_tool_use_id: null,
                  ...(normalizer.nativeSessionId ? { session_id: normalizer.nativeSessionId } : {}),
                  message: { role: 'user', content: entry.text } };
                // The SDK requests another input only after transport.write.
                if (!ending && !cancellation.signal.aborted) entry.resolve();
              }
            })();
            query = queryImpl({ prompt, options: {
              cwd: options.cwd,
              // The native default retries a timed-out request up to ten times,
              // which can leave a desktop turn waiting for nearly an hour.
              // Bound automatic recovery, preserving any explicit configuration.
              env: { ...environment, CLAUDE_CODE_MAX_RETRIES: environment.CLAUDE_CODE_MAX_RETRIES ?? '2',
                // Foundry can send only SSE pings until a long thinking block
                // finishes. Native Claude ignores those pings for its five-minute
                // event watchdog, aborting useful work and restarting it without
                // streaming. Use its supported longer window for this provider;
                // explicit env and native project settings still take precedence.
                ...(/^(1|true|yes|on)$/i.test(environment.CLAUDE_CODE_USE_FOUNDRY ?? '') ? {
                  CLAUDE_STREAM_IDLE_TIMEOUT_MS: environment.CLAUDE_STREAM_IDLE_TIMEOUT_MS ?? '3600000',
                } : {}),
              },
              ...(options.nativeSessionId ? { resume: options.nativeSessionId } : {}),
              ...(options.model ? { model: options.model } : {}),
              ...sessionQueryOptions,
              // Ask native Claude for API-side summaries like its editor UI.
              // This display flag leaves native thinking enablement/budget alone;
              // explicit per-session display choices and disabled thinking win.
              ...(sessionQueryOptions.thinking?.type !== 'disabled' && sessionQueryOptions.thinking?.display === undefined
                ? { extraArgs: { 'thinking-display': 'summarized' } } : {}),
              pathToClaudeCodeExecutable: this.executablePath,
              settingSources: ['user', 'project', 'local'],
              systemPrompt: { type: 'preset', preset: 'claude_code', ...(options.instructions ? { append: options.instructions } : {}) },
              ...(options.outputSchema ? { outputFormat: { type: 'json_schema', schema: options.outputSchema } } : {}),
              // Native tool restriction plus hooks/MCP isolation, not an OS
              // sandbox: externally managed hooks can have stronger precedence.
              ...(options.access === 'read' ? { tools: ['Read', 'Grep', 'Glob'], mcpServers: {}, strictMcpConfig: true } : {}),
              ...(sessionQueryOptions.settings || options.access === 'read' ? { settings: { ...sessionQueryOptions.settings, ...(options.access === 'read' ? { disableAllHooks: true } : {}) } } : {}),
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
            let initialization;
            if (controlOnly || needsStartupGate) {
              if (typeof query.initializationResult !== 'function') throw new Error('Claude control commands are unavailable in this SDK.');
              try { initialization = await whileActive(query.initializationResult()); }
              catch { throw new Error('Claude control initialization failed. Check the native session and configured provider.'); }
              cancellation.signal.throwIfAborted();
            }
            if (needsSessionReset) {
              await whileActive(applyClaudeSessionResets(query, claudeOptions, { signal: cancellation.signal }));
              cancellation.signal.throwIfAborted();
            }
            if (nativeStyleCandidate) {
              if (!Array.isArray(initialization?.available_output_styles)) throw new Error('This native Claude runtime cannot report available output styles. Update the selected host runtime before changing styles.');
              const style = initialization.available_output_styles.find(value => typeof value === 'string' && value.toLowerCase() === nativeArgs.toLowerCase());
              if (style) {
                if (options.access === 'read') throw new Error('/output-style changes native project settings and requires write access; this Claude role has read-only access.');
                settingsIntent = { name: 'output-style', args: style };
              }
            }
            cancellation.signal.throwIfAborted();
            releaseStartup?.();
            if (controlOnly) {
              let modelInfo;
              if (options.command.name === 'thinking' && options.command.args?.trim() === 'adaptive') {
                const settings = await callClaudeNativeControl(query, 'thinking', 'getSettings', [], { signal: cancellation.signal });
                modelInfo = initialization?.models?.find(row => [row.value, row.resolvedModel].includes(settings?.applied?.model));
              }
              const response = await whileActive(executeClaudeControl(query, options.command, '', { access: options.access, signal: cancellation.signal, currentOptions: claudeOptions, modelInfo }));
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
              const answered = next.value?.user_message_uuids ?? (next.value?.user_message_uuid ? [next.value.user_message_uuid] : []);
              // Classify before normalizing: a side result must not finalize
              // an open main-model text block or overwrite its result metadata.
              const goalControlResult = nativeGoalControls && next.value?.type === 'result' && next.value.local_command === 'goal' && !answered.includes(initialMessageId);
              const terminal = normalizer.consume(next.value, { sideResult: goalControlResult });
              if (terminal) {
                if (!goalControlResult) summary = terminal;
                if (answered.includes(initialMessageId)) initialAnswered = true;
                for (const id of answered) pendingInputs.delete(id);
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
                const settingsCommand = terminal.localCommand === 'output_style' ? 'output-style' : terminal.localCommand;
                if (terminal.status === 'completed' && settingsIntent && settingsIntent.name === settingsCommand) {
                  const confirmed = await whileActive(captureClaudeSessionOptions(query, { command: settingsCommand, args: settingsIntent.args, currentOptions: claudeOptions, signal: cancellation.signal }));
                  cancellation.signal.throwIfAborted();
                  // Native commands can report text errors in a successful
                  // zero-turn envelope. Only persist a confirmed setting value.
                  if (settingsCommand === 'output-style' ? confirmed.outputStyle?.toLowerCase() === settingsIntent.args.toLowerCase()
                    : settingsIntent.args === 'auto' || typeof confirmed.effort === 'string') summary.settingsPatch = { ...summary.settingsPatch, claudeOptions: confirmed };
                }
                if (!keepControlAlive && (terminal.status !== 'completed' && !goalControlResult || pendingInputs.size === 0 && (!nativeGoalControls || initialAnswered))) { ending = true; break; }
                if ((pendingInputs.size || nativeGoalControls && !initialAnswered) && !answered.length) throw new Error('This Claude version did not acknowledge live steering. Stop and resend the follow-up as a new turn.');
              }
            }
          }
        }
      } catch (error) { failure = errorText(error); }
      finally {
        clearTimeout(contextTimeout);
        closeInputs();
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
    return { done, interrupt, control, steer };
  }
}
