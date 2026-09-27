import { mkdtemp, mkdir, realpath, readFile, writeFile, unlink, rmdir, lstat } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WorkspaceError, cancelled, immutable, inside, git, gitText, snapshot, materialize, treeEntries, locked, ownedPath, sha256, readonly, parseIndex, blob, statMaybe, safeParents, applyTreeDelta } from './git.mjs';
export { WorkspaceError } from './git.mjs';

// Artifact bytes are also consumed by git apply; user presentation settings must
// not remove path prefixes, inject color, or change a later integrity check.
const patchOptions = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames',
  '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--unified=3',
  '--inter-hunk-context=0', '--diff-algorithm=myers', '--no-indent-heuristic'];

/** Owned artifacts are retained, including after failed and cancelled operations. */
export class GitWorkspaceManager {
  constructor(directory) { this.directory = resolve(directory); }

  async save(record) {
    const value = { schemaVersion: 1, ...record, manifestPath: join(record.artifactRoot, 'manifest.json') };
    await writeFile(value.manifestPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
    return immutable(value);
  }
  async load(record, kinds) {
    if (!record?.manifestPath) throw new WorkspaceError('INVALID_ARTIFACT', 'Workspace metadata is missing its manifest.');
    const path = await ownedPath(this.directory, record.manifestPath);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.schemaVersion !== 1 || !kinds.includes(saved.kind) || !isDeepStrictEqual(saved, record)) throw new WorkspaceError('INVALID_ARTIFACT', 'Workspace metadata does not match its immutable manifest.');
    await ownedPath(this.directory, saved.artifactRoot);
    if (saved.kind !== 'base') await ownedPath(this.directory, saved.root);
    if (saved.gitDir) {
      const base = await this.baseFor(saved);
      if (!inside(join(base.commonDir, 'worktrees'), saved.gitDir) || await realpath(saved.gitDir) !== saved.gitDir) throw new WorkspaceError('INVALID_ARTIFACT', 'Owned worktree metadata is outside the expected repository.');
      for (const filename of ['index', 'HEAD', 'commondir', 'gitdir']) {
        const stat = await statMaybe(join(saved.gitDir, filename));
        if (!stat?.isFile()) throw new WorkspaceError('INVALID_ARTIFACT', 'Owned worktree metadata contains a replaced file.', { filename });
      }
      const pointer = await readFile(join(saved.root, '.git'), 'utf8');
      if (pointer !== `gitdir: ${saved.gitDir}\n`) throw new WorkspaceError('INVALID_ARTIFACT', 'Owned worktree Git metadata was changed.');
      const common = (await readFile(join(saved.gitDir, 'commondir'), 'utf8')).trim();
      if (await realpath(resolve(saved.gitDir, common)) !== base.commonDir || (await readFile(join(saved.gitDir, 'gitdir'), 'utf8')).trim() !== join(saved.root, '.git')) throw new WorkspaceError('INVALID_ARTIFACT', 'Owned worktree repository association was changed.');
    }
    return saved;
  }
  async baseFor(record) {
    const path = await ownedPath(this.directory, record.baseManifest);
    return this.load(JSON.parse(await readFile(path, 'utf8')), ['base']);
  }
  async prepare({ cwd, runId = randomUUID(), signal } = {}) {
    cancelled(signal);
    let repoRoot;
    try { repoRoot = await realpath(await gitText(cwd, ['rev-parse', '--show-toplevel'], { signal })); }
    catch (error) { if (error.code === 'CANCELLED') throw error; throw new WorkspaceError('NOT_GIT', 'Write workflows require an existing Git repository.'); }
    const originalCwd = await realpath(cwd);
    const rootStat = await lstat(repoRoot, { bigint: true });
    const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
    if (inside(repoRoot, this.directory)) throw new WorkspaceError('UNSAFE_PATH', 'Workspace artifacts must be stored outside the source repository.');
    const sparse = await git(repoRoot, ['config', '--bool', 'core.sparseCheckout'], { signal, allowFailure: true });
    if (sparse.stdout.toString().trim() === 'true') throw new WorkspaceError('SETUP_REQUIRED', 'Sparse checkouts require an explicit isolated setup workflow.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directory = await realpath(this.directory);
    if (inside(repoRoot, this.directory)) throw new WorkspaceError('UNSAFE_PATH', 'Workspace artifacts must be stored outside the source repository.');
    const artifactRoot = await mkdtemp(join(this.directory, 'run-'));
    const commonDir = await realpath(await gitText(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { signal }));
    const originalHead = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], { signal, allowFailure: true });
    const captured = await snapshot(repoRoot, repoRoot, artifactRoot, originalHead.code === 0 ? originalHead.stdout.toString().trim() : null, signal);
    const ignored = (await git(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { signal })).stdout.toString('utf8').split('\0').filter(Boolean);
    return this.save({ kind: 'base', id: runId, runId, cwd: originalCwd, originalCwd, subdirectory: relative(repoRoot, originalCwd), repoRoot, rootIdentity, commonDir, artifactRoot, root: artifactRoot, baseHead: captured.head, fileModes: Object.fromEntries(captured.entries.filter(entry => entry.mode.startsWith('100')).map(entry => [entry.path, entry.permissions])), originalHead: originalHead.code === 0 ? originalHead.stdout.toString().trim() : null, setupRequirements: ignored.length ? [{ kind: 'ignored-files', paths: ignored, message: 'Ignored files and dependencies were omitted; use the project setup process inside each isolated workspace.' }] : [] });
  }
  async checkout(base, head, prefix, signal) {
    cancelled(signal);
    const artifactRoot = await mkdtemp(join(base.artifactRoot, `${prefix}-`));
    const root = join(artifactRoot, 'checkout');
    await locked(base.commonDir, () => git(base.repoRoot, ['worktree', 'add', '--detach', '--no-checkout', root, head], { signal }));
    const gitDir = await gitText(root, ['rev-parse', '--absolute-git-dir'], { signal });
    await git(root, ['read-tree', head], { signal });
    await materialize(base.repoRoot, root, await treeEntries(base.repoRoot, head, signal), signal);
    const cwd = join(root, base.subdirectory);
    await mkdir(cwd, { recursive: true });
    return { artifactRoot, root, cwd, gitDir };
  }
  async task(baseValue, { id = randomUUID(), dependencies = [], dependsOn, signal } = {}) {
    const base = await this.load(baseValue, ['base']); cancelled(signal);
    if (dependsOn !== undefined) {
      const supplied = Array.isArray(dependencies) ? dependencies.map(value => value?.id) : [];
      if (!Array.isArray(dependsOn) || dependsOn.some(value => typeof value !== 'string') || new Set(dependsOn).size !== dependsOn.length || new Set(supplied).size !== supplied.length || dependsOn.length !== supplied.length || dependsOn.some(value => !supplied.includes(value))) throw new WorkspaceError('DEPENDENCY_CONFLICT', 'Declared dependency IDs must exactly match the supplied frozen results.', { dependsOn, supplied });
    }
    const ordered = await this.ordered(base, dependencies, signal);
    let head = base.baseHead;
    if (ordered.length) {
      const integration = await this.integrate(baseValue, dependencies, { signal });
      if (integration.status !== 'integrated') throw new WorkspaceError('DEPENDENCY_CONFLICT', 'Dependencies require conflict resolution before starting this task.', { integration });
      head = integration.head;
    }
    const workspace = await this.checkout(base, head, 'task', signal);
    return this.save({ kind: 'task', id, runId: base.runId, ...workspace, repoRoot: base.repoRoot, baseManifest: base.manifestPath, baseHead: head, dependencies: ordered });
  }
  async diff(base, head, artifactRoot, signal) {
    const contents = (await git(base.repoRoot, [...patchOptions, base.baseHead, head, '--'], { signal })).stdout;
    const diffPath = join(artifactRoot, 'changes.patch');
    await writeFile(diffPath, contents, { flag: 'wx', mode: 0o444 });
    const files = (await git(base.repoRoot, ['diff', '--name-only', '--no-renames', '-z', base.baseHead, head, '--'], { signal })).stdout.toString('utf8').split('\0').filter(Boolean);
    return { baseHead: base.baseHead, head, diffPath, hash: sha256(contents), files };
  }
  async freeze(taskValue, { acceptance = [], checks = [], signal } = {}) {
    const task = await this.load(taskValue, ['task']); const base = await this.baseFor(task); cancelled(signal);
    const artifactRoot = await mkdtemp(join(base.artifactRoot, 'snapshot-'));
    const captured = await snapshot(base.repoRoot, task.root, artifactRoot, task.baseHead, signal);
    const changes = await this.diff({ ...base, baseHead: task.baseHead }, captured.head, artifactRoot, signal);
    return this.save({ kind: 'snapshot', id: task.id, status: 'frozen', runId: base.runId, artifactRoot, root: artifactRoot, baseManifest: base.manifestPath, ...changes, dependencies: task.dependencies, acceptance: structuredClone(acceptance), checks: structuredClone(checks) });
  }
  async verifiedSnapshot(base, value, signal, kinds = ['snapshot']) {
    const saved = await this.load(value, kinds);
    if (saved.baseManifest !== base.manifestPath) throw new WorkspaceError('INVALID_ARTIFACT', 'Dependency belongs to another workflow baseline.');
    if (saved.kind === 'integration' && saved.status !== 'integrated') throw new WorkspaceError('UNRESOLVED_CONFLICTS', 'Resolve integration conflicts before reviewing its result.');
    await ownedPath(this.directory, saved.diffPath);
    const diff = await readFile(saved.diffPath);
    const actual = (await git(base.repoRoot, [...patchOptions, saved.baseHead, saved.head, '--'], { signal })).stdout;
    if (sha256(diff) !== saved.hash || sha256(actual) !== saved.hash) throw new WorkspaceError('INVALID_ARTIFACT', 'Frozen diff does not match its reviewed hash.');
    return saved;
  }
  async ordered(base, values, signal) {
    if (!Array.isArray(values)) throw new WorkspaceError('INVALID_ARTIFACT', 'Dependencies must be frozen result objects.');
    const ordered = [], versions = new Map(), active = new Set();
    const compare = (a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    const visit = async value => {
      const saved = await this.verifiedSnapshot(base, value, signal);
      if (active.has(saved.id)) throw new WorkspaceError('DEPENDENCY_CONFLICT', 'Dependency graph contains a cycle.', { taskId: saved.id });
      if (versions.has(saved.id)) {
        if (versions.get(saved.id) !== saved.head) throw new WorkspaceError('DEPENDENCY_CONFLICT', 'Dependency graph references different versions of one task.', { taskId: saved.id });
        return;
      }
      active.add(saved.id);
      for (const dependency of [...saved.dependencies].sort(compare)) await visit(dependency);
      active.delete(saved.id); versions.set(saved.id, saved.head); ordered.push(saved);
    };
    for (const value of [...values].sort(compare)) await visit(value);
    return ordered;
  }
  async review(baseValue, snapshotValue, { id = randomUUID(), signal } = {}) {
    const base = await this.load(baseValue, ['base']); const frozen = await this.verifiedSnapshot(base, snapshotValue, signal, ['snapshot', 'integration']);
    const workspace = await this.checkout(base, frozen.head, 'review', signal);
    const previous = await this.checkout(base, frozen.baseHead, 'review-base', signal);
    await readonly(workspace.root); await readonly(previous.root);
    return this.save({ kind: 'review', id, runId: base.runId, ...workspace, baseManifest: base.manifestPath, baseRoot: previous.root, baseCwd: previous.cwd, baseHead: frozen.baseHead, head: frozen.head, diffPath: frozen.diffPath, hash: frozen.hash, files: frozen.files, acceptance: frozen.acceptance, checks: frozen.checks, readonly: true });
  }
  async syncFiles(base, root, previous, entries, signal) {
    // Even --cached three-way application may materialize an add/add conflict
    // absent from the previous tree. Clear known indexed paths before rebuilding.
    // Remove the old tree first, including old symlinks that are becoming
    // directories, before inspecting any newly indexed descendants.
    const deepestFirst = values => values.map(entry => entry.path).sort((a, b) => b.length - a.length);
    const paths = [...new Set([...deepestFirst(previous), ...deepestFirst(entries)])];
    for (const entryPath of paths) {
      await safeParents(root, entryPath);
      const path = join(root, entryPath), stat = await statMaybe(path);
      if (stat && !stat.isDirectory()) await unlink(path);
      let parent = dirname(path);
      while (parent !== root) {
        try { await rmdir(parent); } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'ENOTDIR', 'EEXIST'].includes(error.code)) throw error; break; }
        parent = dirname(parent);
      }
    }
    await materialize(base.repoRoot, root, entries, signal);
  }
  async indexContents(base, workspace, taskId, signal) {
    const indexed = parseIndex((await git(workspace.root, ['ls-files', '--stage', '-z'], { signal })).stdout);
    const entries = indexed.filter(entry => entry.stage === 0), conflicts = [];
    for (const path of [...new Set(indexed.filter(entry => entry.stage !== 0).map(entry => entry.path))]) {
      const stages = indexed.filter(entry => entry.path === path);
      const before = stages.find(entry => entry.stage === 1), ours = stages.find(entry => entry.stage === 2), theirs = stages.find(entry => entry.stage === 3);
      let chosen = ours ?? theirs, reason = !ours || !theirs ? 'delete-modify' : 'content';
      if (before && ours && theirs && [before, ours, theirs].every(entry => entry.mode.startsWith('100'))) {
        const contents = await Promise.all([ours, before, theirs].map(entry => blob(base.repoRoot, entry.oid, signal)));
        if (contents.some(content => content.includes(0))) reason = 'binary';
        else {
          const paths = contents.map((_, index) => join(workspace.artifactRoot, `merge-${randomUUID()}-${index}`));
          for (let index = 0; index < paths.length; index++) await writeFile(paths[index], contents[index], { flag: 'wx', mode: 0o600 });
          const merged = await git(base.repoRoot, ['merge-file', '-p', '-L', 'current integration', '-L', 'task baseline', '-L', taskId, ...paths], { signal, allowFailure: true });
          if (merged.code === 0 || merged.code === 1) chosen = { ...ours, content: merged.stdout };
        }
      }
      conflicts.push({ path, taskId, reason, stages: stages.map(({ stage, mode, oid }) => ({ stage, mode, oid })) });
      if (chosen) entries.push(chosen);
    }
    return { entries, conflicts };
  }
  async integrate(baseValue, snapshots, { signal } = {}) {
    const base = await this.load(baseValue, ['base']);
    const ordered = await this.ordered(base, snapshots, signal);
    const workspace = await this.checkout(base, base.baseHead, 'integration', signal);
    return this.combine(base, workspace, ordered, [], await treeEntries(base.repoRoot, base.baseHead, signal), { signal });
  }
  async combine(base, workspace, pending, applied, previous, { acceptance = [], checks = [], signal } = {}) {
    let conflicts = [], remaining = [];
    for (let index = 0; index < pending.length; index++) {
      const frozen = await this.verifiedSnapshot(base, pending[index], signal); cancelled(signal);
      const patch = await readFile(frozen.diffPath);
      if (sha256(patch) !== frozen.hash) throw new WorkspaceError('INVALID_ARTIFACT', 'Pending diff changed before it could be integrated.');
      if (patch.length) {
        const response = await git(workspace.root, ['apply', '--cached', '--3way', '--binary', '--whitespace=nowarn', '-'], { input: patch, signal, allowFailure: true });
        if (response.code !== 0) {
          const contents = await this.indexContents(base, workspace, frozen.id, signal);
          conflicts = contents.conflicts.length ? contents.conflicts : [{ path: null, taskId: frozen.id, reason: 'patch-failed', message: response.stderr.trim(), diffPath: frozen.diffPath }];
          remaining = pending.slice(index + 1); applied.push(frozen);
          break;
        }
      }
      applied.push(frozen);
    }
    const contents = await this.indexContents(base, workspace, applied.at(-1)?.id ?? 'integration', signal);
    await this.syncFiles(base, workspace.root, previous, contents.entries, signal);
    const artifactRoot = await mkdtemp(join(base.artifactRoot, 'integrated-result-'));
    const captured = await snapshot(base.repoRoot, workspace.root, artifactRoot, base.baseHead, signal);
    const changes = await this.diff(base, captured.head, artifactRoot, signal);
    return this.save({ kind: 'integration', id: randomUUID(), runId: base.runId, ...workspace, artifactRoot, baseManifest: base.manifestPath, ...changes, status: conflicts.length ? 'conflicted' : 'integrated', conflicts, snapshots: applied, pending: remaining, acceptance: structuredClone(acceptance), checks: structuredClone(checks) });
  }
  async finalizeIntegration(baseValue, integrationValue, options = {}) {
    const base = await this.load(baseValue, ['base']); const integration = await this.load(integrationValue, ['integration']);
    if (integration.baseManifest !== base.manifestPath) throw new WorkspaceError('INVALID_ARTIFACT', 'Integration belongs to another workflow baseline.');
    const unmerged = (await git(integration.root, ['ls-files', '--unmerged', '-z'], { signal: options.signal })).stdout;
    if (unmerged.length) throw new WorkspaceError('UNRESOLVED_CONFLICTS', 'Resolve and stage every conflict in the integration workspace before finalizing.');
    const captured = await snapshot(base.repoRoot, integration.root, integration.artifactRoot, base.baseHead, options.signal);
    await git(integration.root, ['read-tree', captured.head], { signal: options.signal });
    return this.combine(base, integration, integration.pending, [...integration.snapshots], captured.entries, options);
  }
  async apply(baseValue, integrationValue, { signal } = {}) {
    const base = await this.load(baseValue, ['base']); const integration = await this.load(integrationValue, ['integration']); cancelled(signal);
    if (integration.baseManifest !== base.manifestPath || integration.baseHead !== base.baseHead) throw new WorkspaceError('INVALID_ARTIFACT', 'Integration belongs to another workflow baseline.');
    if (integration.status !== 'integrated') throw new WorkspaceError('UNRESOLVED_CONFLICTS', 'Conflicted integration cannot be applied.');
    const actual = (await git(base.repoRoot, [...patchOptions, base.baseHead, integration.head, '--'], { signal })).stdout;
    await ownedPath(this.directory, integration.diffPath);
    if (sha256(actual) !== integration.hash || sha256(await readFile(integration.diffPath)) !== integration.hash) throw new WorkspaceError('INVALID_ARTIFACT', 'Integrated diff no longer matches its frozen artifact.');
    const artifactRoot = await mkdtemp(join(base.artifactRoot, 'apply-'));
    return locked(`apply:${base.repoRoot}`, () => applyTreeDelta(base, integration, artifactRoot, signal));
  }
}
