import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ClaudeEventNormalizer } from './claude-events.mjs';
import { resolveClaudeEnvironment } from './claude-environment.mjs';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorText = (error) => error instanceof Error ? error.message : String(error);

/** One isolated SDK query per run; native Claude persists the resumable session. */
export class ClaudeAdapter {
  constructor({ executablePath = join(homedir(), '.local', 'bin', 'claude'), queryImpl, environment = resolveClaudeEnvironment } = {}) {
    this.executablePath = executablePath;
    this.queryImpl = queryImpl;
    this.environment = environment;
  }

  start(options) {
    const cancellation = new AbortController();
    const sdkAbort = new AbortController();
    const normalizer = new ClaudeEventNormalizer({ onEvent: options.onEvent });
    normalizer.nativeSessionId = options.nativeSessionId;
    let query;
    let nativeChild;
    let childExited;
    let pipesDrained;
    let hasChildExited = false;
    let interrupted = options.signal?.aborted === true;
    let settled = false;
    let shutdownPromise;
    let releaseInput;
    const inputClosed = new Promise((resolve) => { releaseInput = resolve; });
    if (interrupted) cancellation.abort();

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
            if (interrupted) sdkAbort.abort();
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
          const queryImpl = this.queryImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
          if (!interrupted) {
            const prompt = (async function* () {
              if (cancellation.signal.aborted) return;
              yield { type: 'user', message: { role: 'user', content: options.prompt }, parent_tool_use_id: null, ...(options.nativeSessionId ? { session_id: options.nativeSessionId } : {}) };
              // Keep stdin open so permission replies can still use the control protocol.
              await inputClosed;
            })();
            query = queryImpl({ prompt, options: {
              cwd: options.cwd,
              env: this.environment(),
              ...(options.nativeSessionId ? { resume: options.nativeSessionId } : {}),
              ...(options.model ? { model: options.model } : {}),
              pathToClaudeCodeExecutable: this.executablePath,
              settingSources: ['user', 'project', 'local'],
              systemPrompt: { type: 'preset', preset: 'claude_code' },
              permissionMode: 'default',
              includePartialMessages: true,
              abortController: sdkAbort,
              canUseTool,
              spawnClaudeCodeProcess,
            } });
            while (true) {
              const next = await query.next();
              if (next.done) break;
              const terminal = normalizer.consume(next.value);
              if (terminal) { summary = terminal; break; }
            }
          }
        }
      } catch (error) { failure = errorText(error); }
      finally {
        releaseInput();
        cancellation.abort();
        try { await shutdown(); } catch (error) { cleanupFailure = failure = `Claude SDK cleanup failed: ${errorText(error)}`; }
        try { normalizer.finish(); } catch (error) { failure ??= errorText(error); }
        options.signal?.removeEventListener('abort', onAbort);
      }
      if (interrupted) summary = { nativeSessionId: normalizer.nativeSessionId, status: 'interrupted', ...(summary?.usage ? { usage: summary.usage } : {}), ...(cleanupFailure ? { error: cleanupFailure } : {}) };
      else if (failure || !summary) summary = { nativeSessionId: normalizer.nativeSessionId, status: 'failed', error: failure || normalizer.error || 'Claude stream ended without a terminal result.' };
      settled = true;
      try { options.onEvent({ type: 'result', ...summary }); } catch { /* completion remains available through done */ }
      return summary;
    });
    return { done, interrupt };
  }
}
