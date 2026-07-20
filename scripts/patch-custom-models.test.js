const test = require("node:test");
const assert = require("node:assert/strict");

const {
  IPC_INJECT,
  PRELOAD_INJECT,
  UI_INJECT,
  CONV_CONTROLS_INJECT,
  replaceInjectedIife,
} = require("./patch-custom-models");

test("all injected scripts compile independently", () => {
  for (const injection of [IPC_INJECT, PRELOAD_INJECT, UI_INJECT, CONV_CONTROLS_INJECT]) {
    assert.doesNotThrow(() => new Function(injection));
  }
});

test("refreshes an existing injected IIFE without duplicating surrounding code", () => {
  const old = "before\n;(function(){\nSENTINEL\nold\n})();\nafter";
  const replacement = "\n;(function(){\nSENTINEL\nnew\n})();\n";
  const next = replaceInjectedIife(old, "SENTINEL", replacement);

  assert.equal(next.match(/SENTINEL/g).length, 1);
  assert.match(next, /^before/);
  assert.match(next, /new/);
  assert.match(next, /after$/);
  assert.doesNotMatch(next, /old/);
});

test("exposes a real harness probe through IPC and preload", () => {
  assert.match(IPC_INJECT, /codex-models:test/);
  assert.match(IPC_INJECT, /if\(!__e\|\|!__e\.ipcMain\)return/);
  assert.match(IPC_INJECT, /Reply with exactly OK/);
  assert.match(IPC_INJECT, /Timed out after 60 seconds/);
  assert.match(IPC_INJECT, /child\.stdin\.end/);
  assert.match(PRELOAD_INJECT, /test:function\(spec\)/);
});

test("adds the custom model action to the native model menu", () => {
  assert.match(UI_INJECT, /querySelectorAll\('\[role="menu"\]'\)/);
  assert.match(UI_INJECT, /data-cc-add-model/);
  assert.match(UI_INJECT, /data-model-picker-model-row/);
  assert.match(UI_INJECT, /Add custom model/);
  assert.match(UI_INJECT, /Add and select/);
  assert.match(UI_INJECT, /window\.codexModels\.test/);
  assert.match(UI_INJECT, /window\.__ccSelectModel/);
});
