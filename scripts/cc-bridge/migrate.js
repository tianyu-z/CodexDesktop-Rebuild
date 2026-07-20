#!/usr/bin/env node
/*
 * migrate.js — move a conversation between machines / scaffolds.
 *
 * Investigation result (see DESIGN.md): codex rollout JSONL carries NO
 * signature / attestation / hash — the only opaque field is `encrypted_content`
 * on reasoning items (OpenAI encrypted reasoning), which is dropped. So a
 * codex→codex migration is: rewrite the machine-specific cwd/workspace_roots,
 * drop the rollout under the target ~/.codex/sessions, and append one line to
 * the target ~/.codex/session_index.jsonl. The desktop's thread/list then shows
 * it and thread/resume reads it.
 *
 * Cross-scaffold (claude→codex or codex→claude) composes translate.js first.
 *
 * Transport across machines is orthogonal: read the source file locally or via
 * `ssh <host> cat <path>`, write the target locally or via `ssh <host> "cat > <path>"`.
 * This module does the content transform; callers pick local vs ssh I/O.
 */
"use strict";
const crypto = require("crypto");
const T = require("./translate.js");

const parse = (text) => String(text).split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

// Rewrite the machine-specific bits of a codex rollout for a new host/workspace.
// Keeps the conversation content and the thread id (so resume/history line up),
// swaps cwd + workspace_roots everywhere they appear in metadata.
function rewriteCodexRollout(srcJsonl, opts) {
  opts = opts || {};
  const rows = parse(srcJsonl);
  let id = null, oldCwd = null, name = opts.name || null;
  // discover id + old cwd
  for (const r of rows) {
    if (r.type === "session_meta" && r.payload) { id = id || r.payload.session_id || r.payload.id; oldCwd = oldCwd || r.payload.cwd; }
  }
  const newCwd = opts.newCwd || oldCwd;
  const roots = opts.workspaceRoots || (newCwd ? [newCwd] : []);
  for (const r of rows) {
    const p = r.payload;
    if (!p) continue;
    if (r.type === "session_meta") { if (newCwd) p.cwd = newCwd; }
    else if (r.type === "turn_context") { if (newCwd) p.cwd = newCwd; if (roots.length) p.workspace_roots = roots; }
  }
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return { id, oldCwd, newCwd, name, jsonl };
}

// Build the ~/.codex/sessions relative path a desktop expects for a rollout id.
// rollout-<ISO(-'d)>-<id>.jsonl under YYYY/MM/DD from `when` (default now).
function codexRolloutRelPath(id, whenIso) {
  const d = whenIso ? new Date(whenIso) : null;
  // date parts must be supplied by caller (Date.now is fine here — plain script)
  const now = d || new Date();
  const y = String(now.getUTCFullYear());
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const da = String(now.getUTCDate()).padStart(2, "0");
  const stamp = now.toISOString().replace(/:/g, "-").replace(/\..*/, "");
  return ["sessions", y, mo, da, "rollout-" + stamp + "-" + id + ".jsonl"].join("/");
}

function sessionIndexEntry(id, name, updatedAtIso) {
  return JSON.stringify({ id, thread_name: name || "Migrated conversation", updated_at: updatedAtIso || new Date().toISOString() });
}

// claude session (jsonl) -> a codex rollout ready to drop on a codex machine.
function claudeToCodexRollout(claudeJsonl, opts) {
  opts = opts || {};
  const canon = T.claudeToCanonical(claudeJsonl);
  const cwd = opts.newCwd || canon.cwd || process.cwd();
  const out = T.canonicalToCodex(canon, { cwd, model: opts.model });
  return { id: out.sessionId, newCwd: cwd, name: opts.name || "Imported from Claude", jsonl: out.jsonl };
}

module.exports = { rewriteCodexRollout, codexRolloutRelPath, sessionIndexEntry, claudeToCodexRollout };

// ─── CLI ─────────────────────────────────────────────────────────────────────
// node migrate.js codex-rewrite <src.jsonl> <newCwd> [outdir]      (local codex->codex)
// node migrate.js claude-to-codex <src.jsonl> <newCwd> [outdir]
if (require.main === module) {
  const fs = require("fs"), os = require("os"), path = require("path");
  const [mode, src, newCwd, outdir] = process.argv.slice(2);
  if (!mode || !src) { console.error("usage: migrate.js <codex-rewrite|claude-to-codex> <src.jsonl> <newCwd> [outCodexHome]"); process.exit(1); }
  const text = fs.readFileSync(src, "utf8");
  const res = mode === "claude-to-codex" ? claudeToCodexRollout(text, { newCwd }) : rewriteCodexRollout(text, { newCwd });
  const home = outdir || path.join(os.tmpdir(), "codex-migrate-out");
  const rel = codexRolloutRelPath(res.id);
  const dest = path.join(home, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, res.jsonl);
  fs.appendFileSync(path.join(home, "session_index.jsonl"), sessionIndexEntry(res.id, res.name) + "\n");
  console.error("[migrated] id=" + res.id + " cwd=" + res.newCwd);
  console.error("[wrote] " + dest);
  console.error("[index] appended to " + path.join(home, "session_index.jsonl"));
  console.error("To land on a target machine, copy <codexHome>/sessions/** and merge session_index.jsonl into the target ~/.codex (local) or over ssh.");
}
