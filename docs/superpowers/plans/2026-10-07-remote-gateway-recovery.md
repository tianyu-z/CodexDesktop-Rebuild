# Remote Gateway Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and two-stage review.

**Goal:** Recover broken development remote connections and prevent stale proxy and unbounded native RPC accumulation.

**Architecture:** End-to-end downstream heartbeat in the existing proxy; per-request native deadlines; scoped runtime deployment and duplicate execution retirement.

**Tech Stack:** Node.js, ws, node:test, Electron packaged runtime, SSH, Linux pidfds.

## Task 1: Runtime behavior and regression tests

Files: `runtime/agent-modes/remote/proxy.mjs`, `runtime/agent-modes/upstream.mjs`, `tests/agent-modes/remote-proxy-liveness.test.mjs`, `tests/agent-modes/upstream.test.mjs`.

- [ ] Add failing proxy integration tests with actual WebSocket peers and an injectable short heartbeat interval. Connect with `autoPong: false`, initialize, verify ownership is released, then initialize a replacement against the same server. A normal client must survive multiple ping cycles.
- [ ] Add failing native tests with a subprocess that selectively withholds or delays replies. Assert timeout rejection, `client.pending.size === 0`, no replay of a mutating request, successful subsequent calls, and clean timer shutdown.
- [ ] Run `node --test tests/agent-modes/remote-proxy-liveness.test.mjs tests/agent-modes/upstream.test.mjs` and record the expected behavioral failures.
- [ ] Implement downstream heartbeat/cleanup and a 30000ms native request deadline. Deadlines reject with an explicit timeout error and are cleared on every settlement path.
- [ ] Re-run focused tests and the existing remote-server/remote-agent-map suites.
- [ ] Review spec compliance, then code quality; repair findings and commit the bounded patch.

## Task 2: Package and operational recovery

- [ ] Extract the installed remote-runtime archive into a staging directory. Replace only the reviewed runtime files, then run `packageRemoteRuntime(stage, output)` from `scripts/remote-runtime-package.js`. Verify determinism and SHA-256.
- [ ] Back up the previous archive, manifest and replaced installed files. Stage and verify a signed app copy before replacing the authorized installed runtime.
- [ ] On sko, record stopped PID, parent, exact scope, active duplicate turn and current official backend. Retire only the stopped development native process and its scoped gateway; preserve official processes and submitted jobs.
- [ ] On blc/blc-2, upgrade only after health confirms no active work. On other hosts keep busy owners intact. Deploy into the new digest directory with verified tar SHA-256.
- [ ] Trigger development reconnection, verify actual desktop logs show all three hosts connected with no error, and inspect matching remote runtime versions.
- [ ] Apply only the reviewed source files to the original workspace when their baseline hashes still match. Retain backup and worktree for review. Report exact validation and any upgrade intentionally deferred on active hosts.
