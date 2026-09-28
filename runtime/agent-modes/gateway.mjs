#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createEngineRuntime } from './runtime.mjs';

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
  const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  let stopping;
  const runtime = createEngineRuntime({ command, args, directory, emit,
    claudePath: process.env.CDX_CLAUDE_PATH, onExit: () => { void shutdown(); } });
  const { router, native } = runtime;
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
    stopping = Promise.resolve().then(async () => { input.close(); await runtime.close(); await Promise.allSettled([...tasks]); });
    return stopping;
  }
  input.on('close', () => { void shutdown(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
  process.stdout.on('error', () => { void shutdown(); });
}
