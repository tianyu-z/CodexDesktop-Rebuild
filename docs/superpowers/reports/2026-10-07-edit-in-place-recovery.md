# Edit-in-place retry and frontend ownership recovery

Affected chat: rno / VeOmni / Review scaling ladder config,
`01a0dff5-e241-73a3-9c26-02b62fe7abe5`.

## Evidence and cause

The installed branch helper consumed its single global `mode` before attempting
an edit. After an in-place attempt rejected, the editor remained open but its
mode was gone. Sending the same draft again therefore entered the default branch
path. A regression executing that helper observed one fork where zero were
expected. Forks at 00:19:14Z and 00:20:18Z match this path; the user subsequently
archived both. No new fork or edit was performed on this real chat during repair.

The source chat was a frontend follower after 00:11:26Z. The desktop's owner
discovery matched only host and conversation IDs, allowing dev to forward edits
to the official frontend. The installed official implementation still rejects an
older user turn when later user inputs exist; dev's implementation intentionally
supports this operation. In addition, a follower can have older history loaded
that the owner's cache lacks. Both failures happen before rollback/revert, and
the original UI discarded the detailed error. Logs contain no exact exception
for these attempts, so the particular owner-side throw is not asserted as known.

Official snapshots could also replace dev's gateway history/cursors. The
`Invalid engine history cursor` error is consistent with this provenance mismatch.
Shared native daemon ownership and frontend window coordination are separate:
only the latter is isolated by this change.

## Changes

- Bind editing mode to host, chat and turn until success or cancellation.
- Keep in-place mode after failure, coalesce duplicate submits, and serialize
  edits within a chat.
- Reuse a branch's saved snapshot across retries. Cosmetic snapshot-title
  failure no longer loses a successfully created snapshot ID.
- Wire both edit buttons, double click and Cancel into the scoped session.
  Reject a submission with no known mode rather than guessing after reload.
- Display the original edit failure message in the toast.
- Namespace owner discovery, follower requests, stream/following snapshots and
  queued followups between dev windows, preserving native host/thread IDs.
  Encode original IPC schema versions; retain response/error semantics and
  global archive/read/query/reset notifications.
- Migrate already-patched renderer bundles; verify repeat patching is idempotent.

## Validation

- 11 focused tests passed, including the original failure/retry fork regression
  and execution of the installed edit callback and window coordinator.
- 39 assertions passed against the extracted real IPC client and coordinators,
  using an in-memory router and zero native RPCs. Covers both interrupt schemas,
  no-client-found, response correlation, global notifications and cross-app
  snapshot filtering. This fixture is retained as a normal repository test.
- Independent review exercised one reused React compiler cache across chat/host
  changes and actual branch retry after cosmetic title failure; no blockers.
- Complete changed bundles parsed successfully and patching was idempotent.
- Existing history-edit suite: 25 passed, 3 active-fork tests failed. The same
  three failures were reproduced in an untouched HEAD 23c5ba0 archive. This
  frontend repair does not modify that runtime or claim those failures fixed.

## Deployment

The currently open edit draft was backed up before restart. The release changes
only the branch helper, thread callback, user-message component, main window
coordination module and its new IPC adapter. The remote runtime remains byte
identical. Activation and read-only verification are recorded below when done.


### Activated release

- Source commit: `7edcff3`.
- Installed and signed `/Applications/chatgpt-dev.app`; restarted only dev,
  old PID 80751 → new PID 86346.
- ASAR: `0ff094786ff59dcb80b216ca993fc8ca8764737e311fe104cde45e4fbaff65d5`.
- Runtime remains `b642e0e44470b3ab789c5b4135b0a60f24eaf9c0ea560be1cc1c6c156c264218`.
- All 8,615 other archive files verified byte-identical. Rollback bundle retained
  in `.artifacts/rollback-edit-session-20261007/chatgpt-dev.app`.
- Merged 15 source/test/report files into the original workspace using three-way
  merges with backups. Its 12 focused tests passed (including 39 IPC assertions).
- At 00:41:06Z the affected chat became dev frontend `role=owner`; at 00:41:13Z
  resume succeeded with `dangerFullAccess / never / :danger-full-access`.
  86 history pages loaded without an error. At 00:45:20Z no further role change,
  source failure, fork, revert, rollback or turn/start was observed.
- Native read verified the same 432 turns, idle status, no goal and no pending
  requests. Official desktop PID 99053/local native PID 99152 and rno native
  PID 20516/starttime 8081145 remained intact.
- The old edit draft was copied to `恢复的编辑草稿.txt` in the original workspace.
  Its exact source message is being confirmed rather than selecting another
  message by guesswork. No real edited message was submitted for verification.
