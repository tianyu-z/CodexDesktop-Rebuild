#!/usr/bin/env node
/**
 * patch-conv-host.js — Expose the app's OWN store-synced host-command registry to
 * injected renderer code, so the conversation-control UI drives the exact same code
 * path the native UI uses (guaranteeing the on-screen thread updates).
 *
 * WHY (verified live via CDP, see memory codex-conv-controls-native-api):
 *   Calling `__ccAppServer.sendRequest("thread/rollback", ...)` DIRECTLY mutates the
 *   backend but does NOT refresh the DOM — the app pairs every rollback/fork with a
 *   module-private store-sync helper (Y7) that injected code cannot reach. The result
 *   is a desynced UI: the backend rolled back, the screen still shows the old turns.
 *
 *   The renderer instead routes host-initiated actions through a command registry:
 *     l9 = { "edit-last-user-turn-for-host": q7(async (mgr, params) => { ...Z7... }), ... }
 *   dispatched by:
 *     $r.setMessageHandler((e,n)=>l9[e](Tde(t),n))
 *   where `l9[cmd]` is the handler, `Tde(t)` builds the live manager, and each handler
 *   runs the full store-synced path. Editing the LAST user turn does rollback+resend;
 *   editing an EARLIER turn forks then rolls back — both keep the UI in sync.
 *
 * Strategy: wrap the dispatch arrow so that, in addition to normal behavior, it stashes
 * the registry + a manager factory on globalThis. Injected UI then calls:
 *   globalThis.__ccHost.registry["edit-last-user-turn-for-host"](globalThis.__ccHost.manager(), params)
 *
 * Usage: node scripts/patch-conv-host.js [mac-arm64|mac-x64|win] [--check]
 */
const fs = require("fs");
const { SRC_DIR, relPath, locateBundles } = require("./patch-util");

// The dispatch site inside the Qde() layout-effect hook. `l9` = registry, `Tde(t)` =
// manager built from the store accessor `t`. We keep the original call intact and add
// a global stash so injected code can reuse both.
const ANCHOR = "$r.setMessageHandler((e,n)=>l9[e](Tde(t),n))";
// In addition to stashing the registry + manager factory, tap every dispatched
// command so injected UI can learn the LIVE ids (conversationId / turnId / agentMode /
// serviceTier) of the active conversation — these flow through params on every
// edit/turn/settings command and are otherwise unreachable (manager store keys on the
// backend threadId, the DOM keys on a local uuidv4, and the two never join in a place
// injected code can read). `__ccHost.last` holds the most recent params seen per
// conversationId; `__ccHost.lastAny` holds the most recent overall.
// Y7 is the module-private store-sync helper the app runs after a `thread/rollback`
// (Y7(mgr,{conversationId,conversationState,rollbackResponse}) -> updateConversationState).
// A raw rollback via the request client persists to the backend but does NOT refresh the
// DOM without it. Because Y7 and this dispatch arrow live in the same app-main module
// closure, we can capture Y7 here and expose a `syncRollback(conversationId,numTurns)`
// helper that gives injected UI a TRUE multi-turn undo (rollback, no resend) with the
// screen kept in sync — the piece `edit-last-user-turn-for-host` does not cover.
const REPLACEMENT =
  "$r.setMessageHandler((e,n)=>{try{var __h=globalThis.__ccHost=globalThis.__ccHost||{last:{}};__h.registry=l9;__h.manager=()=>Tde(t);if(!__h.syncRollback)__h.syncRollback=async function(cid,num){var lm=Tde(t).getManagerForHostId(`local`);var cs=lm.getConversation(cid);if(!cs)throw Error(`no conversation state`);var rr=await lm.sendRequest(`thread/rollback`,{threadId:cid,numTurns:num||1});Y7(lm,{conversationId:cid,conversationState:cs,rollbackResponse:rr});return rr;};if(!__h.forkRollback)__h.forkRollback=async function(cid,num){var lm=Tde(t).getManagerForHostId(`local`);var cs=lm.getConversation(cid);if(!cs)throw Error(`no conversation state`);var fid=await lm.forkConversationFromLatest({sourceConversationId:cid,cwd:cs.cwd,workspaceRoots:cs.cwd?[cs.cwd]:[],collaborationMode:cs.latestCollaborationMode,threadSource:`user`,addForkedSyntheticItem:!1,ephemeral:!1});var fs=lm.getConversation(fid);if(!fs)throw Error(`no forked conversation state`);if(num>0){var rr=await lm.sendRequest(`thread/rollback`,{threadId:fid,numTurns:num});Y7(lm,{conversationId:fid,conversationState:fs,rollbackResponse:rr});}return fid;};if(n&&typeof n===`object`){__h.lastAny=n;if(n.conversationId)__h.last[n.conversationId]=Object.assign({},__h.last[n.conversationId],n,{cmd:e,at:Date.now()});}}catch(_e){}return l9[e](Tde(t),n)})";
const SENTINEL = "globalThis.__ccHost=";

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateBundles({
    dir: "assets",
    pattern: /^app-main-.*\.js$/,
    platform,
    all: !platform,
  });

  if (bundles.length === 0) {
    console.error("  [x] no app-main bundle found");
    process.exit(1);
  }

  let done = 0;
  let matched = 0;
  for (const b of bundles) {
    const p = b.path || b;
    const code = fs.readFileSync(p, "utf-8");
    if (code.includes(SENTINEL)) {
      console.log(`  [ok] ${relPath(p)}: __ccHost already exposed`);
      done++;
      matched++;
      continue;
    }
    if (!code.includes(ANCHOR)) {
      console.log(`  [!] ${relPath(p)}: dispatch anchor not found`);
      continue;
    }
    matched++;
    if (isCheck) {
      console.log(`  [?] ${relPath(p)}: would expose __ccHost`);
      done++;
      continue;
    }
    fs.writeFileSync(p, code.replace(ANCHOR, REPLACEMENT));
    console.log(`  [ok] ${relPath(p)}: __ccHost exposed`);
    done++;
  }

  if (matched === 0) {
    console.error("  [x] conv-host exposure matched 0 bundles");
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { ANCHOR, REPLACEMENT };
