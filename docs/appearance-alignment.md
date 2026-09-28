# Desktop appearance alignment

The appearance layer adapts the modified 26.820.71523 app to the installed official Codex 26.924.22138 reference. It provides Home, Scheduled, Customize and More navigation, contextual task and plugin sidebars, official navigation artwork, native menu actions, and compatible shell surfaces and header styling.

The reference and base already share the default font families, body sizes, toolbar heights, corner scale and preferred sidebar width. These values and user appearance preferences remain native. New service features such as cloud task pagination and workspace split layouts are not emulated through CSS. The composer, conversation renderer and all Claude/multi-agent controls retain their existing implementation and styles.

## Build

On the Mac with the modified app installed:

```sh
node scripts/build-appearance-preview.js
```

This extracts `/Applications/chatgpt-dev.app`, validates the pinned frontend, and applies only four archive changes:

- `webview/assets/app-initial-CX2pZp2Q.js`: native navigation adapters.
- `webview/assets/sidebar-navigation-ui.js`: independent components.
- `webview/assets/desktop-appearance.css`: explicit appearance selectors.
- `webview/index.html`: the stylesheet link.

The builder rejects any other archive modification and compares the complete copied runtime inventory with the installed app. The remote runtime archive is retained byte for byte. It writes the preview to `.artifacts/ChatGPT Appearance Candidate.app` only after signing and verification complete. Preview application data and engine metadata use a separate app name. Native Codex projects and remote connections are still discovered through the existing Codex configuration; this is not a sandbox for executing model turns.

For a release bundle, call the exported `build` function with `release: true` and a new output path. That keeps the installed identity, launcher and runtime unchanged. Building does not install or restart the production app. The generated `Contents/Resources/appearance-build.json` records hashes and changed paths.

The broader engine preview builder also applies the appearance patch. Its optional `preserveRuntime: true` verifies source runtime files against the installed version before retaining the existing remote package. Use the appearance-only builder for a visual release because it starts from the actual installed archive, including earlier fixes.

## Native contracts

- Scheduled rows use the existing local/cloud queries. Cloud results must match the current account. Local and cloud IDs have separate namespaces. Selection, creation and run opening call existing native actions.
- Customize shares the existing page's selected host and tab atoms. Installed plugins use the same hidden-ID policy and search/sort helpers as the native directory. Details retain the source-bearing native URL.
- More, tooltips, context menus, explicit pinned destinations and chat/project content retain their native callbacks. No engine RPCs or model turns are added by the appearance helper.
- Unknown frontend versions are rejected by the direct patch API. The cross-platform standard patch sequence skips unsupported bundles.

## Validation

```sh
node --test tests/agent-modes/sidebar-navigation.test.mjs tests/agent-modes/sidebar-patch.test.mjs
node --test tests/agent-modes/*.test.mjs
```

The real-bundle guard first applies the current engine patches, then verifies that every existing engine seam remains inside a byte-identical function or top-level expression after appearance patching. GUI checks cover Home, Scheduled, Customize, Skills, plugin details, More and the unchanged Claude model/permission/command controls. The unpacked official app is a read-only visual/source reference, never the release base.
