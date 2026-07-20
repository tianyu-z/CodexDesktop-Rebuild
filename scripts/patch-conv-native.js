#!/usr/bin/env node
/**
 * patch-conv-native.js — Expose the native app-server request client to injected
 * renderer code, so the conversation-control UI (undo / edit+branch / model switch)
 * can call REAL native JSON-RPC methods instead of typing fake slash commands.
 *
 * Native methods this unlocks (verified in app-main + app-server-manager bundles):
 *   - thread/rollback {threadId, numTurns:N}   -> multi-turn undo
 *   - thread/fork {threadId, cwd, model, ...}  -> branch (forkedFromId)
 *   - thread/turns/list {threadId}             -> map bubbles to turnIds
 *
 * Strategy: the AppServerRequestClient defines
 *   async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`); ...}
 * We prepend `globalThis.__ccAppServer=this;` so the first real request stashes the
 * live client on window. Injected UI then does window.__ccAppServer.sendRequest(...).
 *
 * Usage: node scripts/patch-conv-native.js [mac-arm64|mac-x64|win] [--check]
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR } = require("./patch-util");

const ANCHOR =
  "async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);";
const INJECT = "async sendRequest(e,t,n){globalThis.__ccAppServer=this;if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);";
const SENTINEL = "globalThis.__ccAppServer=this;";

function locateManagerBundles(platform) {
  const platforms = platform ? [platform] : ["mac-arm64", "mac-x64", "win"];
  const results = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!/^app-server-manager-signals-.*\.js$/.test(f)) continue;
      results.push({ platform: plat, path: path.join(assetsDir, f) });
    }
  }
  return results;
}

function rel(p) {
  return path.relative(process.cwd(), p);
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateManagerBundles(platform);
  if (bundles.length === 0) {
    console.error("  [x] no app-server-manager bundle found");
    process.exit(1);
  }

  let done = 0;
  for (const b of bundles) {
    const code = fs.readFileSync(b.path, "utf-8");
    if (code.includes(SENTINEL)) {
      console.log(`  [ok] ${rel(b.path)}: __ccAppServer already exposed`);
      done++;
      continue;
    }
    if (!code.includes(ANCHOR)) {
      console.log(`  [!] ${rel(b.path)}: sendRequest anchor not found`);
      continue;
    }
    if (isCheck) {
      console.log(`  [?] ${rel(b.path)}: would expose __ccAppServer`);
      done++;
      continue;
    }
    fs.writeFileSync(b.path, code.replace(ANCHOR, INJECT));
    console.log(`  [ok] ${rel(b.path)}: __ccAppServer exposed`);
    done++;
  }

  if (done === 0) {
    console.error("  [x] conv-native exposure matched 0");
    process.exit(1);
  }
}

main();
