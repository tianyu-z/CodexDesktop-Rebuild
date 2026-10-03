# Computer Use runtime repair

**Goal:** Let the rebuilt macOS app use Computer Use with an authenticated Codex parent and a matching Node/REPL/Sky client, then publish the verified repair to GitHub main.

**Architecture:** Discover the locally installed official ChatGPT/Codex runtime at app startup. Verify its Codex, Node, and node_repl signatures before selecting the complete runtime. Keep the rebuilt desktop resources, data directory, and engine gateway; change only the gateway's native Codex target and Computer Use runtime paths. Preserve native service authentication and macOS permission checks.

**Evidence:** A detached app-server → node_repl test reproduces native pipe startup failure with the Cometix CLI. The signed official CLI passes authentication but reports a version mismatch with the old client. The signed CLI with its matching CUA runtime successfully lists applications. Baseline gateway/bootstrap/native-transport tests pass (9 tests).

**Implementation and validation:**

- [x] Add failing tests for runtime selection, rejected signatures, incomplete installations, gateway preservation, non-macOS behavior, and runtime path overrides.
- [x] Implement `scripts/assets/native-computer-use-runtime.cjs`; use argv-based `codesign` verification and keep all runtime components from one installation.
- [x] Add a fail-closed/idempotent patch in `scripts/patch-computer-use-runtime.js` for the module-directory resolver, REPL sandbox CLI, and startup entry. Test behavior using the exact executable upstream resolver fixture, including its minified scope.
- [x] Integrate the patch into macOS and engine-preview builds. Add a narrowly scoped preview builder for already-installed dev apps so unrelated local features are retained during validation.
- [x] Run focused tests and the existing agent-mode suite: 802 passed, one skipped. Build an isolated preview and verify signatures and 8,617 unchanged archive files. The gateway → native backend → node_repl chain loads Sky and reaches the native service's locked-Mac check.
- [x] Complete independent code review; no remaining actionable findings. Fetch current main and isolate only this repair for publication.

**Validation limit:** The Mac was locked for final integration validation. A read-only window/screenshot request through the final preview remains unverified; the earlier matching-runtime diagnostic successfully listed applications.

**Publication:** Push the verified repair to GitHub main and compare the remote commit with the local commit. The installed dev app is not replaced by the preview builder.

The official app remains a runtime prerequisite for existing builds whose bundled native backend has already been replaced. If a valid runtime cannot be found, preserve the existing CLI behavior and log an actionable diagnostic. Updating/relaunching the official app is still needed if its on-disk client and running Computer Use service differ.
