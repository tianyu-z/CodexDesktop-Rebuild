#!/usr/bin/env node
/** Patch the installed frontend while preserving every other installed fix. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { patchPermissionProfiles } = require('./patch-permission-profiles');
const { replaceExactOnce } = require('./patch-agent-modes');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => digest(fs.readFileSync(file));

function directoryDigest(root, exclude = []) {
  const entries = [];
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const item = path.join(relative, name), file = path.join(root, item), stat = fs.lstatSync(file);
      if (exclude.includes(item)) continue;
      if (stat.isSymbolicLink()) entries.push([item, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) visit(item);
      else entries.push([item, hashFile(file)]);
    }
  };
  visit('');
  return digest(JSON.stringify(entries));
}

function runtimeDigest(app, exclude = []) {
  return directoryDigest(path.join(app, 'Contents/Resources/agent-modes'), exclude);
}

function patchLegacyPermissionRouter(source) {
  source = replaceExactOnce(source, "import { editManagedHistory, recoverHistoryEdit } from './history.mjs';",
    "import { editManagedHistory, recoverHistoryEdit } from './history.mjs';\nimport { restoreLegacyResumePermissions } from './legacy-permission-resume.mjs';", 'legacy permission resume import');
  return replaceExactOnce(source, "if (method === 'thread/read' || method === 'thread/resume') {\n      const clean = nativeParams(params);",
    "if (method === 'thread/read' || method === 'thread/resume') {\n      const clean = method === 'thread/resume'\n        ? await restoreLegacyResumePermissions(this.native, nativeParams(params)) : nativeParams(params);", 'legacy permission resume request');
}

async function build({ sourceApp = '/Applications/chatgpt-dev.app', output = path.resolve('.artifacts/full-access/ChatGPT Permissions Fixed v2.app') } = {}) {
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
  const runtime = path.join(stagedApp, 'Contents/Resources/agent-modes');
  const routerFile = path.join(runtime, 'router.mjs');
  const router = patchLegacyPermissionRouter(fs.readFileSync(routerFile, 'utf8'));
  if (patchLegacyPermissionRouter(router) !== router) throw Error('Runtime patch is not idempotent');
  fs.writeFileSync(routerFile, router);
  fs.copyFileSync(path.resolve(__dirname, '../runtime/agent-modes/legacy-permission-resume.mjs'), path.join(runtime, 'legacy-permission-resume.mjs'));
  const changedRuntimeFiles = ['router.mjs', 'legacy-permission-resume.mjs'];
  // Remote hosts execute the separately packaged runtime. Patch the installed
  // remote archive, so unrelated remote fixes and Linux dependencies survive.
  const remote = path.join(staging, 'remote');
  fs.mkdirSync(remote);
  const remoteArchive = path.join(runtime, 'remote-runtime.tar.gz');
  const remoteSourceHash = hashFile(remoteArchive);
  if (JSON.parse(fs.readFileSync(path.join(runtime, 'remote-build.json'), 'utf8')).sha256 !== remoteSourceHash) throw Error('Installed remote archive hash does not match its manifest');
  execFileSync('tar', ['-xzf', remoteArchive, '-C', remote]);
  const unchangedRemoteHash = directoryDigest(remote, changedRuntimeFiles);
  const remoteRouter = path.join(remote, 'router.mjs');
  fs.writeFileSync(remoteRouter, patchLegacyPermissionRouter(fs.readFileSync(remoteRouter, 'utf8')));
  fs.copyFileSync(path.join(runtime, 'legacy-permission-resume.mjs'), path.join(remote, 'legacy-permission-resume.mjs'));
  if (directoryDigest(remote, changedRuntimeFiles) !== unchangedRemoteHash) throw Error('Unrelated remote runtime files changed');
  const remoteManifest = require('./remote-runtime-package').packageRemoteRuntime(remote, remoteArchive);
  fs.writeFileSync(path.join(runtime, 'remote-build.json'), JSON.stringify(remoteManifest));
  const remoteVerification = path.join(staging, 'remote-verified');
  fs.mkdirSync(remoteVerification);
  execFileSync('tar', ['-xzf', remoteArchive, '-C', remoteVerification]);
  if (directoryDigest(remoteVerification) !== directoryDigest(remote)) throw Error('Packaged remote runtime differs from staged source');
  const changedRuntimeEntries = [...changedRuntimeFiles, 'remote-runtime.tar.gz', 'remote-build.json'];
  if (runtimeDigest(stagedApp, changedRuntimeEntries) !== runtimeDigest(sourceApp, changedRuntimeEntries)) throw Error('Unrelated runtime files changed');
  for (const file of changedRuntimeFiles) execFileSync(process.execPath, ['--check', path.join(runtime, file)]);
  const resultArchive = path.join(stagedApp, 'Contents/Resources/app.asar');
  if (patched !== source) await asar.createPackage(extracted, resultArchive);
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
  const manifest = { sourceApp, output, sourceHash, sourceRuntimeHash, resultHash: hashFile(resultArchive), resultRuntimeHash: runtimeDigest(stagedApp),
    remoteSourceHash, remoteResultHash: remoteManifest.sha256,
    changed: [...(patched === source ? [] : [target]), ...changedRuntimeFiles.map(file => `agent-modes/${file}`), 'agent-modes/remote-runtime.tar.gz', 'agent-modes/remote-build.json'], verifiedUnchangedArchiveFiles: verifiedFiles, createdAt: new Date().toISOString() };
  fs.renameSync(stagedApp, output);
  fs.writeFileSync(path.join(path.dirname(output), 'build-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.rmSync(staging, { recursive: true, force: true });
  return manifest;
}

module.exports = { build, runtimeDigest, patchLegacyPermissionRouter };
if (require.main === module) build().then(value => console.log(JSON.stringify(value, null, 2)), error => { console.error(error); process.exitCode = 1; });
