#!/usr/bin/env node
/** Build the appearance layer on the installed modified app, retaining every previous fix. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { patchSidebarAssets } = require('./patch-sidebar-navigation');
const ROOT = path.resolve(__dirname, '..');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function build({ sourceApp = '/Applications/chatgpt-dev.app', output = path.join(ROOT, '.artifacts', 'ChatGPT Appearance Candidate.app'), appName = 'chatgpt-dev-appearance-candidate', release = false } = {}) {
  if (!/^[a-z0-9-]+$/.test(appName)) throw Error('Invalid preview name');
  if (fs.existsSync(output)) throw Error('Appearance output already exists: ' + output);
  const asar = await import('@electron/asar');
  const sourceArchive = path.join(sourceApp, 'Contents', 'Resources', 'app.asar');
  const originalHash = hash(sourceArchive);
  if (JSON.parse(asar.extractFile(sourceArchive, 'package.json')).version !== '26.820.71523') throw Error('Unsupported installed frontend');
  const stage = fs.mkdtempSync(path.join(ROOT, '.artifacts', 'appearance-build-'));
  const destination = output;
  // Keep the final app path absent until signing completes, so an early launch
  // cannot map framework binaries while codesign is replacing their signature.
  output = path.join(stage, 'Appearance.app');
  const extracted = path.join(stage, 'asar');
  asar.extractAll(sourceArchive, extracted);
  const inventory = directory => {
    const result = {};
    const visit = (relative = '') => {
      for (const name of fs.readdirSync(path.join(directory, relative))) {
        const file = path.join(relative, name), absolute = path.join(directory, file);
        if (fs.lstatSync(absolute).isSymbolicLink()) result[file] = 'link:' + fs.readlinkSync(absolute);
        else if (fs.statSync(absolute).isDirectory()) visit(file);
        else result[file] = hash(absolute);
      }
    };
    visit(); return result;
  };
  const before = inventory(extracted);
  patchSidebarAssets(path.join(extracted, 'webview', 'assets'));
  require('./patch-permission-profiles').patchPermissionAssets(path.join(extracted, 'webview', 'assets'));
  const after = inventory(extracted);
  const allowed = new Set(['webview/index.html', 'webview/assets/app-initial-CX2pZp2Q.js', 'webview/assets/sidebar-navigation-ui.js', 'webview/assets/desktop-appearance.css']);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
  if (changed.some(file => !allowed.has(file))) throw Error('Unexpected non-appearance file modification');
  execFileSync('/bin/cp', ['-cR', sourceApp, output]);
  const resources = path.join(output, 'Contents', 'Resources');
  const runtime = path.join(resources, 'agent-modes');
  const runtimeBefore = inventory(path.join(sourceApp, 'Contents', 'Resources', 'agent-modes'));
  const runtimeAfter = inventory(runtime);
  if (JSON.stringify(runtimeBefore) !== JSON.stringify(runtimeAfter)) throw Error('Runtime copy differs from installed app');
  if (!release) {
    const info = JSON.parse(fs.readFileSync(path.join(runtime, 'build.json'), 'utf8'));
    fs.writeFileSync(path.join(runtime, 'build.json'), JSON.stringify({ ...info, appName }, null, 2));
    fs.writeFileSync(path.join(output, 'Contents', 'MacOS', 'chatgpt-dev'), '#!/bin/sh\nCDX_APPEARANCE_DIR="$(cd "$(dirname "$0")" && pwd)"\nCDX_APPEARANCE_DATA="$HOME/Library/Application Support/' + appName + '"\nmkdir -p "$CDX_APPEARANCE_DATA"\numask 077\nexec "$CDX_APPEARANCE_DIR/ChatGPT" --user-data-dir="$CDX_APPEARANCE_DATA" "$@" >>"$CDX_APPEARANCE_DATA/engine-startup.log" 2>&1\n', { mode: 0o755 });
  }
  const archive = path.join(resources, 'app.asar');
  await asar.createPackage(extracted, archive);
  const plist = path.join(output, 'Contents', 'Info.plist');
  const set = (key, value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  if (!release) {
    set('CFBundleIdentifier', 'com.cometix.' + appName); set('CFBundleName', appName);
    try { set('CFBundleDisplayName', appName); } catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :CFBundleDisplayName string ${appName}`, plist]); }
  }
  set('ElectronAsarIntegrity:Resources/app.asar:hash', createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex'));
  if (hash(sourceArchive) !== originalHash) throw Error('Installed app changed during build');
  const result = { output: destination, sourceApp, originalAsar: originalHash, asarSha256: hash(archive), remoteSha256: hash(path.join(runtime, 'remote-runtime.tar.gz')), changed, unchangedArchiveFiles: Object.keys(before).length - changed.filter(file => file in before).length, preservedRuntimeFiles: Object.keys(runtimeBefore).length, release, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(output, 'Contents', 'Resources', 'appearance-build.json'), JSON.stringify(result, null, 2));
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', output], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' });
  fs.renameSync(output, destination);
  fs.rmSync(stage, { recursive: true, force: true });
  return result;
}
module.exports = { build };
if (require.main === module) build().then(result => console.log(JSON.stringify(result, null, 2)), error => { console.error(error); process.exitCode = 1; });
