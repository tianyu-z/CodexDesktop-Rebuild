#!/usr/bin/env node
/** Apply only the Computer Use repair to a copy of an installed dev app. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { patchComputerUseBuild } = require('./patch-computer-use-runtime.js');
const hash = value => createHash('sha256').update(value).digest('hex');

async function build({ sourceApp = '/Applications/chatgpt-dev.app',
  output = path.resolve('.artifacts/computer-use/chatgpt-dev-computer-use-preview.app'),
  appName = 'chatgpt-dev-computer-use-preview' } = {}) {
  sourceApp = path.resolve(sourceApp); output = path.resolve(output);
  if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
  if (!/^[a-z0-9-]+$/.test(appName)) throw new Error('Invalid application data name');
  const asar = await import('@electron/asar');
  const sourceArchive = path.join(sourceApp, 'Contents/Resources/app.asar');
  const sourceHash = hash(fs.readFileSync(sourceArchive));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), 'computer-use-build-'));
  try {
    const extracted = path.join(staging, 'asar'); asar.extractAll(sourceArchive, extracted);
    patchComputerUseBuild(extracted);
    const pkg = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
    const entryDir = path.dirname(pkg.main);
    const main = fs.readdirSync(path.join(extracted, entryDir)).find(name => /^main-.*\.js$/.test(name));
    const changed = [pkg.main, path.join(entryDir, main), path.join(entryDir, 'native-computer-use-runtime.cjs')];
    for (const file of changed) require('acorn').parse(fs.readFileSync(path.join(extracted, file), 'utf8'), { ecmaVersion: 'latest', allowHashBang: true });
    const stagedApp = path.join(staging, 'Preview.app');
    execFileSync('/bin/cp', ['-cR', sourceApp, stagedApp]);
    const resources = path.join(stagedApp, 'Contents/Resources');
    const archive = path.join(resources, 'app.asar'); await asar.createPackage(extracted, archive);
    let verifiedFiles = 0;
    for (const item of asar.listPackage(sourceArchive)) {
      const relative = item.slice(1), stat = asar.statFile(sourceArchive, relative);
      if (stat.files || stat.link || changed.includes(relative)) continue;
      if (hash(asar.extractFile(sourceArchive, relative)) !== hash(asar.extractFile(archive, relative))) throw new Error(`Unrelated archive file changed: ${relative}`);
      verifiedFiles++;
    }
    const buildInfo = path.join(resources, 'agent-modes/build.json');
    if (!fs.existsSync(buildInfo)) throw new Error('Preview isolation requires an engine-mode dev app');
    const info = JSON.parse(fs.readFileSync(buildInfo, 'utf8')); info.appName = appName;
    fs.writeFileSync(buildInfo, JSON.stringify(info, null, 2));
    const launcher = '#!/bin/sh\nCDX_PREVIEW_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\n'
      + `CDX_PREVIEW_DATA="$HOME/Library/Application Support/${appName}"\n`
      + 'umask 077\nmkdir -p "$CDX_PREVIEW_DATA"\nexec "$CDX_PREVIEW_DIR/ChatGPT" --user-data-dir="$CDX_PREVIEW_DATA" "$@" >>"$CDX_PREVIEW_DATA/engine-startup.log" 2>&1\n';
    fs.writeFileSync(path.join(stagedApp, 'Contents/MacOS/chatgpt-dev'), launcher, { mode: 0o755 });
    const plist = path.join(stagedApp, 'Contents/Info.plist');
    const set = (key, value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    set('CFBundleIdentifier', `com.cometix.${appName}`); set('CFBundleName', appName); set('CFBundleDisplayName', appName);
    set('ElectronAsarIntegrity:Resources/app.asar:hash', hash(asar.getRawHeader(archive).headerString));
    // Only the outer bundle changed. Deep re-signing could strip the identity
    // from native executables that the Computer Use service authenticates.
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', stagedApp], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], { stdio: 'inherit' });
    if (hash(fs.readFileSync(sourceArchive)) !== sourceHash) throw new Error('Source application changed during build');
    const result = { sourceApp, output, appName, sourceHash, archiveHash: hash(fs.readFileSync(archive)), verifiedUnchangedArchiveFiles: verifiedFiles, changed, createdAt: new Date().toISOString() };
    fs.renameSync(stagedApp, output);
    fs.writeFileSync(output + '.json', JSON.stringify(result, null, 2));
    return result;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { build };
if (require.main === module) {
  const { values } = require('node:util').parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, 'app-name': { type: 'string' } } });
  build({ ...(values.source ? { sourceApp: values.source } : {}), ...(values.output ? { output: values.output } : {}), ...(values['app-name'] ? { appName: values['app-name'] } : {}) })
    .then(result => console.log(JSON.stringify(result, null, 2)), error => { console.error(error); process.exitCode = 1; });
}
