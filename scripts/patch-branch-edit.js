#!/usr/bin/env node
/**
 * patch-branch-edit.js — Allow editing ANY user message, not just the latest.
 *
 * Upstream Codex restricts message editing to the most recent turn in two places:
 *
 *   Layer 1 (local-conversation-turn-*.js)
 *     The per-turn `onEditUserMessage` callback is built as
 *       j = !E || te==null || ... ? void 0 : async e=>{await te(u,e)}
 *     where `E` is `isMostRecentTurn`. Dropping the `!E ||` term makes the
 *     hover ✏️ affordance appear on every user turn.
 *
 *   Layer 2 (app-initial-*.js)
 *     `editLastUserTurn` hard-throws when any turn after the edited one has
 *     user input:
 *       if(c.turnId==null||m===-1||h.slice(1).some(({params:e})=>e.input.length>0))
 *         throw Error(`Only the most recent message can be edited.`)
 *     The remaining machinery is turn-agnostic: it already sends
 *     `thread/revert {beforeTurnId}` (paginated) or `thread/rollback {numTurns}`
 *     (legacy) for the full tail, so dropping the `.slice(1).some(...)` term is
 *     sufficient.
 *
 * NOTE: editing is DESTRUCTIVE — the edited turn and everything after it is
 * truncated from the thread. Non-destructive branch editing is layered on top
 * of this by later phases.
 *
 * Every layer hard-errors when its anchor is missing, so an upstream refactor
 * fails the build instead of silently shipping an unpatched app.
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

class PatchError extends Error {}

function eachBundle(pattern, platform, fn) {
  const bundles = locateBundles({
    dir: "assets",
    pattern,
    ...(platform ? { platform } : {}),
  });
  if (bundles.length === 0) {
    throw new PatchError(`no bundle matched ${pattern}`);
  }
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const next = fn(code, bundle);
    if (next === null) {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }
    fs.writeFileSync(bundle.path, next);
    console.log(`  [ok] ${relPath(bundle.path)}: patched`);
  }
}

/** Replace exactly one occurrence of `re`, or throw. */
function replaceOnce(code, re, build, what) {
  const matches = [...code.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
  if (matches.length !== 1) {
    throw new PatchError(`expected 1 match for ${what}, found ${matches.length}`);
  }
  const m = matches[0];
  return code.slice(0, m.index) + build(m) + code.slice(m.index + m[0].length);
}

// ─── Layer 1: show the edit affordance on every turn ────────────

// j = !E || te==null || u.turnId==null || u.status===`inProgress` ? void 0 : async e=>{await te(u,e)}
const L1_UNPATCHED =
  /(\w+)=!(\w+)\|\|(\w+)==null\|\|(\w+)\.turnId==null\|\|\4\.status===`inProgress`\?void 0:async (\w+)=>\{await \3\(\4,\5\)\}/;
const L1_PATCHED =
  /(\w+)=(\w+)==null\|\|(\w+)\.turnId==null\|\|\3\.status===`inProgress`\?void 0:async (\w+)=>\{await \2\(\3,\4\)\}/;

function layerEditGate(platform) {
  console.log("  [layer 1] local-conversation-turn: drop isMostRecentTurn gate");
  eachBundle(/^local-conversation-turn-.*\.js$/, platform, (code) => {
    if (!L1_UNPATCHED.test(code)) {
      if (L1_PATCHED.test(code)) return null;
      throw new PatchError("onEditUserMessage isMostRecentTurn gate not found");
    }
    return replaceOnce(
      code,
      L1_UNPATCHED,
      (m) =>
        `${m[1]}=${m[3]}==null||${m[4]}.turnId==null||${m[4]}.status===\`inProgress\`` +
        `?void 0:async ${m[5]}=>{await ${m[3]}(${m[4]},${m[5]})}`,
      "onEditUserMessage gate",
    );
  });
}

// ─── Layer 2: drop the "most recent only" throw ─────────────────

// if(c.turnId==null||m===-1||h.slice(1).some(({params:e})=>e.input.length>0))
//   throw Error(`Only the most recent message can be edited.`)
const L2_UNPATCHED =
  /if\((\w+)\.turnId==null\|\|(\w+)===-1\|\|(\w+)\.slice\(1\)\.some\(\(\{params:(\w+)\}\)=>\4\.input\.length>0\)\)throw Error\(`Only the most recent message can be edited\.`\)/;
const L2_PATCHED =
  /if\((\w+)\.turnId==null\|\|(\w+)===-1\)throw Error\(`Only the most recent message can be edited\.`\)/;

function layerEditThrow(platform) {
  console.log("  [layer 2] app-initial: drop most-recent-only throw");
  eachBundle(/^app-initial-.*\.js$/, platform, (code) => {
    if (!L2_UNPATCHED.test(code)) {
      if (L2_PATCHED.test(code)) return null;
      throw new PatchError("editLastUserTurn most-recent-only throw not found");
    }
    return replaceOnce(
      code,
      L2_UNPATCHED,
      (m) =>
        `if(${m[1]}.turnId==null||${m[2]}===-1)` +
        "throw Error(`Only the most recent message can be edited.`)",
      "editLastUserTurn throw",
    );
  });
}

// ─── Layer 3: ship the runtime helper + import it ───────────────

const HELPER_SRC = path.join(__dirname, "assets", "cdx-branch.js");
const HELPER_NAME = "cdx-branch.js";
const HELPER_IMPORT = `import"./${HELPER_NAME}";`;

/** Chunks that call into globalThis.__cdxBranch and therefore must import it. */
const HELPER_CONSUMERS = [
  /^local-conversation-thread-(?!turn-entries)[^/]*\.js$/,
  /^local-conversation-thread-turn-entries-.*\.js$/,
  /^subagent-activity-chip-group-.*\.js$/,
];

function layerHelper(platform) {
  console.log("  [layer 3] install cdx-branch.js runtime + imports");
  const helper = fs.readFileSync(HELPER_SRC, "utf-8");
  // Anchor on a chunk we already know exists to find each platform's assets dir.
  const anchors = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    ...(platform ? { platform } : {}),
  });
  if (anchors.length === 0) throw new PatchError("no assets dir found");
  for (const anchor of anchors) {
    const dest = path.join(path.dirname(anchor.path), HELPER_NAME);
    fs.writeFileSync(dest, helper);
    console.log(`  [ok] ${relPath(dest)}: written`);
  }
  for (const pattern of HELPER_CONSUMERS) {
    eachBundle(pattern, platform, (code) =>
      code.startsWith(HELPER_IMPORT) ? null : HELPER_IMPORT + code,
    );
  }
}

// ─── Layer 4: record turnId -> turn index while rendering ───────

// for(let a of N){ ... let l=a,d=l.turnId,_;S&&(...);let y=[{...,conversationId:r,...,isMostRecentTurn:B===P.length-1,
const L4_RE =
  /let (\w+)=(\w+),(\w+)=\1\.turnId,(\w+);(\w+)&&\(\4=(\w+)>=(\w+)\.length-3\?`auto-expand`:`default`\);let (\w+)=\[\{timestampSeparatorAtMs:null,aeonThreadTimestampMarkerKind:null,aeonThreadTimestampMarkerSentAtMs:null,conversationId:(\w+),/;

function layerTurnIndex(platform) {
  console.log("  [layer 4] turn-entries: record turnId -> index");
  eachBundle(/^local-conversation-thread-turn-entries-.*\.js$/, platform, (code) => {
    if (code.includes("__cdxBranch")) return null;
    if (!L4_RE.test(code)) throw new PatchError("turn entry builder not found");
    return replaceOnce(
      code,
      L4_RE,
      (m) => {
        // Must land *after* the `let` declarations it reads, or they are in TDZ.
        const decl = `let ${m[1]}=${m[2]},${m[3]}=${m[1]}.turnId,${m[4]};`;
        if (!m[0].startsWith(decl)) throw new PatchError("turn entry decl shape changed");
        return (
          decl +
          `globalThis.__cdxBranch?.noteTurn(${m[9]},${m[3]},${m[6]});` +
          m[0].slice(decl.length)
        );
      },
      "turn entry builder",
    );
  });
}

// ─── Layer 5: snapshot-fork before a destructive edit ───────────

// The whole `tt` (fork-from-turn) callback — used purely to learn the minified
// names of the fork helpers, cwd, collaborationMode, navigate and route builder.
const L5_FORK_RE =
  /(\w+)=(\w+)\(async (\w+)=>\{if\((\w+)\)try\{let (\w+)=(\w+)\((\w+),(\w+),(\w+)\),(\w+)=await (\w+)\(\7,\9,\{sourceConversationId:\8,targetTurnId:\3,cwd:(\w+),workspaceRoots:\12==null\?void 0:\[\12\],collaborationMode:(\w+)\}\);\5!=null&&await (\w+)\(\7,\9\)\.setThreadTitle\(\10,\5\),(\w+)\(\7,\{sourceConversationId:\8,targetConversationId:\10\}\),(\w+)\((\w+)\(\10,\9\),\{state:\{focusComposerNonce:Date\.now\(\)\}\}\)\}/;

// et = q(async(t,n)=>{try{await cf(y,Te.getHostId()).editLastUserTurn(e,{turnId:t.turnId,message:n,
const L5_EDIT_RE =
  /(\w+)=(\w+)\(async\((\w+),(\w+)\)=>\{try\{await (\w+)\((\w+),(\w+)\.getHostId\(\)\)\.editLastUserTurn\((\w+),\{turnId:\3\.turnId,message:\4,/;

// Be.current!==e&&(Be.current=e,ze.current=null);   — a plain statement in the
// same component body, after navigate/route helpers are in scope.
const L5_ANCHOR_RE =
  /(\w+)\.current!==(\w+)&&\(\1\.current=\2,(\w+)\.current=null\);/;

function layerSnapshotEdit(platform) {
  console.log("  [layer 5] thread: snapshot-fork before destructive edit");
  eachBundle(/^local-conversation-thread-(?!turn-entries)[^/]*\.js$/, platform, (code) => {
    if (code.includes("__cdxBranch?.beforeEdit")) return null;

    const fork = code.match(L5_FORK_RE);
    if (fork == null) throw new PatchError("fork-from-turn callback not found");
    const [, , , , , , SS, Y, CONV, HOST, , CA, CWD, MODE, CF, , NAV, ROUTE] = fork;

    const edit = code.match(L5_EDIT_RE);
    if (edit == null) throw new PatchError("editLastUserTurn callback not found");
    if (edit[6] !== Y || edit[8] !== CONV || edit[5] !== CF) {
      throw new PatchError(
        `edit/fork callbacks disagree on scope vars (${edit[6]}/${Y}, ${edit[8]}/${CONV}, ${edit[5]}/${CF})`,
      );
    }
    const TURN = edit[3];
    const HOSTID = `${edit[7]}.getHostId()`;

    // 5a — expose navigate to the switcher.
    let out = replaceOnce(
      code,
      L5_ANCHOR_RE,
      (m) =>
        `${m[0]}globalThis.__cdxBranch&&(globalThis.__cdxBranch.nav=` +
        `__cdxId=>${NAV}(${ROUTE}(__cdxId,${HOST})));`,
      "thread component body anchor",
    );

    // 5b — fork a full snapshot of the thread before the edit truncates it.
    // Omitting `targetTurnId` routes through forkConversationFromLatest, i.e. a
    // copy of the entire thread as it stands right now.
    out = replaceOnce(
      out,
      L5_EDIT_RE,
      (m) =>
        `${m[0].slice(0, m[0].indexOf("{try{") + 5)}` +
        `await globalThis.__cdxBranch?.beforeEdit({threadId:${CONV},turnId:${TURN}.turnId,fork:async()=>{` +
        `let __cdxT=${SS}(${Y},${CONV},${HOSTID}),` +
        `__cdxF=await ${CA}(${Y},${HOSTID},{sourceConversationId:${CONV},cwd:${CWD},` +
        `workspaceRoots:${CWD}==null?void 0:[${CWD}],collaborationMode:${MODE}});` +
        `return __cdxT!=null&&await ${CF}(${Y},${HOSTID}).setThreadTitle(__cdxF,__cdxT),__cdxF}});` +
        `${m[0].slice(m[0].indexOf("{try{") + 5)}`,
      "editLastUserTurn callback",
    );
    return out;
  });
}

// ─── Layer 6: second edit entry point + version switcher ────────

const L6_PROPS_RE =
  /onEditMessage:(\w+),threadId:(\w+),turnId:(\w+),cwd:(\w+),hostId:(\w+)\}=(\w+)/;

const L6_BTN_RE =
  /(\w+)\?\(0,(\w+)\.jsx\)\((\w+),\{className:`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0`,color:`ghost`,size:`icon`,"aria-label":(\w+)\.formatMessage\(\{id:`codex\.userMessage\.editAriaLabel`,defaultMessage:`Edit message`,description:`[^`]*`\}\),onClick:(\w+),children:\(0,\2\.jsx\)\((\w+),\{className:`icon-xs`\}\)\}\):null/;

const L6_ROOT_RE =
  /(\w+)=\(0,(\w+)\.jsxs\)\(`div`,\{className:`group flex w-full flex-col items-end justify-end gap-1`,children:\[(\w+),(\w+)\]\}\)/;

function layerSwitcher(platform) {
  console.log("  [layer 6] user message: in-place edit button + version arrows");
  eachBundle(/^subagent-activity-chip-group-.*\.js$/, platform, (code) => {
    if (code.includes("__cdxBranch")) return null;

    const props = code.match(L6_PROPS_RE);
    if (props == null) throw new PatchError("user message props not found");
    const [, , THREAD_PROP, TURN] = props;

    // The `threadId` prop is optional; the component resolves it as
    // `L = threadId ?? fromRoute(...)`. Key the switcher off the resolved value.
    const resolved = code.match(
      new RegExp(`\\((\\w+)=${THREAD_PROP}\\?\\?(\\w+)\\((\\w+)\\.value\\),`),
    );
    if (resolved == null) throw new PatchError("resolved threadId not found");
    const THREAD = resolved[1];

    // 6a — tag the existing ✏️ as branch mode and add a destructive twin.
    let out = replaceOnce(
      code,
      L6_BTN_RE,
      (m) => {
        const [, SHOW, JSX, BTN, INTL, START, ICON] = m;
        const branch =
          `${SHOW}?(0,${JSX}.jsx)(${BTN},{className:\`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0\`,` +
          `color:\`ghost\`,size:\`icon\`,"aria-label":${INTL}.formatMessage({id:\`codex.userMessage.editAriaLabel\`,` +
          "defaultMessage:`Edit message`,description:`Aria label for the button that edits the previous user message`})," +
          "title:`Edit message — keeps the current thread as an earlier version`," +
          `onClick:()=>{globalThis.__cdxBranch&&(globalThis.__cdxBranch.mode=\`branch\`),${START}()},` +
          `children:(0,${JSX}.jsx)(${ICON},{className:\`icon-xs\`})}):null`;
        const inplace =
          `${SHOW}?(0,${JSX}.jsx)(${BTN},{className:\`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0\`,` +
          "color:`ghost`,size:`icon`,\"aria-label\":`Edit in place`," +
          "title:`Edit in place — truncates this thread, no earlier version kept`," +
          `onClick:()=>{globalThis.__cdxBranch&&(globalThis.__cdxBranch.mode=\`inplace\`),${START}()},` +
          "children:`↺`}):null";
        return `${branch},${inplace}`;
      },
      "user message edit button",
    );

    // 6b — hang the `< n/m >` switcher under the bubble, outside the hover-only row.
    out = replaceOnce(
      out,
      L6_ROOT_RE,
      (m) =>
        `${m[1]}=(0,${m[2]}.jsxs)(\`div\`,{className:\`group flex w-full flex-col items-end justify-end gap-1\`,` +
        `children:[${m[3]},${m[4]},globalThis.__cdxBranch?globalThis.__cdxBranch.switcher(${m[2]},${THREAD},${TURN}):null]})`,
      "user message root element",
    );
    return out;
  });
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const platform = process.argv.slice(2).find((a) => PLATFORMS.includes(a));
  try {
    layerEditGate(platform);
    layerEditThrow(platform);
    layerHelper(platform);
    layerTurnIndex(platform);
    layerSnapshotEdit(platform);
    layerSwitcher(platform);
  } catch (e) {
    if (!(e instanceof PatchError)) throw e;
    console.error(`  [x] ${e.message}`);
    process.exit(1);
  }
  console.log("  [done] branch-edit");
}

main();
