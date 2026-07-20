#!/usr/bin/env node
/*
 * translate.js — conversation format translator, the shared basis for
 * B.2 (cross-scaffold switching) and C (cross-machine migration).
 *
 * Canonical representation (scaffold/machine-neutral):
 *   { cwd, sessionId, items: [ Item, ... ] }
 *   Item = { kind:"message", role:"user"|"assistant"|"developer", text }
 *        | { kind:"reasoning", text }
 *        | { kind:"tool_call", name, input, output, callId }
 *
 * Readers/writers:
 *   codexToCanonical / canonicalToCodex   — codex rollout-*.jsonl under ~/.codex/sessions
 *   claudeToCanonical / canonicalToClaude — claude <sid>.jsonl under ~/.claude/projects
 *
 * Only conversation content is translated (messages, reasoning, tool calls +
 * their outputs). Host/machine metadata (file-history snapshots, attribution,
 * signatures, encrypted reasoning) is intentionally dropped — that is what
 * makes a transcript portable across scaffold and machine.
 */
"use strict";
const crypto = require("crypto");

const uuid = () => crypto.randomUUID();
const parseLines = (text) => String(text).split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

// ─── codex rollout → canonical ───────────────────────────────────────────────
function codexToCanonical(text) {
  const rows = parseLines(text);
  const out = { cwd: null, sessionId: null, items: [] };
  const callName = {};   // call_id -> tool name (to pair outputs)
  for (const row of rows) {
    if (row.type === "session_meta") {
      out.sessionId = row.payload && (row.payload.session_id || row.payload.id);
      out.cwd = row.payload && row.payload.cwd;
      continue;
    }
    if (row.type !== "response_item" || !row.payload) continue;
    const p = row.payload;
    switch (p.type) {
      case "message": {
        const text = (p.content || []).map((c) => c.text || "").join("");
        if (text) out.items.push({ kind: "message", role: p.role || "user", text });
        break;
      }
      case "reasoning": {
        const t = (p.summary || []).map((s) => s.text || "").join("") || (typeof p.content === "string" ? p.content : "");
        if (t) out.items.push({ kind: "reasoning", text: t });
        break;
      }
      case "function_call":
        callName[p.call_id] = p.name;
        out.items.push({ kind: "tool_call", name: p.name, input: safeJson(p.arguments), output: null, callId: p.call_id });
        break;
      case "custom_tool_call":
        callName[p.call_id] = p.name;
        out.items.push({ kind: "tool_call", name: p.name, input: p.input, output: null, callId: p.call_id });
        break;
      case "function_call_output":
      case "custom_tool_call_output": {
        const tc = out.items.find((i) => i.kind === "tool_call" && i.callId === p.call_id && i.output == null);
        if (tc) tc.output = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
        break;
      }
    }
  }
  return out;
}

// ─── canonical → codex rollout ───────────────────────────────────────────────
function canonicalToCodex(c, opts) {
  opts = opts || {};
  const sid = opts.sessionId || c.sessionId || uuid();
  const cwd = opts.cwd || c.cwd || process.cwd();
  const ts = () => new Date().toISOString();   // caller may re-stamp
  const rows = [];
  rows.push({ timestamp: ts(), type: "session_meta", payload: { session_id: sid, id: sid, timestamp: ts(), cwd, originator: "cc-bridge-migrate", cli_version: "0.0.0" } });
  rows.push({ timestamp: ts(), type: "turn_context", payload: { cwd, workspace_roots: [cwd], approval_policy: "never", sandbox_policy: { mode: "danger-full-access" }, model: opts.model || "gpt-5.6-sol" } });
  for (const it of c.items) {
    if (it.kind === "message") {
      const ct = it.role === "assistant" ? "output_text" : "input_text";
      rows.push({ timestamp: ts(), type: "response_item", payload: { type: "message", role: it.role, content: [{ type: ct, text: it.text }] } });
    } else if (it.kind === "reasoning") {
      rows.push({ timestamp: ts(), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: it.text }], content: null } });
    } else if (it.kind === "tool_call") {
      const cid = it.callId || ("call_" + crypto.randomBytes(12).toString("hex"));
      rows.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: it.name, arguments: typeof it.input === "string" ? it.input : JSON.stringify(it.input || {}), call_id: cid } });
      if (it.output != null) rows.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call_output", call_id: cid, output: String(it.output) } });
    }
  }
  return { sessionId: sid, jsonl: rows.map((r) => JSON.stringify(r)).join("\n") + "\n" };
}

// ─── claude jsonl → canonical ────────────────────────────────────────────────
function claudeToCanonical(text) {
  const rows = parseLines(text);
  // Build uuid -> row for transcript messages; walk from the latest leaf via parentUuid.
  const byUuid = {};
  let sessionId = null, cwd = null;
  for (const r of rows) {
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    if (r.cwd && !cwd) cwd = r.cwd;
    if ((r.type === "user" || r.type === "assistant") && r.uuid) byUuid[r.uuid] = r;
  }
  // latest leaf = a transcript message that is nobody's parent, pick the last in file order
  const parents = new Set(Object.values(byUuid).map((r) => r.parentUuid).filter(Boolean));
  const leaves = Object.values(byUuid).filter((r) => !parents.has(r.uuid));
  let leaf = leaves.length ? leaves[leaves.length - 1] : Object.values(byUuid).pop();
  // walk parent chain, collect, then reverse to chronological
  const chain = [];
  let cur = leaf, guard = 0;
  while (cur && guard++ < 100000) { chain.push(cur); cur = cur.parentUuid ? byUuid[cur.parentUuid] : null; }
  chain.reverse();
  const out = { cwd, sessionId, items: [] };
  const pendingCall = {};   // tool_use_id -> tool_call item awaiting result
  for (const r of chain) {
    const msg = r.message || {};
    const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : []);
    for (const b of content) {
      if (b.type === "text" && b.text) out.items.push({ kind: "message", role: r.type === "assistant" ? "assistant" : "user", text: b.text });
      else if (b.type === "thinking" && b.thinking) out.items.push({ kind: "reasoning", text: b.thinking });
      else if (b.type === "tool_use") { const item = { kind: "tool_call", name: b.name, input: b.input, output: null, callId: b.id }; pendingCall[b.id] = item; out.items.push(item); }
      else if (b.type === "tool_result") { const tc = pendingCall[b.tool_use_id]; if (tc) tc.output = typeof b.content === "string" ? b.content : JSON.stringify(b.content); }
    }
  }
  return out;
}

// ─── canonical → claude jsonl ────────────────────────────────────────────────
function canonicalToClaude(c, opts) {
  opts = opts || {};
  const sid = opts.sessionId || c.sessionId || uuid();
  const cwd = opts.cwd || c.cwd || process.cwd();
  const rows = [];
  let parent = null;
  const push = (type, message) => { const u = uuid(); rows.push({ parentUuid: parent, isSidechain: false, type, message, uuid: u, timestamp: new Date().toISOString(), sessionId: sid, cwd, version: "0.0.0" }); parent = u; };
  // Group consecutive assistant content (text/reasoning/tool_call) into assistant messages;
  // user text into user messages; tool outputs into a following user tool_result message.
  for (const it of c.items) {
    if (it.kind === "message" && it.role !== "assistant") {
      push("user", { role: "user", content: [{ type: "text", text: it.text }] });
    } else if (it.kind === "message") {
      push("assistant", { role: "assistant", model: opts.model || "claude-opus-4-8", content: [{ type: "text", text: it.text }] });
    } else if (it.kind === "reasoning") {
      push("assistant", { role: "assistant", model: opts.model || "claude-opus-4-8", content: [{ type: "thinking", thinking: it.text, signature: "" }] });
    } else if (it.kind === "tool_call") {
      const cid = it.callId || ("toolu_" + crypto.randomBytes(12).toString("hex"));
      push("assistant", { role: "assistant", model: opts.model || "claude-opus-4-8", content: [{ type: "tool_use", id: cid, name: it.name, input: it.input || {} }] });
      if (it.output != null) push("user", { role: "user", content: [{ type: "tool_result", tool_use_id: cid, content: String(it.output) }] });
    }
  }
  return { sessionId: sid, jsonl: rows.map((r) => JSON.stringify(r)).join("\n") + "\n" };
}

function safeJson(s) { if (typeof s !== "string") return s; try { return JSON.parse(s); } catch (e) { return s; } }

module.exports = { codexToCanonical, canonicalToCodex, claudeToCanonical, canonicalToClaude };

// ─── CLI: node translate.js <codex|claude> <codex|claude> <in.jsonl> <out.jsonl> ──
if (require.main === module) {
  const [from, to, infile, outfile] = process.argv.slice(2);
  if (!from || !to || !infile) { console.error("usage: translate.js <codex|claude> <codex|claude> <in.jsonl> [out.jsonl]"); process.exit(1); }
  const fs = require("fs");
  const text = fs.readFileSync(infile, "utf8");
  const canon = from === "codex" ? codexToCanonical(text) : claudeToCanonical(text);
  const msgs = canon.items.filter((i) => i.kind === "message").length;
  const tools = canon.items.filter((i) => i.kind === "tool_call").length;
  console.error(`[canonical] ${canon.items.length} items (${msgs} messages, ${tools} tool calls), cwd=${canon.cwd}`);
  const res = to === "codex" ? canonicalToCodex(canon) : canonicalToClaude(canon);
  if (outfile) { fs.writeFileSync(outfile, res.jsonl); console.error(`[${to}] wrote ${outfile} (session ${res.sessionId})`); }
  else process.stdout.write(res.jsonl);
}
