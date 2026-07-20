"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const E = require("./ensemble");

test("normalizes selected agent instances and leader", () => {
  const c = E.normalizeConfig({ enabled: true, mode: "debate", rounds: 9, leader: "claude:claude-opus-4-8", models: [
    "[codex]-gpt-5.4", "[claude_code]-claude-opus-4-8", "[codex]-gpt-5.4",
  ] });
  assert.equal(c.enabled, true);
  assert.equal(c.mode, "debate");
  assert.equal(c.rounds, 5);
  assert.equal(c.models.length, 3);
  assert.deepEqual(c.models.map((m) => m.key), ["codex:gpt-5.4", "claude:claude-opus-4-8", "codex:gpt-5.4#2"]);
  assert.equal(c.leader, "claude:claude-opus-4-8");
});

test("runs duplicate sub-agent models as separate members", async () => {
  const calls = [];
  const config = { enabled: true, leader: "leader:codex:gpt-5.5", models: [
    { key: "leader:codex:gpt-5.5", harness: "codex", model: "gpt-5.5" },
    { key: "sub:1:codex:gpt-5.5", harness: "codex", model: "gpt-5.5" },
    { key: "sub:2:codex:gpt-5.5", harness: "codex", model: "gpt-5.5" },
    { key: "sub:3:claude:opus-4-6", harness: "claude", model: "opus-4-6" },
  ] };
  const result = await E.runEnsemble(config, "compare approaches", {
    runModel: async (spec, prompt, opts) => {
      calls.push({ key: spec.key, canWork: opts.canWork });
      return spec.key + " response";
    },
  });
  assert.equal(result.members.length, 3);
  assert.deepEqual(result.members.map((m) => m.model), ["gpt-5.5", "gpt-5.5", "opus-4-6"]);
  assert.deepEqual(calls.filter((c) => !c.canWork).map((c) => c.key), [
    "leader:codex:gpt-5.5",
    "sub:1:codex:gpt-5.5",
    "sub:2:codex:gpt-5.5",
    "sub:3:claude:opus-4-6",
  ]);
});

test("reports leader-led discussion events as work completes", async () => {
  const events = [];
  const config = { enabled: true, leader: "codex:leader", models: [
    { key: "codex:leader", harness: "codex", model: "leader", label: "Leader" },
    { key: "claude:member", harness: "claude", model: "member", label: "Member" },
  ] };
  await E.runEnsemble(config, "compare frameworks", {
    runModel: async (spec, prompt, opts) => spec.model + (opts.canWork ? " final" : " report"),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => event.type + ":" + event.phase), [
    "status:leader_agenda",
    "leader:agenda",
    "status:members",
    "member:opening",
    "status:synthesis",
    "leader:answer",
  ]);
  assert.equal(events[1].text, "leader report");
  assert.equal(events[3].text, "member report");
  assert.equal(events[5].text, "leader final");
});

test("reports visible leader status before the first model returns", async () => {
  const events = [];
  let releaseAgenda;
  let call = 0;
  const pending = E.runEnsemble({ enabled: true, leader: "codex:leader", models: [
    { key: "codex:leader", harness: "codex", model: "leader", label: "Leader" },
    { key: "codex:member", harness: "codex", model: "member", label: "Member" },
  ] }, "question", {
    runModel: async () => {
      call++;
      if (call === 1) return new Promise((resolve) => { releaseAgenda = resolve; });
      return "done";
    },
    onEvent: (event) => events.push(event),
  });
  assert.equal(events[0].phase, "leader_agenda");
  assert.match(E.formatEvent(events[0]), /Leader Leader.*framing/);
  releaseAgenda("agenda");
  await pending;
});

test("formats discussion events as incremental visible output", () => {
  const leader = { label: "[codex]-gpt-5.5" };
  const member = { label: "[claude_code]-sonnet-4-6" };
  assert.match(E.formatEvent({ type: "status", phase: "leader_agenda", leader }), /Ensemble discussion/);
  assert.match(E.formatEvent({ type: "leader", phase: "agenda", leader, text: "Compare runtime and throughput." }), /Compare runtime and throughput/);
  assert.match(E.formatEvent({ type: "status", phase: "members", members: [member] }), /dispatched 1 sub-agent/);
  assert.match(E.formatEvent({ type: "member", phase: "opening", member, memberIndex: 0, text: "SGLang view" }), /SGLang view/);
  assert.match(E.formatEvent({ type: "status", phase: "debate", leader, round: 2, rounds: 3 }), /Debate round 2\/3/);
  assert.match(E.formatEvent({ type: "status", phase: "synthesis", leader }), /Leader synthesis/);
  assert.equal(E.formatEvent({ type: "leader", phase: "answer", leader, text: "Use vLLM." }), "\n\nUse vLLM.");
});

test("builds a local Codex exec command without app-server", () => {
  const inv = E.codexInvocation("C:\\Codex\\codex.exe", ["-c", "features.code_mode_host=true", "app-server"], "gpt-5.4", "C:\\repo", false);
  assert.equal(inv.command, "C:\\Codex\\codex.exe");
  assert.deepEqual(inv.args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
  assert.ok(inv.args.includes("read-only"));
  assert.ok(!inv.args.includes("app-server"));
});

test("replaces a remote SSH app-server command with codex exec", () => {
  const inv = E.codexInvocation("ssh", ["-T", "-o", "StrictHostKeyChecking=accept-new", "user@host", "codex", "-c", "features.code_mode_host=true", "app-server"], "gpt-5.4", "/repo", true);
  assert.equal(inv.command, "ssh");
  assert.deepEqual(inv.args.slice(0, 5), ["-T", "-o", "StrictHostKeyChecking=accept-new", "user@host", "codex"]);
  assert.equal(inv.args[5], "exec");
  assert.ok(inv.args.includes("workspace-write"));
  assert.ok(!inv.args.includes("app-server"));
});

test("extracts Codex agent messages from JSONL", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "x" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
  ].join("\n");
  assert.equal(E.parseCodexOutput(output), "final answer");
});

test("resolves Claude to a native executable on Windows", () => {
  const command = E.resolveClaudeCommand();
  if (process.platform === "win32") assert.match(command, /claude\.exe$/i);
});

test("brainstorm is framed by the leader and grants work only to the leader", async () => {
  const calls = [];
  const config = { enabled: true, mode: "brainstorm", leader: "codex:leader", models: [
    { harness: "codex", model: "leader" },
    { harness: "claude", model: "member-a" },
    { harness: "codex", model: "member-b" },
  ] };
  const result = await E.runEnsemble(config, "build it", {
    runModel: async (spec, prompt, opts) => { calls.push({ spec, prompt, canWork: opts.canWork }); return "answer from " + spec.model; },
  });
  assert.equal(calls.length, 4); // leader agenda + 2 members + leader final
  assert.deepEqual(calls.filter((c) => c.canWork).map((c) => c.spec.model), ["leader"]);
  assert.match(result.answer, /leader/);
  assert.match(calls[3].prompt, /Member contributions/);
  assert.match(calls[0].prompt, /Configured sub-agents/);
  assert.match(calls[0].prompt, /member-a/);
  assert.match(calls[1].prompt, /Leader's discussion agenda/);
});

test("debate runs cross-critique rounds before leader synthesis", async () => {
  const calls = [];
  const config = { enabled: true, mode: "debate", rounds: 2, leader: "codex:leader", models: [
    { harness: "codex", model: "leader" },
    { harness: "claude", model: "member-a" },
    { harness: "codex", model: "member-b" },
  ] };
  await E.runEnsemble(config, "choose an architecture", {
    runModel: async (spec, prompt, opts) => { calls.push({ spec, prompt, canWork: opts.canWork }); return spec.model + " view " + calls.length; },
  });
  assert.equal(calls.length, 8); // 3 openings + (2 members x 2 rounds) + 1 leader
  assert.equal(calls.filter((c) => /Debate round/.test(c.prompt)).length, 4);
  assert.equal(calls.filter((c) => /Continue to follow the leader's agenda/.test(c.prompt)).length, 4);
  assert.deepEqual(calls.filter((c) => c.canWork).map((c) => c.spec.model), ["leader"]);
});
