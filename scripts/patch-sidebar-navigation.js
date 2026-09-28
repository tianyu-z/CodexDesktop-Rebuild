#!/usr/bin/env node
/** Independent appearance patch for 26.820.71523. Never rewrites engine or composer code. */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { locateBundles } = require('./patch-util');
const IMPORT = 'import"./sidebar-navigation-ui.js";';
const MARKER = '/* cdx-appearance-2026-09-v1 */';
const ASSETS = path.join(__dirname, 'assets');
function replaceOnce(code, before, after) {
  if (code.split(before).length !== 2) throw Error('appearance: missing or ambiguous anchor: ' + before.slice(0, 100));
  return code.replace(before, () => after);
}
function functionNode(code, name) {
  const anchor = 'function ' + name + '(';
  if (code.split(anchor).length !== 2) throw Error('appearance: unsupported function ' + name);
  return acorn.parseExpressionAt(code, code.indexOf(anchor), { ecmaVersion: 'latest' });
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => walk(child, visit)); else if (value && typeof value === 'object') walk(value, visit);
}
function patchSidebarCode(input) {
  if (input.includes(MARKER)) {
    if (!input.startsWith(IMPORT) || input.split(MARKER).length !== 2 || !input.includes('function __cdxLegacyNavigationRail(') || !input.includes('function __cdxContextualNavigation(')) throw Error('appearance: incomplete existing patch');
    const next = input.slice(0, input.indexOf(MARKER)) + MARKER + '\n' + fs.readFileSync(path.join(ASSETS, 'sidebar-navigation-bridge.js'), 'utf8');
    acorn.parse(next, { ecmaVersion: 'latest', sourceType: 'module' });
    return next;
  }
  // Validate all structural edits before writing any file.
  let code = input;
  functionNode(code, 'GSl');
  const sidebar = functionNode(code, 'BKl'), children = [];
  walk(sidebar, node => {
    if (node.type !== 'ObjectExpression') return;
    const className = node.properties.find(property => property.key?.name === 'className');
    if (!className || code.slice(className.value.start, className.value.end) !== 'RKl.Navigation') return;
    const content = node.properties.find(property => property.key?.name === 'children');
    if (content) children.push(content.value);
  });
  if (children.length !== 1) throw Error('appearance: expected exactly one native conversation sidebar');
  const content = children[0];
  code = code.slice(0, content.start) + '(0,g7.jsx)(__cdxContextualNavigation,{nativeContent:' + code.slice(content.start, content.end) + '})' + code.slice(content.end);
  code = replaceOnce(code, 'function GSl(', 'function __cdxLegacyNavigationRail(');
  code = replaceOnce(code, 'if(!e(vb,`3085093835`))return`legacy`;', '/* Independent visual rail; service capability gates remain native. */');
  code = replaceOnce(code, 'function Qpl(e){', 'function Qpl(e){if(globalThis.__cdxSidebarNavigation.hasPanel(e))return true;');
  code = replaceOnce(code, '$pl=45', '$pl=52');
  code = IMPORT + code + '\n' + MARKER + '\n' + fs.readFileSync(path.join(ASSETS, 'sidebar-navigation-bridge.js'), 'utf8');
  acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  return code;
}
function patchSidebarAssets(assets, { check = false } = {}) {
  const names = fs.readdirSync(assets).filter(name => /^app-initial-.*\.js$/.test(name));
  if (names.length !== 1 || names[0] !== 'app-initial-CX2pZp2Q.js') throw Error('appearance: only pinned 26.820.71523 frontend is supported');
  const bundle = path.join(assets, names[0]), html = path.join(assets, '..', 'index.html');
  const code = patchSidebarCode(fs.readFileSync(bundle, 'utf8'));
  const tag = '<link rel="stylesheet" href="./assets/desktop-appearance.css" data-cdx-appearance="2026-09">';
  let index = fs.readFileSync(html, 'utf8');
  if (!index.includes(tag)) index = replaceOnce(index, '</head>', '  ' + tag + '\n</head>');
  if (!check) {
    fs.writeFileSync(bundle, code);
    for (const name of ['sidebar-navigation-ui.js', 'desktop-appearance.css']) fs.copyFileSync(path.join(ASSETS, name), path.join(assets, name));
    fs.writeFileSync(html, index);
  }
  return { bundle, changed: true };
}
if (require.main === module) {
  const platform = process.argv.find(value => ['mac-arm64', 'mac-x64', 'win'].includes(value));
  for (const bundle of locateBundles({ dir: 'assets', pattern: /^app-initial-.*\.js$/, platform })) {
    // The standard cross-version build is also used for unmodified official sources.
    // Only the pinned engine build has this independently validated appearance contract.
    if (path.basename(bundle.path) !== 'app-initial-CX2pZp2Q.js') { console.log('appearance: skipped unsupported bundle ' + path.basename(bundle.path)); continue; }
    console.log(patchSidebarAssets(path.dirname(bundle.path), { check: process.argv.includes('--check') }));
  }
}
module.exports = { patchSidebarCode, patchSidebarAssets };
