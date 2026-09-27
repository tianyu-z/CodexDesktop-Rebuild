import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, mkdir, writeFile, symlink, chmod, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export class WorkspaceError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'WorkspaceError'; this.code = code; this.details = details; }
}
export function cancelled(signal) {
  if (signal?.aborted) throw new WorkspaceError('CANCELLED', 'Workspace operation was cancelled; its artifacts were retained.');
}
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const immutable = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
};
export function inside(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}
export function safePath(path) {
  if (typeof path !== 'string' || !path || Buffer.from(path).toString('utf8') !== path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /^\.git[ .]*$/i.test(part))) {
    throw new WorkspaceError('UNSAFE_PATH', 'Unsafe repository-relative path.', { path });
  }
  return path;
}
export function decodePaths(buffer) {
  const value = buffer.toString('utf8');
  if (!Buffer.from(value).equals(buffer)) throw new WorkspaceError('UNSAFE_PATH', 'Git paths must have a lossless UTF-8 representation.');
  return value;
}
export async function statMaybe(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}
export async function safeParents(root, path) {
  safePath(path);
  let at = root;
  for (const part of path.split('/').slice(0, -1)) {
    at = join(at, part); const stat = await statMaybe(at);
    if (stat?.isSymbolicLink()) throw new WorkspaceError('UNSAFE_PATH', 'A repository path has a symlink parent.', { path, parent: at });
    if (stat && !stat.isDirectory()) return false;
  }
  return true;
}

/** No shell, inherited Git overrides, optional index refresh, hooks, or external diff. */
export async function git(cwd, args, { input, index, signal, allowFailure = false } = {}) {
  cancelled(signal);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Codex workspace', GIT_AUTHOR_EMAIL: 'workspace@localhost', GIT_COMMITTER_NAME: 'Codex workspace', GIT_COMMITTER_EMAIL: 'workspace@localhost', LC_ALL: 'C' });
  if (index) env.GIT_INDEX_FILE = index;
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-c', 'diff.external=', '-C', cwd, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const stdout = [], stderr = []; let size = 0, failure;
    child.on('error', error => { failure = error; });
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) { failure = new WorkspaceError('OUTPUT_LIMIT', 'Git output exceeded the workspace operation limit.'); child.kill(); }
      else chunks.push(chunk);
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error; });
    child.on('close', code => {
      if (signal?.aborted) return reject(new WorkspaceError('CANCELLED', 'Workspace operation was cancelled; its artifacts were retained.'));
      if (failure) return reject(failure);
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code !== 0 && !allowFailure) return reject(new WorkspaceError('GIT_FAILED', `Git ${args[0]} failed: ${result.stderr.trim()}`, { command: args[0], exitCode: code }));
      resolvePromise(result);
    });
    child.stdin.end(input);
  });
}
export async function gitText(cwd, args, options) { return (await git(cwd, args, options)).stdout.toString('utf8').trim(); }
export function parseIndex(buffer) {
  return decodePaths(buffer).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'); const [mode, oid, stage] = line.slice(0, tab).split(' ');
    return { path: safePath(line.slice(tab + 1)), mode, oid, stage: Number(stage) };
  });
}
export async function treeEntries(repo, head, signal) {
  return decodePaths((await git(repo, ['ls-tree', '-r', '-z', head], { signal })).stdout).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'); const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { path: safePath(line.slice(tab + 1)), mode, oid, type, stage: 0 };
  });
}
export async function blob(repo, oid, signal) { return (await git(repo, ['cat-file', 'blob', oid], { signal })).stdout; }

export function validateLinks(entries) {
  const links = new Map(entries.filter(entry => entry.mode === '120000').map(entry => [entry.path, entry.target]));
  for (const entry of entries.filter(entry => entry.mode === '120000')) {
    let parts = [...posix.dirname(entry.path).split('/').filter(part => part !== '.'), ...entry.target.split('/')];
    let at = [], hops = 0;
    while (parts.length) {
      const part = parts.shift();
      if (!part || part === '.') continue;
      if (part === '..') { if (!at.length) throw new WorkspaceError('UNSAFE_PATH', 'Symlink escapes its isolated workspace.', { path: entry.path }); at.pop(); continue; }
      safePath(part); at.push(part);
      const target = links.get(at.join('/'));
      if (target !== undefined) {
        if (++hops > 40) throw new WorkspaceError('UNSAFE_PATH', 'Symlink cycle is not supported.', { path: entry.path });
        if (isAbsolute(target) || target.includes('\\') || /^[A-Za-z]:/.test(target)) throw new WorkspaceError('UNSAFE_PATH', 'Absolute symlinks cannot be isolated.', { path: entry.path });
        at.pop(); parts = [...target.split('/'), ...parts];
      }
    }
    if (isAbsolute(entry.target) || entry.target.includes('\\') || /^[A-Za-z]:/.test(entry.target)) throw new WorkspaceError('UNSAFE_PATH', 'Absolute symlinks cannot be isolated.', { path: entry.path });
  }
}
export async function commitTree(repo, tree, parent, signal) {
  const head = await gitText(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: 'Codex isolated workspace snapshot\n', signal });
  await git(repo, ['update-ref', `refs/codex-agent-modes/${randomUUID()}`, head], { signal });
  return head;
}

/** Read the real index only for path membership; snapshot raw worktree bytes via a private index. */
export async function snapshot(repo, root, artifactRoot, parent, signal) {
  cancelled(signal);
  const cached = parseIndex((await git(root, ['ls-files', '--stage', '-z'], { signal })).stdout);
  if (cached.some(entry => entry.mode === '160000')) throw new WorkspaceError('SETUP_REQUIRED', 'Submodules require an explicit isolated setup workflow.', { paths: cached.filter(entry => entry.mode === '160000').map(entry => entry.path) });
  const untracked = decodePaths((await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { signal })).stdout).split('\0').filter(Boolean);
  const paths = [...new Set([...cached.map(entry => entry.path), ...untracked])].sort();
  const entries = [];
  for (const path of paths) {
    cancelled(signal); safePath(path);
    if (!await safeParents(root, path)) continue;
    const location = join(root, path), stat = await statMaybe(location);
    if (!stat || stat.isDirectory()) continue;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new WorkspaceError('SETUP_REQUIRED', 'Special files cannot be placed in a Git workspace.', { path });
    const content = stat.isSymbolicLink() ? await readlink(location, { encoding: 'buffer' }) : await readFile(location);
    if (stat.isSymbolicLink()) decodePaths(content);
    const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o100 ? '100755' : '100644');
    const oid = await gitText(repo, ['hash-object', '-w', '--stdin'], { input: content, signal });
    entries.push({ path, mode, oid, permissions: stat.mode & 0o777, ...(stat.isSymbolicLink() ? { target: content.toString('utf8') } : {}) });
  }
  validateLinks(entries);
  const index = join(artifactRoot, `index-${randomUUID()}`);
  await git(repo, ['read-tree', '--empty'], { index, signal });
  if (entries.length) await git(repo, ['update-index', '-z', '--index-info'], { index, input: Buffer.from(entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join('')), signal });
  const tree = await gitText(repo, ['write-tree'], { index, signal });
  return { head: await commitTree(repo, tree, parent, signal), entries };
}
export async function materialize(repo, root, entries, signal) {
  const contents = [];
  for (const entry of entries) {
    safePath(entry.path);
    if (entry.mode === '160000') throw new WorkspaceError('SETUP_REQUIRED', 'Submodules require an explicit isolated setup workflow.');
    const content = entry.content ?? await blob(repo, entry.oid, signal);
    contents.push({ ...entry, content, ...(entry.mode === '120000' ? { target: content.toString('utf8') } : {}) });
  }
  validateLinks(contents);
  for (const entry of contents) {
    cancelled(signal); await safeParents(root, entry.path);
    const location = join(root, entry.path); await mkdir(dirname(location), { recursive: true });
    if (entry.mode === '120000') await symlink(entry.target, location);
    else { await writeFile(location, entry.content, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 }); }
  }
}
export async function readonly(root) {
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(root)) {
    const path = join(root, name), stat = await lstat(path);
    if (stat.isDirectory()) await readonly(path);
    else if (!stat.isSymbolicLink()) await chmod(path, stat.mode & 0o111 ? 0o555 : 0o444);
  }
  await chmod(root, 0o555);
}

const queues = new Map();
export async function locked(key, operation) {
  const predecessor = queues.get(key) ?? Promise.resolve();
  let release; const finished = new Promise(resolvePromise => { release = resolvePromise; });
  const tail = predecessor.then(() => finished); queues.set(key, tail);
  await predecessor;
  try { return await operation(); } finally { release(); if (queues.get(key) === tail) queues.delete(key); }
}

/** Reject symlink ancestors before trusting an artifact location supplied by stored metadata. */
export async function ownedPath(directory, location) {
  const root = await realpath(directory), path = resolve(location);
  if (!inside(root, path) || path === root) throw new WorkspaceError('INVALID_ARTIFACT', 'Artifact is outside this workspace manager.');
  const pieces = relative(root, path).split(sep); let at = root;
  for (const piece of pieces) {
    at = join(at, piece); const stat = await statMaybe(at);
    if (stat?.isSymbolicLink()) throw new WorkspaceError('INVALID_ARTIFACT', 'Artifact contains a symlink path.');
  }
  return path;
}

async function diskTree(path) {
  const stat = await statMaybe(path);
  if (!stat) return null;
  const common = { mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}` };
  if (stat.isSymbolicLink()) return { ...common, kind: 'symlink', target: await fs.readlink(path) };
  if (stat.isFile()) return { ...common, kind: 'file', content: await fs.readFile(path) };
  if (stat.isDirectory()) {
    const children = Object.create(null);
    for (const name of (await fs.readdir(path)).sort()) children[name] = await diskTree(join(path, name));
    return { ...common, kind: 'directory', children };
  }
  return { ...common, kind: 'special' };
}
function fingerprint(node) {
  if (!node) return null;
  if (node.kind === 'file') return { kind: node.kind, mode: node.mode, hash: sha256(node.content) };
  if (node.kind === 'symlink') return { kind: node.kind, target: node.target };
  if (node.kind === 'directory') return { kind: node.kind, children: Object.fromEntries(Object.keys(node.children).sort().map(name => [name, fingerprint(node.children[name])])) };
  return { kind: node.kind };
}
const sameTree = (left, right) => JSON.stringify(fingerprint(left)) === JSON.stringify(fingerprint(right));
function baselineModes(node, path, modes) {
  if (node?.kind === 'file' && modes[path] !== undefined) node.mode = modes[path];
  else if (node?.kind === 'directory') for (const [name, child] of Object.entries(node.children)) baselineModes(child, `${path}/${name}`, modes);
  return node;
}
async function treeAt(repo, entries, path, signal) {
  const exact = entries.find(entry => entry.path === path);
  if (exact) {
    const content = await blob(repo, exact.oid, signal);
    if (exact.mode === '120000') return { kind: 'symlink', target: content.toString('utf8'), mode: 0o777 };
    if (!exact.mode.startsWith('100')) throw new WorkspaceError('SETUP_REQUIRED', 'Applying submodule changes requires explicit project setup.', { path });
    return { kind: 'file', content, mode: exact.mode === '100755' ? 0o755 : 0o644 };
  }
  const descendants = entries.filter(entry => entry.path.startsWith(`${path}/`));
  if (!descendants.length) return null;
  const children = Object.create(null);
  for (const name of [...new Set(descendants.map(entry => entry.path.slice(path.length + 1).split('/')[0]))].sort()) children[name] = await treeAt(repo, descendants, `${path}/${name}`, signal);
  return { kind: 'directory', mode: 0o755, children };
}
async function validateApplyLinks(root, entries, roots, signal) {
  const targets = new Map();
  for (const entry of entries.filter(entry => entry.mode === '120000')) targets.set(entry.path, (await blob(root, entry.oid, signal)).toString('utf8'));
  for (const [path, target] of targets) {
    if (!roots.some(changed => path === changed || path.startsWith(`${changed}/`))) continue;
    let parts = [...posix.dirname(path).split('/').filter(part => part !== '.'), ...target.split('/')], at = [], hops = 0;
    if (isAbsolute(target) || target.includes('\\') || /^[A-Za-z]:/.test(target)) throw new WorkspaceError('UNSAFE_PATH', 'An applied symlink would escape the repository.', { path });
    while (parts.length) {
      const part = parts.shift();
      if (!part || part === '.') continue;
      if (part === '..') { if (!at.length) throw new WorkspaceError('UNSAFE_PATH', 'An applied symlink would escape the repository.', { path }); at.pop(); continue; }
      safePath(part); at.push(part);
      const current = at.join('/'); let next;
      if (roots.some(changed => current === changed || current.startsWith(`${changed}/`))) next = targets.get(current);
      else {
        const stat = await statMaybe(join(root, current));
        if (stat?.isSymbolicLink()) next = await fs.readlink(join(root, current));
      }
      if (next !== undefined) {
        if (++hops > 40 || isAbsolute(next) || next.includes('\\') || /^[A-Za-z]:/.test(next)) throw new WorkspaceError('UNSAFE_PATH', 'An applied symlink has an unsafe target chain.', { path });
        at.pop(); parts = [...next.split('/'), ...parts];
      }
    }
  }
}

function encodeTree(node) {
  if (!node) return null;
  if (node.kind === 'file') return { kind: node.kind, mode: node.mode, content: node.content.toString('base64') };
  if (node.kind === 'directory') return { kind: node.kind, mode: node.mode, children: Object.fromEntries(Object.entries(node.children).map(([name, child]) => [name, encodeTree(child)])) };
  return { kind: node.kind, mode: node.mode, target: node.target };
}

// Helpers are never killed mid-mutation on cancellation: receive their ownership record,
// then roll back with the same pinned-directory protocol. Each helper holds its own cwd.
async function applyHelper(cwd, request, signal) {
  return new Promise((resolvePromise, reject) => {
    const child = childProcess.spawn(process.execPath, [fileURLToPath(new URL('./apply-helper.mjs', import.meta.url))], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '', result, stderr = '', failure;
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error; });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString(); });
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') child.stdin.write(`${JSON.stringify({ action: signal?.aborted ? 'cancel' : 'continue' })}\n`);
          else if (message.type === 'result') { result = message; child.stdin.end(); }
        } catch (error) { failure = error; child.stdin.end(); }
      }
    });
    child.on('close', code => {
      if (result?.ok) return resolvePromise(result.record);
      const reported = result?.error;
      const known = new Set(['UNSAFE_PATH', 'BASELINE_CHANGED', 'CANCELLED']);
      const error = new WorkspaceError(known.has(reported?.code) ? reported.code : 'APPLY_FAILED', reported?.message ?? failure?.message ?? `Apply helper failed (${code}): ${stderr.trim()}`, { record: result?.record });
      reject(error);
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

/** All source mutations run in a child with an inode-checked, kernel-pinned cwd. */
export async function applyTreeDelta(base, integration, artifactRoot, signal) {
  cancelled(signal);
  if (!base.rootIdentity || await fs.realpath(base.repoRoot) !== base.repoRoot) throw new WorkspaceError('UNSAFE_PATH', 'The original repository directory changed; prepare a new baseline.');
  const rootStat = await fs.lstat(base.repoRoot, { bigint: true });
  if (`${rootStat.dev}:${rootStat.ino}` !== base.rootIdentity) throw new WorkspaceError('BASELINE_CHANGED', 'The original repository directory was replaced.');
  const before = await treeEntries(base.repoRoot, base.baseHead, signal), after = await treeEntries(base.repoRoot, integration.head, signal);
  const paths = [...integration.files].map(safePath).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const roots = paths.filter(path => !paths.some(parent => parent !== path && path.startsWith(`${parent}/`)));
  const plans = [];
  for (const path of roots) {
    if (!await safeParents(base.repoRoot, path)) throw new WorkspaceError('BASELINE_CHANGED', 'An affected destination parent no longer matches the baseline.', { path });
    const expected = baselineModes(await treeAt(base.repoRoot, before, path, signal), path, base.fileModes ?? {}), desired = await treeAt(base.repoRoot, after, path, signal);
    const current = await diskTree(join(base.repoRoot, path));
    if (!sameTree(current, expected)) throw new WorkspaceError('BASELINE_CHANGED', 'An affected path changed after the workflow began.', { path });
    if (current?.kind === 'file' && desired?.kind === 'file') desired.mode = (current.mode & ~0o111) | ((current.mode & 0o100) === (desired.mode & 0o100) ? current.mode & 0o111 : desired.mode & 0o111);
    const parts = path.split('/'), name = parts.pop();
    plans.push({ path, name, parents: parts, expected, desired, backupName: `.codex-workspace-backup-${randomUUID()}` });
  }
  await validateApplyLinks(base.repoRoot, after, roots, signal);
  const journalPath = join(artifactRoot, 'apply-journal.json'), attempted = [];
  const journal = { schemaVersion: 2, status: 'applying', repoRoot: base.repoRoot, baseHead: base.baseHead, head: integration.head, paths: roots, operations: [], rollback: [] };
  const save = () => fs.writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const requestFor = (plan, operation) => ({ operation, rootIdentity: plan.record.directoryIdentity, parents: [], name: plan.name, backupName: plan.backupName, backupDirectory: plan.record.backupDirectory, backupDirectoryIdentity: plan.record.backupDirectoryIdentity, expected: fingerprint(plan.expected), captured: plan.record.captured, owned: plan.record.owned });
  const backupPath = plan => plan.record?.backupDirectory
    ? join(plan.record.directoryPath, plan.record.backupDirectory, 'original')
    : join(plan.record?.directoryPath ?? join(base.repoRoot, ...plan.parents), plan.backupName);
  await save();
  try {
    for (const plan of plans) {
      cancelled(signal); attempted.push(plan);
      const entry = { path: plan.path, backup: backupPath(plan), record: null }; journal.operations.push(entry); await save();
      try {
        plan.record = await applyHelper(base.repoRoot, { operation: 'apply', rootIdentity: base.rootIdentity, parents: plan.parents, name: plan.name, backupName: plan.backupName, expected: fingerprint(plan.expected), desired: encodeTree(plan.desired), desiredFingerprint: fingerprint(plan.desired) }, signal);
      } catch (error) {
        plan.record = error.details?.record; entry.record = plan.record ?? null; entry.backup = backupPath(plan);
        throw error;
      }
      entry.record = plan.record; entry.backup = backupPath(plan); await save();
    }
    cancelled(signal);
    const currentRoot = await fs.lstat(base.repoRoot, { bigint: true });
    if (!currentRoot.isDirectory() || `${currentRoot.dev}:${currentRoot.ino}` !== base.rootIdentity) throw new WorkspaceError('BASELINE_CHANGED', 'The repository root moved during application; recovery artifacts were retained.');
    for (const plan of plans) {
      if (!await safeParents(base.repoRoot, plan.path) || !sameTree(await diskTree(join(base.repoRoot, plan.path)), plan.desired)) throw new WorkspaceError('BASELINE_CHANGED', 'Another writer changed an applied path; recovery artifacts were retained.', { path: plan.path });
      await applyHelper(plan.record.directoryPath, requestFor(plan, 'verify'), signal);
    }
    cancelled(signal);
    journal.status = 'applied'; await save();
  } catch (error) {
    for (const plan of [...attempted].reverse()) {
      try {
        if (!plan.record?.directoryIdentity) continue;
        const restored = await applyHelper(plan.record.directoryPath, requestFor(plan, 'rollback'));
        journal.rollback.push({ path: plan.path, status: restored.restored ? 'restored' : restored.retained?.length ? 'retained' : 'unchanged', backup: backupPath(plan) });
      } catch (rollbackError) { journal.rollback.push({ path: plan.path, status: 'retained', backup: backupPath(plan), reason: rollbackError.code ?? rollbackError.message }); }
    }
    for (const plan of [...attempted].reverse()) for (const parent of [...(plan.record?.createdParents ?? [])].reverse()) {
      try { await applyHelper(parent.parentPath, { operation: 'prune', rootIdentity: parent.parentIdentity, parents: [], name: parent.name, backupName: plan.backupName, identity: parent.identity }); }
      catch { /* An intervening writer owns the remaining directory state. */ }
    }
    journal.status = 'failed'; journal.error = error.message;
    try { await save(); } catch { /* Same-parent originals still remain recoverable. */ }
    const failure = error instanceof WorkspaceError ? error : new WorkspaceError('APPLY_FAILED', `Unable to apply integrated changes: ${error.message}`);
    failure.details = { ...failure.details, artifactRoot, journalPath, recoveryPath: artifactRoot, recoveryPaths: attempted.filter(plan => plan.record?.captured).map(backupPath), rollback: journal.rollback };
    throw failure;
  }
  // Cleanup cannot roll back a committed transaction after another backup was removed.
  // Any changed backup remains available with its exact recovery location.
  const recoveryPaths = [];
  for (const plan of plans.filter(value => value.record.captured)) {
    try { const cleaned = await applyHelper(plan.record.directoryPath, requestFor(plan, 'cleanup')); if (!cleaned.cleaned) recoveryPaths.push(backupPath(plan)); }
    catch { recoveryPaths.push(backupPath(plan)); }
  }
  journal.recoveryPaths = recoveryPaths; await save();
  return { status: 'applied', cwd: base.originalCwd, files: integration.files, baseHead: base.baseHead, head: integration.head, diffPath: integration.diffPath, hash: integration.hash, artifactRoot, journalPath, recoveryPaths };
}
