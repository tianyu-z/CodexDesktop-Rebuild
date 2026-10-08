#!/usr/bin/env node
/** Isolate gateway renderer coordination while keeping the native owner shared. */
const fs = require('node:fs');
const path = require('node:path');
const { locateBundles } = require('./patch-util');
function one(code, re, name) {
  const matches = [...code.matchAll(new RegExp(re.source, 'g'))];
  if (matches.length !== 1) throw Error(`Expected one ${name}, found ${matches.length}`);
  return matches[0];
}
function patchThreadIpc(code) {
  if (code.includes('function __cdxThreadIpc(')) {
    if ((code.match(/=__cdxThreadIpc\(/g) ?? []).length !== 2) throw Error('Incomplete thread IPC patch');
    return code;
  }
  const broadcast = one(code, /function (\w+)\((\w+)\)\{let (\w+)=(\w+)\[\2\];return \3===void 0\?0:\3\}/, 'broadcast version');
  const request = one(code, /function (\w+)\((\w+),(\w+)\)\{if\(\2===`thread-follower-interrupt-turn`/, 'request version');
  const owner = one(code, /constructor\((\w+),(\w+)=(\w+)\)\{super\(\),this\.ipcClient=\1,this\.ownerDiscoveryTimeoutMs=\2,(\w+)\.set\(\1,this\.ownedThreads\)\}/, 'thread owner client');
  const follower = one(code, /function (\w+)\(\{hostId:(\w+),ipcClient:(\w+),viewService:(\w+)\}\)\{let (\w+)=(\w+)\.get\(\3\),/, 'thread follower client');
  if (owner[4] !== follower[6]) throw Error('Thread ownership registry changed');
  code = code.replace(owner[0], owner[0].replace('super(),', `super(),${owner[1]}=__cdxThreadIpc(${owner[1]}),`));
  code = code.replace(follower[0], follower[0].replace('}){let ', `}){${follower[3]}=__cdxThreadIpc(${follower[3]});let `));
  return code + `\nfunction __cdxThreadIpc(client){return (__cdxThreadIpc.wrap??=require("./cdx-thread-ipc.cjs").createThreadIpcScope({broadcastVersion:${broadcast[1]},requestVersion:${request[1]}}))(client)}\n`;
}
function main() {
  const platform = process.argv.slice(2).find(value => ['mac-arm64', 'mac-x64', 'win'].includes(value));
  const bundles = locateBundles({ dir: 'build', pattern: /^src-.*\.js$/, ...(platform ? { platform } : {}) });
  if (!bundles.length) throw Error('Missing main thread coordination bundle');
  for (const bundle of bundles) {
    const next = patchThreadIpc(fs.readFileSync(bundle.path, 'utf8'));
    require('acorn').parse(next, { ecmaVersion: 'latest', sourceType: 'script' });
    fs.writeFileSync(bundle.path, next);
    fs.copyFileSync(path.join(__dirname, 'assets/cdx-thread-ipc.cjs'), path.join(path.dirname(bundle.path), 'cdx-thread-ipc.cjs'));
    console.log('Patched thread coordination: ' + bundle.path);
  }
}
module.exports = { patchThreadIpc };
if (require.main === module) main();
