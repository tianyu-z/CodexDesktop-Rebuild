import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const builder = require('../../scripts/build-computer-use-preview.js');

test('preview builder refuses existing output without modifying it', async t => {
  assert.equal(typeof builder.build, 'function');
  const root = mkdtempSync(join(tmpdir(), 'computer-use-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'existing.app'); mkdirSync(output); writeFileSync(join(output, 'keep'), 'original');
  await assert.rejects(builder.build({ sourceApp: output, output }), /already exists/);
  assert.equal(readFileSync(join(output, 'keep'), 'utf8'), 'original');
});

test('unsupported installed archive fails before producing a preview or changing its source', async t => {
  assert.equal(typeof builder.build, 'function');
  const asar = await import('@electron/asar');
  const root = mkdtempSync(join(tmpdir(), 'computer-use-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceApp = join(root, 'source.app'), output = join(root, 'preview.app'), input = join(root, 'input');
  mkdirSync(join(sourceApp, 'Contents/Resources'), { recursive: true }); mkdirSync(join(input, '.vite/build'), { recursive: true });
  writeFileSync(join(input, 'package.json'), JSON.stringify({ main: '.vite/build/early-bootstrap.js' }));
  writeFileSync(join(input, '.vite/build/early-bootstrap.js'), 'require("./main-fixture.js");');
  writeFileSync(join(input, '.vite/build/main-fixture.js'), 'unsupported upstream');
  const archive = join(sourceApp, 'Contents/Resources/app.asar'); await asar.createPackage(input, archive);
  const original = readFileSync(archive);
  await assert.rejects(builder.build({ sourceApp, output }), /exactly 1/);
  assert.deepEqual(readFileSync(archive), original); assert.equal(existsSync(output), false);
});
