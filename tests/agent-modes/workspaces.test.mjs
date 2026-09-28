import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readlink, symlink, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorkspaceManager } from '../../runtime/agent-modes/workspaces/manager.mjs';
import { safePath, git as workspaceGit } from '../../runtime/agent-modes/workspaces/git.mjs';

const exec = promisify(execFile);
async function git(cwd, ...args) { return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout; }
async function unlock(path) {
  const stat = await lstat(path);
  if (stat.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path, { encoding: 'buffer' })) await unlock(Buffer.concat([Buffer.from(path), Buffer.from('/'), name])); }
}
async function fixture(t, { unborn = false } = {}) {
  const root = await fs.realpath(await mkdtemp(join(tmpdir(), 'agent-workspace-')));
  t.after(async () => { await unlock(root); await rm(root, { recursive: true, force: true }); });
  const repo = join(root, 'repo'); await mkdir(repo); await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'workspace@example.invalid');
  await git(repo, 'config', 'user.name', 'Workspace test');
  await writeFile(join(repo, 'first.txt'), 'original\n');
  await writeFile(join(repo, 'second.txt'), 'second\n');
  if (!unborn) { await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'baseline'); }
  const directory = join(root, 'managed');
  return { root, repo, directory, manager: new GitWorkspaceManager(directory) };
}
async function indexBytes(repo) {
  const path = (await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trim();
  return readFile(path);
}
async function result(manager, base, id, files, dependencies = []) {
  const task = await manager.task(base, { id, dependencies });
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(task.root, path));
    else { await mkdir(join(task.root, path, '..'), { recursive: true }); await writeFile(join(task.root, path), content); }
  }
  return manager.freeze(task, { acceptance: ['expected file contents'], checks: [{ command: 'fixture', status: 'passed' }] });
}
async function injectHelperFault(t, root, source) {
  const preload = join(root, 'helper-fault.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';\nimport fsSync from 'node:fs';\n${source}\n`);
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => originalSpawn(command, args.some(argument => argument.endsWith('/apply-helper.mjs')) ? ['--import', preload, ...args] : args, options));
}

test('prepare snapshots dirty, staged, deleted and untracked files without changing user index or HEAD', async t => {
  const { repo, manager } = await fixture(t);
  await writeFile(join(repo, 'first.txt'), 'staged\n'); await git(repo, 'add', 'first.txt');
  await writeFile(join(repo, 'first.txt'), 'unstaged after staged\n');
  await rm(join(repo, 'second.txt'));
  await writeFile(join(repo, 'new file\n.txt'), Buffer.from([0, 255, 7]));
  await writeFile(join(repo, '.gitignore'), 'node_modules/\nsecret\n');
  await mkdir(join(repo, 'node_modules')); await writeFile(join(repo, 'node_modules', 'ignored'), 'dependency');
  await writeFile(join(repo, 'secret'), 'ignored');
  const index = await indexBytes(repo); const head = await git(repo, 'rev-parse', 'HEAD');
  const base = await manager.prepare({ cwd: repo, runId: 'dirty' });
  const worker = await manager.task(base, { id: 'one' });
  assert.notEqual(worker.cwd, repo);
  assert.equal(await readFile(join(worker.cwd, 'first.txt'), 'utf8'), 'unstaged after staged\n');
  await assert.rejects(lstat(join(worker.cwd, 'second.txt')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(worker.cwd, 'new file\n.txt')), Buffer.from([0, 255, 7]));
  await assert.rejects(lstat(join(worker.cwd, 'node_modules')), { code: 'ENOENT' });
  assert.ok(base.setupRequirements.some(entry => entry.kind === 'ignored-files'));
  assert.deepEqual(await indexBytes(repo), index);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'unstaged after staged\n');
});

test('non-Git input fails before creating manager artifacts and unborn Git input is supported', async t => {
  const { root, repo, manager, directory } = await fixture(t, { unborn: true });
  const plain = join(root, 'plain'); await mkdir(plain);
  await assert.rejects(manager.prepare({ cwd: plain, runId: 'plain' }), { code: 'NOT_GIT' });
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  await assert.rejects(lstat(join(plain, '.git')), { code: 'ENOENT' });
  const base = await manager.prepare({ cwd: repo, runId: 'unborn' });
  const task = await manager.task(base, { id: 'worker' });
  assert.equal(await readFile(join(task.cwd, 'first.txt'), 'utf8'), 'original\n');
  await assert.rejects(git(repo, 'rev-parse', '--verify', 'HEAD'));
});

test('parallel workers preserve subdirectory cwd and cannot see later sibling writes', async t => {
  const { repo, manager } = await fixture(t);
  await mkdir(join(repo, 'src')); await writeFile(join(repo, 'src', 'nested'), 'nested');
  const base = await manager.prepare({ cwd: join(repo, 'src'), runId: 'parallel' });
  const [one, two] = await Promise.all(['one', 'two'].map(id => manager.task(base, { id })));
  await writeFile(join(one.cwd, 'nested'), 'one');
  assert.equal(await readFile(join(two.cwd, 'nested'), 'utf8'), 'nested');
  assert.equal(await readFile(join(repo, 'src', 'nested'), 'utf8'), 'nested');
  assert.notEqual(one.root, two.root);
  assert.equal(one.cwd, join(one.root, 'src'));
});

test('freeze preserves binary diff and contracts; review reads fixed head and baseline independently', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'review' });
  const task = await manager.task(base, { id: 'binary' });
  await writeFile(join(task.cwd, 'first.txt'), 'reviewed\n');
  await writeFile(join(task.cwd, 'image.bin'), Buffer.from([0, 255, 13, 10, 0, 99]));
  const acceptance = ['a fixed binary']; const checks = [{ command: 'actual fixture', status: 'passed' }];
  const frozen = await manager.freeze(task, { acceptance, checks });
  acceptance.push('later mutation'); checks[0].status = 'failed';
  assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(frozen.checks[0]));
  assert.deepEqual(frozen.acceptance, ['a fixed binary']); assert.equal(frozen.checks[0].status, 'passed');
  assert.match(await readFile(frozen.diffPath, 'utf8'), /GIT binary patch/);
  await writeFile(join(task.cwd, 'first.txt'), 'subsequent edit\n');
  const review = await manager.review(base, frozen, { id: 'cross-review' });
  assert.notEqual(review.cwd, task.cwd);
  assert.equal(await readFile(join(review.cwd, 'first.txt'), 'utf8'), 'reviewed\n');
  assert.equal(await readFile(join(review.baseCwd, 'first.txt'), 'utf8'), 'original\n');
  assert.deepEqual(await readFile(join(review.cwd, 'image.bin')), Buffer.from([0, 255, 13, 10, 0, 99]));
  assert.equal((await lstat(join(review.cwd, 'first.txt'))).mode & 0o222, 0);
  assert.equal(review.hash, frozen.hash);
  const reloaded = new GitWorkspaceManager(manager.directory);
  const nextReview = await reloaded.review(JSON.parse(JSON.stringify(base)), JSON.parse(JSON.stringify(frozen)));
  assert.equal(await readFile(join(nextReview.cwd, 'first.txt'), 'utf8'), 'reviewed\n');
});

test('dependent and sibling deltas integrate once without reverting shared dependency changes', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'dependencies' });
  const shared = await result(manager, base, 'shared', { 'first.txt': 'shared\n', 'shared.txt': 'new shared\n' });
  const child = await result(manager, base, 'child', { 'second.txt': 'child\n' }, [shared]);
  const cousin = await result(manager, base, 'cousin', { 'cousin.txt': 'cousin\n' }, [shared]);
  const sibling = await result(manager, base, 'sibling', { 'sibling.txt': 'sibling\n' });
  assert.deepEqual(child.files, ['second.txt']);
  const integrated = await manager.integrate(base, [cousin, sibling, child, shared]);
  assert.equal(integrated.status, 'integrated');
  assert.equal(await readFile(join(integrated.cwd, 'first.txt'), 'utf8'), 'shared\n');
  assert.equal(await readFile(join(integrated.cwd, 'second.txt'), 'utf8'), 'child\n');
  assert.equal(await readFile(join(integrated.cwd, 'shared.txt'), 'utf8'), 'new shared\n');
  assert.equal(await readFile(join(integrated.cwd, 'cousin.txt'), 'utf8'), 'cousin\n');
  assert.equal(await readFile(join(integrated.cwd, 'sibling.txt'), 'utf8'), 'sibling\n');
  assert.deepEqual(integrated.snapshots.map(value => value.id), ['shared', 'child', 'cousin', 'sibling']);
});

test('frozen patches integrate and apply independently of user diff presentation settings', async t => {
  const { repo, manager } = await fixture(t);
  await git(repo, 'config', 'diff.noprefix', 'true');
  await git(repo, 'config', 'color.ui', 'always');
  await git(repo, 'config', 'diff.context', '0');
  const base = await manager.prepare({ cwd: repo, runId: 'diff-config' });
  const changed = await result(manager, base, 'changed', { 'first.txt': 'changed\n' });
  assert.match(await readFile(changed.diffPath, 'utf8'), /diff --git a\/first.txt b\/first.txt/);
  await git(repo, 'config', 'diff.noprefix', 'false');
  await git(repo, 'config', 'color.ui', 'never');
  await git(repo, 'config', 'diff.context', '9');
  const integrated = await manager.integrate(base, [changed]);
  assert.equal(integrated.status, 'integrated');
  await manager.apply(base, integrated);
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'changed\n');
});

test('overlapping deltas return repairable conflicts and resume pending tasks after staged repair', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'conflicts' });
  const left = await result(manager, base, 'a', { 'first.txt': 'left\n' });
  const right = await result(manager, base, 'b', { 'first.txt': 'right\n' });
  const later = await result(manager, base, 'c', { 'second.txt': 'later\n' });
  const integration = await manager.integrate(base, [later, right, left]);
  assert.equal(integration.status, 'conflicted');
  assert.equal(integration.conflicts[0].path, 'first.txt');
  assert.equal(integration.conflicts[0].taskId, 'b');
  assert.match(await readFile(join(integration.cwd, 'first.txt'), 'utf8'), /<<<<<<<|left/);
  await assert.rejects(manager.finalizeIntegration(base, integration), { code: 'UNRESOLVED_CONFLICTS' });
  await writeFile(join(integration.cwd, 'first.txt'), 'resolved\n');
  await git(integration.root, 'add', 'first.txt');
  const repaired = await manager.finalizeIntegration(base, integration, { checks: [{ command: 'repair fixture', status: 'passed' }] });
  assert.equal(repaired.status, 'integrated');
  assert.equal(await readFile(join(repaired.cwd, 'first.txt'), 'utf8'), 'resolved\n');
  assert.equal(await readFile(join(repaired.cwd, 'second.txt'), 'utf8'), 'later\n');
  const review = await manager.review(base, repaired);
  assert.equal(await readFile(join(review.cwd, 'first.txt'), 'utf8'), 'resolved\n');
  assert.equal(review.hash, repaired.hash);
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
});

test('apply preserves the original index and unrelated edits while applying binary additions and deletion', async t => {
  const { repo, manager } = await fixture(t);
  await writeFile(join(repo, 'first.txt'), 'staged\n'); await git(repo, 'add', 'first.txt');
  await writeFile(join(repo, 'first.txt'), 'user baseline\n');
  const originalIndex = await indexBytes(repo); const originalHead = await git(repo, 'rev-parse', 'HEAD');
  const base = await manager.prepare({ cwd: repo, runId: 'apply' });
  const frozen = await result(manager, base, 'change', { 'first.txt': 'integrated\n', 'second.txt': null, 'nested/binary file': Buffer.from([0, 128, 255]) });
  const integration = await manager.integrate(base, [frozen]);
  await writeFile(join(repo, 'unrelated.txt'), 'later user edit');
  const applied = await manager.apply(base, integration);
  assert.equal(applied.status, 'applied');
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'integrated\n');
  await assert.rejects(lstat(join(repo, 'second.txt')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(repo, 'nested/binary file')), Buffer.from([0, 128, 255]));
  assert.equal(await readFile(join(repo, 'unrelated.txt'), 'utf8'), 'later user edit');
  assert.deepEqual(await indexBytes(repo), originalIndex);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), originalHead);
});

test('a changed affected baseline blocks every path before applying', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'stale' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'new\n', 'second.txt': 'new second\n' })]);
  await writeFile(join(repo, 'second.txt'), 'later user edit\n');
  await assert.rejects(manager.apply(base, integration), { code: 'BASELINE_CHANGED' });
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(repo, 'second.txt'), 'utf8'), 'later user edit\n');
  assert.ok((await lstat(integration.diffPath)).isFile());
});

test('apply detects symlink-parent escapes and forged artifact paths', async t => {
  const { root, repo, manager } = await fixture(t);
  await mkdir(join(repo, 'nested')); await writeFile(join(repo, 'nested', 'file'), 'baseline');
  await symlink('first.txt', join(repo, 'link'));
  const base = await manager.prepare({ cwd: repo, runId: 'unsafe' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'nested/file': 'new' })]);
  await rm(join(repo, 'nested'), { recursive: true });
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'file'), 'outside');
  await symlink(outside, join(repo, 'nested'));
  await assert.rejects(manager.apply(base, integration), { code: 'UNSAFE_PATH' });
  assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'outside');
  await assert.rejects(manager.apply({ ...base, manifestPath: join(repo, '..', 'forged.json') }, integration), { code: 'INVALID_ARTIFACT' });
});

test('a parent swapped after validation cannot redirect an apply mutation outside the repository', async t => {
  const { repo, root, manager } = await fixture(t);
  await mkdir(join(repo, 'nested')); await writeFile(join(repo, 'nested', 'file'), 'inside\n');
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'file'), 'outside\n');
  const base = await manager.prepare({ cwd: repo, runId: 'ancestor-race' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'nested/file': 'changed\n' })]);
  let raced = false;
  const swap = () => {
    if (raced) return;
    raced = true;
    fsSync.renameSync(join(repo, 'nested'), join(repo, 'saved-nested'));
    fsSync.symlinkSync(outside, join(repo, 'nested'));
  };
  const originalRename = fs.rename, originalSpawn = childProcess.spawn;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (source === join(repo, 'nested', 'file')) swap();
    return originalRename(source, destination);
  });
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    if (args[1]?.some(argument => argument.endsWith('/apply-helper.mjs'))) {
      const originalWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        if (String(chunk).includes('"action":"continue"')) swap();
        return originalWrite(chunk, ...rest);
      };
    }
    return child;
  });
  await assert.rejects(manager.apply(base, integration));
  assert.equal(raced, true);
  assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'outside\n');
  assert.equal(await readFile(join(repo, 'saved-nested', 'file'), 'utf8'), 'inside\n');
});

test('replacing the repository root after it is pinned cannot produce an applied result', async t => {
  const { repo, root, manager } = await fixture(t);
  const outside = join(root, 'outside-root'); await mkdir(outside); await writeFile(join(outside, 'first.txt'), 'planned\n');
  const base = await manager.prepare({ cwd: repo, runId: 'root-race' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'planned\n' })]);
  const originalSpawn = childProcess.spawn; let swapped = false;
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    if (args[1].some(argument => argument.endsWith('/apply-helper.mjs'))) {
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        if (!swapped && String(chunk).includes('"action":"continue"')) {
          swapped = true; fsSync.renameSync(repo, join(root, 'saved-repo')); fsSync.symlinkSync(outside, repo);
        }
        return write(chunk, ...rest);
      };
    }
    return child;
  });
  await assert.rejects(manager.apply(base, integration), { code: 'BASELINE_CHANGED' });
  assert.equal(await readFile(join(outside, 'first.txt'), 'utf8'), 'planned\n');
  assert.equal(await readFile(join(root, 'saved-repo', 'first.txt'), 'utf8'), 'original\n');
});

test('apply rolls back prior paths on a later filesystem failure and retains a recovery journal', async t => {
  const { repo, root, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'rollback' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'new first\n', 'second.txt': 'new second\n' })]);
  let error;
  await injectHelperFault(t, root, `const originalRename = fs.rename; fs.rename = async (source, destination) => {
    if (source === 'second.txt') throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    return originalRename(source, destination);
  };`);
  await assert.rejects(manager.apply(base, integration), failure => { error = failure; return failure.code === 'APPLY_FAILED'; });
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(repo, 'second.txt'), 'utf8'), 'second\n');
  assert.equal(JSON.parse(await readFile(error.details.journalPath, 'utf8')).status, 'failed');
  assert.ok((await lstat(error.details.recoveryPath)).isDirectory());
});

test('rollback preserves an intervening writer and keeps its captured original recoverable', async t => {
  const { repo, root, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'intervening' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'new first\n', 'second.txt': 'new second\n' })]);
  let error;
  await injectHelperFault(t, root, `const originalRename = fs.rename; fs.rename = async (source, destination) => {
    if (source === 'second.txt') {
      await fs.writeFile('first.txt', 'other writer\\n');
      throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };`);
  await assert.rejects(manager.apply(base, integration), failure => { error = failure; return failure.code === 'APPLY_FAILED'; });
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'other writer\n');
  const recovery = error.details.rollback.find(entry => entry.path === 'first.txt');
  assert.equal(recovery.status, 'retained');
  assert.equal(await readFile(recovery.backup, 'utf8'), 'original\n');
});

test('nested directory rollback preserves symlinks and a save during a short file restoration', async t => {
  const { repo, root, manager } = await fixture(t);
  await mkdir(join(repo, 'dir', 'nested'), { recursive: true });
  await writeFile(join(repo, 'dir', 'nested', 'leaf'), 'nested original\n');
  await chmod(join(repo, 'dir', 'nested', 'leaf'), 0o640);
  await symlink('nested/leaf', join(repo, 'dir', 'link'));
  const base = await manager.prepare({ cwd: repo, runId: 'nested-restore-save' });
  const task = await manager.task(base, { id: 'change' });
  await rm(join(task.root, 'dir'), { recursive: true });
  await writeFile(join(task.root, 'dir'), 'replacement\n');
  await writeFile(join(task.root, 'second.txt'), 'new second\n');
  const integration = await manager.integrate(base, [await manager.freeze(task)]);
  const marker = join(root, 'restore-save.json');
  await injectHelperFault(t, root, `const originalRename = fs.rename, originalOpen = fs.open; const marker = ${JSON.stringify(marker)};
    fs.rename = async (source, destination) => {
      if (source === 'second.txt') throw Object.assign(new Error('later apply failure'), { code: 'EIO' });
      return originalRename(source, destination);
    };
    fs.open = async (name, flags, mode) => {
      const handle = await originalOpen(name, flags, mode);
      if (flags & fsSync.constants.O_CREAT) {
        const write = handle.write.bind(handle);
        handle.write = async (content, offset, length, position) => {
          if (content.toString() !== 'nested original\\n' || fsSync.existsSync(marker)) return write(content, offset, length, position);
          const result = await write(content, offset, Math.min(length, 3), position);
          fsSync.writeFileSync(marker, JSON.stringify({ bytesWritten: result.bytesWritten }));
          await fs.writeFile(${JSON.stringify(join(repo, 'dir', 'nested', 'leaf'))}, 'concurrent restored-file edit\\n', { mode: 0o600 });
          return result;
        };
      }
      return handle;
    };`);
  let failure;
  await assert.rejects(manager.apply(base, integration), error => { failure = error; return error.code === 'APPLY_FAILED'; });
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).bytesWritten, 3);
  assert.equal(await readFile(join(repo, 'dir', 'nested', 'leaf'), 'utf8'), 'concurrent restored-file edit\n');
  assert.equal((await lstat(join(repo, 'dir', 'nested', 'leaf'))).mode & 0o777, 0o600);
  assert.equal(await readlink(join(repo, 'dir', 'link')), 'nested/leaf');
  const recovery = failure.details.rollback.find(entry => entry.path === 'dir');
  assert.equal(recovery.status, 'retained');
  assert.equal(await readFile(join(recovery.backup, 'nested', 'leaf'), 'utf8'), 'nested original\n');
  assert.equal((await lstat(join(recovery.backup, 'nested', 'leaf'))).mode & 0o777, 0o640);
  assert.equal(await readlink(join(recovery.backup, 'link')), 'nested/leaf');
  assert.equal((await readdir(join(repo, 'dir', 'nested'))).some(name => name.startsWith('.codex-workspace-stage-')), false);
});

test('cancellation in a multi-path apply restores originals and preserves artifacts', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'cancel-apply' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'new first\n', 'second.txt': 'new second\n' })]);
  const controller = new AbortController(), originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    if (args[1].some(argument => argument.endsWith('/apply-helper.mjs'))) {
      const write = child.stdin.write.bind(child.stdin); let request;
      child.stdin.write = (chunk, ...rest) => {
        const value = JSON.parse(String(chunk));
        if (value.operation) request = value;
        if (value.action === 'continue' && request?.operation === 'apply' && request.name === 'second.txt') controller.abort();
        return write(chunk, ...rest);
      };
    }
    return child;
  });
  await assert.rejects(manager.apply(base, integration, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(repo, 'second.txt'), 'utf8'), 'second\n');
  assert.ok((await lstat(integration.diffPath)).isFile());
});

test('a concurrent save between confirmed short writes survives application unchanged', async t => {
  const { repo, root, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'short-write-save' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'complete output\n' })]);
  const marker = join(root, 'short-write-save.json');
  await injectHelperFault(t, root, `const originalOpen = fs.open; const marker = ${JSON.stringify(marker)};
    fs.open = async (name, flags, mode) => {
      const handle = await originalOpen(name, flags, mode);
      if ((flags & fsSync.constants.O_CREAT) && !fsSync.existsSync(marker)) {
        const write = handle.write.bind(handle); let first = true;
        handle.write = async (content, offset, length, position) => {
          if (!first) return write(content, offset, length, position);
          first = false;
          const result = await write(content, offset, Math.min(length, 3), position);
          fsSync.writeFileSync(marker, JSON.stringify({ bytesWritten: result.bytesWritten }));
          await fs.writeFile(${JSON.stringify(join(repo, 'first.txt'))}, 'concurrent user edit\\n');
          return result;
        };
      }
      return handle;
    };`);
  let failure;
  await assert.rejects(manager.apply(base, integration), error => { failure = error; return error.code === 'BASELINE_CHANGED'; });
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).bytesWritten, 3);
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'concurrent user edit\n');
  assert.equal(await readFile(failure.details.recoveryPaths[0], 'utf8'), 'original\n');
  assert.equal((await readdir(repo)).some(name => name.startsWith('.codex-workspace-stage-')), false);
});

test('a partial write failure discards private output and restores exact original modes', async t => {
  const { repo, root, manager } = await fixture(t);
  await chmod(join(repo, 'first.txt'), 0o664);
  const base = await manager.prepare({ cwd: repo, runId: 'partial-write' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'complete output\n' })]);
  await injectHelperFault(t, root, `const originalOpen = fs.open; const marker = ${JSON.stringify(join(root, 'failure-injected'))};
    fs.open = async (name, flags, mode) => {
      const handle = await originalOpen(name, flags, mode);
      if ((flags & fsSync.constants.O_CREAT) && !fsSync.existsSync(marker)) {
        const write = handle.write.bind(handle); let partial = false;
        handle.write = async (content, offset, length, position) => {
          if (!partial) { partial = true; fsSync.writeFileSync(marker, 'fault'); return write(content, offset, Math.min(length, 3), position); }
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        };
      }
      return handle;
    };`);
  await assert.rejects(manager.apply(base, integration), { code: 'APPLY_FAILED' });
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
  assert.equal((await lstat(join(repo, 'first.txt'))).mode & 0o777, 0o664);
  assert.equal((await readdir(repo)).some(name => name.startsWith('.codex-workspace-stage-')), false);
});

test('an edit arriving after publication is never claimed as helper-owned output or chmodded', async t => {
  const { repo, root, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'write-ownership' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'helper output\n' })]);
  await injectHelperFault(t, root, `const originalLink = fs.link; const marker = ${JSON.stringify(join(root, 'concurrent-edit-injected'))};
    fs.link = async (source, destination) => {
      const result = await originalLink(source, destination);
      if (destination === 'first.txt' && !fsSync.existsSync(marker)) {
        fsSync.writeFileSync(marker, 'once');
        await fs.writeFile(destination, 'concurrent user edit\\n');
        await fs.chmod(destination, 0o600);
      }
      return result;
    };`);
  let failure;
  await assert.rejects(manager.apply(base, integration), error => { failure = error; return error.code === 'BASELINE_CHANGED'; });
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'concurrent user edit\n');
  assert.equal((await lstat(join(repo, 'first.txt'))).mode & 0o777, 0o600);
  assert.equal(await readFile(failure.details.recoveryPaths[0], 'utf8'), 'original\n');
});

test('an ambiguous partial write is never published and leaves the original recoverable', async t => {
  const { repo, root, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'ambiguous-write' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'complete output\n' })]);
  const marker = join(root, 'ambiguous-write.json');
  await injectHelperFault(t, root, `const originalOpen = fs.open; const marker = ${JSON.stringify(marker)};
    fs.open = async (name, flags, mode) => {
      const handle = await originalOpen(name, flags, mode);
      if ((flags & fsSync.constants.O_CREAT) && !fsSync.existsSync(marker)) {
        const write = handle.write.bind(handle);
        handle.write = async (content, offset, length, position) => {
          await write(content, offset, Math.min(3, length), position);
          fsSync.writeFileSync(marker, JSON.stringify({ visible: fsSync.existsSync(${JSON.stringify(join(repo, 'first.txt'))}) }));
          throw Object.assign(new Error('uncertain write'), { code: 'EIO' });
        };
      }
      return handle;
    };`);
  let failure;
  await assert.rejects(manager.apply(base, integration), error => { failure = error; return error.code === 'APPLY_FAILED'; });
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).visible, false);
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(failure.details.recoveryPaths[0], 'utf8'), 'original\n');
  assert.equal((await readdir(repo)).some(name => name.startsWith('.codex-workspace-stage-')), false);
});

test('backup capture reserves a private namespace before using an overwriting rename', async t => {
  const { repo, root, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'backup-reservation' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'changed\n' })]);
  const marker = join(root, 'backup-race.json');
  await injectHelperFault(t, root, `const originalRename = fs.rename;
    fs.rename = async (source, destination) => {
      if (source === 'first.txt') {
        if (!destination.includes('/')) {
          await fs.writeFile(destination, 'unowned exclusive creation\\n', { flag: 'wx' });
          fsSync.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ unownedPath: process.cwd() + '/' + destination }));
        } else {
          const parent = destination.slice(0, destination.lastIndexOf('/'));
          const info = await fs.lstat(parent);
          fsSync.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ privateDirectory: info.isDirectory(), mode: info.mode & 511 }));
        }
      }
      return originalRename(source, destination);
    };`);
  await manager.apply(base, integration);
  const observation = JSON.parse(await readFile(marker, 'utf8'));
  if (observation.unownedPath) assert.equal(await readFile(observation.unownedPath, 'utf8'), 'unowned exclusive creation\n');
  else { assert.equal(observation.privateDirectory, true); assert.equal(observation.mode, 0o700); }
});

test('rollback never treats an uncaptured backup-name collision as an original file', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'backup-collision' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'new.txt': 'created\n' })]);
  const controller = new AbortController(), originalSpawn = childProcess.spawn; let backup;
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    if (args[1].some(argument => argument.endsWith('/apply-helper.mjs'))) {
      const write = child.stdin.write.bind(child.stdin); let request;
      child.stdin.write = (chunk, ...rest) => {
        const value = JSON.parse(String(chunk));
        if (value.operation) request = value;
        if (value.action === 'continue' && request?.operation === 'apply') {
          backup = join(repo, request.backupName); fsSync.writeFileSync(backup, 'unowned\n'); controller.abort();
        }
        return write(chunk, ...rest);
      };
    }
    return child;
  });
  await assert.rejects(manager.apply(base, integration, { signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(lstat(join(repo, 'new.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(backup, 'utf8'), 'unowned\n');
});

test('snapshot bookkeeping never runs checkout hooks or configured clean filters', async t => {
  const { repo, manager } = await fixture(t);
  await writeFile(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nprintf invoked > hook-ran\n', { mode: 0o755 });
  await git(repo, 'config', 'filter.danger.clean', 'touch filter-ran');
  await writeFile(join(repo, '.gitattributes'), '*.txt filter=danger\n');
  const base = await manager.prepare({ cwd: repo, runId: 'no-hooks' });
  const task = await manager.task(base, { id: 'worker' });
  await manager.freeze(task);
  await assert.rejects(lstat(join(repo, 'hook-ran')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(task.root, 'hook-ran')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(repo, 'filter-ran')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(task.root, 'filter-ran')), { code: 'ENOENT' });
});

test('unsafe snapshot symlinks and changed symlink targets are rejected', async t => {
  const { repo, root, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'links' });
  const task = await manager.task(base, { id: 'unsafe-link' });
  await symlink(root, join(task.root, 'external'));
  await assert.rejects(manager.freeze(task), { code: 'UNSAFE_PATH' });
  await rm(join(task.root, 'external'));
  await symlink('first.txt', join(task.root, 'valid'));
  const integration = await manager.integrate(base, [await manager.freeze(task)]);
  await symlink('second.txt', join(repo, 'valid'));
  await assert.rejects(manager.apply(base, integration), { code: 'BASELINE_CHANGED' });
  assert.equal(await readlink(join(repo, 'valid')), 'second.txt');
});

test('a tampered worktree Git pointer cannot redirect bookkeeping into the original index', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'git-pointer' });
  const task = await manager.task(base, { id: 'worker' });
  await writeFile(join(task.root, '.git'), `gitdir: ${join(repo, '.git')}\n`);
  await assert.rejects(manager.freeze(task), { code: 'INVALID_ARTIFACT' });
});

test('changed file permissions block application and unchanged permissions are preserved', async t => {
  const { repo, manager } = await fixture(t);
  await chmod(join(repo, 'first.txt'), 0o640);
  const base = await manager.prepare({ cwd: repo, runId: 'permissions' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'changed\n' })]);
  await chmod(join(repo, 'first.txt'), 0o600);
  await assert.rejects(manager.apply(base, integration), { code: 'BASELINE_CHANGED' });
  await chmod(join(repo, 'first.txt'), 0o640);
  await manager.apply(base, integration);
  assert.equal((await lstat(join(repo, 'first.txt'))).mode & 0o777, 0o640);
});

test('application preserves exact modes despite a restrictive umask', async t => {
  const { repo, manager } = await fixture(t);
  await chmod(join(repo, 'first.txt'), 0o664);
  const base = await manager.prepare({ cwd: repo, runId: 'umask' });
  const integration = await manager.integrate(base, [await result(manager, base, 'change', { 'first.txt': 'new contents\n' })]);
  const previous = process.umask(0o022);
  try {
    await manager.apply(base, integration);
    assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'new contents\n');
    assert.equal((await lstat(join(repo, 'first.txt'))).mode & 0o777, 0o664);
  } finally { process.umask(previous); }
});

test('resuming integration rejects a pending patch changed after its original review', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'pending-hash' });
  const left = await result(manager, base, 'a', { 'first.txt': 'left\n' });
  const right = await result(manager, base, 'b', { 'first.txt': 'right\n' });
  const pending = await result(manager, base, 'c', { 'second.txt': 'reviewed\n' });
  const replacement = await result(manager, base, 'replacement', { 'second.txt': 'unreviewed\n' });
  const integration = await manager.integrate(base, [left, right, pending]);
  await writeFile(join(integration.root, 'first.txt'), 'resolved\n'); await git(integration.root, 'add', 'first.txt');
  await chmod(pending.diffPath, 0o644); await writeFile(pending.diffPath, await readFile(replacement.diffPath));
  await assert.rejects(manager.finalizeIntegration(base, integration), { code: 'INVALID_ARTIFACT' });
  assert.equal(await readFile(join(integration.root, 'second.txt'), 'utf8'), 'second\n');
});

test('explicit dependency IDs must exactly identify the supplied direct frozen dependencies', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'declared-dependencies' });
  const predecessor = await result(manager, base, 'a', { 'first.txt': 'dependency\n' });
  for (const args of [
    { dependsOn: ['a'] },
    { dependsOn: [], dependencies: [predecessor] },
    { dependsOn: ['wrong'], dependencies: [predecessor] },
    { dependsOn: ['a', 'a'], dependencies: [predecessor] },
  ]) await assert.rejects(manager.task(base, { id: 'b', ...args }), { code: 'DEPENDENCY_CONFLICT' });
  const task = await manager.task(base, { id: 'b', dependsOn: ['a'], dependencies: [predecessor] });
  assert.equal(await readFile(join(task.root, 'first.txt'), 'utf8'), 'dependency\n');
});

test('file-directory transitions apply transactionally without deleting unrelated directory entries', async t => {
  const { repo, manager } = await fixture(t);
  await mkdir(join(repo, 'folder')); await writeFile(join(repo, 'folder', 'child'), 'old child');
  const base = await manager.prepare({ cwd: repo, runId: 'types' });
  const task = await manager.task(base, { id: 'types' });
  await rm(join(task.root, 'folder'), { recursive: true }); await writeFile(join(task.root, 'folder'), 'now a file');
  await rm(join(task.root, 'first.txt')); await mkdir(join(task.root, 'first.txt')); await writeFile(join(task.root, 'first.txt', '__proto__'), 'now a directory');
  const integration = await manager.integrate(base, [await manager.freeze(task)]);
  await writeFile(join(repo, 'folder', 'later-user-file'), 'keep');
  await assert.rejects(manager.apply(base, integration), { code: 'BASELINE_CHANGED' });
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
  await rm(join(repo, 'folder', 'later-user-file'));
  await manager.apply(base, integration);
  assert.equal(await readFile(join(repo, 'folder'), 'utf8'), 'now a file');
  assert.equal(await readFile(join(repo, 'first.txt', '__proto__'), 'utf8'), 'now a directory');
});

test('staged ignored additions are included, while unowned manager files are retained', async t => {
  const { repo, directory, manager } = await fixture(t);
  await writeFile(join(repo, 'new-secret'), 'staged addition'); await git(repo, 'add', 'new-secret');
  await writeFile(join(repo, '.gitignore'), 'new-secret\n');
  await mkdir(directory); await writeFile(join(directory, 'user-owned'), 'retain');
  const originalIndex = await indexBytes(repo);
  const base = await manager.prepare({ cwd: repo, runId: '../untrusted/id' });
  const task = await manager.task(base, { id: '../../worker' });
  assert.equal(await readFile(join(task.root, 'new-secret'), 'utf8'), 'staged addition');
  assert.equal(await readFile(join(directory, 'user-owned'), 'utf8'), 'retain');
  assert.deepEqual(await indexBytes(repo), originalIndex);
});

test('Git paths that cannot be represented losslessly are rejected rather than omitted', async t => {
  const { repo, manager } = await fixture(t);
  const oid = (await git(repo, 'rev-parse', 'HEAD:first.txt')).trim();
  await workspaceGit(repo, ['update-index', '-z', '--index-info'], { input: Buffer.concat([Buffer.from(`100644 ${oid}\t`), Buffer.from([0xff, 0])]) });
  await assert.rejects(manager.prepare({ cwd: repo, runId: 'raw-path' }), { code: 'UNSAFE_PATH' });
});

test('path validation rejects traversal and Git metadata aliases', () => {
  for (const path of ['../escape', 'nested/../../escape', '/absolute', 'a\\b', 'C:/drive', '.git/config', '.GIT./config', 'a//b']) assert.throws(() => safePath(path), { code: 'UNSAFE_PATH' });
  assert.equal(safePath('binary file\nwith spaces'), 'binary file\nwith spaces');
});

test('the shared Git index cannot be reached through a replaced owned index', async t => {
  const { repo, manager } = await fixture(t);
  const base = await manager.prepare({ cwd: repo, runId: 'index-pointer' });
  const task = await manager.task(base, { id: 'worker' });
  const ownIndex = join(task.gitDir, 'index');
  await rm(ownIndex); await symlink(join(repo, '.git', 'index'), ownIndex);
  await assert.rejects(manager.freeze(task), { code: 'INVALID_ARTIFACT' });
});

test('submodules fail with a setup requirement and do not initialize or flatten nested repositories', async t => {
  const { repo, manager } = await fixture(t);
  const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
  await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},submodule`);
  const originalIndex = await indexBytes(repo);
  await assert.rejects(manager.prepare({ cwd: repo, runId: 'submodule' }), { code: 'SETUP_REQUIRED' });
  assert.deepEqual(await indexBytes(repo), originalIndex);
  await assert.rejects(lstat(join(repo, 'submodule')), { code: 'ENOENT' });
});

test('cancellation before preparation leaves no artifacts; cancellation later preserves owned workspaces', async t => {
  const { repo, directory, manager } = await fixture(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(manager.prepare({ cwd: repo, runId: 'cancelled', signal: abort.signal }), { code: 'CANCELLED' });
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  const base = await manager.prepare({ cwd: repo, runId: 'retained' });
  const task = await manager.task(base, { id: 'worker' });
  await writeFile(join(task.root, 'first.txt'), 'work in progress');
  await assert.rejects(manager.freeze(task, { signal: abort.signal }), { code: 'CANCELLED' });
  assert.equal(await readFile(join(task.root, 'first.txt'), 'utf8'), 'work in progress');
  assert.equal(await readFile(join(repo, 'first.txt'), 'utf8'), 'original\n');
});
