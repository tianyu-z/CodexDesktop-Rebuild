#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { isAbsolute } from 'node:path';
import { WebSocket } from 'ws';
import { DESKTOP_REQUEST_BYTES, OWNER_RESPONSE_BYTES, OUTPUT_QUEUE_BYTES, HARD_OUTPUT_QUEUE_BYTES } from './limits.mjs';

/** Start or reattach to Codex's installer-managed app-server daemon. */
export function ensureSharedNativeDaemon({ command, env = process.env, timeoutMs = 10000 }) {
  if (!command) return Promise.reject(Error('Shared native Codex executable is required.'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-c', 'features.code_mode_host=true', 'app-server', 'daemon', 'start'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stdoutBytes = 0, stderr = '', settled = false, failure, exitCode, drainTimer;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(drainTimer);
      // The CLI may have launched an independent daemon or another descendant
      // that inherited these pipes. Release only this probe's read handles.
      child.stdout.destroy(); child.stderr.destroy();
      if (failure) { reject(failure); return; }
      if (exitCode !== 0) { reject(Error(`Shared native daemon startup failed (${exitCode}): ${stderr.trim()}`)); return; }
      let result;
      try { result = JSON.parse(stdout); } catch { reject(Error('Invalid shared native daemon response.')); return; }
      if (!['started', 'alreadyRunning'].includes(result?.status) || typeof result.socketPath !== 'string'
          || !isAbsolute(result.socketPath) || result.socketPath.includes('\n')) {
        reject(Error('Shared native daemon did not provide a valid running socket.')); return;
      }
      resolve(result.socketPath);
    };
    const stop = error => {
      if (failure || settled) return;
      failure = error; child.kill('SIGKILL');
      drainTimer ??= setTimeout(finish, 200);
    };
    const timer = setTimeout(() => stop(Error('Shared native daemon startup timed out.')), timeoutMs);
    child.stdout.on('data', bytes => {
      if (failure || settled) return;
      stdoutBytes += bytes.length;
      if (stdoutBytes > 8192) { stop(Error('Invalid shared native daemon response.')); return; }
      stdout += bytes;
    });
    child.stderr.on('data', bytes => { if (!failure && !settled) stderr = (stderr + bytes).slice(-8192); });
    child.on('error', error => { failure ??= error; if (!child.pid) finish(); });
    child.once('exit', code => { exitCode = code; drainTimer ??= setTimeout(finish, 200); });
    child.once('close', code => { exitCode ??= code; finish(); });
  });
}

/** Adapt the gateway's JSON-line native client to the official daemon's stdio WebSocket proxy. */
export function startSharedNativeBridge({ command, socketPath, env = process.env, input = process.stdin, output = process.stdout,
  timeoutMs = 5000, onError = error => console.error(error.message) }) {
  if (!command || !socketPath) throw Error('Shared native daemon command and socket are required.');
  const child = spawn(command, ['app-server', 'proxy', '--sock', socketPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.pipe(process.stderr, { end: false });
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
  Object.assign(transport, { setTimeout: () => transport, setNoDelay: () => transport, setKeepAlive: () => transport });
  const ws = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => transport,
    handshakeTimeout: timeoutMs, maxPayload: OWNER_RESPONSE_BYTES, perMessageDeflate: false });
  let closed = false, ready = false, buffer = Buffer.alloc(0);
  let openingTimer;
  const outboundBacklog = () => Math.max(ws.bufferedAmount, transport.writableLength ?? 0, child.stdin.writableLength ?? 0);
  const fail = error => { if (closed) return; closed = true; clearTimeout(openingTimer); onError(error); ws.terminate(); child.kill(); transport.destroy(); input.destroy(); output.end(); };
  openingTimer = setTimeout(() => fail(Error('Shared native daemon handshake timed out.')), timeoutMs);
  const flush = () => {
    while (ready && buffer.length) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      const line = buffer.subarray(0, end), bytes = buffer.subarray(end + 1);
      buffer = bytes;
      if (line.length > DESKTOP_REQUEST_BYTES) { fail(Error('Shared native request exceeds the 16 MiB limit.')); return; }
      let message;
      try { message = JSON.parse(line); } catch { fail(Error('Shared native client emitted invalid JSON.')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(Error('Shared native client emitted an invalid RPC message.')); return; }
      if (outboundBacklog() + line.length > HARD_OUTPUT_QUEUE_BYTES) { fail(Error('Shared native proxy output is backlogged.')); return; }
      ws.send(line, { binary: false }, error => { if (error) fail(error); else if (!closed) { flush(); if (outboundBacklog() < OUTPUT_QUEUE_BYTES) input.resume(); } });
      if (outboundBacklog() > OUTPUT_QUEUE_BYTES) { input.pause(); break; }
    }
    if (buffer.indexOf(10) < 0 && buffer.length > DESKTOP_REQUEST_BYTES) fail(Error('Shared native request exceeds the 16 MiB limit.'));
    else if (buffer.length > HARD_OUTPUT_QUEUE_BYTES) fail(Error('Shared native request queue is backlogged.'));
  };
  input.on('data', bytes => { buffer = Buffer.concat([buffer, bytes]); flush(); });
  input.on('end', () => { closed = true; clearTimeout(openingTimer); ws.close(); child.kill(); });
  input.on('error', fail); output.on('error', fail); child.on('error', fail);
  child.on('exit', (code, signal) => { if (!closed) fail(Error(`Shared native proxy exited (${signal ?? code}).`)); });
  ws.on('error', fail); ws.on('close', () => { if (!closed) fail(Error('Shared native daemon connection closed.')); });
  ws.on('open', () => { clearTimeout(openingTimer); ready = true; flush(); });
  ws.on('message', bytes => {
    if (closed) return;
    let message;
    try { message = JSON.parse(bytes); } catch { fail(Error('Shared native daemon emitted invalid JSON.')); return; }
    const line = Buffer.concat([bytes, Buffer.from('\n')]);
    if (line.length > OWNER_RESPONSE_BYTES + 1) { fail(Error('Shared native daemon message exceeds the response limit.')); return; }
    if ((output.writableLength ?? 0) > HARD_OUTPUT_QUEUE_BYTES) { fail(Error('Shared native output is backlogged.')); return; }
    if (!output.write(line)) {
      ws._socket?.pause();
      output.once('drain', () => ws._socket?.resume());
    }
  });
  return { close: () => { if (!closed) { closed = true; clearTimeout(openingTimer); ws.terminate(); child.kill(); transport.destroy(); } } };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startSharedNativeBridge({ command: process.argv[2], socketPath: process.argv[3], onError: error => {
    console.error(error.message); process.exitCode = 1;
  } });
}
