# Fork active managed conversations

User request: remove the chatgpt-dev prohibition on forking while a conversation is running.

## Scope and behavior

- Apply the idle guard only to mutations of original history (rollback/revert).
- Fork a cloned public snapshot at the requested boundary; retain partial output as interrupted historical content in an idle child.
- Keep completed native history, detach an active native turn, and clear mutable workflow/session ownership.
- Freeze detached agent details rather than refreshing them from source-owned child sessions.
- Never interrupt or replay the source. Failed fork cleanup owns only the new child.
- Leave pure native Codex routing unchanged.

## Validation and delivery

Use regression tests for active Claude, Codex/mixed and workflow histories, boundary selection, concurrent notifications, child continuation, child-only cleanup, and detached delegation details. Independently review spec compliance and code quality. Package only history.mjs and agent-map.mjs from the installed baseline; verify deterministic archive and signature. Preserve the desktop process and drafts with an atomic resource install. Upgrade bar only through the gateway idle guard, then use disposable conversations to verify native active fork and both continuations. Apply only this repair to the original workspace and retain a verified rollback copy.

## Verification evidence

- Commits: f4585ad (active forks), 12be5a0 (detached agent snapshots), 7276820 (cache scope remapping).
- Relevant worktree suites: 87/87 passed. Original workspace history/map suites: 50/50 passed.
- Spec and quality reviews approved after fixing detached agent refresh and native-ID cache remapping.
- Two broad router tests have stale Claude default-model expectations; both reproduce on clean baseline 1cccb94. Unrelated proxy pressure test failed in a combined reviewer run and passed its isolated retry.
- Isolated bar native probe passed: active earlier-boundary fork, active partial-turn fork, idle children, independent child continuation, uninterrupted source completion, source-content isolation, first-ever active-turn fork. Temporary test chats were archived.
- The initial native probe had an ownership-guard fixture error: newly created child IDs needed registration before managed child truncation. After correcting the fixture and cleaning the test-only orphan, the full probe passed.
- Installed archive: c29a72740f2fb9950a7ad3ce6678987f0f5efb329fad1311fd433d61711a3b8c; baseline: 3c8ceaa30e576503ea434050bb6523ce4dc3468234e9d73899d9a3592f5a2519.
- Changed packaged files only: history.mjs and agent-map.mjs. Deterministic archive, strict deep signature, unchanged frontend, and other runtime inventory verified.
- Atomic resource installation preserved running development app PID 47935. Verified rollback copy: .artifacts/rollback-active-fork-20261007/chatgpt-dev.app.
- Repair applied to original workspace using three-way merges of only the three implementation/test files.
- Gateway activation waits for bar to be idle; never forces shutdown. Evidence/logs under .artifacts/active-fork-*.

## Activation handoff

At the last live check, bar still had an active user turn on the old gateway. A detached one-shot activation worker (PID recorded in .artifacts/active-fork-activation.pid) polls the scoped health endpoint and invokes the guarded prepare only when idle. It exits once the repair is active, or if the installed app version changes, preventing a stale downgrade. It never force-stops the gateway. Successful activation writes .artifacts/active-fork-bar-after.json. The current activation state is recorded in .artifacts/active-fork-activation.log; do not claim the live gateway is upgraded until that evidence confirms it.
