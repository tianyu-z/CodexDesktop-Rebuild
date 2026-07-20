"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { replaceBlock } = require("./sync-cc-bridge");

test("refreshes an existing marked bridge block without changing surrounding code", () => {
  const target = [
    "before",
    "// START",
    "old handler",
    "// END",
    "after",
  ].join("\n");
  const source = [
    "// START",
    "new streaming handler",
    "// END",
  ].join("\n");

  assert.equal(replaceBlock(target, source, "// START", "// END"), [
    "before",
    "// START",
    "new streaming handler",
    "// END",
    "after",
  ].join("\n"));
});

test("returns null when a marked bridge block is not installed yet", () => {
  assert.equal(replaceBlock("plain bridge", "// START\nnew\n// END", "// START", "// END"), null);
});
