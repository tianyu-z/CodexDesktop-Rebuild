import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { startSharedNativeBridge } from '../../runtime/agent-modes/remote/shared-native.mjs';

test('existing native socket remains usable when launching the CLI would stall', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cdx-direct-native-'));
  const socketPath = join(directory, 'native.sock'), cli = join(directory, 'codex'), marker = join(directory, 'launched');
  writeFileSync(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes');process.stdin.resume();`, { mode: 0o700 });
  const http = createServer(), server = new WebSocketServer({ server: http });
  server.on('connection', ws => ws.on('message', bytes => {
    const request = JSON.parse(bytes);
    ws.send(JSON.stringify({ id: request.id, result: { userAgent: 'existing-native' } }));
  }));
  await new Promise(resolve => http.listen(socketPath, resolve));
  const input = new PassThrough(), output = new PassThrough();
  let bridge;
  t.after(async () => {
    bridge?.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => http.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const response = new Promise((resolve, reject) => {
    output.once('data', bytes => resolve(JSON.parse(bytes)));
    bridge = startSharedNativeBridge({ command: cli, socketPath, input, output, timeoutMs: 250, onError: reject });
  });
  input.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\n');
  assert.deepEqual(await response, { id: 1, result: { userAgent: 'existing-native' } });
  assert.equal(existsSync(marker), false, 'Attaching to a running owner must not execute the CLI again');
  bridge.close();
  assert.equal(http.listening, true, 'Closing the bridge must preserve the native daemon');
});

test('an unavailable native socket fails without launching a replacement owner', { timeout: 3000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cdx-missing-native-'));
  const socketPath = join(directory, 'missing.sock'), cli = join(directory, 'codex'), marker = join(directory, 'launched');
  writeFileSync(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes');`, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough(), output = new PassThrough();
  const error = await new Promise(resolve => {
    const bridge = startSharedNativeBridge({ command: cli, socketPath, input, output, onError: resolve });
    t.after(() => bridge.close());
  });
  assert.equal(error.code, 'ENOENT');
  assert.equal(input.destroyed, true);
  assert.equal(existsSync(marker), false);
});
