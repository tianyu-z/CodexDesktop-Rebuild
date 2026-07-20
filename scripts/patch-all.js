#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch both platforms
 *   node scripts/patch-all.js unix         # Patch unix only
 *   node scripts/patch-all.js win          # Patch win only
 *   node scripts/patch-all.js --check      # Dry-run all
 */
const { execFileSync } = require("child_process");
const path = require("path");

const PATCHES = [
  "patch-i18n.js",
  "patch-copyright.js",
  "patch-devtools.js",
  "patch-fast-mode.js",
  "patch-plugin-auth.js",
  "patch-updater.js",
  "patch-archive-delete.js",
  "patch-skip-onboarding.js",
  "patch-custom-models.js",
  "patch-model-picker.js",
  "sync-cc-bridge.js",
  "patch-ensemble.js",
  "patch-ssh-remote.js",
  "patch-conv-native.js",
  "patch-conv-host.js",
  "patch-conv-nav.js",
];

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const extra = args.filter((a) => a.startsWith("--"));
  const passArgs = [...(platform ? [platform] : []), ...extra];

  let failed = 0;

  for (const script of PATCHES) {
    const scriptPath = path.join(__dirname, script);
    const label = script.replace(".js", "");
    console.log(`\n== ${label} ==`);

    try {
      execFileSync("node", [scriptPath, ...passArgs], { stdio: "inherit" });
    } catch (e) {
      console.error(`[x] ${label} failed (exit ${e.status})`);
      failed++;
    }
  }

  console.log(`\n== Summary: ${PATCHES.length - failed}/${PATCHES.length} succeeded ==`);
  if (failed > 0) process.exit(1);
}

main();
