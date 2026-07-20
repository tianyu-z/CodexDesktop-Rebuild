#!/usr/bin/env node
/*
 * claude-bridge.js — sits between the Codex desktop and the real codex
 * app-server. Proxies all newline-delimited JSON-RPC transparently, but
 * intercepts `turn/start` and drives Claude Code instead, synthesizing the
 * turn/item event sequence the desktop expects.
 *
 * Spawned as:  node bridge.js <realCodexCmd> <realCodexArgs...>
 *
 * MVP scope: streaming assistant text only. Tool calls / reasoning / resume
 * are Phase 2. Everything except turn execution still runs through real codex,
 * so threads/models/config/history all keep working.
 */
"use strict";
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
// __ENSEMBLE_IMPORT_V1__
const ensemble = require("./ensemble.js");

const CCDIR = path.join(os.homedir(), ".codex", "cc-bridge");
const LOG = path.join(CCDIR, "bridge.log");
function dbg(s) { try { fs.appendFileSync(LOG, "[" + new Date().toISOString() + "] " + s + "\n"); } catch (e) {} }

// Persisted map: codex threadId -> { sid: claudeSessionId, cwd }. Lets follow-up
// turns resume the same Claude Code session so context carries across turns, and
// survives bridge/app restarts (the desktop can reopen an old thread).
const SESSIONS_FILE = path.join(CCDIR, "sessions.json");
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch (e) {}
function saveSessions() { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch (e) {} }

// approvalId(int) -> { respond(allow) }. Populated when Claude asks tool
// permission; resolved when the desktop replies {id, result:{permissions,scope}}.
// High base id avoids colliding with codex's own server->client request ids.
const pendingApprovals = {};
let nextApprovalId = 900001;
function buildPermissions(name, input, cwd) {
  input = input || {};
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) {
    const fp = input.file_path || input.notebook_path || cwd;
    return { reason: (name === "Write" ? "Create/write " : "Edit ") + fp, permissions: { network: null, fileSystem: { read: null, write: [fp], entries: [{ path: { type: "path", path: fp }, access: "write" }] } } };
  }
  const cmd = name === "Bash" ? (input.command || "") : (name + " " + JSON.stringify(input).slice(0, 80));
  return { reason: "Run: " + cmd, permissions: { network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: "path", path: cwd }, access: "write" }] } } };
}

// Backend selection (feature B / remote). The `backend` file is either the
// plain string "claude" or JSON: { scaffold:"claude", model:"claude-opus-4-8",
// host:"user@host" }. model → claude --model; host → drive `ssh host claude`.
function backendConfig() {
  try {
    const raw = fs.readFileSync(path.join(CCDIR, "backend"), "utf8").trim();
    if (raw.charAt(0) === "{") return JSON.parse(raw);
    return { scaffold: /claude/i.test(raw) ? "claude" : "codex" };
  } catch (e) { return {}; }
}

// Picker models are "[harness]-[model]" (e.g. "[codex]-gpt-5.6-sol",
// "[claude_code]-claude-opus-4-8"). Parse → { harness, model }. Unprefixed
// defaults to codex so nothing breaks if the list isn't the prefixed one.
function parseModel(model) {
  if (!model || typeof model !== "string") return null;
  const mm = /^\[(codex|claude_code|claude)\]-(.+)$/.exec(model);
  if (mm) return { harness: mm[1] === "codex" ? "codex" : "claude", model: mm[2] };
  // Detect harness from the model name — Claude models vs codex (gpt-*).
  if (/^(claude[-_]|opus|sonnet|haiku)/i.test(model)) return { harness: "claude", model: model };
  return { harness: "codex", model: model };
}
// A valid codex model to hand real codex when a thread is actually driven by
// Claude — codex still owns the thread record, so thread/start must not choke.
let _codexDefault = null;
function codexDefaultModel() {
  if (_codexDefault) return _codexDefault;
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    _codexDefault = (cfg.match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || "gpt-5.1";
  } catch (e) { _codexDefault = "gpt-5.1"; }
  return _codexDefault;
}
const pendingRoute = {};   // thread/start request id -> route (threadId not known yet)
const threadRoute = {};    // threadId -> { harness, model }

const codexCmd = process.argv[2];
const codexArgs = process.argv.slice(3);
dbg("start; codex=" + codexCmd + " args=" + JSON.stringify(codexArgs));

const codex = spawn(codexCmd, codexArgs, { stdio: ["pipe", "pipe", "inherit"] });
codex.on("exit", (c) => { dbg("codex exit " + c); process.exit(c || 0); });
codex.on("error", (e) => { dbg("codex error " + e.message); process.exit(1); });

function sendDesktop(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function sendCodex(line) { try { codex.stdin.write(line + "\n"); } catch (e) {} }

// ── desktop -> bridge (intercept turn/start, else forward) ──
let inBuf = "";
process.stdin.on("data", (chunk) => {
  inBuf += chunk.toString("utf8");
  let i;
  while ((i = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1);
    fromDesktop(line);
  }
});
process.stdin.on("end", () => { try { codex.stdin.end(); } catch (e) {} });

// ── codex -> desktop (passthrough + track thread cwd) ──
const threadCwd = {};
let outBuf = "";
codex.stdout.on("data", (chunk) => {
  process.stdout.write(chunk); // raw passthrough
  outBuf += chunk.toString("utf8");
  let i;
  while ((i = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
    const t = line.trim(); if (!t) continue;
    let m; try { m = JSON.parse(t); } catch (e) { continue; }
    if (m.id !== undefined && m.result && m.result.thread && m.result.thread.id) {
      const tid = m.result.thread.id;
      threadCwd[tid] = m.result.thread.cwd;
      if (pendingRoute[m.id]) { threadRoute[tid] = pendingRoute[m.id]; dbg("thread " + tid + " -> " + threadRoute[tid].harness + ":" + threadRoute[tid].model); delete pendingRoute[m.id]; }
    }
  }
});

function fromDesktop(line) {
  const t = line.trim();
  if (!t) { sendCodex(line); return; }
  let m; try { m = JSON.parse(t); } catch (e) { sendCodex(line); return; }
  // Desktop's JSON-RPC response to one of our permission requests.
  // Allow → result.permissions has real grants (e.g. fileSystem.entries).
  // Deny  → result.permissions is an empty object {} (scope is "turn" for both).
  if (m.id !== undefined && m.method === undefined && pendingApprovals[m.id]) {
    const r = m.result || {};
    const perm = r.permissions;
    const allow = (perm && typeof perm === "object" && Object.keys(perm).length > 0) || /accept|approve|allow/i.test(String(r.decision || ""));
    dbg("approval reply " + m.id + " allow=" + allow);
    pendingApprovals[m.id].respond(allow);
    return;   // handled by bridge, not codex
  }
  // Legacy reply-method path (some desktop builds/transports).
  if (m.method === "reply-with-command-execution-approval-decision" || m.method === "reply-with-file-change-approval-decision") {
    const pp = m.params || {};
    if (m.id !== undefined) sendDesktop({ id: m.id, result: {} });
    const pa = pendingApprovals[pp.requestId];
    if (pa) pa.respond(/approve|accept/i.test(String(pp.decision || "")));
    return;
  }
  if (m.method === "thread/start") {
    // Only an EXPLICITLY prefixed "[harness]-[model]" model pins this thread's
    // harness. The app's own power-slider sends unprefixed codex models, so for
    // those we don't pin — the backend file (⟳ Models dropdown) governs, which
    // is what makes runtime harness switching work.
    const model = m.params && m.params.model;
    const route = parseModel(model);
    if (route && m.id !== undefined) {
      pendingRoute[m.id] = route;
      // Claude threads: codex still owns the thread record, so give it a model it accepts.
      if (route.harness === "claude") m.params.model = codexDefaultModel();
      dbg("thread/start route=" + route.harness + ":" + route.model);
      sendCodex(JSON.stringify(m));
      return;
    }
    sendCodex(line); return;
  }
  if (m.method === "turn/start") {
    const text = (m.params && m.params.input || []).filter(x => x && x.type === "text").map(x => x.text).join("");
    if (/provide a short title|concise UI title/i.test(text)) { sendCodex(line); return; }
    // __ENSEMBLE_TURN_HOOK_V1_START__
    const ensembleConfig = ensemble.loadConfig();
    if (ensembleConfig.enabled) { interceptEnsemble(m, ensembleConfig); return; }
    // __ENSEMBLE_TURN_HOOK_V1_END__
    const route = threadRoute[m.params && m.params.threadId];
    const harness = route ? route.harness : (backendConfig().scaffold === "claude" ? "claude" : "codex");
    if (harness === "codex") { sendCodex(line); return; }   // codex thread → real codex runs the turn
    dbg("intercept turn/start thread=" + (m.params && m.params.threadId) + " model=" + (route ? route.model : "(default)") + " text=" + JSON.stringify(text.slice(0, 60)));
    interceptTurn(m, route);
  } else {
    sendCodex(line);
  }
}

const uuid = () => crypto.randomUUID();
const msgId = () => "msg_" + crypto.randomBytes(24).toString("hex");
const nowMs = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);

// __ENSEMBLE_HANDLER_V1_START__
function interceptEnsemble(req, config) {
  const p = req.params || {};
  const threadId = p.threadId;
  const cwd = p.cwd || threadCwd[threadId] || process.cwd();
  const text = (p.input || []).filter(x => x && x.type === "text").map(x => x.text).join("");
  const turnId = uuid(), itemId = msgId(), startedAt = nowSec();
  sendDesktop({ id: req.id, result: { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } });
  sendDesktop({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt, completedAt: null, durationMs: null } } });
  sendDesktop({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: [] } } });
  sendDesktop({ method: "item/started", params: { item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null }, threadId, turnId, startedAtMs: nowMs() } });
  let fullOutput = "";
  function emit(delta) {
    if (!delta) return;
    fullOutput += delta;
    sendDesktop({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta } });
  }
  ensemble.runEnsemble(config, text, {
    threadId, cwd, codexCmd, codexArgs,
    onStatus: (status) => dbg("ensemble " + threadId + ": " + status),
    onEvent: (event) => emit(ensemble.formatEvent(event)),
  }).then(() => finish(null)).catch((error) => finish(error));

  function finish(error) {
    if (error) emit("\n\n[ensemble error: " + error.message + "]");
    sendDesktop({ method: "item/completed", params: { item: { type: "agentMessage", id: itemId, text: fullOutput, phase: "final_answer", memoryCitation: null }, threadId, turnId, completedAtMs: nowMs() } });
    const completedAt = nowSec();
    sendDesktop({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: error ? "failed" : "completed", error: error ? { message: error.message } : null, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } } });
    sendDesktop({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
    dbg("ensemble turn " + (error ? "failed: " + error.message : "completed"));
  }
}
// __ENSEMBLE_HANDLER_V1_END__

function interceptTurn(req, route) {
  const p = req.params || {};
  const threadId = p.threadId;
  const cwd = p.cwd || threadCwd[threadId] || process.cwd();
  const text = (p.input || []).filter(x => x && x.type === "text").map(x => x.text).join("");
  const turnId = uuid();
  const itemId = msgId();
  const startedAt = nowSec();

  // 1. turn/start response
  sendDesktop({ id: req.id, result: { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } });
  // 2. turn/started + thread active
  sendDesktop({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt, completedAt: null, durationMs: null } } });
  sendDesktop({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: [] } } });
  // 3. drive Claude Code, mapping its stream to codex items:
  //    text content blocks -> agentMessage items; Bash -> commandExecution;
  //    Write/Edit/... -> fileChange; every other tool -> a generic command item.
  let full = "";
  let curText = null;            // { id, text } current agentMessage item
  const blockTypes = {};         // content-block index -> type (reset per message)
  const pendingTools = {};       // tool_use_id -> { item, kind }

  function textStart() {
    if (curText) return;
    const id = msgId();
    curText = { id, text: "" };
    sendDesktop({ method: "item/started", params: { item: { type: "agentMessage", id, text: "", phase: "final_answer", memoryCitation: null }, threadId, turnId, startedAtMs: nowMs() } });
  }
  function textDelta(delta) {
    if (!delta) return;
    textStart();
    curText.text += delta; full += delta;
    sendDesktop({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: curText.id, delta } });
  }
  function textStop() {
    if (!curText) return;
    sendDesktop({ method: "item/completed", params: { item: { type: "agentMessage", id: curText.id, text: curText.text, phase: "final_answer", memoryCitation: null }, threadId, turnId, completedAtMs: nowMs() } });
    curText = null;
  }
  function summarize(input) { try { const s = JSON.stringify(input); return s.length > 100 ? s.slice(0, 100) + "…" : s; } catch (e) { return ""; } }
  function fileChanges(name, input) {
    if (name === "Write") return [{ path: input.file_path, kind: { type: "add" }, diff: input.content || "" }];
    if (name === "Edit") return [{ path: input.file_path, kind: { type: "modify" }, diff: (input.old_string || "") + "\n=>\n" + (input.new_string || "") }];
    if (name === "MultiEdit") return (input.edits || []).map(e => ({ path: input.file_path, kind: { type: "modify" }, diff: (e.old_string || "") + "\n=>\n" + (e.new_string || "") }));
    if (name === "NotebookEdit") return [{ path: input.notebook_path, kind: { type: "modify" }, diff: input.new_source || "" }];
    return [{ path: input.file_path || "?", kind: { type: "modify" }, diff: "" }];
  }
  function startTool(toolUseId, name, input) {
    if (pendingTools[toolUseId]) return;   // dedupe (approval control_request + assistant block)
    textStop();
    const id = "exec-" + uuid();
    input = input || {};
    let item, kind;
    if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
      kind = "fileChange";
      item = { type: "fileChange", id, changes: fileChanges(name, input), status: "inProgress" };
    } else {
      kind = "commandExecution";
      const command = name === "Bash" ? (input.command || "") : (name + "(" + summarize(input) + ")");
      item = { type: "commandExecution", id, command, cwd, processId: "0", source: "unifiedExecStartup", status: "inProgress", commandActions: [{ type: "unknown", command }], aggregatedOutput: null, exitCode: null, durationMs: null };
    }
    sendDesktop({ method: "item/started", params: { item, threadId, turnId, startedAtMs: nowMs() } });
    pendingTools[toolUseId] = { item, kind };
    dbg("tool " + name + " -> " + kind);
  }
  function denyTool(toolUseId) {
    const pt = pendingTools[toolUseId]; if (!pt) return;
    const it = pt.kind === "commandExecution"
      ? Object.assign({}, pt.item, { status: "completed", aggregatedOutput: "[denied by user]", exitCode: 1, durationMs: 0 })
      : Object.assign({}, pt.item, { status: "completed" });
    sendDesktop({ method: "item/completed", params: { item: it, threadId, turnId, completedAtMs: nowMs() } });
    delete pendingTools[toolUseId];
  }
  function completeTool(toolUseId, content, isError) {
    const pt = pendingTools[toolUseId]; if (!pt) return;
    const out = typeof content === "string" ? content : JSON.stringify(content);
    let it;
    if (pt.kind === "commandExecution") it = Object.assign({}, pt.item, { status: "completed", aggregatedOutput: out, exitCode: isError ? 1 : 0, durationMs: 0 });
    else it = Object.assign({}, pt.item, { status: "completed" });
    sendDesktop({ method: "item/completed", params: { item: it, threadId, turnId, completedAtMs: nowMs() } });
    delete pendingTools[toolUseId];
  }

  const prior = sessions[threadId];
  const approvalsOn = fs.existsSync(path.join(CCDIR, "approvals"));
  const bcfg = backendConfig();
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  if (approvalsOn) args.push("--input-format", "stream-json", "--permission-prompt-tool", "stdio");   // route tool permissions to us via can_use_tool control_request
  else args.push("--dangerously-skip-permissions");
  // Resume only for local claude — remote sessions live on the remote host.
  if (prior && prior.sid && !bcfg.host) args.push("--resume", prior.sid);
  const claudeModel = (route && route.model) || bcfg.model;   // per-thread picker model, else global
  if (claudeModel) args.push("--model", claudeModel);
  // Local vs remote (reuse SSH): host set → run claude on the remote box.
  let spawnCmd = "claude", spawnArgs = args, useShell = process.platform === "win32", spawnEnv = process.env;
  if (bcfg.host) {
    spawnCmd = "ssh"; useShell = false;
    const sshOpts = ["-T", "-o", "StrictHostKeyChecking=accept-new"];
    if (bcfg.port) sshOpts.push("-p", String(bcfg.port));
    if (bcfg.password) {   // password auth via askpass helper (node echoes CC_SSH_PW)
      var askDir = path.join(CCDIR, "askpass"); try { fs.mkdirSync(askDir, { recursive: true }); } catch (e) {}
      var isWin = process.platform === "win32";
      var askPath = path.join(askDir, isWin ? "askpass.cmd" : "askpass.sh");
      if (isWin) fs.writeFileSync(askPath, "@node -e \"process.stdout.write(process.env.CC_SSH_PW||'')\"\r\n");
      else { fs.writeFileSync(askPath, "#!/bin/sh\nnode -e \"process.stdout.write(process.env.CC_SSH_PW||'')\"\n"); try { fs.chmodSync(askPath, 0o700); } catch (e) {} }
      sshOpts.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no");
      spawnEnv = Object.assign({}, process.env, { SSH_ASKPASS: askPath, SSH_ASKPASS_REQUIRE: "force", CC_SSH_PW: String(bcfg.password), DISPLAY: process.env.DISPLAY || "localhost:0" });
    }
    var remoteClaude = bcfg.remoteClaude || "claude";
    // Remote Claude account auth: a setup-token (CLAUDE_CODE_OAUTH_TOKEN) or an
    // API key (ANTHROPIC_API_KEY), injected as an inline env on the remote command.
    var remotePrefix = [];
    if (bcfg.token) remotePrefix.push((/^sk-ant-api/.test(bcfg.token) ? "ANTHROPIC_API_KEY=" : "CLAUDE_CODE_OAUTH_TOKEN=") + bcfg.token);
    spawnArgs = sshOpts.concat([bcfg.host]).concat(remotePrefix).concat([remoteClaude]).concat(args);
  }
  dbg("spawn " + spawnCmd + (bcfg.host ? " " + bcfg.host + (bcfg.password ? " [pw]" : "") : "") + (claudeModel ? " --model " + claudeModel : "") + (approvalsOn ? " [approvals]" : "") + (prior && prior.sid && !bcfg.host ? " --resume" : " (fresh)") + " cwd=" + cwd);
  let cj;
  try {
    cj = spawn(spawnCmd, spawnArgs, { cwd, stdio: ["pipe", "pipe", "inherit"], shell: useShell, env: spawnEnv });
  } catch (e) { return finishError(e.message); }
  if (approvalsOn) {
    // SDK control handshake FIRST — without the initialize control_request the CLI
    // auto-allows every tool (no can_use_tool prompts). After init, Claude routes
    // each tool permission to us as a can_use_tool control_request.
    try { cj.stdin.write(JSON.stringify({ type: "control_request", request_id: "cc-init", request: { subtype: "initialize", hooks: null } }) + "\n"); } catch (e) {}
    // Then the prompt as a user message (small delay so init is processed first). Keep stdin OPEN for control_response.
    setTimeout(() => { try { cj.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"); } catch (e) {} }, 350);
  } else {
    try { cj.stdin.write(text); cj.stdin.end(); } catch (e) {}
  }
  function sendControl(reqId, allow, updatedInput) {
    try { cj.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: reqId, response: allow ? { behavior: "allow", updatedInput: updatedInput || {} } : { behavior: "deny", message: "Denied by user" } } }) + "\n"); } catch (e) {}
  }

  let cbuf = "";
  cj.stdout.on("data", (d) => {
    cbuf += d.toString("utf8");
    let i;
    while ((i = cbuf.indexOf("\n")) >= 0) {
      const ln = cbuf.slice(0, i); cbuf = cbuf.slice(i + 1);
      const s = ln.trim(); if (!s) continue;
      let ev; try { ev = JSON.parse(s); } catch (e) { continue; }
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id) { sessions[threadId] = { sid: ev.session_id, cwd }; saveSessions(); }
      else if (ev.type === "control_request" && ev.request && ev.request.subtype === "can_use_tool") {
        // Claude asks permission BEFORE running the tool. Show a native approval.
        const r = ev.request, tuid = r.tool_use_id;
        startTool(tuid, r.tool_name, r.input || {});
        const requestId = uuid();
        const isFile = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(r.tool_name);
        let settled = false;
        const apprId = nextApprovalId++;
        const resolveOnce = (allow) => { if (settled) return; settled = true; delete pendingApprovals[apprId]; sendControl(ev.request_id, allow, r.input); if (!allow) denyTool(tuid); };
        pendingApprovals[apprId] = { respond: resolveOnce };
        // Native permission prompt: item/permissions/requestApproval (int id). The
        // desktop shows Deny / Allow and replies {id, result:{permissions,scope}}.
        const it = pendingTools[tuid] && pendingTools[tuid].item;
        const bp = buildPermissions(r.tool_name, r.input, cwd);
        sendDesktop({ id: apprId, method: "item/permissions/requestApproval", params: { threadId, turnId, itemId: it && it.id, environmentId: "local", startedAtMs: nowMs(), cwd, reason: bp.reason, permissions: bp.permissions } });
        dbg("approval req " + apprId + " " + r.tool_name);
        // Safety: never hang the turn if the desktop can't surface the prompt.
        setTimeout(() => { if (!settled) { dbg("approval " + apprId + " auto-allow (timeout)"); resolveOnce(true); } }, 45000);
      }
      else if (ev.type === "stream_event" && ev.event) {
        const e = ev.event;
        if (e.type === "message_start") { for (const k in blockTypes) delete blockTypes[k]; }
        else if (e.type === "content_block_start") { blockTypes[e.index] = e.content_block && e.content_block.type; }
        else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") textDelta(e.delta.text || "");
        else if (e.type === "content_block_stop") { if (blockTypes[e.index] === "text") textStop(); }
      } else if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) if (b.type === "tool_use") startTool(b.id, b.name, b.input || {});
      } else if (ev.type === "user" && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) if (b.type === "tool_result") completeTool(b.tool_use_id, b.content, b.is_error);
      } else if (ev.type === "result") {
        if (approvalsOn) { try { cj.stdin.end(); } catch (e) {} }
      }
    }
  });
  cj.on("exit", () => finishOk());
  cj.on("error", (e) => finishError(e.message));

  function finishTurn() {
    textStop();
    const completedAt = nowSec();
    sendDesktop({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } } });
    sendDesktop({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
  }
  function finishOk() { finishTurn(); dbg("turn done, chars=" + full.length); }
  function finishError(msg) { textDelta("\n\n[claude-bridge error: " + msg + "]"); finishTurn(); dbg("turn error: " + msg); }
}
