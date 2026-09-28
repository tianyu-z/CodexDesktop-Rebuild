import { spawn } from 'node:child_process';

const compatibilityArgs = ['--enable', 'use_legacy_landlock'];
const namespaceDenied = /^bwrap: (?:loopback: Failed RTM_NEWADDR: Operation not permitted|Failed to make \/ slave: Permission denied)\r?$/m;

function probe(command, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure, exited, settled = false, bytes = 0, stderr = '', drainTimer;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(drainTimer);
      child.stdout.destroy(); child.stderr.destroy();
      if (failure) reject(failure); else resolve({ ...exited, stderr });
    };
    const stop = message => {
      if (failure || settled) return;
      failure = Error(message);
      // Own only the direct probe process. Never signal a process group or a
      // different Codex instance running on the host.
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('Remote Codex read-only sandbox probe timed out.'), timeoutMs);
    const consume = (chunk, diagnostic) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { stop('Remote Codex sandbox probe exceeded its output limit.'); return; }
      if (diagnostic) stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => consume(chunk, false));
    child.stderr.on('data', chunk => consume(chunk, true));
    child.on('error', error => {
      failure ??= Error(`Remote Codex sandbox probe could not start (${error.code ?? 'spawn error'}).`);
      if (!child.pid) finish();
    });
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      // A descendant inheriting stdout does not extend ownership or leave this
      // short capability check waiting forever after its child has exited.
      drainTimer = setTimeout(finish, 200);
    });
    child.once('close', (code, signal) => { exited ??= { code, signal }; finish(); });
  });
}

/** Select only a verified native sandbox backend, without changing user config. */
export async function resolveRemoteSandboxArgs({ command, env = process.env, timeoutMs = 4000 }) {
  if (typeof command !== 'string' || !command || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid remote sandbox probe configuration.');
  const args = ['sandbox', '-c', 'sandbox_mode="read-only"'];
  const normal = await probe(command, [...args, '--', '/bin/true'], { env, timeoutMs });
  if (normal.code === 0) return [];
  if (!namespaceDenied.test(normal.stderr)) throw Error(`Remote Codex read-only sandbox preflight failed (exit ${normal.code ?? normal.signal}).`);
  const legacy = await probe(command, [...args, ...compatibilityArgs, '--', '/bin/true'], { env, timeoutMs });
  if (legacy.code !== 0) throw Error('Remote Codex read-only sandbox is unavailable with both native backends.');
  return [...compatibilityArgs];
}
