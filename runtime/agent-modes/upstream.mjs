import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

/** Dedicated native transport: IDs from the client, gateway, and server never collide. */
export class NativeClient {
  constructor({ command, args, env, onNotification, onRequest, onExit, stderr = process.stderr }) {
    this.pending = new Map(); this.serverRequests = new Map(); this.closed = false;
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.pipe(stderr, { end: false });
    this.child.stdin.on('error', error => this.fail(error));
    let resolveExited;
    this.exited = new Promise(resolve => { resolveExited = resolve; });
    this.child.on('error', error => { this.fail(error); if (!this.child.pid) resolveExited({ code: null, signal: null }); });
    this.child.once('exit', (code, signal) => { this.closed = true; resolveExited({ code, signal }); });
    const pipesClosed = new Promise(resolve => this.child.once('close', resolve));
    this.done = this.exited.then(async result => {
      let timer;
      await Promise.race([pipesClosed, new Promise(resolve => { timer = setTimeout(resolve, 200); })]);
      clearTimeout(timer);
      // Background tools can inherit these pipes after the owned process exits.
      // Release only our handles, without killing independent descendants.
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
      this.closed = true;
      this.fail(new Error(`Native Codex exited (${result.signal ?? result.code}).`));
      onExit?.(result.code, result.signal);
      return result;
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Native Codex emitted invalid JSON.')); return; }
      if (message.method && message.id !== undefined) {
        const id = `native-request:${randomUUID()}`;
        this.serverRequests.set(id, message.id);
        onRequest({ ...message, id });
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
        else pending.resolve(message.result);
      } else onNotification(message);
    });
  }
  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Native Codex is unavailable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params) {
    const id = `gateway:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  respond(message) {
    if (!this.serverRequests.has(message.id)) return false;
    const id = this.serverRequests.get(message.id); this.serverRequests.delete(message.id);
    this.send({ ...message, id }); return true;
  }
  notify(message) { this.send(message); }
  fail(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  async close() {
    if (this.closed) return this.done;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 1000);
    const hardTimer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try { return await this.done; } finally { clearTimeout(timer); clearTimeout(hardTimer); }
  }
}
