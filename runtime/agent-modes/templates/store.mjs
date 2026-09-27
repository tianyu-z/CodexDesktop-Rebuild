import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import { BUILTIN_TEMPLATES } from './builtins.mjs';
import { TemplateValidationError, validateId, validateRevision, validateTemplate } from './schema.mjs';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const fail = (path, message) => { throw new TemplateValidationError(path, message); };
const clone = value => structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);

function safePath(path, kind) {
  if (!existsSync(path)) {
    // existsSync follows links and returns false for dangling symlinks.
    try { if (lstatSync(path).isSymbolicLink()) fail('$', `symbolic link is not permitted: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return false;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail('$', `symbolic link is not permitted: ${path}`);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail('$', `expected a ${kind}: ${path}`);
  return true;
}
function ensureDirectory(path) {
  if (!safePath(path, 'directory')) mkdirSync(path, { recursive: true, mode: 0o700 });
}
function readJson(path) {
  if (!safePath(path, 'file')) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
function atomicJson(path, value) {
  safePath(path, 'file');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function parse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_IMPORT_BYTES) fail('$', 'expected YAML/JSON text no larger than 2 MiB');
  const document = parseDocument(text, { schema: 'core', uniqueKeys: true, customTags: [], strict: true });
  if (document.errors.length) fail('$', `YAML/JSON parse error: ${document.errors[0].message}`);
  if (document.warnings.length) fail('$', `YAML/JSON parse warning: ${document.warnings[0].message}`);
  function check(node, path = '$', depth = 0) {
    if (!node) return;
    if (depth > 64) fail(path, 'maximum data nesting exceeded');
    if (isAlias(node) || node.anchor) fail(path, 'YAML anchors and aliases are not supported');
    if (node.tag) fail(path, 'explicit YAML tags are not supported; use plain JSON-compatible values');
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail(path, 'mapping keys must be strings');
        check(pair.key, path, depth + 1); check(pair.value, `${path}.${pair.key.value}`, depth + 1);
      }
    } else if (isSeq(node)) node.items.forEach((item, i) => check(item, `${path}[${i}]`, depth + 1));
  }
  check(document.contents);
  return document.toJS({ maxAliasCount: 0 });
}

/** Synchronous store under the gateway's single-process ownership lock.
 * Revisions are immutable; current.json is a replaceable pointer/tombstone. */
export class TemplateStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) fail('$', 'a template storage directory is required');
    this.directory = resolve(directory);
    ensureDirectory(this.directory);
    this.builtins = new Map(BUILTIN_TEMPLATES.map(value => [value.id, value]));
  }
  #paths(id, create = false) {
    validateId(id);
    safePath(this.directory, 'directory');
    const directory = join(this.directory, id), revisions = join(directory, 'revisions');
    if (create) ensureDirectory(directory); else if (!safePath(directory, 'directory')) return null;
    if (create) ensureDirectory(revisions); else safePath(revisions, 'directory');
    return { directory, revisions, current: join(directory, 'current.json') };
  }
  #current(paths) {
    if (!paths) return null;
    const current = readJson(paths.current);
    if (current === null) return null;
    if (!current || typeof current !== 'object' || Array.isArray(current) || Object.keys(current).some(key => !['revision', 'deleted'].includes(key)) || typeof current.deleted !== 'boolean') fail('$', 'invalid template current pointer');
    validateRevision(current.revision);
    return current;
  }
  list() {
    const values = [...this.builtins.values()].map(clone);
    safePath(this.directory, 'directory');
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) fail('$', `symbolic link is not permitted: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      validateId(entry.name);
      if (this.builtins.has(entry.name)) continue;
      const value = this.read(entry.name);
      if (value) values.push(value);
    }
    return values.sort((a, b) => a.id.localeCompare(b.id));
  }
  read(id, revision) {
    validateId(id);
    if (revision !== undefined) validateRevision(revision);
    if (this.builtins.has(id)) {
      const builtin = this.builtins.get(id);
      return revision === undefined || revision === builtin.revision ? clone(builtin) : null;
    }
    const paths = this.#paths(id);
    if (!paths) return null;
    const current = this.#current(paths);
    if (revision === undefined && (!current || current.deleted)) return null;
    const wanted = revision ?? current.revision;
    const stored = readJson(join(paths.revisions, `${wanted}.json`));
    if (stored === null) return null;
    const value = validateTemplate(stored);
    if (value.id !== id || value.revision !== wanted || value.builtin || value.contentHash !== stored.contentHash) fail('$', `template revision integrity/hash mismatch: ${id}@${wanted}`);
    return value;
  }
  save(input) {
    const value = validateTemplate(input);
    if (this.builtins.has(value.id)) fail('$.id', 'built-in templates are immutable; save a copy with a new ID');
    const paths = this.#paths(value.id, true), current = this.#current(paths);
    // Caller metadata is an optimistic concurrency token only when this ID already exists.
    if (current && own(input, 'revision') && input.revision !== current.revision) fail('$.revision', `revision conflict: expected ${current.revision}, received ${input.revision}`);
    // Include an unpointed snapshot from a crash between snapshot and pointer writes.
    const revisions = readdirSync(paths.revisions).filter(name => /^[1-9][0-9]*\.json$/.test(name)).map(name => Number(name.slice(0, -5)));
    const latest = Math.max(current?.revision ?? 0, ...revisions);
    validateRevision(latest + 1);
    value.revision = latest + 1; value.builtin = false;
    atomicJson(join(paths.revisions, `${value.revision}.json`), value);
    atomicJson(paths.current, { revision: value.revision, deleted: false });
    return clone(value);
  }
  remove(id) {
    validateId(id);
    if (this.builtins.has(id)) fail('$.id', 'built-in templates are immutable');
    const paths = this.#paths(id), current = this.#current(paths);
    if (!current || current.deleted) return false;
    atomicJson(paths.current, { revision: current.revision, deleted: true });
    return true;
  }
  import(text) { return this.save(parse(text)); }
  export(id, revision, format = 'yaml') {
    if (!['yaml', 'json'].includes(format)) fail('$.format', 'expected yaml or json');
    const value = this.read(id, revision);
    if (!value) fail('$.id', `template revision not found: ${id}${revision === undefined ? '' : `@${revision}`}`);
    return format === 'json' ? `${JSON.stringify(value, null, 2)}\n` : stringify(value, { lineWidth: 100 });
  }
}
