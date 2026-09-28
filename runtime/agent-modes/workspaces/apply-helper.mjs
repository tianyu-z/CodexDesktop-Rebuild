// Runs only as an isolated child process: cwd is the kernel-held directory anchor.
// User paths are single-component names. Capture and staging slots live inside
// newly, exclusively created app-owned directories in that pinned cwd.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });
const identity = stat => `${stat.dev}:${stat.ino}`;
// Node caches cwd strings; a harmless chdir('.') refreshes getcwd after an external rename.
const physicalCwd = () => { process.chdir('.'); return process.cwd(); };
const stat = async name => { try { return await fs.lstat(name, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const safeName = name => {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name) || /^\.git[ .]*$/i.test(name)) throw fail('UNSAFE_PATH', 'Unsafe directory-relative filename.');
  return name;
};
const fp = node => {
  if (!node) return null;
  if (node.kind === 'file') return { kind: 'file', mode: node.mode, hash: createHash('sha256').update(node.content).digest('hex') };
  if (node.kind === 'symlink') return { kind: 'symlink', target: node.target };
  if (node.kind === 'directory') return { kind: 'directory', children: Object.fromEntries(Object.keys(node.children).sort().map(name => [name, fp(node.children[name])])) };
  return { kind: node.kind };
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);

async function enter(name, expected) {
  safeName(name);
  const before = await stat(name);
  if (!before?.isDirectory() || (expected && identity(before) !== expected)) throw fail('UNSAFE_PATH', 'A destination ancestor changed or became a symlink.');
  process.chdir(name);
  if (identity(await stat('.')) !== identity(before)) throw fail('UNSAFE_PATH', 'A destination ancestor changed while it was being opened.');
}
async function within(name, expected, operation) {
  const parent = identity(await stat('.'));
  await enter(name, expected);
  try { return await operation(); }
  finally {
    process.chdir('..');
    if (identity(await stat('.')) !== parent) throw fail('UNSAFE_PATH', 'A directory moved during the operation; recovery files were retained.');
  }
}
async function reserveNamespace(prefix) {
  const name = safeName(await fs.mkdtemp(`${safeName(prefix)}-`));
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const value = { name, identity: identity(await handle.stat({ bigint: true })) };
    await handle.chmod(0o700);
    return value;
  } finally { await handle.close(); }
}
async function assertNamespace(namespace) {
  safeName(namespace.name);
  const current = await stat(namespace.name);
  if (!current?.isDirectory() || identity(current) !== namespace.identity) throw fail('UNSAFE_PATH', 'An owned recovery directory changed; its artifacts were retained.');
}
async function readReserved(namespace) {
  await assertNamespace(namespace);
  return within(namespace.name, namespace.identity, () => readNode('original'));
}
async function removeNamespace(namespace) {
  await assertNamespace(namespace);
  await fs.rmdir(namespace.name);
}
async function readNode(name) {
  safeName(name); const info = await stat(name);
  if (!info) return null;
  const common = { identity: identity(info), mode: Number(info.mode & 0o777n) };
  if (info.isSymbolicLink()) return { ...common, kind: 'symlink', target: await fs.readlink(name) };
  if (info.isFile()) {
    const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || identity(opened) !== common.identity) throw fail('BASELINE_CHANGED', 'A file changed while it was being inspected.');
      return { ...common, content: await handle.readFile(), kind: 'file' };
    } finally { await handle.close(); }
  }
  if (info.isDirectory()) return within(name, common.identity, async () => {
    const children = Object.create(null);
    for (const child of (await fs.readdir('.')).sort()) children[safeName(child)] = await readNode(child);
    return { ...common, kind: 'directory', children };
  });
  return { ...common, kind: 'special' };
}
function decode(node) {
  if (!node) return null;
  if (node.kind === 'file') return { ...node, content: Buffer.from(node.content, 'base64') };
  if (node.kind === 'directory') return { ...node, children: Object.fromEntries(Object.entries(node.children).map(([name, child]) => [safeName(name), decode(child)])) };
  return node;
}
async function writeExclusive(name, node, record) {
  if (!node) return;
  safeName(name); record.kind = node.kind;
  if (node.kind === 'file') {
    const staging = await reserveNamespace('.codex-workspace-stage');
    try {
      const stagedIdentity = await within(staging.name, staging.identity, async () => {
        const handle = await fs.open('output', constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, node.mode);
        try {
          const value = identity(await handle.stat({ bigint: true }));
          let written = 0;
          while (written < node.content.length) {
            const { bytesWritten } = await handle.write(node.content, written, node.content.length - written, written);
            if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) throw fail('APPLY_FAILED', 'A file write made no confirmed progress.');
            written += bytesWritten;
          }
          await handle.chmod(node.mode);
          return value;
        } finally { await handle.close(); }
      });
      await assertNamespace(staging);
      try { await fs.link(join(staging.name, 'output'), name); }
      catch (error) {
        if (error.code === 'EEXIST') throw fail('BASELINE_CHANGED', 'Another writer created the destination before publication.');
        throw error;
      }
      // Publication is exclusive and final: never write/chmod the now-visible inode
      // or adopt a reread that may already include another writer's changes.
      record.identity = stagedIdentity; record.fingerprint = fp(node);
    } finally {
      await within(staging.name, staging.identity, async () => {
        try { await fs.unlink('output'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      });
      await removeNamespace(staging);
    }
  } else if (node.kind === 'symlink') {
    await fs.symlink(node.target, name);
    record.identity = identity(await stat(name)); record.fingerprint = fp(node);
  } else if (node.kind === 'directory') {
    await fs.mkdir(name, { mode: node.mode });
    const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { record.identity = identity(await handle.stat({ bigint: true })); await handle.chmod(node.mode); }
    finally { await handle.close(); }
    record.children = Object.create(null);
    await within(name, record.identity, async () => {
      for (const [child, value] of Object.entries(node.children)) {
        const owned = {}; record.children[child] = owned;
        await writeExclusive(child, value, owned);
      }
    });
  } else throw fail('UNSAFE_PATH', 'Unsupported file type in applied changes.');
}
async function removeOwned(name, owned, retained) {
  if (!owned?.identity) return;
  const current = await readNode(name);
  if (!current || current.identity !== owned.identity) { if (current) retained.push(name); return; }
  if (owned.kind === 'directory') {
    await within(name, owned.identity, async () => {
      for (const [child, value] of Object.entries(owned.children ?? {}).reverse()) await removeOwned(child, value, retained);
    });
    try { await fs.rmdir(name); } catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) retained.push(name); else throw error; }
  } else if (equal(fp(current), owned.fingerprint)) {
    // Capture the final leaf before deleting; a racing replacement stays recoverable.
    const quarantine = await reserveNamespace('.codex-workspace-recovery');
    await assertNamespace(quarantine);
    await fs.rename(name, join(quarantine.name, 'original'));
    const captured = await readReserved(quarantine);
    if (captured?.identity === owned.identity && equal(fp(captured), owned.fingerprint)) {
      await within(quarantine.name, quarantine.identity, () => fs.unlink('original'));
      await removeNamespace(quarantine);
    }
    else {
      retained.push(join(physicalCwd(), quarantine.name, 'original'));
      try { await writeExclusive(name, captured, {}); } catch { /* Never replace a later writer. */ }
    }
  } else retained.push(name);
}
async function removeBackup(name, expected) {
  const current = await readNode(name);
  if (!current) return true;
  if (!equal(fp(current), expected)) return false;
  const owned = node => ({ kind: node.kind, identity: node.identity, fingerprint: fp(node), ...(node.kind === 'directory' ? { children: Object.fromEntries(Object.entries(node.children).map(([child, value]) => [child, owned(value)])) } : {}) });
  const retained = []; await removeOwned(name, owned(current), retained);
  return retained.length === 0;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
let request, record;
try {
  const first = await input.next(); request = JSON.parse(first.value);
  if (identity(await stat('.')) !== request.rootIdentity) throw fail('UNSAFE_PATH', 'The original directory was replaced before the helper started.');
  record = { name: safeName(request.name), backupName: safeName(request.backupName), backupDirectory: request.backupDirectory ?? null, backupDirectoryIdentity: request.backupDirectoryIdentity ?? null, captured: false, owned: {}, createdParents: [] };
  for (const name of request.parents ?? []) {
    safeName(name);
    let info = await stat(name);
    if (!info && request.operation === 'apply' && request.desired) {
      const parentPath = physicalCwd(), parentIdentity = identity(await stat('.'));
      await fs.mkdir(name);
      info = await stat(name);
      record.createdParents.push({ parentPath, parentIdentity, name, identity: identity(info) });
    }
    await enter(name, info ? identity(info) : undefined);
  }
  record.directoryPath = physicalCwd(); record.directoryIdentity = identity(await stat('.'));
  emit({ type: 'ready', operation: request.operation });
  const permission = await input.next();
  if (permission.done || JSON.parse(permission.value).action !== 'continue') throw fail('CANCELLED', 'Application was cancelled before the next mutation.');

  if (request.operation === 'apply') {
    if (!equal(fp(await readNode(record.name)), request.expected)) throw fail('BASELINE_CHANGED', 'An affected file changed before application.');
    if (request.expected) {
      const namespace = await reserveNamespace(record.backupName);
      record.backupDirectory = namespace.name; record.backupDirectoryIdentity = namespace.identity;
      await assertNamespace(namespace);
      await fs.rename(record.name, join(namespace.name, 'original')); record.captured = true;
      if (!equal(fp(await readReserved(namespace)), request.expected)) throw fail('BASELINE_CHANGED', 'An affected file changed during capture.');
    }
    await writeExclusive(record.name, decode(request.desired), record.owned);
    if (!equal(fp(await readNode(record.name)), request.desiredFingerprint)) throw fail('BASELINE_CHANGED', 'Another writer changed the applied file.');
  } else if (request.operation === 'rollback') {
    const retained = []; await removeOwned(record.name, request.owned, retained);
    const original = request.captured ? await readReserved({ name: record.backupDirectory, identity: record.backupDirectoryIdentity }) : null;
    if (original) {
      try { await writeExclusive(record.name, original, {}); record.restored = true; }
      catch (error) { retained.push(record.name); record.restoreError = error.code ?? error.message; }
    }
    record.retained = retained;
  } else if (request.operation === 'verify') {
    if (request.captured && !equal(fp(await readReserved({ name: record.backupDirectory, identity: record.backupDirectoryIdentity })), request.expected)) throw fail('BASELINE_CHANGED', 'A captured original changed during application.');
  } else if (request.operation === 'cleanup') {
    const namespace = { name: record.backupDirectory, identity: record.backupDirectoryIdentity };
    await assertNamespace(namespace);
    record.cleaned = await within(namespace.name, namespace.identity, () => removeBackup('original', request.expected));
    if (record.cleaned) await removeNamespace(namespace);
  }
  else if (request.operation === 'prune') {
    const current = await stat(record.name);
    if (current?.isDirectory() && identity(current) === request.identity) {
      try { await fs.rmdir(record.name); } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
  } else throw fail('APPLY_FAILED', 'Unknown apply helper operation.');
  record.directoryPath = physicalCwd();
  emit({ type: 'result', ok: true, record });
} catch (error) {
  if (record) {
    try { if (identity(await stat('.')) === record.directoryIdentity) record.directoryPath = physicalCwd(); } catch { /* Keep the last known recovery location. */ }
  }
  emit({ type: 'result', ok: false, error: { code: error.code ?? 'APPLY_FAILED', message: error.message }, record });
  process.exitCode = 1;
} finally { process.stdin.destroy(); }
