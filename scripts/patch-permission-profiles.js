#!/usr/bin/env node
/** Keep native permission profiles attached to the sandbox snapshot that owns them. */
const fs = require('node:fs');
const path = require('node:path');
const { locateBundles } = require('./patch-util');
const { replaceExactOnce } = require('./patch-agent-modes');

function __cdxPermissionProfile(...sources) {
  for (const source of sources) {
    if (source == null) continue;
    if (source.activePermissionProfile !== undefined) return source.activePermissionProfile;
    if (source.permissions !== undefined) {
      return source.permissions == null ? null : { id: source.permissions, extends: null };
    }
    // Legacy turns have a sandbox but no profile field. That is a complete
    // sandbox choice, not permission to borrow another snapshot's profile.
    if (source.sandboxPolicy != null) return null;
  }
  return undefined;
}

const patches = [
  ['turn sandbox profile source',
    'R=Xzn(o.permissions??w?.activePermissionProfile?.id??w?.permissions??a.currentPermissions?.activePermissionProfile?.id??N?.permissions,',
    'R=Xzn(__cdxPermissionProfile(o,w,N,a.currentPermissions)?.id,'],
  ['turn wire profile source',
    'ce=o.permissions===void 0?o.sandboxPolicy==null?w?.activePermissionProfile===void 0?w?.permissions===void 0?a.currentPermissions?.activePermissionProfile?.id??N?.permissions??null:w.permissions:w.activePermissionProfile?.id??null:null:o.permissions',
    'ce=__cdxPermissionProfile(o,w,N,a.currentPermissions)?.id??null'],
  ['resume profile source',
    'K=_?.currentPermissions?.activePermissionProfile;P?.activePermissionProfile===void 0?N?.permissions!=null&&(K={id:N.permissions,extends:null}):K=P.activePermissionProfile;',
    'K=__cdxPermissionProfile(P,N,_?.currentPermissions);'],
  ['resume response profile source',
    'function Pft(e,t){let n=t?.activePermissionProfile;return t!=null&&e.activePermissionProfile==null&&n?.id===`:danger-full-access`?t:{activePermissionProfile:e.activePermissionProfile??(n!=null&&!n.id.startsWith(`:`)?n:null),runtimeWorkspaceRoots:e.runtimeWorkspaceRoots,approvalPolicy:e.approvalPolicy,approvalsReviewer:e.approvalsReviewer,sandboxPolicy:e.sandbox}}',
    'function Pft(e,t){let n=t?.activePermissionProfile;return{activePermissionProfile:e.activePermissionProfile??(n?.id===`:danger-full-access`&&e.sandbox?.type===`dangerFullAccess`&&e.approvalPolicy===`never`?n:n!=null&&!n.id.startsWith(`:`)?n:null),runtimeWorkspaceRoots:e.runtimeWorkspaceRoots,approvalPolicy:e.approvalPolicy,approvalsReviewer:e.approvalsReviewer,sandboxPolicy:e.sandbox}}'],
];

function patchPermissionProfiles(source) {
  for (const [name, before, after] of patches) source = replaceExactOnce(source, before, after, name);
  const anchor = 'async function Jzn(';
  const helper = `/* cdx-permission-profile-sync-v1 */\n${__cdxPermissionProfile.toString()}\n${anchor}`;
  return replaceExactOnce(source, anchor, helper, 'permission profile resolver');
}

function patchPermissionAssets(directory) {
  const files = fs.readdirSync(directory).filter(name => /^app-initial-.*\.js$/.test(name));
  if (files.length !== 1) throw Error(`Expected one native app bundle in ${directory}`);
  const file = path.join(directory, files[0]);
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchPermissionProfiles(source);
  if (patched !== source) fs.writeFileSync(file, patched);
  return file;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const platform = args.find(arg => ['mac-arm64', 'mac-x64', 'win'].includes(arg));
  const bundles = locateBundles({ dir: 'assets', pattern: /^app-initial-.*\.js$/, platform });
  for (const bundle of bundles) {
    // The general pipeline also builds newer official sources. Only this
    // pinned frontend has a verified permission-resolution contract.
    if (path.basename(bundle.path) !== 'app-initial-CX2pZp2Q.js') {
      console.log(`Permission profile sync: skipped unsupported bundle ${path.basename(bundle.path)}`);
      continue;
    }
    const source = fs.readFileSync(bundle.path, 'utf8');
    const patched = patchPermissionProfiles(source);
    if (!args.includes('--check') && patched !== source) fs.writeFileSync(bundle.path, patched);
    console.log(`Permission profile sync verified: ${bundle.platform}`);
  }
}

module.exports = { patchPermissionProfiles, patchPermissionAssets, selectPermissionProfile: __cdxPermissionProfile };
