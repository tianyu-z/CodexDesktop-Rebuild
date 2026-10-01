import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const permissionConfig = /^(?:permissions|sandbox|approval|approvals|profile)(?:[._]|$)/;

async function stateAgrees(thread, context) {
  let directory = dirname(thread.path);
  for (let depth = 0; depth < 6; depth++, directory = dirname(directory)) {
    if (!['sessions', 'archived_sessions'].includes(basename(directory))) continue;
    // The pinned native server updates this state immediately on settings/update,
    // whereas a new turn_context is written only when another turn begins.
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(dirname(directory), 'state_5.sqlite'), { readOnly: true });
    let row;
    try {
      database.exec('PRAGMA busy_timeout=100');
      row = database.prepare('SELECT rollout_path, sandbox_policy, approval_mode FROM threads WHERE id=?').get(thread.id);
    } finally { database.close(); }
    if (!row || JSON.parse(row.sandbox_policy).type !== 'disabled' || row.approval_mode !== context.approval_policy) return false;
    const paths = await Promise.all([realpath(row.rollout_path), realpath(thread.path)]);
    return paths[0] === paths[1];
  }
  return false;
}

// Read only complete JSONL records from the tail. Large histories must not be
// hydrated into memory merely to recover one legacy permission selection.
async function latestContext(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    for (let length = Math.min(size, 1024 * 1024); length > 0; length = Math.min(size, length * 2)) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, size - length);
      if (bytesRead !== length || buffer.at(-1) !== 10) return null;
      const lines = buffer.toString('utf8').split('\n');
      if (length < size) lines.shift(); // The first record may start before this buffer.
      for (let index = lines.length - 1; index >= 0; index--) {
        if (!lines[index]) continue;
        const record = JSON.parse(lines[index]);
        if (record.type === 'turn_context') return record.payload;
      }
      if (length === size || length >= 32 * 1024 * 1024) return null;
    }
    return null;
  } finally { await file.close(); }
}

async function isLoaded(native, threadId) {
  let cursor;
  const seen = new Set();
  do {
    const page = await native.request('thread/loaded/list', { ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw Error('Invalid loaded-thread response');
    if (page.data.includes(threadId)) return true;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Error('Repeated loaded-thread cursor');
    seen.add(cursor);
  } while (cursor);
  return false;
}

/** Migrate only legacy Full access records lacking a named permission profile. */
export async function restoreLegacyResumePermissions(native, params) {
  if (!params.threadId || params.history != null ||
      ['permissions', 'sandbox', 'approvalPolicy', 'approvalsReviewer'].some(key => params[key] != null) ||
      Object.keys(params.config ?? {}).some(key => permissionConfig.test(key))) return params;
  try {
    // A live thread can have newer settings than its last persisted turn.
    if (await isLoaded(native, params.threadId)) return params;
    const { thread } = await native.request('thread/read', { threadId: params.threadId, includeTurns: false });
    if (thread?.id !== params.threadId || !thread.path || params.path != null && params.path !== thread.path) return params;
    const context = await latestContext(thread.path);
    if (!context || context.active_permission_profile != null ||
        context.sandbox_policy?.type !== 'danger-full-access' ||
        context.permission_profile != null && context.permission_profile.type !== 'disabled' ||
        !['never', 'on-request', 'untrusted'].includes(context.approval_policy) ||
        context.approvals_reviewer != null && !['user', 'auto_review', 'guardian_subagent'].includes(context.approvals_reviewer)) return params;
    if (!await stateAgrees(thread, context) || await isLoaded(native, params.threadId)) return params;
    const { sandbox, ...rest } = params;
    return { ...rest, permissions: ':danger-full-access', approvalPolicy: context.approval_policy,
      ...(context.approvals_reviewer == null ? {} : { approvalsReviewer: context.approvals_reviewer }) };
  } catch {
    // Missing/unsupported history is not evidence for granting more access.
    return params;
  }
}
