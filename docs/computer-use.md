# Computer Use on macOS

The rebuilt app selects an installed, signed official ChatGPT/Codex native runtime at startup. Keep the official app installed and up to date. Default locations are `/Applications/ChatGPT.app`, `/Applications/Codex.app`, and their equivalents in `~/Applications`. Set `CDX_NATIVE_RUNTIME_APP` to an absolute `.app` path for another location. A complete, signed runtime bundled with the rebuilt app is the last fallback.

All four components come from one installation: Codex CLI, `node_repl`, Node, and the `@oai/sky` module directory. Before use, the resolver verifies each executable against its expected identifier and OpenAI's signing team. The official app and Computer Use service are never modified, and macOS permissions and the service's caller authentication remain enforced.

The desktop keeps its own Electron resources, app data, and Claude gateway. The gateway delegates native Codex work to the selected official CLI. The REPL sandbox launcher receives that signed CLI directly through a separate runtime path: its filtered environment cannot run the gateway, which requires `CDX_REAL_CODEX`. This also means local Codex behavior follows that official CLI's version rather than the bundled Cometix version. A custom `CODEX_CLI_PATH` outside the bundled CLI/gateway is respected and logged instead of silently replaced. Remote hosts retain their existing runtime.

If no complete signed runtime is available, ordinary CLI behavior is retained and startup logs explain that the official app is required for Computer Use. After updating the official app, relaunch it and the rebuilt app to keep the running Computer Use service and client synchronized. The service's permissions/status UI is owned by the official app; the rebuilt desktop's native status-menu request can still be rejected as an unsigned caller.

## Rebuild or validate an existing installation

The macOS build and engine-preview build apply the runtime patch. The supported resolver seam is from upstream `26.820.71523`; a changed upstream seam fails the build explicitly rather than producing an unpatched application.

To make a separate preview from an installed engine-mode dev app, preserving its other installed features:

```sh
node scripts/build-computer-use-preview.js \
  --source /Applications/chatgpt-dev.app \
  --output "$PWD/.artifacts/computer-use/chatgpt-dev-computer-use-preview.app"
```

This writes a new bundle with a separate application identifier and data directory. It refuses to overwrite an existing output. It verifies unchanged archive files and signs only the modified outer bundle, preserving nested native signatures. The output is a preview; building it does not replace or restart the installed app.

Regression checks:

```sh
node --test tests/agent-modes/computer-use-*.test.mjs
node --test tests/agent-modes/*.test.mjs
```

## Failure mechanism

The Cometix backend in the affected installation had an ad-hoc signature. Calls through it returned `Sky Computer Use native pipe startup failed`, while the native service recorded `Sender process is not authenticated`. Replacing only the backend with an official signed CLI got past authentication but exposed a client/service version mismatch because the old desktop still loaded its bundled Sky module. Selecting the entire matching runtime addresses both failures.

An isolated diagnostic with its launcher reparented to PID 1 reproduced the rejected call, so a running official Codex ancestor could not mask the problem. The matching official backend and CUA client completed a read-only `sky.list_apps()` call without a model turn or changes to system permissions.

The final preview's gateway → signed backend → REPL sandbox chain also starts successfully, imports Sky, and reaches the native service's locked-Mac check. The Mac was locked during final validation, so a window/screenshot read through that final preview remains unverified. Regression validation passed 802 tests with one existing skip; preview packaging verified 8,617 unrelated ASAR files unchanged and passed strict signature verification.
