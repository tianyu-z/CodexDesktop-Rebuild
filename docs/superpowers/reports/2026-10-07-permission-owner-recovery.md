# Restart permission mismatch in chatgpt-dev

## Scope and observed failure

The user reports intermittent Terminal approvals after restarting chatgpt-dev,
while the selector shows Full access. The affected chat is **Review scaling
ladder config**, thread `01a0dff5-e241-73a3-9c26-02b62fe7abe5`, on `rno` in
`/mnt/vast/home/tianyu.zhang/code/VeOmni`. This repair addresses code and transport
ownership. No permission toggle or approval button was used.

## Evidence

On 2026-10-07, both the official native daemon (PID 20516) and the development
gateway's private native process (PID 4111030) held the same real rollout open.
Both native executables were version 0.142.5. The official desktop used
`codex app-server proxy`; the development gateway spawned its own stdio
`codex app-server` under gateway PID 4110941.

The screenshot's approval was emitted at `2026-10-06T04:46:22.149Z`, for native
turn `09cb2759-0e22-4530-b319-34632f525e5b` and call
`call_dp98u2K6tau84lbMLlvQl7VN`. Its execution context was workspace-write and
on-request. Neither a paired output nor a terminal event was recorded for that
turn. It must not be silently approved or treated as completed.

At inspection, the shared native database and latest rollout context instead
recorded disabled sandbox / never. The latest context was Full access at
`2026-10-07T11:31:57.779Z`. Old restricted and newer Full access turns interleaved
in the same rollout. A separate native owner can retain older in-memory policies
after another owner changes persisted settings.

The existing legacy cold-resume migration was already deployed on rno. An
isolated native 0.142.5 reproduction confirmed that it restores legacy Full
access correctly before a cold resume. A two-owner reproduction confirmed that
an already loaded restricted owner stays restricted after another owner writes
Full access. Removing the loaded-thread guard would overwrite valid in-memory
choices and is not a sound repair.

## Reviewed corrections

1. Native approval mappings are retired on a terminal event for the exact thread
   and turn only. Late answers and duplicate resolutions are ignored. Unscoped,
   live, and other-thread approvals remain intact. Commits `1cccb94`, `d41fe1d`.
2. Frontend resume projection takes the actual native sandbox, approval policy,
   reviewer, and workspace roots. A legacy Full access label survives only when
   the response confirms dangerFullAccess / never. Custom profiles retain their
   established behavior. Commit `a71faac`.

Both corrections passed independent specification and quality review. Neither
correction by itself repairs the two-owner root cause or retires the real
nonterminal approval described above.

## Shared native owner fix

The transport change makes remote main sessions attach to the same
native daemon as the official desktop. Gateway routing, Claude execution, and
isolated role sessions remain separate. Attachment failure exits without a private-owner fallback. Closing the gateway
closes its own proxy and preserves the shared daemon.

An isolated daemon with two official proxy clients passed the following checks:

- Both clients initialized against native 0.142.5.
- The second client resumed the first client's Full access thread with the same
  dangerFullAccess / never / :danger-full-access settings.
- A thread name notification reached the second client after resume.
- Closing one proxy left the daemon and the other client usable.

The root independently ran the new bridge against the pinned rno 0.142.5
release. A second client resumed with only `threadId` and retained Full access.
After the first client explicitly selected workspace-write / on-request, a
second bare resume retained that restriction. The second client could still
read the thread after the first proxy closed. The test materialized its own
empty rollout with `thread/name/set`, ran no model turn, and stopped/removed its
isolated daemon and home. Evidence:
`.artifacts/shared-native-rno-0.142.5.log`.

Read-only compatibility checks found running official daemons on sko and blc
(0.144.5), and blc-2 and bar (0.154.0). Production daemons were not restarted.

Review identified the existing assumption that gateway exit implies native
turn exit. The shared-daemon path now restores authoritative active-turn state,
including orphan history, missing current-turn details, and late snapshot
responses after completion. The corrections are implemented in `6afa80d`,
`eb30207`, and `8793d2e`. Hydration and
sidebar lists preserve newer lifecycle events over delayed metadata. An
active snapshot restores known/current ownership or an unknown-active guard;
an authoritative idle snapshot clears native ownership while preserving
managed Claude and dual runs. Pending local submissions retain their original
input and acknowledgement state until native acknowledgement. Startup failure
releases only owned CLI pipe
handles after a bounded drain, including inherited-pipe cases.

## Verification and deployment record

Final root regression: **143/143 passed** across shared transport, remote daemon,
router/store, native approval lifecycle, remote server, permission projection,
and legacy resume. Evidence: `.artifacts/permission-owner-root-regressions.log`.
Specification and quality reviews approved the final implementation through
`8793d2e`; their final focused runs passed 16 and 11 tests respectively.

Two existing `router.test.mjs` assertions expect a Claude model of `default` or
`undefined`, while the product default is `claude-opus-5-5[1m]`. Both reproduce
in an isolated checkout of base `7526380`; they were explicitly excluded from
the final permission regression command. The unfiltered intermediate broad run
passed 93/95. Baseline and broad-run evidence are retained in
`.artifacts/shared-native-baseline-router.log` and
`.artifacts/shared-native-followup-regressions.log`.

The source was merged back into the original project with per-file backups,
three-way merges, and a narrowly resolved test-block insertion. Independent
original-workspace tests were preserved. Its integration run passed 112/114;
two fixture startup deadlines expired under load, then both passed in an
isolated rerun. Evidence is under `.artifacts/source-permission-owner-merge/`.
The earlier permission projection/approval merge separately passed 21/21.

The signed application was installed at `/Applications/chatgpt-dev.app` by an
atomic directory exchange. Runtime:
`610a9fa145d4c627dc4df78cdf00cbcadfa516f3eb2be0189b31811f86dceae6`.
The new frontend archive hash is
`820e691dbe03cfbff689955f128350e572313021158998bdf36568086aa96fd5`.
The build verified 8,618 unrelated archive files and 6,401 unrelated remote
runtime files were preserved. It retained prior history editing/connection
fixes and the concurrently installed `cdx-approval-owner-recovery-v1` frontend
patch. A stale candidate was rejected after detecting that concurrent update;
the installed build was made from the updated application.

The release was uploaded to rno. At `2026-10-07T13:05:21.986Z`, safe preparation
returned `upgradeDeferred: true`: the old gateway was still busy with two real
native tasks, including **Review scaling ladder config**. The last verified
remote runtime was
`dfceacacc13fe44296541b12e18ba702cef4fc65aa06bd1fd18adcbf5b062f61`.
The official daemon PID 20516 and its original start time were preserved at
that inspection.

On 2026-10-07 the user explicitly authorized immediate activation. The installed
runtime manifest, frontend archive SHA-256, and shared-native helper SHA-256
were rechecked and matched this release. chatgpt-dev was quit normally and
restarted. Its old desktop/runtime/native PIDs 83818, 83907, and 83954 exited;
new desktop PID 27547 was verified at `2026-10-07T18:29:28.064357+00:00`.
The official local desktop PID 99053 and native PID 99152 were preserved.
The restarted development UI was subsequently verified as running.

**Local activation is complete; remote activation is blocked by SSH key
signing, not by missing user authorization.** Before and after the local
restart, rno login failed with `Permission denied (publickey)` and Secretive
`agent refused operation` / `communication with agent failed`. The same
failure was visible in the development UI before restart. The user was asked
to complete local Secretive/Touch ID authentication. No remote gateway stop
was attempted, and current remote runtime/permissions could not be freshly
verified. Once authentication is restored, continue with read-only inspection,
stop only the old scoped development gateway if still necessary, activate the
new runtime, and verify the shared daemon plus the affected chat's actual
permission state. Existing authorization covers that migration.

No approvals were auto-answered, no permission selector was changed, and the
old nonterminal approval was not fabricated as completed.

Release/install/state evidence:

- `.artifacts/permission-owner-release/build-manifest.json`
- `.artifacts/permission-owner-install.json`
- `.artifacts/rno-permission-release-state.json`
- `.artifacts/rno-permission-activation-state.json`
- `.artifacts/source-permission-edge-merge/manifest.json`
- `.artifacts/source-permission-owner-merge/manifest.json`

The independent rollback copy is
`.artifacts/rollback-permission-owner-20261007/chatgpt-dev.app`; the prior bundle
is also parked at `/Applications/.chatgpt-dev-before-permission-owner.app`.
