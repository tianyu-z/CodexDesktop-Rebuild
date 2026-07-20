"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CCDIR = path.join(os.homedir(), ".codex", "cc-bridge");
const CONFIG_FILE = path.join(CCDIR, "ensemble.json");
const HISTORY_FILE = path.join(CCDIR, "ensemble-history.json");
const MAX_HISTORY_TURNS = 8;
const MAX_CONTEXT_CHARS = 30000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function normalizeModel(value) {
  if (value && typeof value === "object") {
    const model = String(value.model || "").trim();
    const harness = value.harness === "claude" || value.harness === "claude_code" ? "claude" : "codex";
    return model ? { key: value.key || harness + ":" + model, harness, model, label: value.label || model } : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;
  const tagged = /^\[(codex|claude_code|claude)\]-(.+)$/.exec(raw);
  if (tagged) {
    const harness = tagged[1] === "codex" ? "codex" : "claude";
    return { key: harness + ":" + tagged[2], harness, model: tagged[2], label: raw };
  }
  const harness = /^(claude[-_]|opus|sonnet|haiku|fable)/i.test(raw) ? "claude" : "codex";
  return { key: harness + ":" + raw, harness, model: raw, label: raw };
}

function normalizeConfig(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const used = new Set();
  const models = (Array.isArray(raw.models) ? raw.models : []).map(normalizeModel).filter(Boolean).map((m) => {
    const baseKey = m.harness + ":" + m.model;
    let key = String(m.key || baseKey).trim() || baseKey;
    if (used.has(key)) {
      let instance = 2;
      while (used.has(baseKey + "#" + instance)) instance++;
      key = baseKey + "#" + instance;
    }
    used.add(key);
    return { ...m, key };
  });
  const leader = models.find((m) => m.key === raw.leader) || models[0] || null;
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === "debate" ? "debate" : "brainstorm",
    rounds: Math.max(1, Math.min(5, Number.parseInt(raw.rounds || 1, 10) || 1)),
    leader: leader ? leader.key : null,
    models,
  };
}

function loadConfig() { return normalizeConfig(readJson(CONFIG_FILE, {})); }

function loadBackend() {
  try {
    const raw = fs.readFileSync(path.join(CCDIR, "backend"), "utf8").trim();
    return raw.startsWith("{") ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

function clip(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(0, max) + "\n[truncated]" : text;
}

function conversationContext(threadId) {
  const all = readJson(HISTORY_FILE, {});
  const turns = Array.isArray(all[threadId]) ? all[threadId].slice(-MAX_HISTORY_TURNS) : [];
  if (!turns.length) return "";
  return clip(turns.map((t) => "User: " + t.prompt + "\nLeader: " + t.answer).join("\n\n"), MAX_CONTEXT_CHARS);
}

function saveHistory(threadId, prompt, answer) {
  if (!threadId) return;
  const all = readJson(HISTORY_FILE, {});
  const turns = Array.isArray(all[threadId]) ? all[threadId] : [];
  turns.push({ prompt: clip(prompt, 8000), answer: clip(answer, 16000), at: new Date().toISOString() });
  all[threadId] = turns.slice(-MAX_HISTORY_TURNS);
  try {
    fs.mkdirSync(CCDIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(all, null, 2));
  } catch (_) {}
}

function runProcess(command, args, options, input) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, options); } catch (e) { reject(e); return; }
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch (_) {}
      settled = true; reject(new Error("model timed out after 15 minutes"));
    }, 15 * 60 * 1000);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr = clip(stderr + d.toString("utf8"), 12000); });
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || ("process exited " + code)).trim()));
    });
    try { child.stdin.end(input || ""); } catch (_) {}
  });
}

function parseClaudeOutput(stdout) {
  const text = String(stdout || "").trim();
  try {
    const obj = JSON.parse(text);
    return String(obj.result || obj.output || obj.text || "").trim();
  } catch (_) {}
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.result || obj.output || obj.text) return String(obj.result || obj.output || obj.text).trim();
    } catch (_) {}
  }
  return text;
}

function parseCodexOutput(stdout) {
  const messages = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const item = ev.item || (ev.params && ev.params.item);
      if (item && /agent.?message/i.test(String(item.type || "")) && item.text) messages.push(String(item.text));
      else if ((ev.type === "message" || ev.type === "agent_message") && ev.text) messages.push(String(ev.text));
      else if (ev.result && typeof ev.result === "string") messages.push(ev.result);
    } catch (_) {}
  }
  return messages.join("\n").trim() || String(stdout || "").trim();
}

function sshRemoteCommandIndex(args) {
  const takesValue = new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-P", "-p", "-Q", "-R", "-S", "-W", "-w"]);
  let i = 0;
  while (i < args.length) {
    const a = String(args[i]);
    if (a === "--") { i++; break; }
    if (!a.startsWith("-")) { i++; break; }
    i += takesValue.has(a) ? 2 : 1;
  }
  return i;
}

function codexInvocation(codexCmd, codexArgs, model, cwd, canWork) {
  const execArgs = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-m", model,
    "-c", 'approval_policy="never"', "-s", canWork ? "workspace-write" : "read-only"];
  const base = path.basename(String(codexCmd || "")).toLowerCase();
  if (base === "ssh" || base === "ssh.exe") {
    const remoteIndex = sshRemoteCommandIndex(codexArgs || []);
    if (remoteIndex >= (codexArgs || []).length) throw new Error("cannot locate remote Codex command in SSH arguments");
    return { command: codexCmd, args: codexArgs.slice(0, remoteIndex + 1).concat(execArgs, ["-"]), cwd: process.cwd(), shell: false };
  }
  if (base === "codex" || base === "codex.exe") {
    if (cwd) execArgs.push("-C", cwd);
    execArgs.push("-");
    return { command: codexCmd, args: execArgs, cwd: cwd || process.cwd(), shell: false };
  }
  throw new Error("unsupported Codex launcher for ensemble: " + codexCmd);
}

function resolveClaudeCommand() {
  const candidates = [process.env.CLAUDE_CLI_PATH];
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  }
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return "claude";
}

function claudeInvocation(model, cwd, canWork) {
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--model", model];
  if (canWork) args.push("--permission-mode", "acceptEdits");
  else args.push("--tools", "");
  const backend = loadBackend();
  if (!backend.host) return { command: resolveClaudeCommand(), args, cwd: cwd || process.cwd(), shell: false, env: process.env };
  const ssh = ["-T", "-o", "StrictHostKeyChecking=accept-new"];
  if (backend.port) ssh.push("-p", String(backend.port));
  ssh.push(backend.host, backend.remoteClaude || "claude");
  return { command: "ssh", args: ssh.concat(args), cwd: process.cwd(), shell: false, env: process.env };
}

async function runModel(spec, prompt, options) {
  options = options || {};
  if (spec.harness === "claude") {
    const inv = claudeInvocation(spec.model, options.cwd, options.canWork);
    const result = await runProcess(inv.command, inv.args, { cwd: inv.cwd, env: inv.env, shell: inv.shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }, prompt);
    return parseClaudeOutput(result.stdout);
  }
  const inv = codexInvocation(options.codexCmd, options.codexArgs || [], spec.model, options.cwd, options.canWork);
  const result = await runProcess(inv.command, inv.args, { cwd: inv.cwd, env: process.env, shell: inv.shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }, prompt);
  return parseCodexOutput(result.stdout);
}

function roleHeader(spec, role) {
  return "You are " + role + " model " + spec.label + " (" + spec.harness + ").";
}

function leaderAgendaPrompt(leader, members, userPrompt, context, mode) {
  return [roleHeader(leader, "the discussion leader"),
    mode === "debate"
      ? "Frame the central dispute, state a provisional position, and identify the claims members must stress-test."
      : "Set a concise discussion agenda. Identify the distinct lenses, unknowns, and trade-offs the members should explore.",
    "Configured sub-agents:\n" + members.map((member, index) => (index + 1) + ". " + member.label + " (" + member.harness + ")").join("\n"),
    "Assign each configured sub-agent a distinct lens or question. Your agenda will govern their opening reports and every debate round.",
    "Do not modify files yet. This is the briefing for the member models; you will synthesize and do the work after they respond.",
    context ? "Prior ensemble context:\n" + context : "",
    "User request:\n" + userPrompt].filter(Boolean).join("\n\n");
}

function openingPrompt(spec, userPrompt, context, mode, agenda) {
  return [roleHeader(spec, mode === "debate" ? "a debate participant" : "a brainstorming member"),
    "Analyze independently. Be concrete, surface assumptions, risks, alternatives, and trade-offs.",
    "Do not modify files or run destructive tools; your output is advice for the leader.",
    "Leader's discussion agenda:\n" + agenda,
    context ? "Prior ensemble context:\n" + context : "",
    "User request:\n" + userPrompt].filter(Boolean).join("\n\n");
}

function critiquePrompt(spec, userPrompt, own, others, round, agenda) {
  return [roleHeader(spec, "a debate member"),
    "Debate round " + round + ". Critique the other positions fairly: say what is right, weak, missing, or risky, then provide your updated position. Do not agree merely to converge.",
    "Continue to follow the leader's agenda and your assigned lens:\n" + agenda,
    "Original request:\n" + userPrompt,
    "Your previous position:\n" + own,
    "Other positions:\n" + others].join("\n\n");
}

function leaderPrompt(config, leader, userPrompt, context, contributions) {
  const modeText = config.mode === "debate"
    ? "The members debated the proposal. Resolve the strongest objections and preserve genuine disagreements."
    : "The members brainstormed independently. Select and combine the strongest useful ideas.";
  return [roleHeader(leader, "the leader"),
    "You lead the discussion and own the final work. " + modeText,
    "Produce the final answer to the user. When the request requires code or files, inspect the workspace and do the work now; do not merely describe what should be done.",
    "Attribute a member only when attribution helps. Do not dump raw notes without synthesis.",
    context ? "Prior ensemble context:\n" + context : "",
    "User request:\n" + userPrompt,
    "Member contributions:\n" + contributions].filter(Boolean).join("\n\n");
}

function report(options, event) {
  try { if (options.onStatus && event.message) options.onStatus(event.message); } catch (_) {}
  try { if (options.onEvent) options.onEvent(event); } catch (_) {}
}

function formatEvent(event) {
  const label = (event.leader || event.member || {}).label || "agent";
  if (event.type === "status" && event.phase === "leader_agenda") return "## Ensemble discussion\n\n**Leader " + label + "** is framing the discussion...";
  if (event.type === "leader" && event.phase === "agenda") return "\n\n### Leader agenda - " + label + "\n\n" + event.text;
  if (event.type === "status" && event.phase === "members") return "\n\n_Leader dispatched " + event.members.length + " sub-agent" + (event.members.length === 1 ? "" : "s") + " in parallel._";
  if (event.type === "member" && event.phase === "opening") return "\n\n### Sub-agent " + (event.memberIndex + 1) + " - " + label + "\n\n" + event.text;
  if (event.type === "status" && event.phase === "debate") return "\n\n### Debate round " + event.round + "/" + event.rounds + "\n\n_Cross-critique is continuing under the leader's agenda._";
  if (event.type === "member" && event.phase === "debate") return "\n\n#### Sub-agent " + (event.memberIndex + 1) + " - " + label + "\n\n" + event.text;
  if (event.type === "status" && event.phase === "synthesis") return "\n\n## Leader synthesis - " + label + "\n\n_Synthesizing the discussion..._";
  if (event.type === "leader" && event.phase === "answer") return "\n\n" + event.text;
  return "";
}

async function runEnsemble(config, userPrompt, options) {
  config = normalizeConfig(config);
  options = options || {};
  const runner = options.runModel || runModel;
  if (!config.enabled) throw new Error("ensemble is disabled");
  if (config.models.length < 2) throw new Error("select at least two models");
  const leader = config.models.find((m) => m.key === config.leader);
  if (!leader) throw new Error("leader model is not selected");
  const members = config.models.filter((m) => m.key !== leader.key);
  const context = conversationContext(options.threadId);
  report(options, { type: "status", phase: "leader_agenda", leader, message: "Leader " + leader.label + " is framing the discussion..." });
  const agenda = await runner(leader, leaderAgendaPrompt(leader, members, userPrompt, context, config.mode), { ...options, canWork: false });
  report(options, { type: "leader", phase: "agenda", leader, text: agenda, message: "Leader " + leader.label + " published the discussion agenda." });
  report(options, { type: "status", phase: "members", leader, members, message: "Consulting " + members.length + " member model" + (members.length === 1 ? "" : "s") + "..." });
  const positions = { [leader.key]: agenda };
  await Promise.all(members.map(async (spec, index) => {
    try { positions[spec.key] = await runner(spec, openingPrompt(spec, userPrompt, context, config.mode, agenda), { ...options, canWork: false }); }
    catch (e) { positions[spec.key] = "[" + spec.label + " failed: " + e.message + "]"; }
    report(options, { type: "member", phase: "opening", member: spec, memberIndex: index, text: positions[spec.key], message: "Member " + spec.label + " returned an opening position." });
  }));

  if (config.mode === "debate") {
    for (let round = 1; round <= config.rounds; round++) {
      report(options, { type: "status", phase: "debate", round, rounds: config.rounds, leader, message: "Debate round " + round + "/" + config.rounds + "..." });
      const previous = { ...positions };
      await Promise.all(members.map(async (spec, index) => {
        const others = config.models.filter((m) => m.key !== spec.key).map((m) => "### " + m.label + "\n" + (previous[m.key] || "(no position)")).join("\n\n");
        try { positions[spec.key] = await runner(spec, critiquePrompt(spec, userPrompt, previous[spec.key] || "", others, round, agenda), { ...options, canWork: false }); }
        catch (e) { positions[spec.key] = previous[spec.key] || ("[" + spec.label + " failed: " + e.message + "]"); }
        report(options, { type: "member", phase: "debate", round, rounds: config.rounds, member: spec, memberIndex: index, text: positions[spec.key], message: "Member " + spec.label + " returned debate round " + round + "." });
      }));
    }
  }

  const contributions = members.map((m) => "### " + m.label + " (" + m.harness + ")\n" + (positions[m.key] || "(no response)")).join("\n\n");
  report(options, { type: "status", phase: "synthesis", leader, message: "Leader " + leader.label + " is synthesizing and working..." });
  const answer = await runner(leader, leaderPrompt(config, leader, userPrompt, context, contributions), { ...options, canWork: true });
  report(options, { type: "leader", phase: "answer", leader, text: answer, message: "Leader " + leader.label + " completed the synthesis." });
  saveHistory(options.threadId, userPrompt, answer);
  return { answer, leader, members, contributions };
}

module.exports = {
  CONFIG_FILE,
  codexInvocation,
  formatEvent,
  loadConfig,
  normalizeConfig,
  normalizeModel,
  parseCodexOutput,
  resolveClaudeCommand,
  runEnsemble,
  sshRemoteCommandIndex,
};
