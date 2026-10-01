# Full access permission profile synchronization

## Reproduction and cause

The affected remote chat is `01a0f460-68f5-75e3-8775-89d2cc5f1fde` on
`remote-ssh-discovered:rno`, titled `梳理 v2-v25 filter review (3) (3)`.
The installed native frontend is `26.820.71523`.

On 2026-09-30, the fork was resumed with `:workspace` and `on-request`.
The inherited legacy history contained `danger-full-access` and `never`.
The next turn's desktop log recorded:

```text
requestApprovalPolicy=never
requestPermissionProfile=:workspace
requestSandboxPolicyType=null
```

The remote rollout at `2026-09-30T22:16:00.954Z` confirms `workspace-write`
with restricted network and `approval_policy=never`. Commands then failed with
`bwrap: Failed to make / slave: Permission denied`. The UI displayed Full access.

Native turn preparation (`Jzn`) and resume preparation (`lpt`) resolved a legacy
sandbox from history/settings, but borrowed a profile from `currentPermissions`.
Since a non-null profile suppresses the legacy sandbox field on the wire, the
workspace profile won. Toggling permissions replaced this mixed state, explaining
the user's workaround.

## Fix

`scripts/patch-permission-profiles.js` changes three exact native seams and
injects one small resolver. A profile is selected from the same source priority
as the sandbox: explicit turn request, latest settings, previous turn, current
permissions. An explicit `null` clears a profile. A legacy sandbox without a
profile also stops inheritance from older sources. Approval-only changes do not
clear a profile, and custom profile identities/extends are retained.

No sandbox backend or approval policy is bypassed. Full access is honored only
when it is already the selected sandbox. Workspace/read-only choices cannot
inherit an older Full access profile. Native server-default permission selection
continues to omit overrides.

The patch is idempotent and rejects missing/duplicate native seams. It runs in
the normal patch pipeline for the pinned frontend and both existing preview
builders. The general cross-version CLI skips unsupported upstream bundle names;
the explicit patch/build API remains strict. The dedicated
builder patches the installed app's archive without replacing other installed
runtime changes, checks unchanged archive contents and runtime hashes, updates
ASAR integrity, and signs/verifies the staged app before installation.

## Validation

```sh
node --test tests/agent-modes/permission-profile-sync.test.mjs \
  tests/agent-modes/patch.test.mjs tests/agent-modes/frontend.test.mjs \
  tests/agent-modes/bootstrap.test.mjs tests/agent-modes/remote-sandbox.test.mjs
node scripts/build-permission-profile-fix.js
```

The initial three regression tests failed with the actual stale `:workspace`
selection before the fix. The tests execute the captured native turn request
builder, stubbing workspace services only. Additional cases cover restricted
legacy settings, explicit sandbox/profile changes, explicit null, custom
profiles, native server defaults, and patch drift/idempotence.

On 2026-09-30, all 70 targeted tests passed. Independent review found no resolver
or security issues and identified the cross-version CLI guard, which was fixed
with a failing-then-passing regression test. Unsupported upstream bundles are left unchanged by the general CLI. The signed application was installed
at `/Applications/chatgpt-dev.app` with only
`webview/assets/app-initial-CX2pZp2Q.js` changed. The builder verified 8,618 other
archive files and the complete installed agent runtime were preserved.

After reopening the installed app, the original affected chat was tested without
changing the permission selector. Its next request sent
`approvalPolicy=never` and `permissions=:danger-full-access`. Remote turn
`01a0f480-417a-7831-a771-1880fda51bc4` recorded `danger-full-access` and a disabled
permission profile at `2026-09-30T22:47:21.238Z`. Its single `exec_command` call
ran `/bin/pwd`, returned exit code 0 and `/mnt/vast/home/tianyu.zhang/learn`, then
completed with `PERMISSIONS_OK` at `22:47:36.132Z`.

The 759 MiB legacy history also exposed a separate latency issue: several history
RPCs took around 33–36 seconds, and the desktop's 30-second turn-start timeout
fired before its successful acknowledgement. The diagnostic was submitted only
once; no retry was sent, and its restored draft was cleared after completion.
This patch does not change history loading or RPC timeouts.

Local build and live verification evidence is kept in `.artifacts/full-access/`.
The dedicated builder's manifest records the source/runtime digests so a later
installation can reject a candidate if another task has updated the app.

Official reference: [Codex sandboxing](https://developers.openai.com/codex/sandboxing).

## Follow-up: legacy cold resume

The `Review scaling ladder config` chat on `rno` exposed a second path. At
2026-10-01T03:38:48Z an automatic goal continuation used
`workspace-write / on-request`, followed by the same `bwrap` error. Earlier and
later turns used Full access. The desktop had resumed the thread before it had
any historical permission settings and omitted permission overrides.

An isolated native app-server reproduction confirmed the missing compatibility
step: a legacy turn with `sandbox_policy=danger-full-access` and no
`active_permission_profile` resumes with `:workspace` after a process restart.
The equivalent turn with the named `:danger-full-access` profile survives the
same restart. Injected diagnostic history materialized the test thread without
running model inference; each probe used its own temporary native home.

`runtime/agent-modes/legacy-permission-resume.mjs` now supplies the corresponding
named profile before cold resume, only when the latest legacy context and the
native `state_5.sqlite` row both agree that the thread has Full access. This DB
check matters because `thread/settings/update` persists a new restriction before
the next `turn_context` is written. Loaded threads, explicit request policies,
named/custom profiles, unsupported policies, and missing or ambiguous state
retain native behavior. Tail reading is bounded to 32 MiB and requires complete
JSONL records. The DB is read-only and its thread ID, rollout path, resolved
policy, and approval mode must match.

The migration uses `node:sqlite` when available and otherwise skips. The target
`rno` host runs Node 22.17.1 and the bundled local runtime is Node 24.14.1; older
Node 20 installations do not receive this compatibility migration. Granular
approval-policy objects and native rollback/revert behavior are outside the
verified migration cases.

Validation on 2026-10-01: 93 targeted tests passed, plus real native process
restarts verified both legacy Full access restoration and preservation of a
newer `:workspace / on-request` choice. Independent review verified the latter
case. The dedicated builder patches both the installed local runtime and its
separate remote archive, verifies unrelated contents, and retains the previous
frontend fix and installed Claude changes.

The live VeOmni goal was left running. Its 05:57:18Z context still recorded
`danger-full-access / never`, and commands continued exiting successfully through
06:07:51Z. No permission toggles, new user prompt, or model inference were sent
to that chat for these checks. Probe evidence is under `.artifacts/full-access/`.
