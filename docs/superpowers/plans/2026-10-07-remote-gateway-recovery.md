# Remote Gateway Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and two-stage review.

**Goal:** Recover broken development remote connections and prevent stale proxy and unbounded native RPC accumulation.

**Architecture:** End-to-end downstream heartbeat in the existing proxy; per-request native deadlines; scoped runtime deployment and duplicate execution retirement.

**Tech Stack:** Node.js, ws, node:test, Electron packaged runtime, SSH, Linux pidfds.

## Task 1: Runtime behavior and regression tests

Files: `runtime/agent-modes/remote/proxy.mjs`, `runtime/agent-modes/upstream.mjs`, `tests/agent-modes/remote-proxy-liveness.test.mjs`, `tests/agent-modes/upstream.test.mjs`.

- [x] Add failing proxy integration tests with actual WebSocket peers and an injectable short heartbeat interval. Connect with `autoPong: false`, initialize, verify ownership is released, then initialize a replacement against the same server. A normal client must survive multiple ping cycles.
- [x] Add failing native tests with a subprocess that selectively withholds or delays replies. Assert timeout rejection, `client.pending.size === 0`, no replay of a mutating request, successful subsequent calls, and clean timer shutdown.
- [x] Run `node --test tests/agent-modes/remote-proxy-liveness.test.mjs tests/agent-modes/upstream.test.mjs` and record the expected behavioral failures.
- [x] Implement downstream heartbeat/cleanup and a 30000ms native request deadline. Deadlines reject with an explicit timeout error and are cleared on every settlement path.
- [x] Re-run focused tests and the existing remote-server/remote-agent-map suites.
- [x] Review spec compliance, then code quality; repair findings and commit the bounded patch.

## Task 2: Package and operational recovery

- [x] Extract the installed remote-runtime archive into a staging directory. Replace only the reviewed runtime files, then run `packageRemoteRuntime(stage, output)` from `scripts/remote-runtime-package.js`. Verify determinism and SHA-256.
- [x] Back up the previous archive, manifest and replaced installed files. Stage and verify a signed app copy before replacing the authorized installed runtime.
- [x] On sko, record stopped PID, parent, exact scope, active duplicate turn and current official backend. Retire only the stopped development native process and its scoped gateway; preserve official processes and submitted jobs.
- [x] On blc/blc-2, upgrade only after health confirms no active work. On other hosts keep busy owners intact. Deploy into the new digest directory with verified tar SHA-256.
- [x] Trigger development reconnection, verify actual desktop logs show all three hosts connected with no error, and inspect matching remote runtime versions.
- [x] Apply only the reviewed source files to the original workspace when their baseline hashes still match. Retain backup and worktree for review. Report exact validation and any upgrade intentionally deferred on active hosts.


## Verification evidence

- Runtime repair commit: `c6e08141a2d32c217fc51c26f806c3c219da65ce`; isolated deployed baseline: `16985336bf08d24e1b0b54db98f95cc071fc6c90`.
- Sequential verification: 33 tests passed, 0 failed/cancelled, using `node --test --test-concurrency=1` with remote proxy liveness, upstream, remote server, remote agent map, and remote daemon suites. See `.artifacts/verification-tests.tap`.
- Independent spec and code quality reviews approved the runtime patch and scoped recovery procedure.
- Deterministic remote archive SHA-256: `31371cdfbecb763d4691027232a14a57c794a9fadf786d1388c86e9f4051f6d8`; 6,404 files, only proxy and upstream source replaced. Both staged and installed app passed strict deep signature verification. Frontend archive unchanged.
- Full installed-app rollback: `.artifacts/rollback-20261007T0928Z/chatgpt-dev.app`; previous original workspace files saved in `.artifacts/original-source-backup`.
- sko's stopped duplicate native PID 303041 was retired without SIGCONT, along with its wrapper/gateway. Its development turn was marked interrupted on restart. Official backend PID 303740 retained its original process start and remains running. Remote conversation backup is recorded in `.artifacts/sko-retirement.json`.
- sko, blc, and blc-2 report the new runtime version. Real development app PID 12812 logged all three connected with `error=null` at 09:31:24–09:31:26 UTC on 2026-10-07. See `.artifacts/desktop-connected.json` and per-host verification JSON files.
- Only the four reviewed runtime/test files were copied to the original workspace after exact baseline checks. The isolated repair branch and rollback artifacts are retained; no unrelated working-tree changes were merged.
- Final observation at 09:33:14 UTC: all three desktop connections remained connected with no errors or transport restarts for more than 107 seconds. Each target has exactly one gateway and one proxy using the new runtime; no active duplicate turn remains. See `.artifacts/final-verification.json` and `.artifacts/{sko,blc,blc-2}-final.json`.
