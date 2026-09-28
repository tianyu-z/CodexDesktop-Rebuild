#!/usr/bin/env node
/** Narrow, fail-closed seams for upstream 26.901.51231. Generated assets are ignored. */
const fs = require('node:fs');
const path = require('node:path');
const { locateBundles } = require('./patch-util');
const HELPER_NAME = 'agent-modes-ui.js';
const HELPER_IMPORT = `import"./${HELPER_NAME}";`;

function occurrences(source, anchor) { return source.split(anchor).length - 1; }
function replaceExactOnce(source, before, after, name) {
  const patched = occurrences(source, after);
  if (patched === 1 && occurrences(source.replace(after, ''), before) === 0) return source;
  const count = occurrences(source, before);
  if (patched !== 0 || count !== 1) {
    throw new Error(`agent-modes: expected exactly 1 match for ${name}; found ${count} original and ${patched} patched matches`);
  }
  return source.replace(before, () => after);
}
function withHelper(source) {
  const count = occurrences(source, HELPER_IMPORT);
  if (count > 1) throw new Error('agent-modes: expected one helper import');
  return count === 1 ? source : HELPER_IMPORT + source;
}

// Keep the separately rendered dual picker tied to the known native constructor.
// This identity seam validates its props without changing the only-mode width gate.
const APP_PATCHES = [
  ['managed composer remains editable during approval',
    'FKs(at,!ht&&!bo);',
    'FKs(at,(!ht||globalThis.__cdxEngineModes.canManageFollowUps(U,le,me))&&!bo);'],
  ['managed approval and composer coexist',
    'Lee,(0,Y3.jsx)(AZc,{conversationId:le,children:vte??(0,Y3.jsx)(sFc,{',
    'Lee,globalThis.__cdxEngineModes.canManageFollowUps(U,le,me)?vte:null,(0,Y3.jsx)(AZc,{conversationId:le,children:(globalThis.__cdxEngineModes.canManageFollowUps(U,le,me)?null:vte)??(0,Y3.jsx)(sFc,{'],
  ['new conversation goal guard',
    'k=async(t,n)=>{if(t.threadGoalDraft==null)return{context:t,goal:void 0};',
    'k=async(t,n)=>{if(t.threadGoalDraft==null)return{context:t,goal:void 0};let __cdxGoalError=globalThis.__cdxEngineModes.nativeGoalError(e,null,n);if(__cdxGoalError)throw Error(__cdxGoalError);'],
  ['existing conversation goal guard',
    'async function zAn({scope:e,appendTranscriptItem:t,conversationId:n,hostId:r,intl:i,objective:a,threadSettings:o}){try{',
    'async function zAn({scope:e,appendTranscriptItem:t,conversationId:n,hostId:r,intl:i,objective:a,threadSettings:o}){let __cdxGoalError=globalThis.__cdxEngineModes.nativeGoalError(e,n,r);if(__cdxGoalError){e.get(Dg).danger(__cdxGoalError);return!1}try{'],
  ['native Claude permission controls',
    'function TPc(e){let t=(0,kPc.c)(102),',
    'function TPc(e){let __cdxScope=us(LB);return(0,z2.jsx)(globalThis.__cdxEngineModes.PermissionControls,{React:APc,jsx:z2,scope:__cdxScope,threadId:e.conversationId,hostId:e.hostId,cwd:e.cwdOverride,getHost:(e,t)=>e.get(Rk,t),getManager:zg,nativePicker:(0,z2.jsx)(__cdxNativePermissions,e)})}function __cdxNativePermissions(e){let t=(0,kPc.c)(102),'],
  ['native Claude slash catalog',
    'E=Y(LXs),D=d?E.filter(xZs):E',
    'E=globalThis.__cdxEngineModes.useClaudeCommands({React:F$,scope:m,threadId:FB(m),cwd:Y(CS),composer:g,nativeCommands:Y(LXs),getHost:(e,t)=>e.get(Rk,t),getManager:zg}),D=d?E.filter(xZs):E'],
  ['native model picker contract',
    'H=!P&&(0,H2.jsx)(`span`,{ref:S,children:(0,H2.jsx)(fNc,{conversationId:f,hideLabel:F,permissionsCwdOverride:i,permissionsHostId:a})})',
    'H=!P&&(0,H2.jsx)(`span`,{ref:S,children:(0,H2.jsx)(fNc,{conversationId:f,hideLabel:F,permissionsCwdOverride:i,permissionsHostId:a})})'],
  ['manager response observation',
    'async sendRequest(e,t,n){return this.requestClient.sendRequest(e,t,n)}',
    'async sendRequest(e,t,n){let __cdxEngineHost=this.getHostId();globalThis.__cdxEngineModes.registerManager(this,__cdxEngineHost);let __cdxEngineResponse=await this.requestClient.sendRequest(e,t,n);globalThis.__cdxEngineModes.observe(this,e,t,__cdxEngineResponse,__cdxEngineHost);return __cdxEngineResponse}'],
  ['scoped composer controls',
    'HV.FooterInlineControls,{ref:x,children:[V,H,r,U]}',
    'HV.FooterInlineControls,{ref:x,children:[V,(0,H2.jsx)(globalThis.__cdxEngineModes.Selector,{React:V2,jsx:H2,scope:u,threadId:f,hostId:a,cwd:i,getHost:(e,t)=>e.get(Rk,t),getManager:zg,useAtom:ss,busyAtom:yk,runtimeStatusAtom:kk,requestsAtom:XDr,nativeModelPicker:H,bothNativeModelPicker:(0,H2.jsx)(fNc,{conversationId:f,hideLabel:!1,permissionsCwdOverride:i,permissionsHostId:a})}),r,U]}'],
  // The upstream compiler memo does not depend on the composer scope. Rebuild
  // this one footer element so navigating between two drafts cannot retain the
  // previous scope in the selector's props; the selector owns its subscriptions.
  ['footer composer scope propagation',
    'let W;return t[35]!==r||t[36]!==V||t[37]!==H||t[38]!==U?',
    'let W;return !0||t[35]!==r||t[36]!==V||t[37]!==H||t[38]!==U?'],
  ['new thread submission capture',
    'j=async(n,r,i,a,s)=>{let{context:c,memoryPreferences:l}=await A(n)',
    'j=async(n,r,i,a,s)=>{let __cdxEngineSelection=globalThis.__cdxEngineModes.capture(e,a?.hostId??S);let{context:c,memoryPreferences:l}=await A(n)'],
  ['new thread options', 'S.clientUserMessageId=s,', 'Object.assign(S,__cdxEngineSelection),S.clientUserMessageId=s,'],
  ['worktree submission capture',
    'M=async(n,r,i,c,l,u)=>{let d=l?.workspaceRoots',
    'M=async(n,r,i,c,l,u)=>{let __cdxEngineSelection=globalThis.__cdxEngineModes.capture(e,l?.hostId??S);let d=l?.workspaceRoots'],
  ['worktree options',
    'h.threadStartKind!=null&&(b.threadStartKind=h.threadStartKind),',
    'Object.assign(b,__cdxEngineSelection),h.threadStartKind!=null&&(b.threadStartKind=h.threadStartKind),'],
  ['worktree entry conversion',
    '...Rbs({...o,workspaceRoots:[r,...vDe(o.workspaceRoots)],cwd:r}),initialTitle:a||t.label.trim()||void 0,skipAutoTitleGeneration:a.length>0',
    '...Rbs({...o,workspaceRoots:[r,...vDe(o.workspaceRoots)],cwd:r}),...globalThis.__cdxEngineModes.requestFields(o),initialTitle:a||t.label.trim()||void 0,skipAutoTitleGeneration:o.engineMode===`claude`||o.engineMode===`both`||a.length>0'],
  ['cloud continuation capture',
    'F=async(n,r,i,a)=>{let{context:s,memoryPreferences:c}=await A(n)',
    'F=async(n,r,i,a)=>{let __cdxEngineSelection=globalThis.__cdxEngineModes.capture(e,i?.hostId??S);let{context:s,memoryPreferences:c}=await A(n)'],
  ['cloud continuation options',
    'D.clientUserMessageId=a;let k=await GN',
    'Object.assign(D,__cdxEngineSelection),D.clientUserMessageId=a;let k=await GN'],
  ['thread creation propagation',
    'this.threadCreation.createConversation({clientUserMessageId:u,',
    'this.threadCreation.createConversation({clientUserMessageId:u,...globalThis.__cdxEngineModes.requestFields(e),'],
  ['thread start capture before shadowed binding',
    'async createConversation(e){let t=e.mode??`default`',
    'async createConversation(e){let __cdxEngineRequest=globalThis.__cdxEngineModes.requestFields(e);let t=e.mode??`default`'],
  ['thread start request',
    'let e=await i.prepareStart(),t=await this.params.requestClient.sendRequest(e.method,e.request,e.options)',
    'let e=await i.prepareStart(),t=await this.params.requestClient.sendRequest(e.method,{...e.request,...__cdxEngineRequest},e.options)'],
  ['first turn metadata cache',
    'this.threadStore.notifyConversationCallbacks(B),',
    'globalThis.__cdxEngineModes.noteStarted(this,B,e),this.threadStore.notifyConversationCallbacks(B),'],
  ['first turn override including prewarm',
    'await this.executeTurnStart(B,{request:{threadId:B,clientUserMessageId:u,',
    'await this.executeTurnStart(B,{request:{threadId:B,clientUserMessageId:u,...globalThis.__cdxEngineModes.requestFields(e),'],
  ['prepared turn wire request',
    'Ce={threadId:t,clientUserMessageId:r,additionalContext:i,input:o.input,',
    'Ce={threadId:t,clientUserMessageId:r,...globalThis.__cdxEngineModes.turnRequestFields(e,t,o,r,A??E?.settings?.model),additionalContext:i,input:o.input,'],
  ['Claude first turn title exclusion',
    'r.skipAutoTitleGeneration!==!0&&Mzn(',
    'r.engineMode!==`claude`&&r.engineMode!==`both`&&r.skipAutoTitleGeneration!==!0&&Mzn('],
  ['automatic title generation gate',
    'async function Pzn(e,t,n,r,i,a){let o=t.getConversation(n)',
    'async function Pzn(e,t,n,r,i,a){if(!await globalThis.__cdxEngineModes.permitsNativeMetadata(t,n))return null;let o=t.getConversation(n)'],
  ['automatic title final generation gate',
    'a=await zX.threadMetadataGeneration?.generateTitle({hostId:t.getHostId(),prompt:VRn(u),cwd:i,readOnlyAppToolAllowlist:r,...o.serviceName===void 0?{}:{serviceName:o.serviceName}}),s=a?.title.trim()??``',
    'a=await globalThis.__cdxEngineModes.permitsNativeMetadata(t,n)?await zX.threadMetadataGeneration?.generateTitle({hostId:t.getHostId(),prompt:VRn(u),cwd:i,readOnlyAppToolAllowlist:r,...o.serviceName===void 0?{}:{serviceName:o.serviceName}}):null,s=a?.title.trim()??``'],
  ['manual title final generation gate',
    'let i=Vkl(e);return i.length===0?null:',
    'let i=Vkl(e);return i.length===0||!await globalThis.__cdxEngineModes.permitsNativeMetadata(n,t)?null:'],
  ['description generation gate',
    'async function Izn(e,t,n){try{let r=e.getConversation(t)',
    'async function Izn(e,t,n){if(!await globalThis.__cdxEngineModes.permitsNativeMetadata(e,t))return null;try{let r=e.getConversation(t)'],
  ['title reconsideration gate',
    'async function Lzn(e,t,n,r){let i=e.getConversation(t)',
    'async function Lzn(e,t,n,r){if(!await globalThis.__cdxEngineModes.permitsNativeMetadata(e,t))return null;let i=e.getConversation(t)'],
  ['manual title generation gate',
    'async function Bkl(e,t){let n=ik(e,t),r=n?.getConversation(t);if(n==null||r==null)return null;try{',
    'async function Bkl(e,t){let n=ik(e,t),r=n?.getConversation(t);if(n==null||r==null)return null;if(!await globalThis.__cdxEngineModes.permitsNativeMetadata(n,t))return null;try{'],
];
// Earlier development previews used these exact replacements. Upgrade only
// recognized output so patchAssets can safely reuse a previously patched copy.
const PREVIEW_UPGRADES = [
  ['manager response observation', 'async sendRequest(e,t,n){globalThis.__cdxEngineModes.registerManager(this);let __cdxEngineResponse=await this.requestClient.sendRequest(e,t,n);globalThis.__cdxEngineModes.observe(this,e,t,__cdxEngineResponse);return __cdxEngineResponse}'],
  ['scoped composer controls', 'HV.FooterInlineControls,{ref:x,children:[V,(0,H2.jsx)(globalThis.__cdxEngineModes.Selector,{React:V2,jsx:H2,scope:u,threadId:f,hostId:a,cwd:i,getHost:(e,t)=>e.get(Rk,t),getManager:zg,useAtom:ss,busyAtom:yk,runtimeStatusAtom:kk,requestsAtom:XDr,nativeModelPicker:H}),r,U]}'],
  ['thread creation propagation', 'this.threadCreation.createConversation({clientUserMessageId:u,engineMode:e.engineMode,engineModel:e.engineModel,'],
  ['first turn override including prewarm', 'await this.executeTurnStart(B,{request:{threadId:B,clientUserMessageId:u,engineMode:e.engineMode,engineModel:e.engineModel,'],
  ['prepared turn wire request', 'Ce={threadId:t,clientUserMessageId:r,...globalThis.__cdxEngineModes.turnRequestFields(e,t,o,r),additionalContext:i,input:o.input,'],
  ['worktree entry conversion', '...Rbs({...o,workspaceRoots:[r,...vDe(o.workspaceRoots)],cwd:r}),...globalThis.__cdxEngineModes.requestFields(o),initialTitle:a||t.label.trim()||void 0,skipAutoTitleGeneration:o.engineMode===`claude`||a.length>0'],
  ['Claude first turn title exclusion', 'r.engineMode!==`claude`&&r.skipAutoTitleGeneration!==!0&&Mzn('],
  ['scoped composer controls', 'HV.FooterInlineControls,{ref:x,children:[V,(0,H2.jsx)(globalThis.__cdxEngineModes.Selector,{React:V2,jsx:H2,scope:u,threadId:f,hostId:a,getHost:(e,t)=>e.get(Rk,t),getManager:zg,useAtom:ss,busyAtom:yk,runtimeStatusAtom:kk,requestsAtom:XDr,nativeModelPicker:H}),r,U]}'],
  ['scoped composer controls', 'HV.FooterInlineControls,{ref:x,children:[V,(0,H2.jsx)(globalThis.__cdxEngineModes.Selector,{React:V2,jsx:H2,scope:u,threadId:f,hostId:a,getHost:(e,t)=>e.get(Rk,t),getManager:zg,useAtom:ss,busyAtom:yk,nativeModelPicker:H}),r,U]}'],
  ['prepared turn wire request', 'Ce={threadId:t,clientUserMessageId:r,...globalThis.__cdxEngineModes.requestFields(o),additionalContext:i,input:o.input,'],
];
const NATIVE_PICKER_PATCHES = [
  ['native picker guard context',
    'function fNc(e){let t=(0,_Nc.c)(167),',
    'globalThis.__cdxEngineModes.configureCodexAvailability({usePolicy:__cdxHost=>{let __cdxAvailability=ss(Vqa),__cdxAuth=LA(__cdxHost),{data:__cdxConfig}=ss(RS,__cdxHost,{enabled:!1});return{...__cdxAvailability,authMethod:__cdxAuth?.authMethod,isCustomModelProvider:Afn(__cdxConfig==null?null:cb(__cdxConfig.config)),loading:__cdxAuth?.isLoading===!0}},isAvailable:__cdxOptions=>Wqa(__cdxOptions)});function fNc(e){let __cdxPickerProps=e;let t=(0,_Nc.c)(167),'],
  ['native model selection guard',
    'Ie=function(e,t){return(w?.selectModelAndReasoningEffort??x)',
    'Ie=function(e,t){if(!globalThis.__cdxEngineModes.permitsNativeModelSelection(__cdxPickerProps))return;return(w?.selectModelAndReasoningEffort??x)'],
  ['native model reset guard',
    'function Le(e,t){return w==null?S(e,t):w.setModelAndReasoningEffort(e,t)}',
    'function Le(e,t){if(!globalThis.__cdxEngineModes.permitsNativeModelSelection(__cdxPickerProps))return;return w==null?S(e,t):w.setModelAndReasoningEffort(e,t)}'],
  ['native service tier guard',
    'let{serviceTierSettings:L,setServiceTier:R}=NZ(n),z;',
    'let{serviceTierSettings:L,setServiceTier:__cdxSetServiceTier}=NZ(n),R=(...__cdxArgs)=>{if(globalThis.__cdxEngineModes.permitsNativeModelSelection(__cdxPickerProps))return __cdxSetServiceTier(...__cdxArgs)},z;'],
  ['native toggleFastMode command gate',
    '_$(`composer.toggleFastMode`,He,We)',
    '_$(`composer.toggleFastMode`,He,{...We,enabled:We.enabled&&globalThis.__cdxEngineModes.permitsNativeModelSelection(__cdxPickerProps)})'],
  ['native increaseReasoningEffort command gate',
    '_$(`composer.increaseReasoningEffort`,Ge,Ke)',
    '_$(`composer.increaseReasoningEffort`,Ge,{...Ke,enabled:Ke.enabled&&globalThis.__cdxEngineModes.permitsNativeModelSelection(__cdxPickerProps)})'],
  ['native decreaseReasoningEffort command gate',
    '_$(`composer.decreaseReasoningEffort`,qe,Je)',
    '_$(`composer.decreaseReasoningEffort`,qe,{...Je,enabled:Je.enabled&&globalThis.__cdxEngineModes.permitsNativeModelSelection(__cdxPickerProps)})'],
  ['native cycleReasoningEffort command gate',
    '_$(`composer.cycleReasoningEffort`,Ye,Xe)',
    '_$(`composer.cycleReasoningEffort`,Ye,{...Xe,enabled:Xe.enabled&&globalThis.__cdxEngineModes.permitsNativeModelSelection(__cdxPickerProps)})'],
];
function patchNativePicker(source) {
  const previous = 'function fNc(e){let __cdxPickerProps=e;let t=(0,_Nc.c)(167),', current = NATIVE_PICKER_PATCHES[0][2];
  const previousCount = occurrences(source, previous), currentCount = occurrences(source, current);
  if (previousCount > 1 || currentCount > 1) throw new Error('agent-modes: expected one native picker availability registration');
  if (previousCount === 1 && currentCount === 0) source = source.replace(previous, () => current);
  for (const [name, before, after] of NATIVE_PICKER_PATCHES) source = replaceExactOnce(source, before, after, name);
  return source;
}

function patchAppBundle(source) {
  source = patchNativePicker(source);
  for (const [name, previous] of PREVIEW_UPGRADES) {
    const count = occurrences(source, previous);
    if (count === 0) continue;
    const current = APP_PATCHES.find(([label]) => label === name)[2];
    if (count !== 1 || occurrences(source, current) !== 0) throw new Error(`agent-modes: expected one previous match for ${name}`);
    source = source.replace(previous, () => current);
  }
  for (const [name, before, after] of APP_PATCHES) source = replaceExactOnce(source, before, after, name);
  return withHelper(source);
}
function patchTurnBundle(source) {
  return withHelper(replaceExactOnce(source,
    't[71]=i,t[72]=N):N=t[72],N})}));',
    't[71]=i,t[72]=N):N=t[72],(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(globalThis.__cdxEngineModes.SourceBadge,{React:Ua,jsx:$,threadId:a,hostId:s,turnId:u.turnId,raw:u}),N]})})}));',
    'turn source badge'));
}
function onlyBundle(assetsDir, pattern) {
  const files = fs.readdirSync(assetsDir).filter(name => pattern.test(name));
  if (files.length !== 1) throw new Error(`agent-modes: expected 1 ${pattern} in ${assetsDir}, found ${files.length}`);
  return path.join(assetsDir, files[0]);
}
function patchAssets(assetsDir) {
  const app = onlyBundle(assetsDir, /^app-initial-.*\.js$/);
  const turn = onlyBundle(assetsDir, /^local-conversation-turn-.*\.js$/);
  // Validate every seam before writing either bundle.
  const nextApp = patchAppBundle(fs.readFileSync(app, 'utf8'));
  const nextTurn = patchTurnBundle(fs.readFileSync(turn, 'utf8'));
  fs.copyFileSync(path.join(__dirname, 'assets', HELPER_NAME), path.join(assetsDir, HELPER_NAME));
  if (fs.existsSync(path.join(assetsDir, 'cdx-branch.js'))) fs.copyFileSync(path.join(__dirname, 'assets', 'cdx-branch.js'), path.join(assetsDir, 'cdx-branch.js'));
  fs.writeFileSync(app, nextApp);
  fs.writeFileSync(turn, nextTurn);
  return { app, turn, helper: path.join(assetsDir, HELPER_NAME) };
}
function main(args = process.argv.slice(2)) {
  const explicit = args.indexOf('--assets-dir');
  if (explicit >= 0) {
    if (!args[explicit + 1]) throw new Error('--assets-dir needs a path');
    patchAssets(path.resolve(args[explicit + 1]));
  } else {
    const platform = args.find(value => ['mac-arm64', 'mac-x64', 'win'].includes(value));
    const bundles = locateBundles({ dir: 'assets', pattern: /^app-initial-.*\.js$/, ...(platform ? { platform } : {}) });
    if (!bundles.length) throw new Error('agent-modes: no app bundles found');
    for (const bundle of bundles) patchAssets(path.dirname(bundle.path));
  }
  console.log('[done] agent-modes renderer');
}
module.exports = { replaceExactOnce, patchAppBundle, patchNativePicker, patchTurnBundle, patchAssets };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
