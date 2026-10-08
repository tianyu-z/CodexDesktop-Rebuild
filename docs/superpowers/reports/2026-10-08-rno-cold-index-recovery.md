# rno connection loss after login-container restart

## Verified cause

The existing connection closed at 2026-10-08 01:25:06 UTC (October 7,
18:25:06 America/Los_Angeles). rno's login container PID 1 started at
01:25:46 UTC. The previous native owner PID 20516 and gateway socket no longer
existed. This affected the official app as well as chatgpt-dev.

The remote `~/.codex/state_5.sqlite`, logs, goals and memories databases are
symlinks into `/var/tmp/codex-db`. The remote `.bashrc` lines 247–249 explicitly
note that the directory is wiped on pod restart and only recreate the directory.
No persisted SQLite restore is configured there. This configuration was not
changed by the prior editor/frontend-ownership patch.

After earlier SSH agent refusal/network failures, a fresh native database was
initialized at 05:24:03 UTC. Native PID 11065 held the actual app-server startup
flock and rebuilt rollout metadata from the shared home. Progress was observed
advancing through August and September, with the database growing past 22 GB.
The other native processes were waiting for that startup flock, not processing
chats or concurrently rebuilding the index. `unix://` is a valid default listen
address; its appearance in the command line was not a lost parameter.

The native socket only became available when backfill completed at 05:36:33 UTC:
59,044 indexed rows, last watermark on October 7. During this roughly 12.5-minute
startup, desktop connection deadlines expired and showed `socket hang up`.
After completion, waiting duplicate processes exited automatically and the
original recovering PID 11065 remained as the one native owner.

## Desktop recovery and verification

The dev desktop also stopped producing logs at 05:14:34 UTC. A process sample
showed its main thread blocked in macOS AppKit NSSceneStatusItem / FrontBoard
menu-bar scene creation. Computer Use timed out on that window. Its complete
profile was backed up to `.artifacts/rno-recovery-20261008/profile-before-restart`,
then only dev PID 86346 was terminated and relaunched as PID 61260. Official app
PID 99053 and local native PID 99152 were preserved.

- Official app reconnected at 05:36:38 UTC, initialized=true, next=connected.
- Dev reconnected at 05:37:22 UTC, initialized=true, next=connected.
- Dev UI shows VeOmni / rno as Connected and the original chat can be opened.
- Read-only native check at 05:38:31 UTC: original chat
  `01a0dff5-e241-73a3-9c26-02b62fe7abe5` still has 432 turns; idle; goal=null;
  no in-progress turns and no pending requests. No message was sent or edited.
- Native and gateway sockets exist again. Only native PID 11065 remains.
- Installed runtime and editor patch were not changed in this recovery.

## Remaining limitation

Connection has recovered; the ephemeral database storage configuration is not
permanently repaired. Another login-container restart can trigger the same cold
rebuild. A durable recovery design must preserve an internally consistent SQLite
snapshot on persistent storage, restore onto local storage before daemon startup,
and reconcile newer/changed rollouts. Copying a stale database onto a live daemon,
putting its WAL directly on NFS, or marking an incomplete backfill as complete is
not an acceptable shortcut. No such database or infrastructure change was made.
