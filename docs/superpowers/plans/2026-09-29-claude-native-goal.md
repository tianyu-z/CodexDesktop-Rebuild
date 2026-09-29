# Native Claude Goal Implementation Plan

**Goal:** Execute Claude's own `/goal` in the desktop without invoking Codex goal management.

**Architecture:** Preserve native slash-command text before the desktop Codex goal parser. Reuse the command catalog, native Claude SDK input stream, session binding and Stop lifecycle. Track acknowledged input IDs so local command results cannot settle a still-running model turn.

**Stack:** JavaScript, Node test runner, Claude Agent SDK, Electron bundle patch seams.

- [x] Add and run failing frontend tests for `/goal`, `/goal <condition>` and `/goal clear` in Claude sessions/drafts, retaining native Codex behavior and host isolation. Patch `scripts/patch-agent-modes.js` and `scripts/assets/agent-modes-ui.js` at the submit parser; verify literal upstream seam and idempotence.
- [x] Add adapter regression coverage for steering during a native goal and for command results arriving before, during and after the original model result. In `runtime/agent-modes/claude-adapter.mjs`, allow steering when the original command is built-in goal; account for initial and subsequent input acknowledgments without closing stdin early. Preserve main text, structured output, usage and existing non-goal command restrictions. Local command receipts must not hide result-only model replies.
- [x] Route live `/goal` controls through the owned Claude input stream with existing turn and role ownership checks. Add router tests proving no Codex goal RPC or second Claude process is used; preserve partial output and Stop responsiveness.
- [x] Add an opt-in disposable real-engine fixture in `tests/agent-modes/live-claude-goal.mjs`. Verify native achievement and transcript-restored goal after Stop, status/clear commands, and no lingering owned workers. Execute the patched installed-bundle submit handlers for new/existing Claude and mixed chats. This checks the real parser code; it is not a GUI click test.
- [x] Run relevant adapter, command, router, frontend, scheduler and remote tests. Build using the existing preview builder; verify signatures and source/runtime parity. Install safely without restarting active production chats. Update `docs/agent-modes.md` with supported syntax and evidence limits.

Acceptance requires actual native command/evaluator behavior, original-session continuation, no hidden Codex inference, and passing meaningful regressions. No new service, vendor binary modifications, automatic policy relaxation, or unrelated appearance changes.

Verification: 304 relevant tests passed. Independent follow-up review passed. The real Claude fixture verified native achievement/automatic clearing, Stop during approval, restoration of the same native session, clearing and continuation, and live clear while a turn was active; it made zero Codex inference calls. Release/preview signatures and installed source/runtime/remote-archive parity passed. Installation retained all 13 observed production app processes and made a timestamped backup; the app was not restarted. Per-cluster native Goal execution remains unverified.
