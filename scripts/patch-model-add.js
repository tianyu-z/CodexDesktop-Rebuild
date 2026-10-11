#!/usr/bin/env node
/**
 * patch-model-add.js — Make extra models selectable in the app.
 *
 * The Codex desktop app populates its model picker from the CLI's
 * `model/list` response: `select:({data})=>Uqa({...,models:data,...})`
 * iterates ONLY over that list (see `Uqa`/`Wqa`). A model the CLI has no
 * metadata for is absent from `model/list`, so it never appears — even
 * though `codex exec -m <model>` runs it fine ("Model metadata for X not
 * found. Defaulting to fallback metadata"). The `availableModels`
 * whitelist and `additionalAvailableModels` only un-hide models already
 * in the list; they cannot introduce a new one.
 *
 * So to surface such a model we must inject it INTO the `model/list` data.
 *
 * Two layers, both idempotent and hard-erroring on a missing anchor so an
 * upstream refactor fails the build instead of silently shipping unpatched:
 *
 *   Layer A — append the model to the two hardcoded reasoning-effort
 *     candidate arrays (minified `Uic`/`Gic`) so the effort slider orders
 *     it correctly. Anchored on each array's tail entry.
 *
 *   Layer B — in every `Uqa({...,models:<data>,useHiddenModels:<x>.
 *     useHiddenModels})` call (the model-list builders), replace
 *     `models:<data>` with a synthetic entry appended when missing. The
 *     entry is CLONED from its base model, or the first existing model, with only
 *     its identity + visibility overridden, so it inherits a valid shape
 *     (supportedReasoningEfforts, contextWindow, …) and can never crash
 *     the picker on a missing field. Object KEYS in the call
 *     (`models:`/`useHiddenModels:`) are destructuring names and survive
 *     minification; only the local var aliases are matched loosely.
 *
 * Availability is still gated by the backend: injecting here makes the app
 * SEND `-m <model>`; whether the turn succeeds is up to the CLI/backend
 * (which, per the user's `codex exec` test, already serves it).
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

class PatchError extends Error {}

// ─── Models to add ──────────────────────────────────────────────
const NEW_MODELS = [
  { model: "gpt-6-astra", modelLabel: "6 Astra", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "gpt-6.1-sol", modelLabel: "6.1 Sol", cloneFrom: "gpt-6-sol", efforts: ["low", "medium", "high", "xhigh"] },
];

function candidateEntries(models) {
  return models
    .flatMap(({ model, modelLabel, efforts }) =>
      efforts.map(
        (effort) =>
          "{id:`" + model + ":" + effort + "`,model:`" + model + "`," +
          "modelLabel:`" + modelLabel + "`,reasoningEffort:`" + effort + "`}",
      ),
    )
    .join(",");
}

// Tail entry of each hardcoded candidate array (`.` escaped for regex).
const TAIL_A =
  /\{id:`gpt-5\.6-sol:xhigh`,model:`gpt-5\.6-sol`,modelLabel:`5\.6 Sol`,reasoningEffort:`xhigh`\}/;
const TAIL_B =
  /\{id:`gpt-5\.6-terra:xhigh`,model:`gpt-5\.6-terra`,modelLabel:`5\.6 Terra`,reasoningEffort:`xhigh`\}/;

// Uqa model-list builder call: `...,models:<data>,useHiddenModels:<x>.useHiddenModels`
// (the trailing `.useHiddenModels` distinguishes the CALL from Uqa's own
// destructuring definition `models:s,useHiddenModels:c}`).
const MODELS_CALL = /,models:(\w+),useHiddenModels:(\w+)\.useHiddenModels\b/g;
const LEGACY_MODELS_CALL = /,models:\(!([\w]+)\.length\|\|\1\.some\(o=>o&&o\.model===`gpt-6-astra`\)\?\1:\1\.concat\(\[\{\.\.\.\1\[0\],model:`gpt-6-astra`,slug:`gpt-6-astra`,id:`gpt-6-astra`,displayName:`6 Astra`,isDefault:!1,hidden:!1\}\]\)\),useHiddenModels:(\w+)\.useHiddenModels\b/g;
const INJECT_MARKER = "/*cdx-model-add-v2*/";

/** Replace exactly one occurrence, or throw. */
function replaceOnce(code, re, build, what) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const matches = [...code.matchAll(g)];
  if (matches.length !== 1) {
    throw new PatchError("expected 1 match for " + what + ", found " + matches.length);
  }
  const m = matches[0];
  return code.slice(0, m.index) + build(m) + code.slice(m.index + m[0].length);
}

/** Replace every occurrence (>=1), or throw. Returns {code, count}. */
function replaceAll(code, re, build, what) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const matches = [...code.matchAll(g)];
  if (matches.length === 0) {
    throw new PatchError("expected >=1 match for " + what + ", found 0");
  }
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += code.slice(last, m.index) + build(m);
    last = m.index + m[0].length;
  }
  return { code: out + code.slice(last), count: matches.length };
}

function eachBundle(pattern, platform, fn) {
  const bundles = locateBundles({ dir: "assets", pattern, ...(platform ? { platform } : {}) });
  if (bundles.length === 0) throw new PatchError("no bundle matched " + pattern);
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const next = fn(code, bundle);
    if (next === null) {
      console.log("  [ok] " + relPath(bundle.path) + ": already patched");
      continue;
    }
    fs.writeFileSync(bundle.path, next);
    console.log("  [ok] " + relPath(bundle.path) + ": patched");
  }
}

// ─── Layer A: hardcoded effort-slider candidate lists ───────────
function layerCandidates(platform) {
  console.log("  [layer A] effort-slider candidate lists (Uic/Gic)");
  eachBundle(/^app-initial-.*\.js$/, platform, (code) => {
    let out = code;
    for (const tail of [TAIL_A, TAIL_B]) {
      out = replaceOnce(out, new RegExp(tail.source + "[^\\]]*\\]"), (m) => {
        const missing = NEW_MODELS.map(model => ({ ...model,
          efforts: model.efforts.filter(effort => !m[0].includes("id:`" + model.model + ":" + effort + "`")),
        }));
        const extra = candidateEntries(missing);
        return extra ? m[0].slice(0, -1) + "," + extra + "]" : m[0];
      }, "candidate list tail " + tail.source);
    }
    return out === code ? null : out;
  });
}

// ─── Layer B: inject into the model/list data (Uqa calls) ───────
function synthModels(dataVar) {
  // Prefer the same model family. Keep native entries authoritative and leave
  // empty catalogs untouched because they have no valid metadata to inherit.
  const models = NEW_MODELS.map(({ model, modelLabel, cloneFrom }) => [model, modelLabel, cloneFrom ?? model]);
  return (
    "((catalog)=>" + INJECT_MARKER + "!catalog.length?catalog:" + JSON.stringify(models) +
    ".reduce((data,[model,displayName,base])=>data.some(o=>o&&o.model===model)?data:" +
    "data.concat([{...(catalog.find(o=>o&&o.model===base)||catalog[0])," +
    "model,slug:model,id:model,displayName,isDefault:!1,hidden:!1}]),catalog))(" + dataVar + ")"
  );
}

function layerInject(platform) {
  console.log("  [layer B] inject synthetic model into model/list builders (Uqa)");
  eachBundle(/^app-initial-.*\.js$/, platform, (code) => {
    if (code.includes(INJECT_MARKER)) return null;
    // Upgrade the exact v1 expression already present in installed dev builds.
    code = code.replace(LEGACY_MODELS_CALL, ",models:$1,useHiddenModels:$2.useHiddenModels");
    const { code: patched, count } = replaceAll(
      code,
      MODELS_CALL,
      (m) =>
        ",models:" + synthModels(m[1]) +
        ",useHiddenModels:" + m[2] + ".useHiddenModels",
      "Uqa models-list call",
    );
    console.log("       injected into " + count + " builder call(s)");
    return patched;
  });
}

function main() {
  const platform = process.argv.slice(2).find((a) => PLATFORMS.includes(a));
  console.log("  [model-add] " + NEW_MODELS.map((m) => m.model).join(", "));
  try {
    layerCandidates(platform);
    layerInject(platform);
  } catch (e) {
    if (!(e instanceof PatchError)) throw e;
    console.error("  [x] " + e.message);
    process.exit(1);
  }
  console.log("  [done] model-add");
}

main();
