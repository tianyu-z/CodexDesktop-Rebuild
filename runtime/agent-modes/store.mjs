import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const clone = value => structuredClone(value);
const engines = new Set(['codex', 'claude']);
export function assertEngine(mode) {
  if (mode === 'both') throw new Error('Both-engine mode is not implemented yet.');
  if (!engines.has(mode)) throw new Error(`Unknown engine mode: ${mode}`);
}

/** One gateway owns a store directory. Each snapshot is replaced atomically. */
export class ConversationStore {
  constructor(directory) {
    this.directory = directory;
    this.records = new Map();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const value = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !Array.isArray(value.turns)) {
        throw new Error(`Unsupported conversation data: ${file}`);
      }
      this.records.set(value.id, value);
      if (value.activeRun) {
        const record = value.turns.find(row => row.turn.id === value.activeRun.turnId);
        if (record?.turn.status === 'inProgress') record.turn.status = 'interrupted';
        const binding = value.bindings[value.activeRun.engine];
        const acknowledged = value.activeRun.acknowledgedSeq;
        if (binding?.sessionId && Number.isInteger(acknowledged) && acknowledged > binding.consumedSeq && acknowledged < value.nextSeq) binding.consumedSeq = acknowledged;
        value.activeRun = null;
        this.save(value);
      }
    }
  }

  path(id) { return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`); }
  remove(id) {
    this.records.delete(id);
    for (const path of [this.path(id), this.path(id).replace(/\.json$/, '.history.txt')]) {
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  get(id) { return this.records.has(id) ? clone(this.records.get(id)) : null; }
  list() { return [...this.records.values()].map(clone); }
  require(id) {
    const value = this.records.get(id);
    if (!value) throw new Error(`Unknown conversation: ${id}`);
    return value;
  }
  save(value) {
    const path = this.path(value.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  }

  ensureThread(thread, { mode = 'codex' } = {}) {
    if (typeof thread?.id !== 'string' || !thread.id) throw new Error('Thread id is required.');
    if (!this.records.has(thread.id)) {
      assertEngine(mode);
      const { turns = [], ...metadata } = thread;
      this.records.set(thread.id, {
        schemaVersion: 1, id: thread.id, mode, cwd: thread.cwd,
        thread: clone(metadata), models: { codex: thread.model ?? null, claude: 'default' },
        bindings: {
          codex: { sessionId: thread.id, consumedSeq: 0 },
          claude: { sessionId: null, consumedSeq: 0 },
        },
        nextSeq: 1, turns: [], activeRun: null,
      });
    }
    return this.mergeNativeThread(thread);
  }

  mergeNativeThread(thread) {
    if (!this.records.has(thread.id)) return this.ensureThread(thread);
    const value = this.require(thread.id);
    const { turns = [], ...metadata } = thread;
    value.thread = { ...value.thread, ...clone(metadata), preview: metadata.preview || value.thread.preview, updatedAt: Math.max(metadata.updatedAt ?? 0, value.thread.updatedAt ?? 0), recencyAt: Math.max(metadata.recencyAt ?? 0, value.thread.recencyAt ?? 0) };
    value.cwd = thread.cwd ?? value.cwd;
    if (thread.model && !thread.model.startsWith('claude-code/')) value.models.codex = thread.model;
    for (const turn of turns) {
      const existing = value.turns.find(row => row.turn.id === turn.id);
      if (existing && existing.turn.status !== 'inProgress' && turn.status === 'inProgress') continue;
      this.putTurn(thread.id, turn, { engine: 'codex', save: false });
    }
    this.save(value);
    return clone(value);
  }

  setMode(id, mode, { model } = {}) {
    assertEngine(mode);
    const value = this.require(id);
    if (value.activeRun) throw new Error('Finish or interrupt the active run before switching engines.');
    value.mode = mode;
    if (model) value.models[mode] = model;
    this.save(value);
    return clone(value);
  }

  setBinding(id, engine, patch) {
    assertEngine(engine);
    const value = this.require(id);
    const previous = value.bindings[engine];
    if (patch.consumedSeq != null && (!Number.isInteger(patch.consumedSeq) || patch.consumedSeq < previous.consumedSeq)) {
      throw new Error('Context cursor must advance monotonically.');
    }
    value.bindings[engine] = { ...previous, ...clone(patch) };
    this.save(value);
  }

  beginRun(id, run) {
    assertEngine(run.engine);
    const value = this.require(id);
    if (value.activeRun) throw new Error('A run is already active in this conversation.');
    value.activeRun = clone(run);
    this.save(value);
  }

  finishRun(id, runId) {
    const value = this.require(id);
    if (value.activeRun?.id !== runId) throw new Error('Run ownership mismatch.');
    value.activeRun = null;
    this.save(value);
  }

  putTurn(id, turn, { engine, runId = turn.id, save = true } = {}) {
    assertEngine(engine);
    const value = this.require(id);
    let record = value.turns.find(row => row.turn.id === turn.id);
    if (record) {
      if (record.engine !== engine) throw new Error('Turn engine ownership mismatch.');
      record.turn = clone(turn);
    } else {
      record = { seq: value.nextSeq++, engine, runId, turn: clone(turn),
        runs: [{ id: runId, engine, nativeTurnId: turn.id }] };
      value.turns.push(record);
    }
    value.thread.updatedAt = Math.max(value.thread.updatedAt ?? 0, turn.startedAt ?? 0, turn.completedAt ?? 0);
    value.thread.recencyAt = Math.max(value.thread.recencyAt ?? 0, value.thread.updatedAt);
    const user = turn.items?.find(item => item.type === 'userMessage');
    if (!value.thread.preview && user) {
      value.thread.preview = user.content?.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 250) ?? '';
    }
    if (save) this.save(value);
    return clone(record);
  }
}
