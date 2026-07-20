#!/usr/bin/env node
/**
 * Post-build patch: Force-enable DevTools & InspectElement
 *
 * Strategy (AST-based):
 *   In the main bundle, find Property nodes:
 *   - allowInspectElement: <value>  ->  allowInspectElement: !0
 *   - devTools: <expr containing allowDevtools>  ->  devTools: !0
 *
 * Usage:
 *   node scripts/patch-devtools.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-devtools.js --check      # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walkAST(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((c) => walkAST(c, visitor, node));
    } else if (child && typeof child === "object" && child.type) {
      walkAST(child, visitor, node);
    }
  }
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return null;
}

// ──────────────────────────────────────────────
//  Declarative rules
// ──────────────────────────────────────────────

const RULES = [
  {
    id: "allowInspectElement",
    match(node, source, parent) {
      if (node.type !== "Property") return null;
      if (getPropertyName(node.key) !== "allowInspectElement") return null;
      // Skip destructured function params (ObjectPattern context)
      if (parent && parent.type === "ObjectPattern") return null;
      if (node.shorthand) return null;
      const val = node.value;
      const valSrc = source.slice(val.start, val.end);
      if (valSrc === "!0") return null;
      // Skip if value is a binding target (Identifier in pattern-like position)
      // Only patch when value is clearly an expression (MemberExpression, Identifier used as value)
      return { start: val.start, end: val.end, replacement: "!0", original: valSrc };
    },
  },
  {
    id: "devTools",
    match(node, source) {
      if (node.type !== "Property") return null;
      if (getPropertyName(node.key) !== "devTools") return null;
      const val = node.value;
      const valSrc = source.slice(val.start, val.end);
      if (valSrc === "!0") return null;
      if (!valSrc.includes("allowDevtools") && !valSrc.includes("allowDevTools"))
        return null;
      return { start: val.start, end: val.end, replacement: "!0", original: valSrc };
    },
  },
];

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateBundles({
    dir: "build",
    pattern: /^main(-[^.]+)?\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.error("[x] No main bundle found");
    process.exit(1);
  }

  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1048576).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = [];
    const seen = new Set();

    walkAST(ast, (node, parent) => {
      for (const rule of RULES) {
        const result = rule.match(node, source, parent);
        if (!result) continue;
        const key = `${result.start}:${result.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        patches.push({ ...result, rule: rule.id });
      }
    });

    // Menu/shortcut gate — applied independently of the AST devTools patches, since a
    // bundle can already have devTools:!0 (patches.length===0) yet still hide the menu
    // item + its Ctrl+Shift+I / F12 accelerator behind a debug flag `r`:
    //   ...r?[{role:`toggleDevTools`}]:[]
    // Force the gate true so the item + accelerator always exist. String-based: the gate
    // var name is minified/unstable across builds; the literal role token is not.
    function forceMenuGate(src) {
      const MENU_GATE = "...r?[{role:`toggleDevTools`}]:[]";
      const MENU_GATE_FORCED = "...!0?[{role:`toggleDevTools`}]:[]";
      if (src.includes(MENU_GATE)) {
        console.log("   * [menuGate] toggleDevTools menu item + accelerator force-enabled");
        return src.split(MENU_GATE).join(MENU_GATE_FORCED);
      }
      if (src.includes(MENU_GATE_FORCED)) {
        console.log("   [ok] menu gate already forced");
      } else {
        console.log("   [!] toggleDevTools menu gate not found (upstream layout changed)");
      }
      return src;
    }

    if (patches.length === 0) {
      console.log("   [ok] DevTools property already enabled or no match");
      if (!isCheck) {
        const forced = forceMenuGate(source);
        if (forced !== source) fs.writeFileSync(bundle.path, forced, "utf-8");
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of [...patches].reverse()) {
        console.log(`     > [${p.rule}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    let patched = source;
    for (const p of patches) {
      console.log(`   * [${p.rule}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      patched = patched.slice(0, p.start) + p.replacement + patched.slice(p.end);
    }

    patched = forceMenuGate(patched);

    fs.writeFileSync(bundle.path, patched, "utf-8");
    console.log(`   [ok] DevTools force-enabled: ${patches.length} replacements`);
  }
}

main();
