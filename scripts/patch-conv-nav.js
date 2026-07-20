#!/usr/bin/env node
/**
 * patch-conv-nav.js — Expose the app's own "navigate to a local conversation" function
 * to injected renderer code, so the branch-navigation UI can switch the displayed
 * thread to a specific conversation id (a fork / branch) with the real router.
 *
 * WHY: branches are separate threads linked by `forkedFromId`. Switching between them
 * means navigating the SPA route to a given conversation id. That routing lives in a
 * React hook (`use-navigate-to-local-conversation`) that injected code cannot call
 * directly. We tap the memoized navigate closure and stash it on globalThis, plus
 * record the last target so the UI knows which branch is currently shown.
 *
 * The hook (minified):
 *   function p(){let e=(0,m.c)(2),t=u(),n;return e[0]===t?n=e[1]:(n=e=>{let n=i(a(e));
 *     (0,h.flushSync)(()=>{t(n)})},e[0]=t,e[1]=n),l(n)}
 * `n` is `navigate(conversationId)`. We wrap it so calling globalThis.__ccNavigate(id)
 * both routes and records __ccCurrentThread.
 *
 * Usage: node scripts/patch-conv-nav.js [mac-arm64|mac-x64|win] [--check]
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const ANCHOR = "e[0]=t,e[1]=n),l(n)}";
const REPLACEMENT =
  "e[0]=t,e[1]=n),globalThis.__ccNavigate=function(__x){try{globalThis.__ccCurrentThread=__x;}catch(__e){}return n(__x);},l(n)}";
const SENTINEL = "globalThis.__ccNavigate=";

function locateNavBundles(platform) {
  const platforms = platform ? [platform] : ["mac-arm64", "mac-x64", "win"];
  const results = [];
  for (const plat of platforms) {
    const dir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/^use-navigate-to-local-conversation-.*\.js$/.test(f)) {
        results.push({ platform: plat, path: path.join(dir, f) });
      }
    }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateNavBundles(platform);
  if (bundles.length === 0) {
    console.error("  [x] no use-navigate-to-local-conversation bundle found");
    process.exit(1);
  }

  let done = 0;
  for (const b of bundles) {
    const code = fs.readFileSync(b.path, "utf-8");
    if (code.includes(SENTINEL)) {
      console.log(`  [ok] ${relPath(b.path)}: __ccNavigate already exposed`);
      done++;
      continue;
    }
    if (!code.includes(ANCHOR)) {
      console.log(`  [!] ${relPath(b.path)}: navigate hook anchor not found`);
      continue;
    }
    if (isCheck) {
      console.log(`  [?] ${relPath(b.path)}: would expose __ccNavigate`);
      done++;
      continue;
    }
    fs.writeFileSync(b.path, code.replace(ANCHOR, REPLACEMENT));
    console.log(`  [ok] ${relPath(b.path)}: __ccNavigate exposed`);
    done++;
  }

  if (done === 0) {
    console.error("  [x] conv-nav exposure matched 0");
    process.exit(1);
  }
}

main();
