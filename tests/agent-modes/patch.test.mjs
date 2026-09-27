import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { patchAppBundle, patchTurnBundle, replaceExactOnce } = require('../../scripts/patch-agent-modes.js');

// Deliberately literal upstream seams: a renamed binding must fail a build.
const appFixture = [
  'async sendRequest(e,t,n){return this.requestClient.sendRequest(e,t,n)}',
  'HV.FooterInlineControls,{ref:x,children:[V,H,r,U]}',
  'let W;return t[35]!==r||t[36]!==V||t[37]!==H||t[38]!==U?',
  'j=async(n,r,i,a,s)=>{let{context:c,memoryPreferences:l}=await A(n)',
  'S.clientUserMessageId=s,',
  'M=async(n,r,i,c,l,u)=>{let d=l?.workspaceRoots',
  'h.threadStartKind!=null&&(b.threadStartKind=h.threadStartKind),',
  '...Rbs({...o,workspaceRoots:[r,...vDe(o.workspaceRoots)],cwd:r}),initialTitle:a||t.label.trim()||void 0,skipAutoTitleGeneration:a.length>0',
  'F=async(n,r,i,a)=>{let{context:s,memoryPreferences:c}=await A(n)',
  'D.clientUserMessageId=a;let k=await GN',
  'this.threadCreation.createConversation({clientUserMessageId:u,',
  'async createConversation(e){let t=e.mode??`default`',
  'let e=await i.prepareStart(),t=await this.params.requestClient.sendRequest(e.method,e.request,e.options)',
  'this.threadStore.notifyConversationCallbacks(B),',
  'await this.executeTurnStart(B,{request:{threadId:B,clientUserMessageId:u,',
  'Ce={threadId:t,clientUserMessageId:r,additionalContext:i,input:o.input,',
  'r.skipAutoTitleGeneration!==!0&&Mzn(',
  'async function Pzn(e,t,n,r,i,a){let o=t.getConversation(n)',
  'a=await zX.threadMetadataGeneration?.generateTitle({hostId:t.getHostId(),prompt:VRn(u),cwd:i,readOnlyAppToolAllowlist:r,...o.serviceName===void 0?{}:{serviceName:o.serviceName}}),s=a?.title.trim()??``',
  'let i=Vkl(e);return i.length===0?null:',
  'async function Izn(e,t,n){try{let r=e.getConversation(t)',
  'async function Lzn(e,t,n,r){let i=e.getConversation(t)',
  'async function Bkl(e,t){let n=ik(e,t),r=n?.getConversation(t);if(n==null||r==null)return null;try{',
].join('\n');
const turnFixture = 't[71]=i,t[72]=N):N=t[72],N})}));';

test('exact replacement rejects missing, ambiguous, and mixed upstream anchors', () => {
  assert.equal(replaceExactOnce('A target B', 'target', 'patched-target', 'seam'), 'A patched-target B');
  for (const text of ['none', 'target target', 'patched-target target', 'patched-target patched-target']) {
    assert.throws(() => replaceExactOnce(text, 'target', 'patched-target', 'seam'), /seam/);
  }
});

test('exact replacement is idempotent even when replacement contains original text', () => {
  assert.equal(replaceExactOnce('patched-target', 'target', 'patched-target', 'seam'), 'patched-target');
});

test('app patch is idempotent and captures engine settings before preparation', () => {
  const patched = patchAppBundle(appFixture);
  assert.equal(patchAppBundle(patched), patched);
  assert.match(patched, /j=async\(n,r,i,a,s\)=>\{let __cdxEngineSelection=globalThis\.__cdxEngineModes.capture\(e,a\?\.hostId\?\?S\);let\{context:c/);
  assert.match(patched, /let W;return !0\|\|/);
  assert.match(patched, /busyAtom:yk,runtimeStatusAtom:kk,requestsAtom:XDr,nativeModelPicker:H/);
  assert.match(patched, /Object\.assign\(S,__cdxEngineSelection\)/);
  assert.match(patched, /Object\.assign\(D,__cdxEngineSelection\)/);
  assert.match(patched, /Object\.assign\(b,__cdxEngineSelection\)/);
  assert.match(patched, /request:\{threadId:B,clientUserMessageId:u,engineMode:e.engineMode,engineModel:e.engineModel,/);
  assert.match(patched, /r.engineMode!==`claude`&&r.skipAutoTitleGeneration/);
  assert.match(patched, /a=await globalThis\.__cdxEngineModes\.permitsNativeMetadata\(t,n\)\?await zX/);
  assert.match(patched, /let i=Vkl\(e\);return i.length===0\|\|!await globalThis\.__cdxEngineModes\.permitsNativeMetadata\(n,t\)\?null:/);
});

test('app patch rejects every missing or duplicate upstream seam', () => {
  for (const anchor of appFixture.split('\n')) {
    assert.throws(() => patchAppBundle(appFixture.replace(anchor, 'UPSTREAM_CHANGED')), /expected|missing|match/i, anchor);
    assert.throws(() => patchAppBundle(`${appFixture}\n${anchor}`), /expected|ambiguous|match/i, anchor);
  }
});

test('source badge patch is idempotent and bound to the rendered turn identity', () => {
  const patched = patchTurnBundle(turnFixture);
  assert.match(patched, /threadId:a,hostId:s,turnId:u.turnId,raw:u/);
  assert.equal(patchTurnBundle(patched), patched);
  assert.throws(() => patchTurnBundle('upstream changed'), /match/);
  assert.throws(() => patchTurnBundle(turnFixture + turnFixture), /match/);
});

test('shipped helper can be parsed as a classic script and contains no bundled imports', () => {
  const helper = readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(helper));
  assert.doesNotMatch(helper, /^import\s/m);
});

// Upstream Rbs intentionally reconstructs its output. Exercise that real
// conversion rather than assuming its input spread survives to GN.
const upstreamRbs = `function Rbs({agentMode:e,permissionProfileId:t,permissionSelection:n,shouldSendPermissionOverrides:r,workspaceRoots:i,config:a,configOverrides:o,input:s,commentAttachments:c,mcpAppModelContextAttachments:l,collaborationMode:u,serviceTier:d,serviceName:f,cwd:p,fileAttachments:m,addedFiles:h,memoryPreferences:g,mode:_,threadSource:v,threadStartKind:y,workspaceKind:b="project",projectlessOutputDirectory:x,projectAssignment:S,baseInstructions:C,additionalDeveloperInstructions:w,requiresThreadReferences:T},{allowProjectlessWithoutOutputDirectory:E=false}={}){if(b==="projectless"&&x==null&&_!=="durable"&&!E)throw Error("Projectless conversations require an output directory");let D=v_([...m,...h]),O=null;n?.kind==="custom"?O=Tl("custom",i,a):n==null&&r!==false&&(O=Tl(e,i,a)),O!=null&&t!=null&&(O.activePermissionProfile={id:t,extends:null},O.runtimeWorkspaceRoots=i);let k;return k=O==null?n?.kind==="agent-mode"||n?.kind==="profile"?{permissionSelection:n}:{useAppServerPermissionDefault:true}:{permissionsConfig:O,approvalsReviewer:O.approvalsReviewer},{input:s,commentAttachments:c,mcpAppModelContextAttachments:l,workspaceRoots:i,...n==null?{}:{usePermissionSelection:true},collaborationMode:u,multiAgentMode:RRn,serviceTier:d,...f===void 0?{}:{serviceName:f},...k,cwd:p,attachments:D,localTurnMetadata:{fileAttachmentCount:m.length+h.filter(ZTe).length},workspaceKind:b,projectAssignment:S,mode:_,threadSource:v,threadStartKind:y,config:o,...b==="projectless"?{projectlessOutputDirectory:x}:{},memoryPreferences:g,baseInstructions:C,additionalDeveloperInstructions:w,requiresThreadReferences:T}}`;

test('worktree conversion preserves captured engine and model through persisted entry to GN', () => {
  const context = { v_: input => input, RRn: 'explicitRequestOnly', ZTe: () => false };
  vm.runInNewContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8') + upstreamRbs, context);
  const scope = { node: {}, value: { kind: 'new' } }, api = context.__cdxEngineModes;
  api.setDraftSelection(scope, { engineMode: 'claude', engineModel: 'opus' });
  const captured = api.capture(scope, 'local');
  const entry = JSON.parse(JSON.stringify({ startConversationParamsInput: {
    shouldSendPermissionOverrides: false, fileAttachments: [], addedFiles: [], input: [{ type: 'text', text: 'hello' }], workspaceRoots: ['/source'], ...captured,
  }, label: 'Worktree' }));
  api.setDraftSelection(scope, { engineMode: 'codex' });
  const expression = patchAppBundle(appFixture).split('\n').find(line => line.startsWith('...Rbs('));
  const convert = new Function('Rbs', 'vDe', 'o', 'r', 'a', 't', 'globalThis', `return ({${expression}})`);
  const sentToGN = convert(context.Rbs, value => value, entry.startConversationParamsInput, '/worktree', '', entry, context);
  assert.equal(sentToGN.engineMode, 'claude');
  assert.equal(sentToGN.engineModel, 'opus');
  assert.equal(sentToGN.skipAutoTitleGeneration, true);
  assert.equal(sentToGN.cwd, '/worktree');
  assert.deepEqual(sentToGN.input, [{ type: 'text', text: 'hello' }]);
});

test('prewarmed first-turn override survives the actual turn request reconstruction', () => {
  const context = {};
  vm.runInNewContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8'), context);
  const patched = patchAppBundle(appFixture).split('\n');
  const firstTurn = patched.find(line => line.startsWith('await this.executeTurnStart('));
  const wireRequest = patched.find(line => line.startsWith('Ce={'));
  const prepareWireRequest = new Function('o', 't', 'r', 'i', 'globalThis', `const e={getHostId:()=> 'local'};return (${wireRequest.slice(3)}model:o.model,collaborationMode:o.collaborationMode})`);
  const startPrewarmed = new Function('e', 'B', 'u', 'executeTurnStart', `return ${firstTurn.replace('await this.executeTurnStart', 'executeTurnStart')}input:e.input,model:e.model,collaborationMode:e.collaborationMode}})`);
  const selected = { engineMode: 'claude', engineModel: 'haiku', model: 'gpt-native', input: [{ type: 'text', text: 'First message' }], collaborationMode: { mode: 'default' } };
  const wire = startPrewarmed(selected, 'prewarmed-thread', 'message-1', (id, submission) => prepareWireRequest(submission.request, id, 'message-1', null, context));
  assert.equal(wire.threadId, 'prewarmed-thread');
  assert.equal(wire.engineMode, 'claude');
  assert.equal(wire.engineModel, 'haiku');
  assert.equal(wire.model, 'gpt-native');
  assert.deepEqual(wire.input, selected.input);
  const native = prepareWireRequest({ input: selected.input, model: 'gpt-native' }, 'existing', 'message-2', null, context);
  assert.equal(native.engineMode, undefined);
  assert.equal(native.model, 'gpt-native');
});

test('existing-chat retry wire reconstruction carries retained first-turn creation intent', () => {
  const context = {};
  vm.runInNewContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8'), context);
  const manager = { getHostId: () => 'local' };
  context.__cdxEngineModes.noteStarted(manager, 'prewarmed-retry', { engineMode: 'claude', engineModel: 'haiku', clientUserMessageId: 'failed-prepare' });
  const wireRequest = patchAppBundle(appFixture).split('\n').find(line => line.startsWith('Ce={'));
  const prepareWireRequest = new Function('e', 'o', 't', 'r', 'i', 'globalThis', `return (${wireRequest.slice(3)}model:o.model})`);
  const wire = prepareWireRequest(manager, { input: [{ type: 'text', text: 'Retry' }], model: 'native-default' }, 'prewarmed-retry', 'retry-message', null, context);
  assert.equal(wire.engineMode, 'claude');
  assert.equal(wire.engineModel, 'haiku');
  assert.equal(wire.clientUserMessageId, 'retry-message');
  assert.equal(wire.model, 'native-default');
});

test('known development preview patches upgrade exactly once without re-extraction', () => {
  const current = patchAppBundle(appFixture);
  const previous = current.replace('busyAtom:yk,runtimeStatusAtom:kk,requestsAtom:XDr,nativeModelPicker:H', 'busyAtom:yk,nativeModelPicker:H').replace('turnRequestFields(e,t,o,r)', 'requestFields(o)');
  assert.equal(patchAppBundle(previous), current);
  const oldSelector = previous.split('\n').find(line => line.startsWith('HV.FooterInlineControls'));
  assert.throws(() => patchAppBundle(previous + '\n' + oldSelector), /expected one previous match/);
  assert.throws(() => patchAppBundle(current + '\n' + oldSelector), /expected one previous match/);
});
