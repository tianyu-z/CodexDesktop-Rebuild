const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const prepared = new WeakMap(), preparing = new WeakMap();
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function execute(connection, command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(connection.ssh, [...connection.args, connection.login(command)], { env: connection.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(Error('Remote engine setup timed out.')); }, 90000);
    child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-65536); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
    child.on('error', error => finish(error));
    child.once('close', code => {
      if (code !== 0) finish(Error('Remote engine setup failed (' + code + '). ' + stderr.split(/\r?\n/).filter(line => !/^debug[0-9]:/.test(line)).slice(-5).join(' ').slice(0, 1500)));
      else finish(null, stdout);
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
    if (input) {
      const stream = fs.createReadStream(input); stream.on('error', error => { child.kill(); finish(error); }); child.once('close', () => stream.destroy()); stream.pipe(child.stdin);
    } else child.stdin.end();
  });
}
function layout(connection, resources = process.resourcesPath) {
  const runtime = path.join(resources, 'agent-modes');
  const config = JSON.parse(fs.readFileSync(path.join(runtime, 'build.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'remote-build.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[a-z0-9-]+$/.test(config.appName)) throw Error('Invalid bundled remote runtime manifest.');
  const hostKey = crypto.createHash('sha256').update(JSON.stringify(connection.args)).digest('hex').slice(0, 12);
  const scope = config.appName + '-' + hostKey;
  const homeBase = '"$HOME/.local/share/codex-desktop-rebuild"';
  const root = homeBase + '/runtime/' + manifest.sha256;
  return { archive: path.join(runtime, 'remote-runtime.tar.gz'), version: manifest.sha256, root, scope };
}
function setupCommand(info, codex) {
  return [
    'set -eu', 'umask 077', 'CDX_REMOTE_ROOT=' + info.root,
    'CDX_REMOTE_NODE="$(command -v node || true)"',
    'if [ -z "$CDX_REMOTE_NODE" ]; then for p in "$HOME"/.vscode-server/cli/servers/*/server/node "$HOME"/.vscode-server/bin/*/node "$HOME"/.vscode-server-insiders/cli/servers/*/server/node "$HOME"/.vscode-server-insiders/bin/*/node; do if [ -x "$p" ]; then CDX_REMOTE_NODE="$p"; break; fi; done; fi',
    'test -n "$CDX_REMOTE_NODE" || { echo "No remote Node runtime found (requires Node >= 20)." >&2; exit 1; }',
    '"$CDX_REMOTE_NODE" -e ' + quote('if(Number(process.versions.node.split(".")[0])<20)process.exit(1)'),
    'CDX_REAL_CODEX="$(command -v ' + quote(codex) + ')"',
    'CDX_CLAUDE_PATH="$(command -v claude || true)"',
    'if [ -z "$CDX_CLAUDE_PATH" ] && [ -x "$HOME/.local/bin/claude" ]; then CDX_CLAUDE_PATH="$HOME/.local/bin/claude"; fi',
    'test -n "$CDX_CLAUDE_PATH" || { echo "Claude Code is not installed on this host." >&2; exit 1; }',
    'export CDX_REAL_CODEX CDX_CLAUDE_PATH',
    'CDX_REMOTE_SCOPE=' + quote(info.scope), 'CDX_REMOTE_VERSION=' + quote(info.version), 'export CDX_REMOTE_SCOPE CDX_REMOTE_VERSION',
    '"$CDX_REMOTE_NODE" "$CDX_REMOTE_ROOT/remote/daemon.mjs" ensure',
  ].join('\n');
}
async function prepare(transport, connection) {
  if (preparing.has(transport)) return preparing.get(transport);
  const task = (async () => {
    const info = layout(connection);
    const check = await execute(connection, 'if [ -f ' + info.root + '/.complete ]; then printf "CDX_READY"; else printf "CDX_MISSING"; fi');
    if (!check.endsWith('CDX_READY')) {
      const install = ['set -eu', 'umask 077', 'CDX_REMOTE_ROOT=' + info.root,
        'mkdir -p "$(dirname "$CDX_REMOTE_ROOT")"',
        'CDX_REMOTE_STAGE="$(mktemp -d "${CDX_REMOTE_ROOT}.XXXXXX")"',
        'trap \'rm -rf -- "$CDX_REMOTE_STAGE"\' EXIT HUP INT TERM',
        'cat > "$CDX_REMOTE_STAGE/runtime.tar.gz"',
        'if command -v sha256sum >/dev/null 2>&1; then CDX_REMOTE_ACTUAL="$(sha256sum "$CDX_REMOTE_STAGE/runtime.tar.gz" | cut -d " " -f 1)"; else CDX_REMOTE_ACTUAL="$(shasum -a 256 "$CDX_REMOTE_STAGE/runtime.tar.gz" | cut -d " " -f 1)"; fi',
        'test "$CDX_REMOTE_ACTUAL" = ' + quote(info.version),
        'tar -xzf "$CDX_REMOTE_STAGE/runtime.tar.gz" -C "$CDX_REMOTE_STAGE"',
        'rm "$CDX_REMOTE_STAGE/runtime.tar.gz"', 'touch "$CDX_REMOTE_STAGE/.complete"',
        'if [ ! -d "$CDX_REMOTE_ROOT" ]; then mv "$CDX_REMOTE_STAGE" "$CDX_REMOTE_ROOT"; fi',
      ].join('\n');
      await execute(connection, install, info.archive);
    }
    await execute(connection, setupCommand(info, connection.codex));
    prepared.set(transport, { info, codex: connection.codex });
  })().finally(() => preparing.delete(transport));
  preparing.set(transport, task); return task;
}
function proxyCommand(transport) {
  const value = prepared.get(transport);
  if (!value) throw Error('Remote engine gateway is not prepared.');
  return setupCommand(value.info, value.codex).replace('"$CDX_REMOTE_NODE" "$CDX_REMOTE_ROOT/remote/daemon.mjs" ensure',
    'exec "$CDX_REMOTE_NODE" "$CDX_REMOTE_ROOT/remote/daemon.mjs" proxy');
}
module.exports = { prepare, proxyCommand, quote, setupCommand, execute, layout };
