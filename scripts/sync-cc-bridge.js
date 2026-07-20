#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const sourceDir = path.join(__dirname, "cc-bridge");
const targetDir = path.join(os.homedir(), ".codex", "cc-bridge");
const sourceBridge = path.join(sourceDir, "bridge.js");
const targetBridge = path.join(targetDir, "bridge.js");

function block(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end);
  if (from < 0 || to < from) throw new Error("missing source marker " + start);
  return source.slice(from, to + end.length);
}

function replaceBlock(target, source, start, end) {
  const replacement = block(source, start, end);
  if (!target.includes(start)) return null;
  const current = block(target, start, end);
  return target.replace(current, replacement);
}

function main() {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(path.join(sourceDir, "ensemble.js"), path.join(targetDir, "ensemble.js"));
  if (!fs.existsSync(targetBridge)) {
    fs.copyFileSync(sourceBridge, targetBridge);
    console.log("  [ok] installed bridge.js and ensemble.js");
    return;
  }

  let target = fs.readFileSync(targetBridge, "utf8");
  const source = fs.readFileSync(sourceBridge, "utf8");
  const importLine = block(source, "// __ENSEMBLE_IMPORT_V1__", 'const ensemble = require("./ensemble.js");');
  const turnHook = block(source, "// __ENSEMBLE_TURN_HOOK_V1_START__", "// __ENSEMBLE_TURN_HOOK_V1_END__");
  const handler = block(source, "// __ENSEMBLE_HANDLER_V1_START__", "// __ENSEMBLE_HANDLER_V1_END__");

  if (!target.includes('require("./ensemble.js")')) {
    const anchor = 'const path = require("path");';
    if (!target.includes(anchor)) throw new Error("bridge import anchor not found");
    target = target.replace(anchor, anchor + "\n" + importLine);
  }
  const titleAnchor = 'if (/provide a short title|concise UI title/i.test(text)) { sendCodex(line); return; }';
  if (!target.includes("ensembleConfig.enabled")) {
    if (!target.includes(titleAnchor)) throw new Error("turn hook anchor not found");
    target = target.replace(titleAnchor, titleAnchor + "\n    " + turnHook.replace(/\n/g, "\n    "));
  }
  if (!target.includes("function interceptEnsemble")) {
    const handlerAnchor = "function interceptTurn(req, route) {";
    if (!target.includes(handlerAnchor)) throw new Error("handler anchor not found");
    target = target.replace(handlerAnchor, handler + "\n\n" + handlerAnchor);
  }
  target = replaceBlock(target, source, "// __ENSEMBLE_IMPORT_V1__", 'const ensemble = require("./ensemble.js");') || target;
  target = replaceBlock(target, source, "// __ENSEMBLE_TURN_HOOK_V1_START__", "// __ENSEMBLE_TURN_HOOK_V1_END__") || target;
  target = replaceBlock(target, source, "// __ENSEMBLE_HANDLER_V1_START__", "// __ENSEMBLE_HANDLER_V1_END__") || target;
  fs.writeFileSync(targetBridge, target);
  console.log("  [ok] synchronized ensemble bridge integration");
}

if (require.main === module) main();

module.exports = { block, replaceBlock };
