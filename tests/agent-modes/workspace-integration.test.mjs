import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorkspaceManager } from '../../runtime/agent-modes/workspaces/manager.mjs';
const exec = promisify(execFile);

test('independent additions to an absent file produce a repairable integration conflict', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-add-conflict-')), repo = join(root, 'repo');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(repo); await exec('git', ['init', '-q', repo]);
  const manager = new GitWorkspaceManager(join(root, 'artifacts'));
  const base = await manager.prepare({ cwd: repo, runId: 'add-conflict' }), snapshots = [];
  for (const id of ['first', 'second']) {
    const task = await manager.task(base, { id });
    await writeFile(join(task.cwd, 'shared.txt'), `${id}\n`);
    snapshots.push(await manager.freeze(task));
  }
  const conflicted = await manager.integrate(base, snapshots);
  assert.equal(conflicted.status, 'conflicted');
  assert.equal(conflicted.conflicts[0].path, 'shared.txt');
  await writeFile(join(conflicted.cwd, 'shared.txt'), 'combined\n');
  await exec('git', ['-C', conflicted.cwd, 'add', 'shared.txt']);
  const fixed = await manager.finalizeIntegration(base, conflicted);
  assert.equal(fixed.status, 'integrated');
  await manager.apply(base, fixed);
  assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'combined\n');
});

test('replacing a baseline symlink with a directory integrates without traversing the old symlink', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-symlink-transition-')), repo = join(root, 'repo');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(repo); await exec('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'first.txt'), 'preserved\n'); await symlink('first.txt', join(repo, 'alias'));
  const manager = new GitWorkspaceManager(join(root, 'artifacts'));
  const base = await manager.prepare({ cwd: repo, runId: 'symlink-directory' });
  const task = await manager.task(base, { id: 'change' });
  await rm(join(task.cwd, 'alias')); await mkdir(join(task.cwd, 'alias'));
  await writeFile(join(task.cwd, 'alias', 'child.txt'), 'nested\n');
  const integrated = await manager.integrate(base, [await manager.freeze(task)]);
  assert.equal(integrated.status, 'integrated');
  await manager.apply(base, integrated);
  assert.equal(await readFile(join(repo, 'alias', 'child.txt'), 'utf8'), 'nested\n');
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'preserved\n');
});
