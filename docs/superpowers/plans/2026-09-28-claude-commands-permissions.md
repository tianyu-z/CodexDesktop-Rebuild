# Claude commands and permissions implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development with tests and review. Keep native process ownership, remote host isolation and persistence-before-notification guarantees.

**Goal:** Invoke the selected host's Claude Code commands in the existing composer and select native Claude permissions independently of Codex, including individual workflow roles.

**Architecture:** Discover commands through the installed native Claude SDK initialization without inference. Dispatch user commands before handoff/workflow prompt construction; use the exact native command text and the selected role's native session. Claude-only and each Claude workflow role have persisted native permission settings. Native local results, resets and settings changes must update public session state. UI-only commands use explicit application/native control operations rather than model prompts.

**Tech stack:** Electron renderer patch seams, JavaScript, Node ESM, pinned Claude Agent SDK, existing local/remote engine gateway, node:test.

## Contract

- `claudePermissionMode`: default `default`; supported native values `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, `dontAsk` (last is advanced API mode). UI matches VS Code's five ordinary choices.
- `roleOverrides[roleId].permissionMode`: optional override for that Claude role. Effective template role carries the value into frozen workflow invocations and retry. Codex never receives Claude permission fields. Read-only role tool restrictions remain in effect under every mode.
- `claudeCommandTarget`: optional selected Claude role ID in multi-agent; validated against effective roles. Selection is host/chat scoped. Commands use this role alone and preserve native session ownership; custom role engine/model changes must not reuse incompatible bindings.
- `engine/claude/commands`: cwd/thread/target-scoped catalog request; returns sanitized native command name, description, argument hint, aliases and builtin marker, with explicit refresh.
- Commands are submitted via ordinary composer `turn/start`; slash recognition occurs before prompt augmentation. Multi-agent commands do not launch the template. Literal generated role prompts do not dispatch slash commands.
- Native `/clear` starts fresh Claude context; older public history stays visible, and its handoff watermark advances so it is not reimported. Claude-only and workflow session IDs remain separate.
- Native commands are discovered per host. Interface operations such as `/permissions` are explicit app actions. Unsupported runtime capabilities report actionable errors and never fall through to a model.

## Tasks

- [x] Permission backend: tests for persistence, invalid modes, native options, roles/retries and Codex isolation; implement `claude-permissions.mjs`, adapter options, store/router/schema/scheduler propagation.
- [x] Command backend: test dynamic catalog, exact command dispatch, result-only output, aliases, session resets, target ownership, cancellation and remote requests; implement native catalog/control support and router dispatch.
- [x] Renderer: tests for draft/persisted capture, role permissions/target, slash entries and engine-specific permissions; replace pinned slash catalog and native permission component seams with reactive helpers. Command selection inserts editable text; normal submit executes it.
- [x] Native validation: disposable local sessions and reachable clusters; verify discovery, `/model`, `/context`, `/config`, `/clear`, custom skill and native approval behavior without changing unrelated settings.
- [x] Review, full node:test suite, complete signed isolated preview build, GUI verification, backup/install while preserving production processes. No push in this task.

## Verification commands

Run focused suites after each component, then `node --test tests/agent-modes/*.test.mjs`. Build with `scripts/build-agent-modes-preview.js` using a unique output app and wait for exit 0 and strict signature verification before launch. Record native checks and exact installed artifact hashes in `.artifacts` and user-facing documentation.

## Validation outcome

Full suite: 577 passed. Subsequent attribution, renderer, and session-restoration regressions passed (27, 8, and 65 focused checks respectively). Local native permission behavior and signed preview menus were exercised. Six-host commands/roles matrix passed its 54 command runs; native Auto rejects on bar/blc/blc-2. Native remote /context accounting remains unavailable; final rno timeout and same-chat recovery passed. Final install hashes and backup are recorded in `.artifacts/claude-controls-install-manifest.json`. No push in this task.
