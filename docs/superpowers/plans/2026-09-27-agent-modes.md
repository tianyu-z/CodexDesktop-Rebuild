# Conversation Engine Modes Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation and review tasks. Execute integration work in this session. The user approved the design and implementation on 2026-09-27; do not ask again for an execution-method choice.

**Goal:** Add persistent Only Codex and Only Claude Code modes to the same chat in the installed development app, with a disabled, extensible Both mode.

**Architecture:** Put a local JSONL protocol gateway in front of the existing Codex App Server. Preserve native Codex requests and use a separate Claude adapter, common conversation store, and event normalization for Claude turns. Add narrow version-checked renderer/bootstrap patches; retain the native thread identifier as the visible conversation identifier and separate each engine's binding and execution IDs.

**Tech Stack:** Node.js ESM, node:test, Claude Agent SDK 0.3.282 / local Claude Code 2.1.283, existing Codex CLI 0.153.4-cometix, existing compiled Electron/React application. SDK 0.3.282 respects this machine's npm publication-age policy; verify compatibility with the installed CLI in live tests.

## Working directories and baseline

- Work only in `/Users/tianyu.zhang/.codex/worktrees/claude-code-modes/New project 10` on `codex/claude-code-modes`.
- Original project and installed app remain available for comparison and rollback.
- Preserve the copied, previously uncommitted model picker customization as a separate baseline commit.
- Runtime modules go in `runtime/agent-modes/`; generated bundles stay under ignored `src/mac-arm64/_asar/`.
- Root `node_modules` is a read-only shared symlink. Install SDK dependencies only in `runtime/agent-modes/node_modules`.
- Diagnostics, copied bundles, and test conversations use `.artifacts/` and temporary directories, never existing user conversations.

## Task 1: Confirm protocol and packaging boundaries

Files: `runtime/agent-modes/package.json`, `.gitignore`, test fixtures under `tests/agent-modes/fixtures/`.

- [x] Generate the installed Codex schema with `'/Applications/chatgpt-dev.app/Contents/Resources/codex' app-server generate-json-schema --out .artifacts/codex-schema`.
- [x] Inspect thread/turn, history pagination, approval, and item event shapes. Capture only necessary representative fixtures, excluding account data.
- [x] Pin the compatible SDK dependency and install with optional bundled executables omitted; use the verified existing Claude binary through `pathToClaudeCodeExecutable`.
- [x] Verify SDK initialization and native session IDs without modifying user settings; model aliases are exposed, Haiku is exercised through real Foundry calls.

Runtime dependency declaration:

```json
{"private":true,"type":"module","dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.282"}}
```

## Task 2: Build the Claude adapter with tests first

Files: `runtime/agent-modes/claude-adapter.mjs`, `runtime/agent-modes/claude-events.mjs`, `tests/agent-modes/claude-adapter.test.mjs`, `tests/agent-modes/claude-events.test.mjs`.

Adapter contract:

```js
const adapter = new ClaudeAdapter({ executablePath, queryImpl });
const run = adapter.start({
  prompt, cwd, nativeSessionId, model, signal,
  onEvent, onPermission,
});
await run.interrupt();
const result = await run.done;
// result: { nativeSessionId, status, error?, usage? }
```

Normalized events carry stable native IDs: session, message-start, text-delta, message-completed, tool-start, tool-completed, status, result. Tool permission callbacks carry the tool name, input, native tool-use ID and abort signal; accept/reject must return to the exact SDK request. No bypass-permissions defaults.

- [x] Write failing stream tests for partial text followed by a completed message, tool start/result pairing, session ID capture, and SDK errors.
- [x] Write failing adapter tests for native resume, project directory, permission allow/deny, abort before startup, abort while waiting for permission, and awaited shutdown.
- [x] Run `node --test tests/agent-modes/claude-*.test.mjs` and confirm expected red failures before implementing.
- [x] Implement SDK import/launch and normalization. Use injectable query implementation only at the external SDK boundary; assertions verify emitted events and permission outcomes.
- [x] Re-run tests, then spec review followed by quality review; repair findings before integration.

## Task 3: Persist and merge logical conversation history

Files: `runtime/agent-modes/store.mjs`, `runtime/agent-modes/handoff.mjs`, `tests/agent-modes/store.test.mjs`, `tests/agent-modes/handoff.test.mjs`.

Stored conversation data includes schema version, logical/native IDs, mode, workspace, engine bindings, per-engine models, engine-tagged turns, event sequence, and consumed context sequence. Writes use atomic replacement; completed turn state is flushed before reporting completion. A mode of `both` is recognized but rejected for execution.

- [x] Write failing tests for reload, stable IDs, duplicate event suppression, reserved run metadata and ownership, isolated conversations, and unsupported mode rejection.
- [x] Write failing handoff tests for Codex → Claude → Codex, sending only unseen public history and preserving workspace/file-change context.
- [x] Run the tests to establish red, then implement storage and deterministic context packaging.
- [x] Keep full history available locally when input is bounded. Explicitly label transferred history; never promote agent text or tool output to a privileged instruction role.
- [x] Verify mode changes require no active run or unresolved approval, and context cursors advance only on acknowledged input.

Example acceptance assertion:

```js
assert.equal(reloaded.id, original.id);
assert.deepEqual(reloaded.turns.map(t => t.engine), ['codex', 'claude', 'codex']);
assert.equal(new Set(reloaded.turns.map(t => t.id)).size, 3);
```

## Task 4: Route native Codex and Claude through one protocol gateway

Files: `runtime/agent-modes/gateway.mjs`, `runtime/agent-modes/router.mjs`, `runtime/agent-modes/codex-events.mjs`, `tests/agent-modes/router.test.mjs`, `tests/agent-modes/gateway.test.mjs`.

- [x] Add failing process-level tests using a deterministic fake App Server and SDK boundary. Verify initialization/auth/config passthrough and request-ID collision avoidance.
- [x] Preserve ordinary CLI invocations by delegating non-app-server commands to the original CLI.
- [x] Intercept engine mode metadata and Claude model selections; send only native-compatible parameters to Codex.
- [x] Preserve the logical thread ID. Normalize Claude turns/items/approval requests into the installed UI's App Server schema.
- [x] Merge Claude turns into thread read/resume and both turn/item pagination paths. Preserve ordering, cursors, engine labels, and completed history across restart.
- [x] Bind approvals and interrupts to exact runs. Reject cross-thread answers and active-run mode changes. Close child processes and pending requests on disconnect.
- [x] Test that Claude turns produce zero Codex `turn/start` calls and Codex turns produce zero Claude inference calls.
- [x] Confirm errors and unsupported Both requests are explicit and cannot silently choose a different engine.

## Task 5: Integrate the mode selector and packaging

Files: `scripts/patch-agent-modes.js`, `scripts/assets/agent-modes-ui.js`, `scripts/assets/agent-modes-bootstrap.cjs`, `scripts/build-agent-modes-preview.js`, `tests/agent-modes/patch.test.mjs`.

- [x] Write failing patch tests against small anchor fixtures for exact-one-match enforcement and repeated application.
- [x] Add a conversation-scoped selector with labels Only Codex, Only Claude Code, and disabled Codex + Claude Code. Keep each engine's selected model separate.
- [x] Pass mode and model with thread creation and switch requests; do not use an unscoped process-global mode for new conversations.
- [x] Disable changes during execution/approval. Route unsupported remote-host selections to an explanatory unavailable state.
- [x] Reuse existing message and approval UI, clearly label the source engine, and preserve composer shortcuts.
- [x] Install the gateway through a narrow bootstrap entry. Resolve the verified Node runtime and original Codex binary without overwriting either executable.
- [x] Build a separately identified test copy of the installed development app using APFS copy-on-write, preserving bundled frameworks and native modules. Patch only the copied ASAR and added runtime resources.

## Task 6: Verify real integration and deliver the modified application

Files: `tests/agent-modes/live-smoke.mjs`, `docs/agent-modes.md`, updated implementation checklist.

- [x] Run `node --test tests/agent-modes/*.test.mjs` and `git diff --check`.
- [x] In a disposable workspace, run a real Codex turn, switch to Claude, ask it to recall an explicit test fact and inspect a file, then switch back to Codex and verify the Claude contribution is available.
- [x] Check real Claude approval allow/deny and cancellation; verify denied operations do not occur and no worker remains active after interruption.
- [x] Restart the gateway/app and verify mixed history and selected mode restoration; native Claude session bindings are durable and consecutive real Claude calls resume the same session.
- [x] Verify the packaged application's startup and UI paths. Use available application automation for native UI inspection; report a concrete permission limitation if it prevents visual validation.
- [x] Obtain independent final spec and code reviews, resolve findings, and re-run affected checks.
- [x] Preserve a recoverable backup before updating the user-requested development app. Document installation, rollback, current limitations and the reserved Both-mode extension boundary.

## Plan self-review

All design requirements map to Tasks 2–6. Native engine execution is separate from public history, mode from model, and Turn from AgentRun. Both remains disabled in UI and backend. First implementation targets local Claude on this Mac; Codex remote behavior remains native. No original user conversation is used as a test fixture.


## Verification record (2026-09-27)

- 100/100 automated tests passed; exact logs: `.artifacts/agent-modes-tests-final.log`.
- Independent Claude adapter, frontend, and core specification/quality reviews approved after regression fixes.
- Real Codex round trip, native history pagination and gateway restart passed; evidence: `.artifacts/live/smoke-St5tA7/report.json`.
- Packaged preview: Claude authentication error is visible, controls re-enable after failure, same-chat switch to Codex succeeds, and Codex returns `CODEX_UI_OK`. Backend contains exactly two failed Claude turns and one completed Codex turn. Evidence: `.artifacts/live/ui-validation.json`.
- Preview and release builds both passed strict code-signature verification; ASAR SHA-256: `97e36d4dfda5afcaae7695c7e8956f1eb20367ed86bb331cbaf0092cb4deab39`.
- Remaining real Claude acceptance is blocked by `claude auth status --json` reporting `loggedIn:false, authMethod:none`. SDK invocation returns `Not logged in`. No successful Claude inference, real file-tool permission behavior, or two-way model recall is claimed from fixtures. The user was asked to complete `claude auth login`; no credentials or configuration were altered.
- The packaged app was restarted; both Claude errors, the Codex reply, source labels, and Only Codex selection restored correctly. The disposable UI conversation was archived.
- Installed `/Applications/chatgpt-dev.app` after preserving the original at `/Users/tianyu.zhang/.codex/backups/agent-modes/2026-09-27T10-18-48-024Z/chatgpt-dev.app`; backup and installed ASAR hashes verified, installed signature verified.


## Foundry connection follow-up (2026-09-27)

- User identified VS Code Insiders `claudeCode.environmentVariables` as the working connection source. The earlier bare-shell `loggedIn:false` observation did not account for the plugin-only Foundry provider environment.
- Added per-run read-only JSONC connection loading, with explicit process-provider precedence and a restricted connection/model allowlist. No credential values were copied into source, logs, or application resources, and editor permission/MCP settings were not imported.
- Real direct Claude returned `CLAUDE_FOUNDRY_OK`; full two-way mixed-engine/file/restart smoke passed (`.artifacts/live/smoke-6sr9S0/report.json`).
- Actual Claude allow/deny/cancellation and owned-process exit checks passed (`.artifacts/live/permissions-TfdGWa/report.json`).
- Corrected missing approval-resolution notifications and native resolution ID mapping, including responses-before-resolution. Independent review approved; 111/111 automated tests pass (`.artifacts/agent-modes-tests-foundry.log`).
- These results supersede the earlier login blocker. No additional Claude OAuth login is needed for this configured provider.
- The final real permission run additionally verified exactly one correctly remapped `serverRequest/resolved` notification per approval and empty pending-request maps after cancellation.
- Updated installed application returned `CLAUDE_DESKTOP_OK` in its real GUI; exactly one completed Claude turn, no Codex inference, idle state and a bound native Claude session were verified (`.artifacts/live/foundry-ui-validation.json`).
