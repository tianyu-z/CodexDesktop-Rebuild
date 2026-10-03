const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function verifyOpenAIExecutable(file, identifier) {
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "${identifier}"`;
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, file], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch { return false; }
}

function resolveNativeRuntime({ platform = process.platform, resourcesPath, env = process.env, appPaths,
  verifyExecutable = verifyOpenAIExecutable } = {}) {
  if (platform !== 'darwin') return null;
  const candidates = appPaths ?? (env.CDX_NATIVE_RUNTIME_APP?.trim() ? [env.CDX_NATIVE_RUNTIME_APP.trim()] : [
    '/Applications/ChatGPT.app', '/Applications/Codex.app',
    path.join(os.homedir(), 'Applications/ChatGPT.app'), path.join(os.homedir(), 'Applications/Codex.app'),
    ...(resourcesPath ? [path.resolve(resourcesPath, '../..')] : []),
  ]);
  for (const appPath of candidates) {
    if (!path.isAbsolute(appPath)) continue;
    const resources = path.join(appPath, 'Contents/Resources');
    const nodePath = path.join(resources, 'cua_node/bin/node');
    const nodeReplPath = path.join(resources, 'cua_node/bin/node_repl');
    const nodeModuleDirs = path.join(resources, 'cua_node/lib/node_modules');
    const codexPath = [path.join(resources, 'codex-cli/CodexCLI.app/Contents/MacOS/codex'), path.join(resources, 'codex')].find(fs.existsSync);
    if (!codexPath || ![nodePath, nodeReplPath, path.join(nodeModuleDirs, '@oai/sky/package.json')].every(fs.existsSync)) continue;
    if (![[codexPath, 'codex'], [nodePath, 'node'], [nodeReplPath, 'node_repl']].every(([file, id]) => verifyExecutable(file, id))) continue;
    return { appPath, resourcesPath: resources, codexPath, nodePath, nodeReplPath, nodeModuleDirs };
  }
  return null;
}

function configureNativeRuntime({ platform = process.platform, resourcesPath, env = process.env, warn = console.warn, ...options } = {}) {
  if (platform !== 'darwin') return null;
  const selected = resolveNativeRuntime({ platform, resourcesPath, env, ...options });
  if (!selected) {
    warn('[computer-use] No complete signed native runtime found. Install or update the official ChatGPT app, then restart chatgpt-dev to enable Computer Use. CDX_NATIVE_RUNTIME_APP can select a custom installation path.');
    return null;
  }
  const gateway = path.join(resourcesPath, 'agent-modes/codex-gateway');
  const current = env.CODEX_CLI_PATH?.trim();
  const managed = [gateway, path.join(resourcesPath, 'codex'), path.join(resourcesPath, 'codex-cli/CodexCLI.app/Contents/MacOS/codex'), selected.codexPath];
  if (current && !managed.includes(current)) {
    warn('[computer-use] Keeping the custom CODEX_CLI_PATH. Computer Use requires a signed native Codex CLI and matching CUA runtime.');
    return null;
  }
  // Keep the engine gateway as the desktop transport. Only its native child
  // changes; Claude routing, remote transports, and the data store stay local.
  env.CDX_REAL_CODEX = selected.codexPath;
  env.CODEX_CLI_PATH = current === gateway ? gateway : selected.codexPath;
  // REPL sandbox launchers filter the environment, so they cannot use the
  // gateway, which requires CDX_REAL_CODEX. Give them the signed CLI directly.
  env.CDX_COMPUTER_USE_CODEX_PATH = selected.codexPath;
  env.CODEX_NODE_REPL_PATH = selected.nodeReplPath;
  env.CODEX_BROWSER_USE_NODE_PATH = selected.nodePath;
  env.NODE_REPL_NODE_MODULE_DIRS = selected.nodeModuleDirs;
  return selected;
}

module.exports = { configureNativeRuntime, resolveNativeRuntime, verifyOpenAIExecutable };
