#!/usr/bin/env node
/**
 * patch-model-add.js — Add extra models to the client-side picker lists.
 *
 * Upstream Codex bakes its selectable models into the `app-initial-*.js`
 * bundle as two hardcoded candidate/ordering arrays of
 *   {id, model, modelLabel, reasoningEffort}
 * entries (minified names, e.g. `Uic` and `Gic`). At runtime the picker
 * intersects those candidates with the models the server actually offers
 * (see `Vic(candidates, availableModels)`), and each model's real
 * `supportedReasoningEfforts` is served by the backend — nothing is
 * hardcoded here beyond the candidate list.
 *
 * This patch appends our extra models to BOTH candidate arrays, mirroring
 * an existing model's shape, so they surface in the picker with the right
 * label and effort ordering. Availability is still gated by the backend:
 * a model added here only appears/works if the account/server serves it.
 *
 * We anchor on the TAIL entry of each array (the minified array variable
 * name changes across upstream rebuilds, the model entries do not):
 *   - list A (the primary list): ends with the `gpt-5.6-sol:xhigh` entry
 *   - list B (the fallback list): ends with the `gpt-5.6-terra:xhigh` entry
 * and insert the new entries right after it, before the closing `]`.
 *
 * Like every patch here, a missing anchor is a hard error so an upstream
 * refactor fails the build instead of silently shipping an unpatched app.
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const PLATFORMS = ["mac-arm64", "mac-x64", "win"];

class PatchError extends Error {}

// ─── Models to add ──────────────────────────────────────────────
// One entry per (model, reasoningEffort). Mirror an existing model's
// effort set; the backend ultimately decides which efforts are valid.
const NEW_MODELS = [
  { model: "gpt-6-astra", modelLabel: "6 Astra", efforts: ["low", "medium", "high", "xhigh"] },
];

function entriesFor(models) {
  return models
    .flatMap(({ model, modelLabel, efforts }) =>
      efforts.map(
        (effort) =>
          `{id:\`${model}:${effort}\`,model:\`${model}\`,` +
          `modelLabel:\`${modelLabel}\`,reasoningEffort:\`${effort}\`}`,
      ),
    )
    .join(",");
}

// Tail entry of each hardcoded candidate array. `.` is escaped for regex.
const TAIL_A =
  /\{id:`gpt-5\.6-sol:xhigh`,model:`gpt-5\.6-sol`,modelLabel:`5\.6 Sol`,reasoningEffort:`xhigh`\}/;
const TAIL_B =
  /\{id:`gpt-5\.6-terra:xhigh`,model:`gpt-5\.6-terra`,modelLabel:`5\.6 Terra`,reasoningEffort:`xhigh`\}/;

/** Replace exactly one occurrence of `re`, or throw. */
function replaceOnce(code, re, build, what) {
  const matches = [...code.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
  if (matches.length !== 1) {
    throw new PatchError(`expected 1 match for ${what}, found ${matches.length}`);
  }
  const m = matches[0];
  return code.slice(0, m.index) + build(m) + code.slice(m.index + m[0].length);
}

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

function main() {
  const platform = process.argv.slice(2).find((a) => PLATFORMS.includes(a));
  const extra = entriesFor(NEW_MODELS);
  const added = NEW_MODELS.map((m) => m.model).join(", ");
  console.log(`  [model-add] append to picker candidate lists: ${added}`);

  try {
    eachBundle(/^app-initial-.*\.js$/, platform, (code) => {
      if (NEW_MODELS.every((m) => code.includes(`\`${m.model}:`))) return null;

      let out = replaceOnce(code, TAIL_A, (m) => `${m[0]},${extra}`, "primary model list tail");
      out = replaceOnce(out, TAIL_B, (m) => `${m[0]},${extra}`, "fallback model list tail");
      return out;
    });
  } catch (e) {
    if (!(e instanceof PatchError)) throw e;
    console.error(`  [x] ${e.message}`);
    process.exit(1);
  }
  console.log("  [done] model-add");
}

main();
