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

The first local restart could not complete the remote migration: Secretive
returned `agent refused operation` / `communication with agent failed`, ending
in `Permission denied (publickey)`. On the user's subsequent retry, an existing
SSH master was usable and remote migration proceeded.

At `2026-10-07T20:46Z`, scoped gateway `chatgpt-dev-4027ac0d116d` was switched to
runtime `610a9fa145d4c627dc4df78cdf00cbcadfa516f3eb2be0189b31811f86dceae6`.
Old gateway/native PIDs 4110941/4111030 exited. New gateway PID 3403812 uses
bridge PID 3404245 and official proxy PID 3404306. The bridge attaches to
`.codex/app-server-control/app-server-control.sock`. Official daemon PID 20516
retained its original starttime 8081145. Unrelated gateway scopes were not
stopped. Desktop PID 27547 was quit normally and the release launched as
PID 44586. The official local desktop/native PIDs 99053/99152 remained alive.

A bare `thread/resume` through the actual new gateway returned
**workspaceWrite / on-request**, with the affected chat active and the original
`09cb2759-0e22-4530-b319-34632f525e5b` approval still pending. The check expecting
Full access correctly failed; persisted disabled/never values did not reflect
the existing official owner's in-memory state. This strengthens the two-owner
diagnosis and means migration alone cannot complete an already pending native
request. No model turn or permission override was sent by the probe.

## Additional legacy picker correction

Live UI verification exposed another independent mismatch. The successful
resume log at `2026-10-07T20:52:28.465Z` records `:workspace / on-request`, yet
the legacy permission picker still displayed Full access. Its `KG` hook chose
the host's stored mode ahead of the restored chat's `threadMode`, and prepared
an implicit override for the next turn. Commit `3b0d9e9` changes that precedence:
existing chats use their own permitted mode, including explicit next-turn
settings; new chats retain host defaults. Loaded policy requirements and
model-required Guardian mode retain priority. Registered custom profile
identity is preserved.

Captured production-hook tests failed in three cases before the correction:
restricted chat versus Full access host default, Full access chat versus
restricted host default, and custom profile. Review caught an allowed-policy
fallback regression; its new test failed before adding the policy guard.
Final root and original-workspace runs both passed **23/23**. Independent
review approved the guarded implementation. Evidence:
`.artifacts/permission-picker-regressions.log` and
`.artifacts/source-picker-merge/tests.log`.

The frontend-only update is signed and installed. New ASAR SHA-256:
`ae2667da4c61c1973a777ab59b3b224a8aacaf1af07e6d3d071364961c54a7eb`.
All 8,618 unrelated ASAR files were verified unchanged; the entire runtime
inventory, including remote archive 610a9fa, stayed identical. Its prior bundle
is parked at `/Applications/.chatgpt-dev-before-permission-picker.app`, with an
independent backup in `.artifacts/rollback-permission-picker-20261007/`.

**Remote shared-owner activation is verified. The additional picker patch is
installed but its UI activation remains pending manual Mac unlock.** At
`2026-10-07T21:15:28Z`, Computer Use returned `The Mac is locked and automatic
unlock could not unlock it`; the attempted GUI quit did not run. PID 44586
therefore still holds the earlier frontend. The user was asked to unlock the
Mac. Existing authorization covers the subsequent normal restart and checks.

## Connection investigation during activation

SSH authentication and ongoing SSH transport latency are distinct failures.
The app reconnected to rno, then repeatedly encountered
`REMOTE_HEARTBEAT_TIMEOUT` / `desktop-inbound`; one separate startup stalled
at `auto-mux: Trying existing master` before session acknowledgement. There is
no evidence that the incidental remote `.gitconfig` lock warning caused this:
another heartbeat failure lacked that warning.

A read-only 75-message echo test through the exact login wrapper and existing
SSH master, with the remote shell replaced by `/bin/cat`, reproduced severe
latency outside the application/gateway: session acknowledgement 26.051s,
marker 37.433s, RTT p50 17.801s, p95 25.504s, max 27.868s. All 75 replies
arrived; local send scheduling and write callbacks remained responsive. Early
samples were 0.187–0.814s, then rose after the app connection reopened. Both the
official app and dev app were verified sharing SSH master PID 42003. The route
to rno used utun4; four ICMP probes had 0% loss and 491–677ms RTT. Shared SSH
traffic, remote scheduling, and tunnel/TCP congestion still need a controlled
comparison; a single specific bottleneck has not been proven.

The heartbeat timer starts when a ping is queued, not when it is delivered,
so its direction label alone does not identify which side stalled. No timeout
was inflated and no SSH config was changed without evidence. A separate fresh
connection was attempted once and rejected by Secretive; the later Mac-lock
finding is consistent with authentication being unavailable while locked.
Next verification: compare echo delay with dev closed, then reopen the patched
frontend and inspect the affected chat's permission label and connection.

Evidence: `.artifacts/rno-ssh-latency-2026-10-07T21-10-43-427Z.json`,
`.artifacts/rno-permission-live-after-activation.json`,
`.artifacts/rno-permission-owner-live-resume.json`, and
`.artifacts/permission-picker-release/build-manifest.json`.

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

## Retry and direct native socket correction

At 21:19Z the Mac was still locked. Existing SSH masters remained reachable.
Read-only gateway checks returned in 2.081s on bar and 33.648s on rno. rno's
610a gateway remained healthy/busy. bar had no reachable scoped gateway socket;
its gateway log repeatedly reported `Shared native daemon handshake timed out`.

The shared bridge launched an additional `codex app-server proxy` subprocess
and imposed a 5-second handshake deadline. On bar, the actual CLI proxy took
18.596s to produce HTTP 101; a native `--version` call took 12.594s, and other
CLI probes exceeded 20s. In contrast, direct HTTP upgrade on the same existing
native Unix socket took 0.2ms. The shared home's `.codex/tmp/arg0` contained
79,471 entries and its directory scan took 3.400s, consistent with expensive
CLI startup/cleanup; no temporary directories were deleted. Evidence:
`.artifacts/bar-native-handshake-retry.json` and
`.artifacts/bar-socket-retry.json`.

Commit `48c2d6c` removes that additional CLI startup. The JSON-line bridge now
opens the official daemon's existing Unix WebSocket directly. Official daemon
startup/discovery, permissions, request framing, payload bounds, and the
5-second socket-handshake deadline remain in place. Closing the bridge closes
only its client socket; missing/unresponsive sockets fail without a private
native fallback. The live isolated-daemon probe uses a private test-only Unix
relay for its remote socket.

The new stalled-CLI regression failed with the original handshake timeout and
passed after the change. Root verification covered 28 distinct tests across
shared-native, remote daemon/server, and native request/approval lifecycle
suites, all passing across the focused runs. An initial concurrent run also
hit an unchanged CLI fixture's 2-second startup deadline; the sequential rerun
passed. Independent review approved the final change and passed 19 tests.
The source merge into the original workspace preserved existing edits. Its
integration run passed 27/28: the unrelated pinned-desktop fixture could not
open the preexisting missing `src-DJnwJvdz.js` in that workspace. That test
passes in the repair worktree where its pinned source is present. Evidence:
`.artifacts/shared-native-socket-red.log`,
`.artifacts/shared-native-socket-regressions.log`,
`.artifacts/shared-native-socket-additional.log`, and
`.artifacts/source-native-socket-merge/tests.log`.

The exact revised bridge was then tested on both real remote hosts, using only
`initialize`, `initialized`, and `thread/list(limit=1)`. bar's native 0.154.0
initialized in 112.1ms and listed in 72.5ms; rno's 0.142.5 initialized in
138.8ms and listed in 392ms. Both succeeded. Temporary bridge files were
removed, and no model turn, thread setting, approval response, or production
daemon stop was issued. Evidence: `.artifacts/native-direct-live-results.json`.

This resolves the unnecessary CLI startup in the shared-owner attachment
path. It does not establish that rno's shared SSH transport delay is fixed.
Frontend restart/visual verification still requires manual Mac unlock; the
last GUI retry returned the same locked-Mac error.

The revised signed bundle was installed by atomic exchange at approximately
21:38Z. Its remote runtime archive is
`dc066ef461979de93d714049b7b6042d2a56959f54bc26065a98e1b5bc586b33`.
The frontend ASAR remains byte-for-byte
`ae2667da4c61c1973a777ab59b3b224a8aacaf1af07e6d3d071364961c54a7eb`, including
the picker correction. The build verified 8,618 unrelated ASAR files and
6,405 unrelated remote runtime files unchanged. Backups:
`/Applications/.chatgpt-dev-before-native-socket.app` and
`.artifacts/rollback-native-socket-20261007/chatgpt-dev.app`. Evidence:
`.artifacts/native-socket-release/build-manifest.json` and
`.artifacts/native-socket-install.json`.

Installation is complete; activation is still pending. Desktop PID 44586
continues running its previous frontend. Official desktop/native PIDs
99053/99152 remained alive. The new dc066ef remote release was not deployed
or forced over a busy gateway while the desktop remained locked. After manual
unlock, quit only chatgpt-dev normally, measure rno SSH latency with dev closed,
then launch the installed app and verify bar startup plus the affected rno
chat's permission label. Preserve the pending native request and the official
daemon. Compare rno transport latency after reopening before attributing that
remaining delay to a specific cause.
