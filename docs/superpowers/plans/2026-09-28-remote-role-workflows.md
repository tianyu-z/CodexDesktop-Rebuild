# Remote Collaboration and Role Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkboxes for tracking. Shared worktree: /Users/tianyu.zhang/.codex/worktrees/claude-code-modes/New project 10. Never edit another worker's assigned files.

**Goal:** Run native collaborative workflows on SSH clusters and let each participant and host choose its engine, model and instructions.
**Architecture:** Independent remote gateway over the existing desktop SSH WebSocket channel, with host-scoped UI; additive role overrides and validated hosted debate in the existing scheduler.
**Tech Stack:** Node ESM/CJS, official Claude Agent SDK, Codex app-server JSON RPC, SSH, ws, existing patched Electron/React UI.

## Task 1 — Role execution and host contract
Files: runtime/agent-modes/{store.mjs,router.mjs,templates/schema.mjs,templates/store.mjs,templates/builtins.mjs,orchestration/router.mjs,orchestration/scheduler.mjs}; tests/agent-modes/{templates,workflow-store,scheduler,dual-router}.test.mjs.
- [ ] Add failing tests for roleOverrides map validation, persistence, precedence, same-engine graphs, independent bindings and immutable retries. Example assertion: two roles engine=codex, models=a/b result in two runner.start calls with requested model a/b and distinct role/session IDs.
- [ ] Add optional role.model, remove distinct-engine requirement, retain v1 compatibility and old built-in revisions. Resolve roleOverrides before taking frozen workflow snapshot. No override may increase role access.
- [ ] Add hosted debate with validated structured host decisions, a hard round limit, final-only setting, retry and resume tests. Invalid decision must block, not converge.
- [ ] Run focused tests: node --test tests/agent-modes/{templates,workflow-store,scheduler,dual-router,role-runner}.test.mjs. Commit only task files.

## Task 2 — Persistent remote protocol and provider
Files: new runtime/agent-modes/remote/{server,proxy,environment}.mjs, runtime factory extracted from gateway.mjs, tests/agent-modes/remote-*.test.mjs; runtime package dependencies.
- [ ] Write a real local Unix socket integration test: initialize connection, start fake delayed native workflow, disconnect, reconnect, read completed state without second turn/start. Repeat with unresolved approval, same ID, explicit denial.
- [ ] Implement ws server on private socket; detached lifecycle, single-owner store, connection-scoped RPC IDs, bounded output, pending approval replay and graceful owned-child cleanup. NativeClient remains gateway-owned over stdio; remote proxy pipes WebSocket bytes over SSH.
- [ ] Test known Foundry provider mapping using fixture TOML/auth and environment headers; ensure explicit Claude provider is unchanged, unsupported provider fails closed, credential rotation is re-read. Implement without copying host credentials.
- [ ] Run node --test tests/agent-modes/remote-*.test.mjs and gateway/upstream/router regressions.

## Task 3 — Desktop SSH bootstrap
Files: scripts/assets/agent-modes-remote.cjs, scripts/patch-agent-remote.js, scripts/build-agent-modes-preview.js, tests/agent-modes/remote-patch.test.mjs.
- [ ] Fixture-test exact pinned main bundle seams before patching; include idempotence.
- [ ] Install deterministic runtime archive through existing SSH connection arguments, strict host checking preserved, private content-addressed directory, Node/CLI discovery, atomic extraction, no root npm install or user config edits.
- [ ] Replace only remote gateway connect/bootstrap/proxy seams; do not call upstream broad kill/restart. Remote gateway errors must be visible.
- [ ] Run actual pinned bundle parse/idempotence and test missing runtime/node/claude plus duplicate connections.

## Task 4 — Role controls and host-scoped renderer
Files: scripts/assets/agent-modes-ui.js, scripts/patch-agent-modes.js if necessary, tests/agent-modes/{frontend,dual-frontend,remote-frontend}.test.mjs.
- [ ] Test draft/started/existing selection carries roleOverrides through thread/start and turn/start without native model overriding explicit role choices; all state keyed by host.
- [ ] Render engine/model/prompt controls per role, host behavior options, complete engine catalogs; UI labels identify role and actual engine/model.
- [ ] Enable remote capability/mode/template/history/run operations; preserve no-capability native Codex operation and actionable error. No hardcoded local-only gates.
- [ ] Test stale reads, prewarm, two hosts with same thread IDs, busy selection locking and failed discovery.

## Task 5 — Native verification and release
Files: tests/agent-modes/live-remote.mjs, docs/remote-claude-validation.md, docs/agent-modes.md; ignored .artifacts evidence.
- [ ] Run all focused suites after integration and independent spec/quality review.
- [ ] Deploy to temporary/private own paths on six reachable clusters and run real dual workflow + random-marker Read evidence with exact models; test rno pending approval reconnect and restart.
- [ ] Build unique preview and GUI verify rno remote workflow, same-engine roles, custom host, model catalogs and local regression. Use computer-use skill exclusively for GUI.
- [ ] Build and verify production bundle, preserve current hosting processes, back up and install only after acceptance; report restart requirement and any unverified cluster separately. No push implied.

