# Long-history connection recovery plan

Use subagent-driven-development: one implementation task at a time, then independent specification and quality reviews. User approval is already established by the explicit optimization request following the diagnosed failure; continue through concrete repair and safe deployment.

Baseline: `bb1d0da`, matching the installed remote archive `31371cdfbecb763d4691027232a14a57c794a9fadf786d1388c86e9f4051f6d8`. Runtime fingerprints are in `.artifacts/bar-source-baseline.json`. Original workspace contains unrelated differences in router/events/daemon and requires a three-way application of only the reviewed patch.

## Task 1: History pagination and hydration

- [x] Add failing behavior tests in `tests/agent-modes/large-history.test.mjs`: notLoaded excludes item bodies; full/item pages preserve complete content; byte-limited pages visit each anchor once in both directions; a single over-target entry is delivered alone; only selected rows are presented; subsequent managed history pages do not invoke native history hydration, while explicit resume/read refreshes it.
- [x] Modify `runtime/agent-modes/codex-events.mjs` page/presentation helpers and narrow paths in `runtime/agent-modes/router.mjs`. Optional fourth page options carry a byte budget and lazy value presenter; existing three-argument calls retain compatibility. Avoid mapping/cloning all turn bodies before slicing.
- [x] Track unpersisted native deltas per turn; refresh only affected full/item pages, retaining cached metadata/completed pages. Keep forwarded delta revisions distinct from stored-data revisions so output hydration and stored notification race protection both work.
- [x] Preserve history recovery and live notification revision logic. Run new tests and existing router, events, and history suites; record failing-before/passing-after evidence.

## Task 2: Bounded responses and diagnostic errors

- [ ] Add actual proxy/server tests for 28.5 MB responses, >64 MiB response rejection with connection survival, a healthy subsequent RPC, read-only request count caps, and output pressure on a single RPC without controller loss.
- [ ] Add `runtime/agent-modes/remote/limits.mjs` for shared transport constants/response error helpers if needed. Keep request ceiling 16 MiB, proxy legacy receive ceiling 128 MiB, RPC response ceiling 64 MiB. Do not raise limits without pre-send response checks.
- [ ] Update proxy/server send paths and daemon diagnostics. No request replay. Preserve pending approvals and disconnect cleanup. Payload/error diagnostics must contain no transcript bodies.
- [ ] Add `remote/history-snapshot.mjs` and snapshot pagination tests: only after a successful forwarded read/resume/page and initialization, read the managed owner's atomically written snapshot for later pages. Validate identity/schema and no symlinks, bound size/concurrency and cancellation, never mutate snapshot/store. Fall back on missing/unsupported data, pending history edits, or full pages intersecting active Codex turns whose streaming deltas are not all persisted. This bypasses repeated full hydration on an older busy gateway while preserving its task.
- [ ] Run focused tests plus the existing proxy liveness, server, agent map, daemon, and upstream regressions sequentially to avoid known test contention.
- [ ] Specification review, then quality review; resolve findings and commit the bounded changes.

## Task 3: Safe deployment and evidence

- [ ] Build from the current installed archive using reviewed files only; verify deterministic packaging, unchanged unrelated files, and strict app signatures. Preserve a rollback app and baseline source backups.
- [ ] Verify active local and bar tasks before switching anything. Publish the new remote digest and reconnect bar's transient proxy using the new runtime while preserving its busy gateway. Install the desktop package without forcing active tasks to stop; retain gateway upgrade deferral where required.
- [ ] Use actual large-history read-only requests and desktop logs to verify connection stability and record detailed error diagnostics if reproduced. Confirm the original active gateway/task remains alive.
- [ ] Apply only the reviewed changes to the original working tree with a three-way merge where baseline hashes differ. Preserve the repair worktree and report exact runtime/deferred state and validation.

## Task 1 verification

Implementation commits: `c26859f`, `2747ccf`. Specification review passed, then quality review caught and verified the live-output dirty-revision repair. Root independently ran events, history, edits, large-history and stream-responsiveness tests sequentially: **38/38 passed**. The broader implementer suite passed **92/94**; the same two pre-existing Claude model expectation failures remain at `router.test.mjs:291` and `:315`. An independent broader review also identified two unchanged timestamp expectations in `claude-events.test.mjs:232` and `:249`; neither implementation nor tests in that file changed.
