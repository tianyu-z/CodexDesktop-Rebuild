import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const publicCalls = new Set(['spawn_agent', 'send_message', 'followup_task', 'interrupt_agent', 'wait_agent', 'list_agents']);
const lifecycle = new Map([['task_started', 'running'], ['task_complete', 'completed'], ['turn_aborted', 'interrupted']]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0;
const tokens = value => Number.isSafeInteger(value) && value >= 0;
const isoTime = value => typeof value === 'string' ? Date.parse(value) : NaN;
const nativeTime = value => typeof value === 'number' && value >= 0 && Number.isFinite(value * 1000) ? value * 1000 : NaN;

/** Read only the native Thread.path supplied by the caller, never a guessed transcript. */
export async function readCodexAgentHistory(path, { callIds, turnIds } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Codex agent history requires an absolute native transcript path.');
  const selectedCalls = callIds === undefined ? undefined : new Set(callIds);
  const selectedTurns = new Set(turnIds ?? []);
  const dispatches = new Map(), models = new Map(), usage = new Map(), ambiguousUsage = new Set(), turnStates = new Map();
  let activeTurn, previousTotal, limited = false;
  const consume = bytes => {
    if (!bytes.length) return;
    let row;
    try { row = JSON.parse(bytes.toString('utf8')); }
    catch { throw new SyntaxError('Invalid JSON in native Codex agent history.'); }
    if (!record(row) || !record(row.payload)) return;
    const payload = row.payload;
    if (row.type === 'event_msg' && lifecycle.has(payload.type) && identifier(payload.turn_id) && (turnIds === undefined || selectedTurns.has(payload.turn_id))) {
      const starting = payload.type === 'task_started';
      const state = starting ? {} : { ...turnStates.get(payload.turn_id) };
      state.status = lifecycle.get(payload.type);
      const startedAt = Number.isFinite(nativeTime(payload.started_at)) ? nativeTime(payload.started_at) : starting ? isoTime(row.timestamp) : NaN;
      const completedAt = Number.isFinite(nativeTime(payload.completed_at)) ? nativeTime(payload.completed_at) : isoTime(row.timestamp);
      if (Number.isFinite(startedAt)) state.startedAt = startedAt;
      if (!starting && Number.isFinite(completedAt)) state.completedAt = completedAt;
      turnStates.set(payload.turn_id, state);
    }
    if (row.type === 'response_item' && payload.type === 'function_call' && payload.namespace === 'collaboration' && publicCalls.has(payload.name) && identifier(payload.call_id) && (!selectedCalls || selectedCalls.has(payload.call_id))) {
      let args;
      try { args = JSON.parse(payload.arguments); } catch { return; }
      if (!record(args) || dispatches.has(payload.call_id)) return;
      const prompt = typeof args.message === 'string' ? args.message : typeof args.prompt === 'string' ? args.prompt : undefined;
      const startedAt = isoTime(row.timestamp);
      dispatches.set(payload.call_id, { tool: payload.name, arguments: args,
        ...(prompt !== undefined ? { prompt } : {}), ...(Number.isFinite(startedAt) ? { startedAt } : {}) });
    } else if (row.type === 'turn_context') {
      activeTurn = identifier(payload.turn_id) ? payload.turn_id : undefined;
      if (selectedTurns.has(activeTurn)) {
        if (!models.has(activeTurn)) models.set(activeTurn, new Set());
        models.get(activeTurn).add(identifier(payload.model) ? payload.model : undefined);
      }
    } else if (row.type === 'event_msg' && payload.type === 'task_started') {
      activeTurn = identifier(payload.turn_id) ? payload.turn_id : undefined;
    } else if (row.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload.type)) {
      if (!identifier(payload.turn_id) || payload.turn_id === activeTurn) activeTurn = undefined;
    } else if (row.type === 'event_msg' && payload.type === 'token_count') {
      const total = payload.info?.total_token_usage?.total_tokens;
      if (!tokens(total)) return;
      const last = payload.info?.last_token_usage?.total_tokens;
      // A first total equal to its last request establishes the initial zero
      // baseline. Otherwise the omitted history cannot be charged to this turn.
      const baseline = previousTotal ?? (tokens(last) && total === last ? 0 : undefined);
      if (selectedTurns.has(activeTurn)) {
        if (baseline === undefined || total < baseline) ambiguousUsage.add(activeTurn);
        else usage.set(activeTurn, (usage.get(activeTurn) ?? 0) + total - baseline);
      }
      previousTotal = total;
    }
  };

  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return { dispatches: {}, warnings: [] }; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new TypeError('Codex agent history requires a regular native transcript file.');
    const length = Math.min(stat.size, MAX_BYTES);
    limited = stat.size > MAX_BYTES;
    if (length) {
      let fragments = [], records = 0;
      // Snapshot the byte boundary so a live producer cannot extend this read
      // indefinitely. Only newline-terminated records are complete evidence.
      const stream = file.createReadStream({ start: 0, end: length - 1, autoClose: false, highWaterMark: 64 * 1024 });
      reading: for await (const chunk of stream) {
        let start = 0, end;
        while ((end = chunk.indexOf(10, start)) !== -1) {
          if (records++ >= MAX_RECORDS) { limited = true; break reading; }
          fragments.push(chunk.subarray(start, end));
          consume(fragments.length === 1 ? fragments[0] : Buffer.concat(fragments));
          fragments = [];
          start = end + 1;
        }
        if (start < chunk.length) fragments.push(chunk.subarray(start));
      }
    }
  } finally { await file.close(); }

  const result = { dispatches: Object.fromEntries(dispatches), warnings: limited ? ['Codex agent history was truncated at the read limit.'] : [] };
  if (turnStates.size) result.turnStates = Object.fromEntries(turnStates);
  if (!limited && selectedTurns.size && [...selectedTurns].every(id => models.has(id))) {
    const actualModels = new Set([...models.values()].flatMap(values => [...values]));
    if (actualModels.size === 1 && identifier([...actualModels][0])) result.model = [...actualModels][0];
    if ([...selectedTurns].every(id => usage.has(id) && !ambiguousUsage.has(id))) {
      const tokenCount = [...selectedTurns].reduce((sum, id) => sum + usage.get(id), 0);
      if (tokens(tokenCount)) result.tokenCount = tokenCount;
    }
  }
  return result;
}
