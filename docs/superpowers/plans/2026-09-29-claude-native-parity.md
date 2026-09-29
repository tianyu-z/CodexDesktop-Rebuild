# Claude Native Experience Implementation Plan

> Use the subagent-driven-development workflow for isolated modules, followed by integration and independent review. The user has authorized auditing and migrating native functionality in this session.

**Goal:** Deliver a complete installed-version feature inventory and migrate missing native interactions and input/control capabilities into Claude-only and compatible mixed workflows.

**Architecture:** Keep Claude Code as the native harness. Extend the existing SDK adapter and host-scoped routes with shared, testable interaction and input translation modules. Extend the current frontend controls rather than replacing the official Codex shell.

**Tech Stack:** JavaScript, Node tests, Claude Agent SDK, Electron bundle patching.

## Task 1: Versioned inventory

- [x] Combine the CLI, VS Code and app audit reports into `docs/claude-native-feature-matrix.md` and a machine-readable manifest inventory. List all manifest commands/keybindings/settings, observed native commands, control methods and known gates. Cross-check identifiers/counts against the installed package and distinguish dynamic project skills from builtins.

## Task 2: Native questions, plans and approvals

Files: create `runtime/agent-modes/claude-interactions.mjs` and `tests/agent-modes/claude-interactions.test.mjs`; modify permission paths in `claude-adapter.mjs`, `router.mjs`, `orchestration/router.mjs`, and their tests.

- [x] Add a failing assertion that an AskUserQuestion request renders its original question/options and maps a reply back to `updatedInput.answers[originalQuestion]` instead of Allow/Deny.
- [x] Cover multiple questions, multiple answers, free text, malformed/cancelled replies, plan approval with manual/automatic edits, rejection guidance, scope-preserving permission suggestions and stale replies after Stop.
- [x] Implement shared prompt/response conversion and preserve the native permission request metadata. Only return explicit native permission updates selected by the user.
- [x] Run the interaction, adapter, router and dual-router tests; inspect existing Codex approval paths for unchanged behavior.

## Task 3: Native input blocks

Files: create `runtime/agent-modes/claude-input.mjs` and `tests/agent-modes/claude-input.test.mjs`; integrate in `handoff.mjs`, `claude-command-router.mjs`, `router.mjs`, `claude-adapter.mjs`, `steering.mjs` and workflow input preparation.

- [x] Test text/reference ordering, image data URLs, local PNG/JPEG/GIF/WebP payloads, invalid or oversized files, URL rejection, missing files, and image-only input.
- [x] Convert original inputs to native content blocks with an explicit handoff prefix. Keep public history records unchanged. Gate slash-command recognition on text-only command input.
- [x] Verify steering and role execution use the same bytes, do not fetch remote URLs, and never reinterpret an unsupported attachment as an empty text prompt.

## Task 4: Controls and native presentation

Files: `claude-commands.mjs`, `claude-live-controls.mjs`, `claude-command-router.mjs`, focused new native-control helpers, `scripts/assets/agent-modes-ui.js`, and corresponding command/frontend tests.

- [x] Add ownership-tested task stop and readable status/plan/task/skill/memory/MCP/plugin output from actual native response shapes.
- [x] Add a searchable categorized Claude command/control entry point. Selecting an action inserts an editable command without erasing the current draft or changing the selected role/host.
- [x] Add supported native session effort/thinking/output-style controls with validated values and explicit persistence scope; verify the selected values survive the app's next native process where promised.
- [x] Retain dynamic command precedence and native gates. List features that need the editor or a native account service accurately in the matrix.

## Task 5: Integration, verification and installation

- [x] Run all relevant regression suites once the modules are integrated. Fix review findings and rerun affected tests.
- [x] Execute disposable live Claude question/plan/image/control flows; record session IDs and assertions in ignored artifacts, without using production chats.
- [x] Verify actual patched bundle handlers and syntax/idempotence. Build from the installed app with a strict changed-file allowlist; include every new/changed runtime file in the remote payload.
- [x] Verify code signatures and source/package parity, back up the app and conversation sidecars, install without restarting active processes, and update the user-facing matrix/docs with precise results and remaining host/service dependencies.

## Completion evidence

754 unique regression cases resolved (751 initial passes, 3 test-runner timeouts; full Polly 28/28 passed with 120-second limit). Real questions/plans, images/steering, mixed Codex+Claude vision, task Stop, settings persistence and Goal passed. Actual bundle multi-select handler, source parity for 14 local/remote runtime files, and both package signatures passed. Installed with backup, all 13 existing App PIDs preserved. See `.artifacts/claude-native-parity-final/validation.json` and `install.json`. No manual GUI clicks or per-cluster native revalidation claimed.
