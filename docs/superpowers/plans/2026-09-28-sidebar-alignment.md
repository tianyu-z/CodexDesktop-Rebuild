# Official appearance alignment

**Goal:** Align the modified app's entire compatible appearance with the installed official Codex 26.924.22138, including Home, Scheduled, Customize and More, shell surfaces, headers, page layouts and menus. The user explicitly expanded the request beyond the sidebar. Preserve every Claude component and engine runtime.

**Reference:** `/Applications/ChatGPT.app` (`com.openai.codex`, build 11645), extracted privately under `.artifacts/upstream-sidebar-26.924.22138`. The modified app uses 26.820.71523. The official plug icon opens Customize, which contains Plugins, Skills and installed plugins. Its rail is a fixed Home/Scheduled/Customize/More group with a contextual sidebar and native navigation actions.

**Architecture:** A separate renderer helper and fail-closed patch adapt the existing native navigation destinations and data hooks. Keep the native router, project/chat list, task management, plugin management and composer. Use existing native tooltips/context menus. Port compatible shell and native page styles with explicit selectors; do not overwrite global utility classes, palette, or styles inherited by Claude controls. The reference uses the same base font families, font sizes, toolbar heights, corner scale and preferred sidebar width as the old build; preserve these already aligned values. Transplanting the entire new bundle would require unrelated composer/protocol changes. New service-backed features absent from the pinned backend are outside this appearance task.

**Boundaries:** Do not edit `scripts/assets/agent-modes-ui.js`, agent-mode patch seams, `runtime/agent-modes`, credentials, user settings, remote gateways or production conversations. New UI must not send model turns, run workflows, or grant new permissions. Capability checks still control available data/actions. Preserve the original Home project/chat list and recoverable error/loading states for other panels. A scheduled item or plugin opens through its existing native action.

## Work

- [x] Add navigation behavior tests in `tests/agent-modes/sidebar-navigation.test.mjs`: route selection, fixed entries, More preserving remaining destinations, callbacks, and contextual content fallback.
- [x] Add `scripts/assets/sidebar-navigation-ui.js` with rail and contextual panels. The renderer receives native React, JSX, current location, destination callbacks and scoped native data adapters; it does not discover credentials or access engine managers.
- [x] Add `scripts/patch-sidebar-navigation.js` for the pinned frontend. Expose `patchSidebarCode` and `patchSidebarAssets`; reject missing/ambiguous anchors, wrap only the native rail and sidebar content, and remain idempotent. Preserve the original rail as a recognized fallback implementation.
- [x] Add patch integrity tests: syntax, idempotence, drift rejection, all pre-existing Claude seams unchanged, and no modifications to thread/composer bundles.
- [x] Integrate the independent patch into `scripts/build-agent-modes-preview.js` and the standard patch sequence.
- [x] Align compatible main content surfaces, titlebars, page headers, navigation controls and menus using a separate appearance stylesheet; preserve compact windows and user theme/size preferences. Record reference values and intentional compatibility limits.
- [x] Build a separately named, signed preview with isolated app data. Verify Home, Scheduled, Customize, More, active state, keyboard/menu interactions and navigation back to chats using Computer Use on the modified preview.
- [x] Verify Claude helper/runtime hashes, run sidebar and existing frontend/history regressions, then run the full test suite once after implementation settles.
- [x] Back up and install the verified frontend while preserving current production processes; report the actual loaded/installed state and any restart requirement.

**Validation:** `node --test tests/agent-modes/sidebar-navigation.test.mjs tests/agent-modes/sidebar-patch.test.mjs`, then the existing frontend and patch suites, and `node --test tests/agent-modes/*.test.mjs`. Artifacts and unpacked official bundles remain untracked. Do not push unless the user requests it.

## Review and evidence

- Native navigation, Scheduled, Customize, Skills, plugin detail and More actions were exercised in the modified preview. Claude model, permission and slash-command controls were checked without sending model turns.
- Read-only review found route classification and hidden-search issues; these were fixed and covered by tests. Ten focused tests pass, including every existing engine seam.
- Final signed preview and release have identical frontend archives. The first final-preview signing attempt was interrupted by an early preview launch; the builder now publishes its output path only after signing, and the replacement builds pass signature verification.
- Subsequent Computer Use capture was denied by macOS. The already exercised preview has the same frontend SHA-256 as the final signed build, so no UI bypass is needed.
- Final release changes four archive files, preserves 8,615 other archive files, and preserves all 6,400 installed runtime files. The remote archive remains `180f1491f2b0ca0aba47a1f7a3539a9df519017e8c24dff90b2784ab1dcc54b1`.
- Minor remaining accessibility compatibility: the native outer conversation-sidebar landmark label is preserved while the contextual section has its correct Scheduled/Customize label.

**Regression results:** First complete run: 616 tests, 615 passed, one pre-existing remote daemon stop/concurrency test failed (exit code at the final stop). The unchanged remote-daemon suite was rerun alone: all five passed, including that scenario. No runtime fix or test weakening was made. See `.artifacts/appearance-full-tests.log` and `.artifacts/appearance-remote-daemon-recheck.log`. The initial stop failure cause is not conclusively established.

**Installed:** `/Applications/chatgpt-dev.app`, archive `1ad85911bfe8b8ff48e4598c484216f0854ab5893064463186511fd465a2fe28`. All 12 existing application/runtime processes survived. No restart was performed. Backup: `/Users/tianyu.zhang/.codex/backups/agent-modes/appearance-2026-09-28T21-13-49.224Z`. The new renderer loads on the next normal app restart.
