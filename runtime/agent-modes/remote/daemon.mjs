#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, lstatSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createEngineRuntime } from '../runtime.mjs';
import { startRemoteServer } from './server.mjs';
import { remoteClaudeEnvironment } from './environment.mjs';
import { acquireStartupLock } from './startup-lock.mjs';
import { resolveRemoteSandboxArgs } from './sandbox.mjs';
import { startRemoteProxy } from './proxy.mjs';

const scope = process.env.CDX_REMOTE_SCOPE ?? 'chatgpt-dev';
if (!/^[a-z0-9-]{1,100}$/.test(scope)) throw Error('Invalid remote engine scope.');
const directory = process.env.CDX_ENGINE_STORE ?? join(homedir(), '.local', 'share', 'codex-desktop-rebuild', scope, 'conversations');
const token = createHash('sha256').update(directory).digest('hex').slice(0, 20);
const socketDirectory = join(tmpdir(), 'cdx-engines-' + (process.getuid?.() ?? 'user') + '-' + token);
const socketPath = join(socketDirectory, 'rpc.sock');
const version = process.env.CDX_REMOTE_VERSION ?? 'development';
// Two bounded 20-second read-only probes plus startup overhead. The desktop
// setup helper allows 90 seconds, including login and a scoped idle upgrade.
const startupTimeoutMs = 45000;
function prepareDirectory() {
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const info = lstatSync(socketDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())) throw Error('Remote engine socket directory is not private.');
}
function controlRequest(path = '/health', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, timeout: 1500 }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; if (body.length > 4096) req.destroy(); });
      res.on('end', () => { try { const result = JSON.parse(body); if (res.statusCode >= 400) reject(Object.assign(Error(result.error ?? 'Gateway control request failed.'), { statusCode: res.statusCode })); else resolve(result); } catch { reject(Error('Invalid gateway control response.')); } });
    });
    req.on('timeout', () => req.destroy(Error('Remote gateway health check timed out.'))); req.on('error', reject); req.end();
  });
}
const health = () => controlRequest();
async function waitForStop() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await health(); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return;
      // A health request accepted just before close may lose its socket. Keep
      // polling until the owner is gone instead of failing a successful stop.
      if (error.code !== 'ECONNRESET') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Remote gateway is still stopping. Retry after its active operations finish.');
}
async function stop(force = false) {
  try { await controlRequest(force ? '/shutdown?force=1' : '/shutdown', 'POST'); }
  catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return; throw error; }
  await waitForStop();
}
function connectionStatus(status) {
  if (status.protocolVersion !== 1) throw Error('The old remote gateway requires a scoped restart before upgrading.');
  // The socket and wire protocol are stable across runtime builds. Reattach to
  // a busy owner so its work/approvals remain reachable; the next idle ensure
  // can upgrade. Never report that the requested runtime is already running.
  return status.version === version ? status : { ...status, upgradeDeferred: true, requestedVersion: version };
}
async function ensure() {
  prepareDirectory();
  try {
    const status = await health();
    if (status.stopping) await waitForStop();
    else if (status.version !== version) {
      const existing = connectionStatus(status);
      if (status.busy) return existing;
      try { await stop(); }
      catch (error) {
        // Work can start after /health reports idle. A refused graceful stop
        // must take the same reconnect path, never escalate to forced shutdown.
        if (error.statusCode !== 409) throw error;
        const current = await health();
        if (current.stopping) await waitForStop();
        else return connectionStatus(current);
      }
    } else return connectionStatus(status);
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const log = openSync(join(directory, 'gateway.log'), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', log, log], env: process.env });
  closeSync(log); child.unref();
  let exited = false; child.once('exit', () => { exited = true; });
  const deadline = performance.now() + startupTimeoutMs;
  while (performance.now() < deadline) {
    try {
      const status = await health();
      // Another installer may win startup with a compatible version. Reuse it
      // rather than reject a reachable owner or start a replacement underneath it.
      if (!status.stopping) return connectionStatus(status);
    } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    if (exited) throw Error('Remote engine gateway exited during startup. Inspect its private gateway.log.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Remote engine gateway did not become ready within 45 seconds.');
}
async function main() {
  const action = process.argv[2];
  if (action === 'ensure') { console.log(JSON.stringify(await ensure())); return; }
  if (action === 'stop') { prepareDirectory(); await stop(true); return; }
  if (action === 'proxy') {
    startRemoteProxy({ socketPath, directory,
      onError: () => { console.error('Remote engine gateway connection failed.'); process.exitCode = 1; },
      // Node intentionally keeps stdout's fd open after destroy(). Once both
      // WebSockets are gone, a stalled SSH reader must not retain this proxy.
      onClose: () => setImmediate(() => process.exit(process.exitCode ?? 0)),
    }); return;
  }
  if (action !== 'serve') throw Error('Expected ensure, serve or proxy.');
  prepareDirectory();
  const deadline = performance.now() + startupTimeoutMs;
  const release = await acquireStartupLock(join(socketDirectory, 'startup.lock'), { timeoutMs: startupTimeoutMs });
  let server;
  try {
    try {
      const status = await health();
      if (status.version !== version) throw Error('A different remote gateway version is running.');
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      try { unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  const command = process.env.CDX_REAL_CODEX;
  if (!command || !process.env.CDX_CLAUDE_PATH) throw Error('Remote Codex and Claude executables must be configured.');
  // Only read roles opt into the backend this read-only probe verified. Main
  // sessions and write roles preserve the user's configured native policies.
  const sandboxArgs = await resolveRemoteSandboxArgs({ command, deadline });
  server = await startRemoteServer({ socketPath, version, closeLock: () => acquireStartupLock(join(socketDirectory, 'startup.lock')),
    runtimeFactory: ({ emit, onExit }) => createEngineRuntime({ command, args: ['-c', 'features.code_mode_host=true', 'app-server'], codexReadRoleArgs: [...sandboxArgs, 'app-server'],
      directory, emit, onExit, remote: true, claudePath: process.env.CDX_CLAUDE_PATH, environment: remoteClaudeEnvironment }) });
  } finally { await release(); }
  let closing;
  const close = () => closing ??= server.close().catch(() => { process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close(); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
