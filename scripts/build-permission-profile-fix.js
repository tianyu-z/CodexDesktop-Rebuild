#!/usr/bin/env node
/** Patch the installed frontend while preserving every other installed fix. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { patchPermissionProfiles } = require('./patch-permission-profiles');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => digest(fs.readFileSync(file));

function runtimeDigest(app) {
  const root = path.join(app, 'Contents/Resources/agent-modes');
  const entries = [];
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const item = path.join(relative, name), file = path.join(root, item), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) entries.push([item, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) visit(item);
      else entries.push([item, hashFile(file)]);
    }
  };
  visit('');
  return digest(JSON.stringify(entries));
}

async function build({ sourceApp = '/Applications/chatgpt-dev.app', output = path.resolve('.artifacts/full-access/ChatGPT Permissions Fixed.app') } = {}) {
  const asar = await import('@electron/asar');
  const archive = path.join(sourceApp, 'Contents/Resources/app.asar');
  const sourceHash = hashFile(archive);
  const sourceRuntimeHash = runtimeDigest(sourceApp);
  if (fs.existsSync(output)) throw Error(`Output already exists: ${output}`);
  const paths = asar.listPackage(archive);
  const targets = paths.filter(name => /^\/webview\/assets\/app-initial-[^/]+\.js$/.test(name));
  if (targets.length !== 1) throw Error('Expected exactly one installed native frontend');
  const target = targets[0].slice(1);
  const source = asar.extractFile(archive, target).toString('utf8');
  const patched = patchPermissionProfiles(source);
  require('acorn').parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  if (patchPermissionProfiles(patched) !== patched) throw Error('Patch is not idempotent');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), 'permission-build-'));
  const extracted = path.join(staging, 'asar');
  asar.extractAll(archive, extracted);
  fs.writeFileSync(path.join(extracted, target), patched);
  const stagedApp = path.join(staging, 'Fixed.app');
  execFileSync('/bin/cp', ['-cR', sourceApp, stagedApp]);
  if (runtimeDigest(stagedApp) !== sourceRuntimeHash) throw Error('Runtime changed while copying the app');
  const resultArchive = path.join(stagedApp, 'Contents/Resources/app.asar');
  await asar.createPackage(extracted, resultArchive);
  const afterPaths = asar.listPackage(resultArchive);
  if (JSON.stringify(paths) !== JSON.stringify(afterPaths)) throw Error('Archive inventory changed');
  let verifiedFiles = 0;
  for (const name of paths) {
    const relative = name.slice(1);
    const entry = asar.statFile(archive, relative);
    if (entry.files || entry.link || relative === target) continue;
    if (digest(asar.extractFile(archive, relative)) !== digest(asar.extractFile(resultArchive, relative))) throw Error(`Unrelated archive file changed: ${relative}`);
    verifiedFiles++;
  }
  const plist = path.join(stagedApp, 'Contents/Info.plist');
  const headerHash = digest(asar.getRawHeader(resultArchive).headerString);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`, plist]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', stagedApp], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], { stdio: 'inherit' });
  if (hashFile(archive) !== sourceHash || runtimeDigest(sourceApp) !== sourceRuntimeHash) throw Error('Installed application changed during build');
  const manifest = { sourceApp, output, sourceHash, sourceRuntimeHash, resultHash: hashFile(resultArchive), changed: [target], verifiedUnchangedArchiveFiles: verifiedFiles, createdAt: new Date().toISOString() };
  fs.renameSync(stagedApp, output);
  fs.writeFileSync(path.join(path.dirname(output), 'build-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.rmSync(staging, { recursive: true, force: true });
  return manifest;
}

module.exports = { build, runtimeDigest };
if (require.main === module) build().then(value => console.log(JSON.stringify(value, null, 2)), error => { console.error(error); process.exitCode = 1; });
