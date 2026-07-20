#!/usr/bin/env node
/**
 * patch-skip-onboarding.js — Skip the built-in first-run onboarding survey.
 *
 * The app decides what to show via an onboarding-target resolver in the
 * app-main chunk:
 *
 *   return auth.isLoading ? null
 *     : (!auth.authMethod && auth.requiresAuth) ? `login`   // ← keep: login is required
 *     : forcedOverride || (finalStepLoading ? null
 *         : shouldShowFinalStep ? `welcome`                  // ← survey
 *         : (backendOnboardingCompleted||...) ? `app`
 *         : loading ? null
 *         : `welcome`)                                       // ← survey (fallback)
 *
 * We rewrite the two `welcome` targets to `app` so the app never shows the
 * usage/role onboarding survey and lands straight on the main UI. The `login`
 * branch is left intact — auth is still required for the app to function.
 *
 * Usage:
 *   node scripts/patch-skip-onboarding.js [mac-arm64|mac-x64|win] [--check]
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

// Anchor is stable across builds (real string literals, not minified names).
const ANCHOR = "requiresAuth?`login`:";
// How far past the anchor the onboarding return expression extends. The whole
// expression is ~150 chars; 320 gives margin without reaching unrelated code.
const WINDOW = 320;

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const check = args.includes("--check");
  const opts = platform ? { platform } : {};

  const bundles = locateBundles({ dir: "assets", pattern: /^app-main-.*\.js$/, ...opts });
  if (bundles.length === 0) {
    console.log("  [!] no app-main bundle found");
    process.exit(1);
  }

  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    const anchorIdx = code.indexOf(ANCHOR);
    if (anchorIdx < 0) {
      console.log(`  [!] ${relPath(bundle.path)}: onboarding resolver anchor not found`);
      continue;
    }

    const start = anchorIdx + ANCHOR.length;
    const before = code.slice(start, start + WINDOW);

    if (!before.includes("`welcome`")) {
      // Already patched (no welcome targets left) or layout changed.
      if (before.includes("`app`")) {
        console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
        patched++;
      } else {
        console.log(`  [!] ${relPath(bundle.path)}: no \`welcome\` target in resolver window`);
      }
      continue;
    }

    const count = (before.match(/`welcome`/g) || []).length;
    if (count !== 2) {
      console.log(`  [!] ${relPath(bundle.path)}: expected 2 \`welcome\` targets, found ${count} — aborting`);
      continue;
    }

    if (check) {
      console.log(`  [dry] ${relPath(bundle.path)}: would rewrite 2 \`welcome\` -> \`app\``);
      patched++;
      continue;
    }

    const after = before.replace(/`welcome`/g, "`app`");
    const newCode = code.slice(0, start) + after + code.slice(start + WINDOW);
    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: onboarding survey skipped (2 welcome -> app)`);
    patched++;
  }

  if (patched === 0) {
    console.error("  [x] onboarding skip: 0 bundles patched — upstream layout changed");
    process.exit(1);
  }
}

main();
