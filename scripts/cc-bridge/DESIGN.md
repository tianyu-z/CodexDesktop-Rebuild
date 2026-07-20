# Codex Desktop ⟷ Claude Code — bridge, scaffold-switching, portable conversations

Reverse-engineered + validated design. Phase A (bridge) has a working MVP; B and C
are planned on top of it. Everything centers on one idea: a **canonical conversation
representation** that the desktop UI can drive and that can be moved across scaffold,
model, and machine.

## Native model menu — Claude selectable natively — DONE + verified (2026-07-16)

Claude models now live in the **app's own model menu** (no separate picker for selection).
Three patches make it work:
- `patch-custom-models.js` queryFn override **always merges** the Claude Code models into
  whatever list the native picker gets — custom API list *or* the codex presets — so Claude
  shows in the native menu **out of the box**. The Claude list is now **dynamically fetched**
  (not hardcoded): a main-process IPC `claude-models:get` GETs `{ANTHROPIC_BASE_URL}/v1/models`
  with the machine's claude token (env `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, else
  `~/.claude/.credentials.json`), filters to `claude*`, caches in-process; falls back to a
  hardcoded 7-model list only if the endpoint is unreachable. Symmetric to the codex fetch
  (`/v1/models` on the OpenAI-compatible base). Verified live: returns 9 models —
  `fable-5, opus-4-5/4-6/4-7/4-8, sonnet-5/4-6/4-5, haiku-4-5` with friendly display names,
  all present in the native menu; selecting fetched `claude-opus-4-7` → `spawn claude --model claude-opus-4-7`.
- `patch-model-picker.js` (1) bypasses `model-list-filter`'s `availableModels` gate
  (`…?n.has(r.model):!r.hidden` → `!r.hidden`) so non-codex models aren't dropped, and
  (2) exposes the composer's select handler as `window.__ccSelectModel(model, effort)`.
- **No selection-validation layer exists** — the earlier "falls back to gpt" symptom was purely
  a Radix-submenu automation artifact (synthetic hover never opened the submenu). Proven by
  calling `__ccSelectModel('claude-opus-4-8','high')` directly: `thread/start route=claude:claude-opus-4-8`
  → `turn/start model=claude-opus-4-8` → `spawn claude --model claude-opus-4-8` → UI reply
  *"I'm Claude, an AI assistant made by Anthropic."* Composer chip shows `claude · claude-opus-4-8 · High`.

So a real user hovers **Model** in the native menu, sees the Claude entries, and clicks one — it
routes to Claude Code end-to-end. The `⟳ Models` panel is now optional (API model fetch + remote
host/port/token config only); model **selection** is fully native.

## Ground truth (captured, not guessed)

The Codex desktop spawns `codex ... app-server` and speaks **newline-delimited
JSON-RPC over stdio** (NOT Content-Length; string ids). Captured with `tee.js`.

Core turn lifecycle (desktop ⟶ server, then server ⟶ desktop notifications):

```
→ initialize {clientInfo, capabilities}          ← {userAgent, codexHome, platformFamily, platformOs}
→ thread/start {cwd, model, config{...}}          ← {thread:{id, sessionId, status:{type:"idle"}, path, cwd, ...}}
→ turn/start {threadId, input:[{type:"text",text}], approvalPolicy, permissions}
                                                   ← {turn:{id, status:"inProgress"}}
   ← turn/started {threadId, turn}
   ← thread/status/changed {threadId, status:{type:"active"}}
   ← item/started {item:{type:"agentMessage", id:"msg_…", text:"", phase:"final_answer"}, threadId, turnId}
   ← item/agentMessage/delta {threadId, turnId, itemId, delta:"…"}   (streamed)
   ← item/completed {item:{type:"agentMessage", id, text:"<full>"}, threadId, turnId}
   ← turn/completed {threadId, turn:{status:"completed", startedAt, completedAt, durationMs}}
   ← thread/status/changed {threadId, status:{type:"idle"}}
```

Item types seen: `userMessage`, `agentMessage`, `reasoning` (+ `commandExecution`,
`fileChange`, `webSearch`, `mcpToolCall` per omnigent). The desktop also auto-opens a
separate ephemeral thread to generate the task **title**.

Claude Code driver (validated locally, v2.1.119):
```
claude -p --output-format stream-json --input-format stream-json --include-partial-messages --verbose
```
stdout events: `system/init` (→ session_id), `stream_event: content_block_delta.text_delta`
(streamed text), `content_block_delta.thinking_delta` (reasoning), `assistant`
(full message w/ tool_use blocks), `result` (turn done). Remote = `ssh host claude …`.

---

## Phase A — the bridge  (MVP DONE ✅)

`bridge.js` sits between desktop and real codex app-server:
- **Proxies** every JSON-RPC line transparently, so threads / models / config / history
  / titles keep working through real codex.
- **Intercepts `turn/start`**, drives Claude Code with the input text, and synthesizes
  the exact `turn/started → item/started → item/agentMessage/delta* → item/completed →
  turn/completed → thread/status/changed idle` sequence.
- Title-gen turns are detected and passed through to codex.

Activated by `~/.codex/cc-bridge/backend` = `claude`; the spawn override
(`__sshOverrideSpawnOptions`) rewrites the app-server spawn to `node bridge.js <realcodex…>`.
**Verified end-to-end**: asked "which model are you?" in the Codex UI → rendered
"I'm Claude, made by Anthropic, running on the Claude Sonnet 4.6 model."

### A.2 status

- ✅ **Session continuity (resume)** — DONE + tested. Persist `codexThreadId ↔
  claudeSessionId` in `~/.codex/cc-bridge/sessions.json`; follow-up turns run
  `claude --resume <sid>` (same cwd). Verified: told the secret "Zorbax42" in turn 1,
  recalled it in turn 2.
- ✅ **Tool calls** — DONE + tested. Block-based mapping of Claude's stream:
  each text content-block → an `agentMessage` item; `Bash` → `commandExecution`
  `{id:"exec-…", command, cwd, source:"unifiedExecStartup", status, aggregatedOutput,
  exitCode}`; `Write/Edit/MultiEdit/NotebookEdit` → `fileChange` `{changes:[{path,
  kind:{type:add|modify}, diff}]}`; every other tool → a generic command item;
  `tool_result` → `item/completed`. Verified: Claude ran `echo` + created a real file;
  the desktop rendered a "Worked for 10s" work-summary and the file was actually written.
  (Currently runs with `--dangerously-skip-permissions`; A.2-approvals replaces that.)

### A.2 approvals — DONE + fully verified end-to-end ✅ (`~/.codex/cc-bridge/approvals` flag)
Native approve/deny renders and the full round-trip works. Verified: a Claude `Write` showed
the desktop's **Permissions card** ("Allow ChatGPT to edit approval_check.txt? — Deny / Allow
once"); clicking **Allow once** flowed back through the bridge (bridge.log: `approval reply
900001 allow=true`) → Claude proceeded → the file was actually written.
- **The key shape** (found by forcing the desktop's "Ask for approval" mode + an out-of-workspace
  write, then capturing the real codex traffic): the render method is **`item/permissions/
  requestApproval`** (NOT commandExecution/fileChange), sent as a REQUEST with an **integer id**
  and params `{threadId, turnId, itemId, environmentId:"local", startedAtMs, cwd, reason,
  permissions:{network, fileSystem:{read, write:[paths], entries:[{path:{type:"path",path},access}]}}}`.
  The desktop replies `{id, result:{permissions:{…}, scope:"turn"}}` for BOTH allow and deny —
  **the discriminator is whether `permissions` has keys**: allow = `permissions.fileSystem…entries`
  populated; **deny = `permissions:{}` (empty object), scope still "turn"**. (My first cut checked
  `!!permissions` which is truthy for `{}` → misread deny as allow; fixed to
  `Object.keys(permissions).length > 0`.) Bridge uses a high id base (900001+) to avoid colliding
  with codex's own request ids.
- **THE critical enabler**: send `control_request{subtype:"initialize"}` on Claude's stdin BEFORE
  the user message. Without it, `-p` headless auto-allows every tool (no prompts at all, even with
  `--permission-prompt-tool stdio`). After the init handshake, Claude routes each gated tool to a
  `can_use_tool` control_request. (Source: `print.ts:4495` stdio routing, `:4559` init handler.)
- Bridge maps Claude `can_use_tool` → a permission request (Write/Edit → fileSystem.write:[file];
  Bash/other → workspace write + command in `reason`) → waits for the desktop decision →
  `control_response{behavior:"allow"|"deny"}` to Claude. 45 s auto-allow safety. Only claude-gated
  tools prompt (safe commands like `echo` auto-run). **Verified both ways**: Allow → file written;
  Deny → `allow=false`, file NOT written, tool skipped.

### A.2 approvals — earlier notes (superseded above)
- **Trigger found**: run claude with `--permission-prompt-tool stdio` (+ `--input-format
  stream-json`, NO `--dangerously-skip-permissions`). Confirmed in isolation: claude emits
  `control_request{subtype:"can_use_tool", tool_name:"Write", input, tool_use_id, request_id}`.
  Safe commands (e.g. `echo`) are auto-allowed by claude's rules and don't prompt — only
  gated tools (Write/Edit, risky Bash) emit the control_request.
- **Bridge**: on control_request → `startTool` + emit `item/fileChange/requestApproval` /
  `item/commandExecution/requestApproval` `{conversationId, requestId, turnId, itemId, item,
  command, cwd}` → wait → on desktop reply send `control_response{behavior:"allow"|"deny"}`.
  25 s auto-allow safety so a turn never hangs. Flag OFF by default (tested skip-permissions).
- **Last mile**: the desktop registered the request (turn paused) but didn't render clickable
  buttons — the exact `requestApproval` params the approval component needs are still slightly
  off. Nail by capturing a real codex approval (force approval mode) or reversing the approval
  UI component fields, then adjust the params. Everything else is done.

### A.2 approvals — reference (protocol, all shapes) Run Claude
   WITHOUT `--dangerously-skip-permissions`, WITH `--input-format stream-json` (bidirectional;
   keep stdin open, close on `result`). Exact wire shapes:
   - **Claude → bridge** (stdout): `{type:"control_request", request_id, request:{subtype:"can_use_tool",
     tool_name, input, tool_use_id, permission_suggestions, blocked_path, decision_reason}}`
   - **bridge → Claude** (stdin): `{type:"control_response", response:{subtype:"success",
     request_id, response:{behavior:"allow", updatedInput:<input>}}}` (or `{behavior:"deny", message}`)
   - **bridge → desktop**: `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`
     with `{conversationId:<threadId>, requestId:<uuid>, …command/changes…}` (the desktop stores it
     keyed by conversationId→requestId; verify exact params via test-against-UI).
   - **desktop → bridge**: `{method:"reply-with-command-execution-approval-decision" |
     "reply-with-file-change-approval-decision", params:{conversationId, requestId, decision}}`,
     `decision ∈ approved | denied | abort | approved_for_session | decline`.
   - Bridge maps approved/approved_for_session → `behavior:"allow"`, else → `behavior:"deny"`.
   - **Claude stream-json input** user message: `{type:"user", content:"<text>", uuid:"",
     session_id:"", message:{role:"user", content:"<text>"}, parent_tool_use_id:null}`.
   Sources: `structuredIO.ts:618/860/871`, `print.ts:2936`, desktop `app-main` handler.
2. **Streaming reasoning**: `thinking_delta` → `item/reasoning/textDelta` + reasoning item.
3. **Remote**: `backend` = `claude@<sshhost>` → drive `ssh host claude …` (reuse SSH transport).
4. **Ship the runtime**: patch writes `bridge.js`/`tee.js` to `~/.codex/cc-bridge/` on
   startup + a UI toggle (reuse the SSH modal: add a "Backend: Codex / Claude Code (local|remote)"
   selector) instead of hand-placed files.

### Claude transcript persistence (for resume + migration C)
`~/.claude/projects/<project-key>/<sessionId>.jsonl` — append-only, one `Entry` per line.
Resume rebuilds the chain via `uuid`/`parentUuid` from the latest leaf (NOT file order),
then applies compact/snip projections. `--resume` requires the same cwd. subagents are
sidechains in `subagents/agent-<id>.jsonl`. (Source:
`claude-code-main/docs/internals/session-transcript-persistence.md`,
`src/utils/sessionStorage.ts`, `src/utils/conversationRecovery.ts`.) This is the schema the
format translator (B.2 / C) reads and writes.

---

## Shared format translator — DONE + tested  (`translate.js`)

Canonical rep `{cwd, sessionId, items:[{kind:"message"|"reasoning"|"tool_call", …}]}` with
four converters: `codexToCanonical` / `canonicalToCodex` (codex rollout `response_item`s) and
`claudeToCanonical` / `canonicalToClaude` (claude uuid/parentUuid chain). Verified round-trip
on real transcripts: codex→claude→canonical preserved 13 messages / 191 tool calls / 191 tool
outputs; claude→codex→canonical preserved messages+tools. Drops host metadata (file-history,
attribution, encrypted reasoning) — that's what makes a transcript portable.

## Phase C — cross-machine migration — DONE + tested  (`migrate.js`)

**Signature investigation (the thing to check first): codex rollout JSONL has NO
signature / attestation / hmac / hash** — grep found none; the only opaque field is
`encrypted_content` on reasoning items (dropped). `session_index.jsonl` is trivial:
`{id, thread_name, updated_at}`. So codex→codex migration = rewrite `cwd`/`workspace_roots`
in `session_meta`+`turn_context`, drop the rollout under the target `~/.codex/sessions/…`,
append one `session_index.jsonl` line. `rewriteCodexRollout` verified: cwd rewritten
(`h:\…` → `/home/otheruser/project`), thread id + all 13 msg / 191 tool preserved.
`claudeToCodexRollout` (C.3 cross-scaffold) composes the translator → valid codex rollout.
Transport is orthogonal: read/write local or `ssh host cat` / `ssh host "cat > …"`.
Remaining: a UI "move/import conversation" action + the ssh transport wiring + a
main-process ipc; claude→claude (C.2) needs the `<url-encoded-cwd>` dir re-encode + resume-cwd.

## Phase B — seamless model + scaffold switching — backend DONE + tested

Bridge now reads `~/.codex/cc-bridge/backend` as `{scaffold, model, host}`:
- **model** → `claude --model <model>` per turn. Verified: set `claude-opus-4-8` → reply
  "I'm Claude Opus 4.8". Within-Claude model switch is per-turn (bridge re-reads each turn).
- **host/port/password** → drive `ssh <host> claude …` (remote Claude Code). DONE + transport
  verified end-to-end against a real box (root@198.46.171.57): bridge spawned
  `ssh root@… [pw] claude` with password auth (SSH_ASKPASS + CC_SSH_PW), reached the remote.
  Remote sessions are separate, so `--resume` is skipped for remote. Password/port added to the
  Backend UI. Remote box prep done there: node upgraded 18→22 (claude requires ≥22), claude 2.1.211
  installed. **The one remaining step is remote Claude auth** — it hangs with no credentials; the
  user does a one-time `ssh -t root@host claude` login (OAuth) or sets `ANTHROPIC_API_KEY` on the
  box. That's inherent to any headless Claude deployment, not a bridge gap.
- Codex↔Claude scaffold switch mid-thread: model/host is live per-turn; a full scaffold flip
  additionally needs replaying canonical history into the target (translator, already built)
  and the app-server to respawn on the new backend. Remaining: the **two-axis picker UI**
  (scaffold × model) writing `backend` — reuse the ⟳ Models panel + a `codex-backend:set` ipc.

## Phase B (original notes) — seamless model + scaffold switching mid-conversation

Goal: a conversation started on Claude Code Opus 4.6 can continue on Opus 4.8, or even
GPT-5.5 (codex), keeping context.

The bridge already translates between representations — B makes that switchable per turn.

**B.1 Same scaffold, different model** (Claude 4.6 → 4.8, or gpt-5.6-sol → gpt-5.5): trivial.
- Claude: next turn spawns `claude --resume <sid> --model <new>`; the session keeps history,
  the model changes. Codex: it already supports model change per turn (`turn/start` model /
  collaborationMode.settings.model).

**B.2 Cross-scaffold** (Claude ⟷ codex): the hard, interesting case.
- The bridge maintains a **canonical transcript** (ordered `{role, content, toolCalls}` list)
  built from whichever backend ran each turn (it already sees every item event / claude event).
- On switch, seed the target scaffold with that transcript:
  - → **codex**: stop intercepting; write a codex rollout `.jsonl` seeded with the transcript
    and `thread/resume` it (or start a thread whose history is pre-populated). Codex then owns
    subsequent turns natively (real GPT).
  - → **claude**: build a `--resume`-able claude session (write a transcript into
    `~/.claude/projects/<cwd>/…jsonl` in Claude's schema, or replay history as the first
    stream-json input) and drive claude from there.
- **UI**: extend the model picker (already API-fetched) to a two-axis picker —
  **scaffold** (Codex / Claude Code) × **model** (that scaffold's list). Selecting a Claude
  model flips `backend=claude --model=…`; selecting a GPT model flips `backend=codex`.
  The bridge reads the selection per turn.

Dependency: B.2 needs the canonical transcript + **format translators** (claude jsonl ⟷ codex
rollout), which is exactly what C also needs → build the translator once, share it.

---

## Phase C — cross-machine conversation migration (local ⟷ ssh ⟷ ssh)

Conversations live on disk:
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` + an index entry in
  `~/.codex/session_index.jsonl`; threads are keyed by cwd. `initialize` advertises
  `requestAttestation:true` — **rollouts may carry signatures/attestation that a different
  machine/cluster rejects** (needs investigation + re-signing or stripping).
- **Claude**: `~/.claude/projects/<url-encoded-cwd>/<sessionId>.jsonl`; the cwd is encoded in
  the directory name and `--resume` refuses a mismatched cwd. Harder to relocate.

Migration = read (source: local or over ssh) → **rewrite machine-specific bits** → write
(target: local or ssh) → target app-server lists it.

**C.1 Codex→Codex across machines**
1. Pull `rollout-*.jsonl` (+ index entry) from source (`ssh host cat …` or local read).
2. Rewrite: `cwd` paths to the target's workspace, timestamps/ids if colliding, and any
   signature/attestation to match the target (INVESTIGATE: dump a rollout, find the signed
   fields; likely re-hash or drop the attestation line so codex re-accepts it).
3. Push to target `~/.codex/sessions/…` + append a rewritten line to target
   `~/.codex/session_index.jsonl`.
4. Target's `thread/list` now shows it; open → `thread/resume`.

**C.2 Claude→Claude across machines**: same, but re-encode the `<cwd>` directory name for the
target path and fix the resume-cwd guard (store/rewrite launch cwd, cf. omnigent
`claude_native_state`).

**C.3 Cross-scaffold migration** (Claude-on-A → codex-on-B): compose C + B.2 — translate the
transcript into the target format, then land it as in C.1/C.2.

**UI**: a "Move / import conversation" action listing threads from any reachable host
(local + configured ssh hosts — we already parse `~/.ssh/config`) with a source→target picker.
Under the hood: an `ipcMain` handler that shells `ssh host tar/cat` for transport and runs the
translator/rewriter.

**Open investigations before building C**:
- What exactly does codex sign in a rollout, and will it load an edited/re-pathed one? (dump + diff)
- Claude jsonl schema for a hand-authored resumable session.
- Whether `session_index.jsonl` needs a checksum.

---

## Build order

1. **A.2 tool calls + resume** (makes the bridge genuinely useful — real Claude Code coding).
2. **Shared format translators** (claude jsonl ⟷ canonical ⟷ codex rollout) — needed by B.2 and C.
3. **B two-axis picker + per-turn backend switch**.
4. **C.1 codex→codex migration** (investigate signatures first), then C.2/C.3.
5. **Remote everywhere** (ssh) — reuses the SSH transport already built.

Each step is independently testable via the DevTools-driven harness used for the MVP
(launch with `--remote-debugging-port`, drive a turn, assert the rendered result).
