# Claude native experience audit and migration

The user's request is to inspect the installed Claude Code and VS Code Insiders packages, enumerate their features, and migrate their behavior into this desktop app. The reference versions are CLI/extension 2.1.283; this app uses Agent SDK 0.3.282, while the extension bundles SDK client 0.3.283. Availability must be checked against the actual local or SSH-host CLI. An internal string or method is evidence of an implementation, not evidence that an account can use it.

## Inventory

Produce a versioned Chinese feature matrix with the complete extension manifest command, shortcut and setting lists; the observed native command catalog; the SDK/control surface; and the extension's editor, account and service dependencies. Mark each capability as supported, migrated and verified, partially supported, host-dependent, gated, or not yet migrated. Keep extracted vendor code and private initialization responses in ignored artifacts. Commit only our own descriptions, identifiers and tests.

## Native interaction bridge

Reuse the existing request/response transport and ownership checks for both Claude-only and Claude workflow roles. AskUserQuestion must present the actual questions and return answers keyed by their original question text, including multiple selections and free text. ExitPlanMode must show the native plan and return the user's chosen native session permission mode; deprecated allowedPrompts is not authorization. Generic approvals must preserve the native title, reason, blocked path and suggested permission updates. Rejection feedback must reach Claude. Scope reusable permissions accurately to the lifetime the app can guarantee; do not label an allow-once response as session-wide permission. Cancellation must resolve pending interactions and prevent late answers from restarting a stopped run.

## Multimodal input

Convert composer image inputs into Claude's native image content blocks. Validate actual formats, bounded payload size and file reads on the selected host. Do not fetch arbitrary image URLs behind the user's back. Preserve editable public inputs and resume the same native session. Text-only slash commands continue through the existing catalog; an image plus slash-looking text must not silently discard its attachment. Use the same conversion for ordinary Claude steering. Workflow roles receive image content through an explicit input contract rather than a fabricated text description. Unsupported input forms produce a useful error before starting a model.

## Native controls and discoverability

Add a discoverable Claude control surface using the existing host/session/role bindings. Expose the command catalog by category and make actions editable in the composer. Improve native status, plan, task, skills, memory, MCP and plugin output into readable fields and lists, preserving native errors and capability gates. Task stop must target a task owned by the selected live Claude process. Effort, thinking and output-style settings must distinguish session overrides from native file settings and preserve each role's frozen configuration. Do not enable a gated service, silently edit native configuration, or impersonate the VS Code host.

## Verification and release

Use focused red/green tests for each new behavior, real disposable Claude sessions for inputs and interactive answers, and mocked ownership/race tests for multiple roles and hosts. Verify the patched installed frontend code, syntax, idempotence, packaged runtime and remote archive. Preserve the previous goal implementation and the existing production processes. Install with a recoverable backup without restarting active chats. Report live-test limits separately from code compatibility; a feature inventory must not imply full native parity before the interaction works.
