const fs = require('node:fs');
const path = require('node:path');
const { replaceExactOnce } = require('./patch-agent-modes.js');
const HELPER = 'native-computer-use-runtime.cjs';
const SETUP = `require("./${HELPER}").configureNativeRuntime({resourcesPath:process.resourcesPath});`;

function patchComputerUseBundle(source) {
  source = replaceExactOnce(source, 'rawValue:e.CODEX_CLI_PATH,resolveWindowsAppsPath:a',
    'rawValue:e.CDX_COMPUTER_USE_CODEX_PATH??e.CODEX_CLI_PATH,resolveWindowsAppsPath:a', 'Computer Use sandbox CLI override');
  // Upstream 26.820: executable overrides already exist, but module discovery
  // always uses the rebuilt desktop's resources, which can load an older Sky.
  return replaceExactOnce(source, 'nodeModuleDirs:n.Zn(d)',
    'nodeModuleDirs:e.NODE_REPL_NODE_MODULE_DIRS?.trim()?e.NODE_REPL_NODE_MODULE_DIRS.split(r===`win32`?`;`:`:`).map(e=>e.trim()).filter(Boolean):n.Zn(d)', 'Computer Use module directory override');
}

function patchComputerUseBootstrap(source) {
  const count = source.split(SETUP).length - 1;
  if (count > 1) throw new Error('computer-use: expected one runtime bootstrap');
  if (count === 1) return source;
  const gateway = 'require("./agent-modes-bootstrap.cjs");';
  if (source.includes(gateway)) return replaceExactOnce(source, gateway, `${gateway}\n${SETUP}`, 'Computer Use gateway bootstrap order');
  return `${SETUP}\n${source}`;
}

function patchComputerUseBuild(asarRoot) {
  const root = path.resolve(asarRoot);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = path.resolve(root, pkg.main);
  if (!entry.startsWith(root + path.sep)) throw new Error('computer-use: entry must be inside the ASAR');
  const buildDir = path.dirname(entry);
  const files = fs.readdirSync(buildDir).filter(name => /^main-.*\.js$/.test(name));
  if (files.length !== 1) throw new Error(`computer-use: expected one main bundle, found ${files.length}`);
  const main = path.join(buildDir, files[0]);
  const patchedMain = patchComputerUseBundle(fs.readFileSync(main, 'utf8'));
  const patchedEntry = patchComputerUseBootstrap(entry === main ? patchedMain : fs.readFileSync(entry, 'utf8'));
  // Validate every seam before changing generated source.
  fs.copyFileSync(path.join(__dirname, 'assets', HELPER), path.join(buildDir, HELPER));
  if (main !== entry) fs.writeFileSync(main, patchedMain);
  fs.writeFileSync(entry, patchedEntry);
}

module.exports = { patchComputerUseBundle, patchComputerUseBootstrap, patchComputerUseBuild };
