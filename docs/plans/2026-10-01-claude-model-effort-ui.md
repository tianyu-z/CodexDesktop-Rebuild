# Claude composer controls

Use the existing Codex Button, ComposerDropdownLabel, Dropdown, menu items,
and PowerMenu components through a small injected interface. Keep native Codex
model selection intact. Claude gets a model/effort pill, Model and Effort
submenus, and the existing Advanced/compact effort slider. Engine selection
uses the same menu primitives. Keep model IDs and supported effort levels from
Claude's catalog; Auto clears the explicit effort override.

Only Claude effort belongs to its native session binding. Carry an optional
claudeEffort through draft capture, thread creation, prewarm/retry and mode/set.
Validate before changing persisted state, preserve other session settings,
reject changes during a run, and remove this field from native Codex requests.
Multi-agent keeps per-role command settings; its shared model picker does not
silently edit a role's effort.

1. Add regression tests for persistence, reset, validation, and first-turn wiring.
2. Implement direct effort selection and the shared native renderer controls.
3. Test relevant suites and exercise a separate app preview with native assets.
4. Apply narrow patches to the installed app and remote package, preserving the
   installed Claude progress/defaults/thinking and Full access fixes. Do not
   interrupt running chats to activate the update.
