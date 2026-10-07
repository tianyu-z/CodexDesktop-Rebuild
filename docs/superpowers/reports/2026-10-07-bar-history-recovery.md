# bar long-history recovery — verified deployment

The initial history-performance deployment used `/Applications/chatgpt-dev.app`. Gateway and proxy on `bar` both used runtime `c652f0a2e73d0da4f4ee39eb08c309ab01d6b92ad59f5342ebc0b794e542c66d`. Local development app PID 34760; remote gateway PID 3804850; remote native PID 3805068. The previous bar turn finished naturally before the upgrade; the final pre-install health check was idle, so the gateway upgraded gracefully. Official remote backend PIDs 3606928/3606939 retain their original start times and remain running.

The package changes only seven runtime source files. Deterministic packaging, extracted inventory comparisons, installed-source drift checks, and deep strict app signatures passed. The frontend archive and unrelated resources were preserved. Seven remote source hashes match the signed package. Source changes were applied to the original working directory with a three-way merge for its already-modified router; unrelated changes remain intact.

## Actual bar acceptance

- Full history: 29,492,037 response bytes, 145 turns, 53.214 seconds end to end.
- Metadata page: 20 turns, 4,527 bytes, 321 ms.
- Item page: 11 items, 18,237 bytes, 333 ms.
- Nine full-content pages reconstructed every turn without duplicate IDs; each page stayed under the 8 MiB target.
- Read-only acceptance connection remained open for 111.294 seconds and answered 4 proxy heartbeats. There were no pending approvals during this real probe; approval preservation was tested in WebSocket integration fixtures.
- Desktop reconnected at 2026-10-07T11:20:43.471Z; no connection failures during the next 143.6 seconds of log observation. Earlier “Another desktop controller” errors occurred while the read-only acceptance controller occupied the connection and ended when it disconnected.

Full-content transfer remains proportional to payload size: the metadata result does not imply an entire 29.5 MB transcript loads in 0.32 seconds. The fix prevents repeated native hydration for ordinary history pages and bounds transport failure to individual RPCs where possible.

## Automated verification

Task1 and Task2 passed independent specification and quality reviews. Root ran 90 related tests sequentially with no failures before the last active-item edge-case fix; after that fix the focused WebSocket history suite passed 20/20. New tests reproduce the old 16 MiB failure, check 28.5 MiB response survival, reject responses over 64 MiB without replay, exercise pressure/approvals, and verify snapshot ownership, cursors, mutations, cancellation and active-content fallback.

The original working directory ran 92 related tests: 91 passed and one could not open its missing pinned frontend fixture. Re-running the exact original server test file in an isolated fixture layout linked to the **original runtime** and the pinned frontend fixture passed 8/8. The original frontend checkout was not changed. Earlier broader suites also have two pre-existing Claude model assertions and two pre-existing timestamp assertions, documented in the plan; they are unrelated to this repair.

## Retained artifacts

All detailed evidence is in `.artifacts/`: `bar-history-acceptance.json`, `desktop-stability-verification.json`, `bar-final-state.json`, `large-history-release/build-manifest.json`, regression logs, and `source-history-merge/manifest.json`. A verified rollback app remains at `.artifacts/rollback-large-history-20261007/chatgpt-dev.app`. The temporary duplicate app under `/Applications` was removed after validation.

## Paginated editing repair — deployed

At 2026-10-07T11:23:28.600Z, the desktop attempted `thread/rollback` for conversation `01a0b36d-a22d-7431-ac67-7b5a5f93a082`. The backend rejected it with code `-32600`: `paginated threads do not support thread/rollback`. This is a separate pre-existing compatibility gap: `EngineRouter.thread()` exposes managed history as `legacy`, but the history-edit adapter is selected only for mixed/detached/discarded history. Pure Codex paginated history falls through to the obsolete native rollback operation. Commit `f858e186bafb38158b6b8174b9f8515e7bcbf400` routes this case through the existing history-edit adapter, which translates the retained-prefix boundary to `thread/revert` and preserves validation, durable recovery and stale-turn suppression. Legacy rollback behavior remains unchanged.


The editing repair is installed as runtime `3c8ceaa30e576503ea434050bb6523ce4dc3468234e9d73899d9a3592f5a2519`. Only `router.mjs` changed in the runtime package; 6,405 other remote files, 6,412 unrelated local runtime files, and the frontend archive were unchanged. Deterministic packaging and deep strict code-signature verification passed. A macOS atomic directory exchange installed the signed app without stopping the existing desktop PID 34760. The old app is retained at `.artifacts/rollback-paginated-edit-20261007/chatgpt-dev.app`; the live process's previous bundle also remains parked under `/Applications/.chatgpt-dev-before-paginated-edit.app`.

The idle bar gateway upgraded gracefully. Gateway PID 3808476, native backend PID 3808819 and proxy PID 3808820 all run the new digest, with matching source hashes. Desktop logs confirm reconnection at 2026-10-07T11:40:32.591Z. The official backend PIDs 3606928/3606939 and their start times are unchanged. The real research chat remains at 145 turns and its turn-content SHA-256 is identical before and after deployment (`e755329e443374b417f883217fdfec8979dde6b3ce7acf0a93a2d53da6286d8f`). No real history was edited or submitted during validation.

Verification: specification and quality reviews passed; root ran 40/40 related tests and the original workspace passed 20/20 history-edit tests after a narrow three-way merge. Isolated real-native tests passed both locally and on bar: exact revert boundary once, preserved prefix, preserved earlier version, edited continuation, and rollback through the first turn. Only test-owned chats were created/edited and they were archived afterward. Remote test IDs were `01a1162b-696d-70c0-9d8c-82c1b825fb26` and `01a1162b-9174-7461-80ca-fe77380b4bc7`.

Editing evidence: `.artifacts/paginated-edit-validation.json`, `paginated-edit-native-report.json`, `bar-edit-native-run.log`, `bar-edit-prestate.json`, `bar-edit-poststate.json`, `paginated-edit-release/build-manifest.json`, and `source-paginated-edit-merge/manifest.json`. This deployment preserves the earlier long-history/connection repairs. The user's subsequent rno approval-state report is being investigated separately.
