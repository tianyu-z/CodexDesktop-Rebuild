#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const VERSION = '26.820.71523';
function replaceOne(code, anchor, replacement) {
  if (code.split(anchor).length !== 2) throw new Error(`Bootstrap anchor mismatch: ${anchor}`);
  return code.replace(anchor, replacement);
}
function patchBootstrap(code) {
  const marker = '/* cdx-engine-bootstrap-v1 */';
  if (code.startsWith(marker)) return code;
  code = replaceOne(code, 'NAME="chatgpt-dev"', 'NAME=process.env.CDX_ENGINE_APP_NAME||"chatgpt-dev"');
  return `${marker}\nrequire("./agent-modes-bootstrap.cjs");\n${code}`;
}
async function build({ sourceApp = '/Applications/chatgpt-dev.app', output = path.join(ROOT, '.artifacts', 'ChatGPT Engines Preview.app'), appName = 'chatgpt-dev-engines-preview' } = {}) {
  const asar = await import('@electron/asar');
  const { patchAssets } = require('./patch-agent-modes.js');
  const source = path.join(ROOT, 'src', 'mac-arm64', '_asar');
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  if (version !== VERSION) throw new Error(`Unsupported source version ${version}; expected ${VERSION}.`);
  const staging = fs.mkdtempSync(path.join(ROOT, '.artifacts', 'engine-build-'));
  const stagedAsar = path.join(staging, 'asar');
  execFileSync('/bin/cp', ['-cR', source, stagedAsar]);
  patchAssets(path.join(stagedAsar, 'webview', 'assets'));
  const bootstrap = path.join(stagedAsar, '.vite', 'build', 'early-bootstrap.js');
  fs.writeFileSync(bootstrap, patchBootstrap(fs.readFileSync(bootstrap, 'utf8')));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'assets', 'agent-modes-bootstrap.cjs'), path.join(stagedAsar, '.vite', 'build', 'agent-modes-bootstrap.cjs'));
  const buildInfo = { feature: 'conversation-engine-modes', sourceVersion: version, appName, createdAt: new Date().toISOString() };
  if (!fs.existsSync(output)) execFileSync('/bin/cp', ['-cR', sourceApp, output]);
  else {
    const marker = path.join(output, 'Contents', 'Resources', 'agent-modes', 'build.json');
    if (!fs.existsSync(marker)) throw new Error(`Output already exists and is not an engine-mode build: ${output}`);
  }
  if (!/^[a-z0-9-]+$/.test(appName)) throw new Error('Invalid application data name.');
  const launcher = '#!/bin/sh\nCDX_LAUNCHER_DIR="$(cd "$(dirname "$0")" && pwd)"\nCDX_LAUNCHER_DATA="$HOME/Library/Application Support/' + appName + '"\nmkdir -p "$CDX_LAUNCHER_DATA"\numask 077\nexec "$CDX_LAUNCHER_DIR/ChatGPT" --user-data-dir="$CDX_LAUNCHER_DATA" "$@" >>"$CDX_LAUNCHER_DATA/engine-startup.log" 2>&1\n';
  fs.writeFileSync(path.join(output, 'Contents', 'MacOS', 'chatgpt-dev'), launcher, { mode: 0o755 });
  const resources = path.join(output, 'Contents', 'Resources');
  const runtime = path.join(resources, 'agent-modes');
  fs.mkdirSync(runtime, { recursive: true });
  fs.rmSync(path.join(runtime, 'node_modules', '.bin'), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'runtime', 'agent-modes'), runtime, { recursive: true, dereference: true, filter: sourcePath => !sourcePath.split(path.sep).includes('.bin') });
  fs.copyFileSync('/usr/local/bin/node', path.join(runtime, 'node'));
  fs.chmodSync(path.join(runtime, 'node'), 0o755);
  // Absolute paths are resolved by the bootstrap; the wrapper remains movable
  // with the application and never replaces the original Codex executable.
  fs.writeFileSync(path.join(runtime, 'codex-gateway'), '#!/bin/sh\nCDX_GATEWAY_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$CDX_GATEWAY_DIR/node" "$CDX_GATEWAY_DIR/gateway.mjs" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(runtime, 'build.json'), JSON.stringify(buildInfo, null, 2));
  const archive = path.join(staging, 'app.asar');
  await asar.createPackage(stagedAsar, archive);
  fs.copyFileSync(archive, path.join(resources, 'app.asar'));
  const plist = path.join(output, 'Contents', 'Info.plist');
  const plistSet = (key, value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  plistSet('CFBundleIdentifier', `com.cometix.${appName}`);
  plistSet('CFBundleName', appName);
  try { plistSet('CFBundleDisplayName', appName); } catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :CFBundleDisplayName string ${appName}`, plist]); }
  // Electron validates the archive header before executing the bootstrap.
  const headerHash = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  plistSet('ElectronAsarIntegrity:Resources/app.asar:hash', headerHash);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', output], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' });
  const hash = createHash('sha256').update(fs.readFileSync(path.join(resources, 'app.asar'))).digest('hex');
  fs.writeFileSync(path.join(ROOT, '.artifacts', 'engine-build-manifest.json'), JSON.stringify({ ...buildInfo, output, asarSha256: hash }, null, 2));
  fs.rmSync(staging, { recursive: true, force: true });
  return { output, asarSha256: hash };
}
if (require.main === module) build().then(result => console.log(JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });
module.exports = { build, patchBootstrap };
