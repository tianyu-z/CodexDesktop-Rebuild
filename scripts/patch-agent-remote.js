const fs = require('node:fs');
const path = require('node:path');
const IMPORT = 'globalThis.__cdxRemoteEngineModes=require("./agent-modes-remote.cjs");\n';
const START = 'async startRemoteAppServer(e){';
const END = '}createSshSetupError(e,t){';
const BODY = 'return globalThis.__cdxRemoteEngineModes.prepare(this,{ssh:n.Kn.resolve(`ssh`)??`ssh`,args:[`-T`,...zS(this.options.getConnectTimeoutSeconds?.()),...VS(this.options.sshConnection)],login:bS,env:i.t(process.env),codex:xS()})';
const BEFORE = 'createSshProxyStream(e){let t=xS(),r=`${PS} && exec ${n.Hn(t)} app-server proxy`,a=';
const AFTER = 'createSshProxyStream(e){let t=xS(),r=globalThis.__cdxRemoteEngineModes.proxyCommand(this),a=';
function exactlyOne(source, term) { if (source.split(term).length !== 2) throw Error('agent-remote: expected exactly one ' + term.slice(0, 70)); }
function patchRemoteMain(source) {
  exactlyOne(source, START); exactlyOne(source, END);
  const start = source.indexOf(START) + START.length, end = source.indexOf(END, start);
  if (end <= start) throw Error('agent-remote: expected complete bootstrap method');
  const body = source.slice(start, end);
  if (body !== BODY) {
    for (const anchor of ['let t=xS(),r;try', 'codex_path_probe', 'operation:`app_server_bootstrap`', 'pkill -9']) exactlyOne(body, anchor);
    source = source.slice(0, start) + BODY + source.slice(end);
  }
  if (!source.includes(AFTER)) { exactlyOne(source, BEFORE); source = source.replace(BEFORE, AFTER); }
  else { exactlyOne(source, AFTER); if (source.includes(BEFORE)) throw Error('agent-remote: conflicting proxy seams'); }
  if (!source.startsWith(IMPORT)) { if (source.includes(IMPORT)) throw Error('agent-remote: duplicate bootstrap'); source = IMPORT + source; }
  return source;
}
function patchRemoteBuild(directory) {
  const files = fs.readdirSync(directory).filter(file => /^main-.*\.js$/.test(file));
  if (files.length !== 1) throw Error('agent-remote: expected one main bundle');
  const target = path.join(directory, files[0]);
  const source = patchRemoteMain(fs.readFileSync(target, 'utf8'));
  fs.copyFileSync(path.join(__dirname, 'assets', 'agent-modes-remote.cjs'), path.join(directory, 'agent-modes-remote.cjs'));
  fs.writeFileSync(target, source);
}
module.exports = { patchRemoteMain, patchRemoteBuild };
