# Native Claude Goal

The installed Claude Code 2.1.283 and Agent SDK 0.3.282 expose a built-in, noninteractive `/goal` command. The command installs a session-scoped prompt Stop hook, evaluates completion natively, records goal-status attachments, and restores an unfinished goal when resuming its native transcript. `/goal` reports status; `/goal clear` removes the hook. The VS Code Insiders extension bundles the same CLI and forwards native events.

Use this native command instead of implementing a second goal scheduler or forwarding Claude goals to Codex `thread/goal/*`. Existing command discovery and native-session bindings already provide the correct transport. Fix the desktop submit parser so Claude slash commands remain text, and permit ordinary steering during a native Claude goal command. Keep the current ownership checks, permission policy, Stop cleanup, native resume, and Codex-only behavior.

Verify with literal upstream parser seams, router ownership tests, a delayed steering-result test, and real disposable native sessions: set and achieve a goal; stop while awaiting approval; inspect the restored goal; clear it; continue without the cleared hook. If native goal commands are sent during a running Claude turn, their individual result must not prematurely terminate the main turn. Do not patch the vendor binary or override workspace trust/hook restrictions.

Package investigation is kept in ignored `.artifacts/claude-native-goal`. No extracted vendor source, credentials, or user transcripts are committed. Existing chats and production processes must remain running during build/install; the installed update takes effect on the next normal launch.
