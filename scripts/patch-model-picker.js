#!/usr/bin/env node
/**
 * patch-model-picker.js — Make the native model MENU list arbitrary models
 * (Codex + Claude Code), not just codex's curated set.
 *
 * The model menu renders `m?.map(e => <yt modelOption={e} …/>)` where `m` is the
 * models array from the list query (after model-list-filter F). Two gates hide
 * Claude models:
 *   1. F drops models not in `availableModels` when useHiddenModels is on.
 *   2. (investigating) the item component may hide unknown models.
 *
 * This patch: (a) forces F's `!hidden` path so non-hidden models pass, and
 * (b) installs a probe capturing the models array the menu receives.
 *
 * Usage: node scripts/patch-model-picker.js [mac-arm64|mac-x64|win]
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const opts = platform ? { platform } : {};
  let did = 0;

  // 1. model-list-filter: bypass the availableModels gate.
  for (const b of locateBundles({ dir: "assets", pattern: /^model-list-filter-.*\.js$/, all: true, ...opts })) {
    let code = fs.readFileSync(b.path, "utf-8");
    if (code.includes("/*ccgate*/")) { console.log(`  [ok] ${relPath(b.path)}: filter already patched`); did++; continue; }
    const re = /(\w)\?(\w+)\.has\((\w+)\.model\):!(\w+)\.hidden/;
    const m = code.match(re);
    if (m) { code = code.replace(re, "/*ccgate*/!" + m[4] + ".hidden"); fs.writeFileSync(b.path, code); console.log(`  [ok] ${relPath(b.path)}: availableModels gate bypassed`); did++; }
    else console.log(`  [!] ${relPath(b.path)}: gate not found`);
  }

  // 2. model-and-reasoning-dropdown: probe the models array the menu maps over.
  for (const b of locateBundles({ dir: "assets", pattern: /^model-and-reasoning-dropdown-.*\.js$/, all: true, ...opts })) {
    let code = fs.readFileSync(b.path, "utf-8");
    if (code.includes("__ccMenuModels")) { console.log(`  [ok] ${relPath(b.path)}: menu probe present`); did++; continue; }
    // Match: (X=Y?.map(Z=>(0,$.jsx)(W,{keepOpenOnSelect
    const re = /(=)(\w+)(\?\.map\(\w+=>\(0,\$?\.?jsx\)\(\w+,\{keepOpenOnSelect)/;
    const m = code.match(re);
    if (m) {
      code = code.replace(re, "$1(window.__ccMenuModels=" + m[2] + "," + m[2] + ")$3");
      fs.writeFileSync(b.path, code);
      console.log(`  [ok] ${relPath(b.path)}: menu-models probe installed`);
      did++;
    } else console.log(`  [!] ${relPath(b.path)}: menu map site not found`);
  }

  // 3. composer: expose the model-select handler so we can drive/verify selection.
  for (const b of locateBundles({ dir: "assets", pattern: /^composer-.*\.js$/, all: true, ...opts })) {
    let code = fs.readFileSync(b.path, "utf-8");
    if (code.includes("__ccSelectModel")) { console.log(`  [ok] ${relPath(b.path)}: composer probe present`); did++; continue; }
    const re = /onSelectModel:\((\w+),(\w+)\)=>\{(\w+)\(\1,\2\)\}/;
    const m = code.match(re);
    if (m) {
      code = code.replace(re, "onSelectModel:(window.__ccSelectModel=(" + m[1] + "," + m[2] + ")=>{" + m[3] + "(" + m[1] + "," + m[2] + ")})");
      fs.writeFileSync(b.path, code);
      console.log(`  [ok] ${relPath(b.path)}: onSelectModel exposed as window.__ccSelectModel`);
      did++;
    } else console.log(`  [!] ${relPath(b.path)}: onSelectModel handler not found`);
  }

  if (did === 0) { console.error("  [x] model-picker: nothing patched"); process.exit(1); }
}

main();
