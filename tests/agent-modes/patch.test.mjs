import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { patchAppBundle, patchTurnBundle, replaceExactOnce } = require('../../scripts/patch-agent-modes.js');

// Deliberately literal upstream seams: a renamed binding must fail a build.
const appFixture = [
  'function fNc(e){let t=(0,_Nc.c)(167),',
  'Ie=function(e,t){return(w?.selectModelAndReasoningEffort??x)',
  'function Le(e,t){return w==null?S(e,t):w.setModelAndReasoningEffort(e,t)}',
  'let{serviceTierSettings:L,setServiceTier:R}=NZ(n),z;',
  '_$(`composer.toggleFastMode`,He,We)',
  '_$(`composer.increaseReasoningEffort`,Ge,Ke)',
  '_$(`composer.decreaseReasoningEffort`,qe,Je)',
  '_$(`composer.cycleReasoningEffort`,Ye,Xe)',

  'H=!P&&(0,H2.jsx)(`span`,{ref:S,children:(0,H2.jsx)(fNc,{conversationId:f,hideLabel:F,permissionsCwdOverride:i,permissionsHostId:a})})',
  'async sendRequest(e,t,n){return this.requestClient.sendRequest(e,t,n)}',
  'function TPc(e){let t=(0,kPc.c)(102),',
  'E=Y(LXs),D=d?E.filter(xZs):E',
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
  assert.match(patched, /__cdxEngineModes\.PermissionControls/);
  assert.match(patched, /__cdxEngineModes\.useClaudeCommands/);
  assert.match(patched, /useClaudeCommands\(\{React:F\$,scope:m,threadId:FB\(m\)/);
  assert.match(patched, /j=async\(n,r,i,a,s\)=>\{let __cdxEngineSelection=globalThis\.__cdxEngineModes.capture\(e,a\?\.hostId\?\?S\);let\{context:c/);
  assert.match(patched, /let W;return !0\|\|/);
  assert.match(patched, /busyAtom:yk,runtimeStatusAtom:kk,requestsAtom:XDr,nativeModelPicker:H/);
  assert.match(patched, /Object\.assign\(S,__cdxEngineSelection\)/);
  assert.match(patched, /Object\.assign\(D,__cdxEngineSelection\)/);
  assert.match(patched, /Object\.assign\(b,__cdxEngineSelection\)/);
  assert.match(patched, /request:\{threadId:B,clientUserMessageId:u,\.\.\.globalThis\.__cdxEngineModes.requestFields\(e\),/);
  assert.match(patched, /r.engineMode!==`claude`&&r.engineMode!==`both`&&r.skipAutoTitleGeneration/);
  assert.match(patched, /a=await globalThis\.__cdxEngineModes\.permitsNativeMetadata\(t,n\)\?await zX/);
  assert.match(patched, /let i=Vkl\(e\);return i.length===0\|\|!await globalThis\.__cdxEngineModes\.permitsNativeMetadata\(n,t\)\?null:/);
});

test('app patch rejects every missing or duplicate upstream seam', () => {
  for (const anchor of appFixture.split('\n')) {
    assert.throws(() => patchAppBundle(appFixture.replace(anchor, 'UPSTREAM_CHANGED')), /expected|missing|match/i, anchor);
    assert.throws(() => patchAppBundle(`${appFixture}\n${anchor}`), /expected|ambiguous|match/i, anchor);
  }
});

test('model discovery receives the composer project directory, including upgraded patches', () => {
  const patched = patchAppBundle(appFixture);
  assert.match(patched, /Selector,\{React:V2,jsx:H2,scope:u,threadId:f,hostId:a,cwd:i,/);
  const previous = patched.replace(',bothNativeModelPicker:(0,H2.jsx)(fNc,{conversationId:f,hideLabel:!1,permissionsCwdOverride:i,permissionsHostId:a})', '').replace('hostId:a,cwd:i,getHost:', 'hostId:a,getHost:');
  assert.equal(patchAppBundle(previous), patched);
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
  const prepareWireRequest = new Function('o', 't', 'r', 'i', 'globalThis', `const e={getHostId:()=> 'local'},A=o.model,E=o.collaborationMode;return (${wireRequest.slice(3)}model:o.model,collaborationMode:o.collaborationMode})`);
  const startPrewarmed = new Function('e', 'B', 'u', 'executeTurnStart', `const globalThis=arguments[4];return ${firstTurn.replace('await this.executeTurnStart', 'executeTurnStart')}input:e.input,model:e.model,collaborationMode:e.collaborationMode}})`);
  const selected = { engineMode: 'claude', engineModel: 'haiku', model: 'gpt-native', input: [{ type: 'text', text: 'First message' }], collaborationMode: { mode: 'default' } };
  const wire = startPrewarmed(selected, 'prewarmed-thread', 'message-1', (id, submission) => prepareWireRequest(submission.request, id, 'message-1', null, context), context);
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
  const prepareWireRequest = new Function('e', 'o', 't', 'r', 'i', 'globalThis', `const A=o.model,E=o.collaborationMode;return (${wireRequest.slice(3)}model:o.model})`);
  const wire = prepareWireRequest(manager, { input: [{ type: 'text', text: 'Retry' }], model: 'native-default' }, 'prewarmed-retry', 'retry-message', null, context);
  assert.equal(wire.engineMode, 'claude');
  assert.equal(wire.engineModel, 'haiku');
  assert.equal(wire.clientUserMessageId, 'retry-message');
  assert.equal(wire.model, 'native-default');
});

test('known development preview patches upgrade exactly once without re-extraction', () => {
  const current = patchAppBundle(appFixture);
  const previous = current.replace(',bothNativeModelPicker:(0,H2.jsx)(fNc,{conversationId:f,hideLabel:!1,permissionsCwdOverride:i,permissionsHostId:a})', '').replace('hostId:a,cwd:i,getHost:', 'hostId:a,getHost:').replace('busyAtom:yk,runtimeStatusAtom:kk,requestsAtom:XDr,nativeModelPicker:H', 'busyAtom:yk,nativeModelPicker:H').replace('turnRequestFields(e,t,o,r,A??E?.settings?.model)', 'requestFields(o)');
  assert.equal(patchAppBundle(previous), current);
  const oldSelector = previous.split('\n').find(line => line.startsWith('HV.FooterInlineControls'));
  assert.throws(() => patchAppBundle(previous + '\n' + oldSelector), /expected one previous match/);
  assert.throws(() => patchAppBundle(current + '\n' + oldSelector), /expected one previous match/);
});


test('dual creation and prepared-turn seams clone snapshots and resolve the current native Codex model', () => {
  const context = {};
  vm.runInNewContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8'), context);
  const patched = patchAppBundle(appFixture).split('\n');
  const creation = patched.find(line => line.startsWith('this.threadCreation.createConversation('));
  const create = new Function('e', 'u', 'globalThis', `return (${creation.replace('this.threadCreation.createConversation(', '')}})`);
  const selected = { engineMode: 'both', engineModels: { codex: 'stale-draft', claude: 'claude-exact' }, template: { id: 'debby', revision: 1, parameters: { rounds: 3 } } };
  const cloned = create(selected, 'message', context);
  assert.deepEqual(JSON.parse(JSON.stringify(cloned.engineModels)), selected.engineModels);
  assert.notEqual(cloned.engineModels, selected.engineModels);
  assert.notEqual(cloned.template.parameters, selected.template.parameters);
  const wireRequest = patched.find(line => line.startsWith('Ce={'));
  const prepare = new Function('e', 'o', 'A', 'E', 'globalThis', `const t='chat',r='message',i=null;return (${wireRequest.slice(3)}model:A,collaborationMode:E})`);
  for (const [A, E, expected] of [['native-current', null, 'native-current'], [null, { settings: { model: 'collaboration-current' } }, 'collaboration-current']]) {
    const wire = prepare({ getHostId: () => 'local' }, { ...selected, input: [] }, A, E, context);
    assert.equal(wire.engineModels.codex, expected);
    assert.equal(wire.engineModels.claude, 'claude-exact');
    assert.equal(wire.template.parameters.rounds, 3);
  }
  const worktree = patched.find(line => line.startsWith('...Rbs('));
  assert.match(worktree, /o.engineMode===`both`/);
});

test('recognized single-engine patches upgrade all dual propagation seams without ambiguity', () => {
  const current = patchAppBundle(appFixture);
  const previous = current
    .replaceAll('...globalThis.__cdxEngineModes.requestFields(e),', 'engineMode:e.engineMode,engineModel:e.engineModel,')
    .replace('turnRequestFields(e,t,o,r,A??E?.settings?.model)', 'turnRequestFields(e,t,o,r)')
    .replace('o.engineMode===`claude`||o.engineMode===`both`||a.length>0', 'o.engineMode===`claude`||a.length>0')
    .replace('r.engineMode!==`claude`&&r.engineMode!==`both`&&r.skipAutoTitleGeneration', 'r.engineMode!==`claude`&&r.skipAutoTitleGeneration');
  assert.equal(patchAppBundle(previous), current);
  assert.notEqual(previous, current);
  const duplicate = previous.split('\n').find(line => line.startsWith('this.threadCreation.createConversation('));
  assert.throws(() => patchAppBundle(previous + '\n' + duplicate), /expected/);
});

test('dual footer assembles a native picker independently of the width-gated single-mode picker', () => {
  const patched = patchAppBundle(appFixture), footer = patched.split('\n').find(line => line.startsWith('HV.FooterInlineControls,'));
  const factory = { jsx: (type, props) => ({ type, props }) };
  const context = { H2: factory, HV: { FooterInlineControls: 'footer' }, x: {}, V: null, H: false, r: null, U: null,
    V2: {}, u: {}, f: 'thread', a: 'local', i: '/project', Rk: {}, zg: {}, ss: {}, yk: {}, kk: {}, XDr: {}, fNc: 'native-model-and-effort-picker', __cdxEngineModes: { Selector: 'engine-selector' } };
  const tree = vm.runInNewContext(`(0,H2.jsx)(${footer})`, context);
  const selector = tree.props.children[1];
  assert.equal(selector.props.nativeModelPicker, false);
  assert.equal(selector.props.bothNativeModelPicker?.type, 'native-model-and-effort-picker');
  assert.deepEqual(JSON.parse(JSON.stringify(selector.props.bothNativeModelPicker.props)), { conversationId: 'thread', hideLabel: false, permissionsCwdOverride: '/project', permissionsHostId: 'local' });
  const nativeContract = 'H=!P&&(0,H2.jsx)(`span`,{ref:S,children:(0,H2.jsx)(fNc,{conversationId:f,hideLabel:F,permissionsCwdOverride:i,permissionsHostId:a})})';
  assert.ok(patched.includes(nativeContract), 'Only-mode width policy must remain unchanged');
  assert.throws(() => patchAppBundle(appFixture.replace(nativeContract, nativeContract.replace('fNc', 'changedNativePicker'))), /native model picker contract/);
});

function nativePickerProbe() {
  const changes = [], commands = new Map(), cache = Array(167).fill(Symbol.for('react.memo_cache_sentinel'));
  const noop = () => {}, context = {
    console, _Nc: { c: () => cache }, Q: {}, yNc: 'menu', Xj: 'flags', Uu: {}, WO: 'localModel', Sk: 'mode', DU: 'host', kMc: 'runtime', nG: 'hotkey',
    us: () => ({ get: () => 0, set: noop }), Y: key => key === 'flags' ? { data: { ultraEffortEnabled: false } } : 'simple', JX: () => false,
    EP: () => ({ hostId: 'local', cwd: '/project' }), ss: key => key === 'runtime' ? 'idle' : false, LA: () => ({ authMethod: 'apiKey' }),
    WU: () => ({ focus: noop }), tZ: () => false, Jb: () => 'default',
    cNc: () => ({ modelSettings: { model: 'gpt', reasoningEffort: 'low', isLoading: false }, selectComposerModelAndReasoningEffort: (...args) => changes.push(['select', ...args.slice(0, 2)]), setModelAndReasoningEffort: (...args) => changes.push(['reset', ...args]) }),
    IMc: () => null, kU: () => ({ data: { models: [] }, status: 'success' }), gNc: () => false, hNc: () => false,
    NZ: () => ({ serviceTierSettings: { selectedServiceTier: 'standard', availableOptions: [{ value: 'standard' }, { value: 'fast', iconKind: 'fast' }] }, setServiceTier: (...args) => changes.push(['tier', ...args]) }),
    Wys: () => ({ isServiceTierAllowed: true }), ssc: () => ({ isOpen: false, setIsOpen: noop, triggerRef: {}, onTriggerBlur: noop, onTriggerPointerDown: noop, onTriggerPointerLeave: noop, handleSelectAndClose: noop }),
    tJa: () => true, aAc: () => ['low', 'high'], Lic: () => [], oAc: effort => effort, mNc: noop, Pic: () => [], Ric: () => null, Fic: () => null, dsc: () => [],
    $Mc: noop, HG: () => ({ model: 'gpt' }), pNc: option => option.iconKind === 'fast', CEr: () => false, gEr: () => false,
    vNc: { useRef: value => ({ current: value }) }, sAc: () => 'high', cAc: () => 'high',
    _$: (name, callback, options) => commands.set(name, { callback, options }),
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../../scripts/assets/agent-modes-ui.js', import.meta.url), 'utf8'), context);
  const nativeSource = readFileSync(new URL('./fixtures/native-model-picker.js', import.meta.url), 'utf8');
  const patch = require('../../scripts/patch-agent-modes.js').patchNativePicker ?? (text => text);
  vm.runInContext(patch(nativeSource), context);
  return { api: context.__cdxEngineModes, render: props => context.fNc(props), changes, commands };
}

test('busy Both chats disable actual native model shortcuts and reject cached selection callbacks', () => {
  const { api, render, changes, commands } = nativePickerProbe(), manager = { getHostId: () => 'local' };
  const context = { threadId: 'busy', hostId: 'local' }, props = { conversationId: 'busy', cdxEngineSelectionContext: context };
  api.observe(manager, 'engine/mode/set', { threadId: 'busy' }, { engineMode: 'both', models: {}, busy: false });
  const idle = render(props), cachedCommands = [...commands.values()].map(command => command.callback);
  assert.equal(commands.get('composer.increaseReasoningEffort').options.enabled, true);
  commands.get('composer.increaseReasoningEffort').callback();
  assert.deepEqual(changes[0], ['select', 'gpt', 'high']);
  changes.length = 0;
  api.observe(manager, 'engine/mode/set', { threadId: 'busy' }, { engineMode: 'both', models: {}, busy: true });
  render(props);
  for (const name of ['composer.increaseReasoningEffort', 'composer.decreaseReasoningEffort', 'composer.cycleReasoningEffort', 'composer.toggleFastMode']) assert.equal(commands.get(name).options.enabled, false, name);
  for (const callback of cachedCommands) callback();
  idle.select('other', 'high'); idle.reset('other', 'high'); idle.selectTier('fast');
  assert.deepEqual(changes, []);
  api.observe(manager, 'engine/mode/set', { threadId: 'other' }, { engineMode: 'both', models: {}, busy: false });
  render({ conversationId: 'other', cdxEngineSelectionContext: { threadId: 'other', hostId: 'local' } });
  assert.equal(commands.get('composer.toggleFastMode').options.enabled, true);
  commands.get('composer.toggleFastMode').callback();
  assert.equal(changes.length, 1);
  changes.length = 0;
  render({ conversationId: 'busy' }); // Ordinary native instances retain their behavior.
  commands.get('composer.increaseReasoningEffort').callback();
  assert.equal(changes.length, 1);
});
