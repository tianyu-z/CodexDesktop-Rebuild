import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../runtime/agent-modes/store.mjs';
import { EngineRouter } from '../../runtime/agent-modes/router.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'engine-router-'));
  const thread={id:'thread-1',cwd:dir,turns:[],status:{type:'idle'},createdAt:1,updatedAt:1,preview:''};
  const calls=[],events=[],runs=[];
  const native={async request(method,params){calls.push({method,params});if(method==='thread/start'||method==='thread/resume'||method==='thread/read')return {thread:structuredClone(thread),model:'codex-model'};if(method==='turn/start')return {turn:{id:'native-turn',items:[{id:'native-user',type:'userMessage',content:params.input}],status:'inProgress'}};if(method.includes('/list'))return {data:[],nextCursor:null};return {};}};
  const adapter={start(options){let finish;const done=new Promise(r=>finish=r);const run={options,finish,done,async interrupt(){finish({status:'interrupted',nativeSessionId:'claude-session'});}};runs.push(run);return run;}};
  const store=new ConversationStore(dir);const router=new EngineRouter({store,native,adapter,emit:message=>events.push(message)});
  t.after(async()=>{await router.close();rmSync(dir,{recursive:true,force:true});});return {dir,thread,calls,events,runs,store,router};
}
async function start(f,engineMode='codex'){return f.router.request('thread/start',{cwd:f.dir,engineMode,model:'codex-model',agentMode:'guardian-approvals'});}
test('interrupt bypasses a pending history read for the same chat', async t => {
  const f = fixture(t); await start(f, 'claude');
  const { turn } = await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] }); await tick();
  const original = f.router.native.request.bind(f.router.native); let release, stopped = false;
  f.router.native.request = (method, params) => method === 'thread/read'
    ? new Promise(resolve => { release = () => resolve({ thread: structuredClone(f.thread) }); }) : original(method, params);
  const read = f.router.request('thread/read', { threadId: 'thread-1' }); await tick();
  const stop = f.router.request('turn/interrupt', { threadId: 'thread-1', turnId: turn.id }).then(() => { stopped = true; });
  await tick();
  try { assert.equal(stopped, true); } finally {
    f.router.native.request = original; release(); await Promise.all([read, stop]);
  }
});
test('capabilities discover exact models in the chat workspace and carry explicit refresh', async t => {
  const f = fixture(t); await start(f, 'claude');
  const models = ['claude-opus-4-8', 'claude-opus-4-6', 'claude-opus-5', 'claude-opus-5-5'].map(value => ({ value, resolvedModel: value, displayName: value, description: 'From Claude Code' }));
  let request;
  f.router.adapter.listModels = async options => { request = options; return models; };
  const result = await f.router.request('engine/capabilities', { threadId: 'thread-1', cwd: '/wrong-workspace', refresh: true });
  assert.deepEqual(result.claudeModels, models);
  assert.deepEqual(request, { cwd: f.dir, refresh: true });
  assert.equal(result.modelListError, null);
  assert.equal(f.runs.length, 0);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0);
});
test('model discovery failure keeps engines available and does not expose provider errors', async t => {
  const f = fixture(t);
  f.router.adapter.listModels = async () => { throw Error('sensitive-provider-token'); };
  const result = await f.router.request('engine/capabilities', {});
  assert.deepEqual(result.engines, ['codex', 'claude']);
  assert.deepEqual(result.claudeModels, []);
  assert.match(result.modelListError, /refresh|retry/i);
  assert.ok(!JSON.stringify(result).includes('sensitive-provider-token'));
});
test('capabilities expose provider catalog metadata and SDK fallback warning without breaking model arrays', async t => {
  const f = fixture(t);
  const models = [{ value: 'claude-fable-50', displayName: 'Future Claude', description: 'API advertised model; not individually verified.' }];
  const metadata = { source: 'sdk-fallback', apiStatus: 'failed', provider: 'foundry', endpointPath: '/openai/v1/models', apiModelCount: 0, sdkModelCount: 1, advertised: true, warning: 'Provider API unavailable; SDK options may be incomplete.' };
  let request;
  f.router.adapter.listModelCatalog = async options => { request = options; return { models, ...metadata }; };
  const result = await f.router.request('engine/capabilities', { cwd: f.dir, refresh: true });
  assert.deepEqual(result.claudeModels, models);
  assert.deepEqual(result.modelCatalog, metadata);
  assert.equal(result.modelListError, metadata.warning);
  assert.deepEqual(request, { cwd: f.dir, refresh: true });
});
test('exact Claude model identifiers reach the adapter without alias conversion', async t => {
  const f = fixture(t); await start(f, 'claude');
  for (const model of ['claude-opus-4-8', 'claude-opus-4-6', 'claude-opus-5', 'claude-opus-5-5']) {
    await f.router.request('engine/mode/set', { threadId: 'thread-1', engineMode: 'claude', engineModel: model });
    await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
    await tick();
    const run = f.runs.at(-1); assert.equal(run.options.model, model);
    run.finish({ status: 'completed', nativeSessionId: 'cc' }); await tick();
  }
});
test('invalid Claude IDs are rejected before creating a native thread or changing selection', async t => {
  const f = fixture(t);
  await assert.rejects(f.router.request('thread/start', { cwd: f.dir, engineMode: 'claude', engineModel: '--dangerously-skip-permissions' }), /model/i);
  assert.equal(f.calls.length, 0);
  await start(f, 'claude');
  await assert.rejects(f.router.request('engine/mode/set', { threadId: 'thread-1', engineMode: 'claude', engineModel: 'bad\nmodel' }), /model/i);
  assert.equal(f.store.get('thread-1').models.claude, 'default');
});
test('router shutdown closes pending model discovery alongside active runs', async t => {
  const f = fixture(t); let closed = 0;
  f.router.adapter.close = async () => { closed++; };
  await f.router.close(); assert.equal(closed, 1);
});
test('slow model discovery never blocks interrupting an active Claude turn', async t => {
  const f = fixture(t); await start(f, 'claude');
  const { turn } = await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] }); await tick();
  let release;
  f.router.adapter.listModels = () => new Promise(resolve => { release = resolve; });
  const catalog = f.router.request('engine/capabilities', { threadId: 'thread-1' }); await tick();
  const interrupted = f.router.request('turn/interrupt', { threadId: 'thread-1', turnId: turn.id });
  try { await tick(); assert.equal(f.runs[0].options.signal.aborted, true); }
  finally { release([]); await Promise.all([catalog, interrupted]); }
});
test('mode is scoped to thread; native parameters retain permission agentMode',async t=>{const f=fixture(t);await start(f,'claude');assert.equal(f.store.get('thread-1').mode,'claude');assert.equal(f.calls[0].params.agentMode,'guardian-approvals');assert.equal(f.calls[0].params.engineMode,undefined);assert.equal(f.calls[0].params.model,undefined);await assert.rejects(()=>f.router.request('engine/mode/set',{threadId:'thread-1',engineMode:'both'}),/gateway/);assert.equal(f.store.get('thread-1').mode,'claude');});
test('Claude start never starts Codex inference; completion persists before notification',async t=>{const f=fixture(t);await start(f,'claude');const {turn}=await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'hello'}],model:'wrong-codex-model'});await tick();assert.equal(f.runs.length,1);assert.equal(f.runs[0].options.model,undefined);assert.equal(f.runs[0].options.prompt,'hello');assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);await assert.rejects(()=>f.router.request('engine/mode/set',{threadId:'thread-1',engineMode:'codex'}),/active/);f.runs[0].options.onEvent({type:'session',sessionId:'claude-session'});f.runs[0].options.onEvent({type:'message-start',id:'text-1'});f.runs[0].options.onEvent({type:'text-delta',id:'text-1',delta:'answer'});f.runs[0].options.onEvent({type:'message-completed',id:'text-1',text:'answer'});f.runs[0].finish({status:'completed',nativeSessionId:'claude-session'});await tick();const record=new ConversationStore(f.dir).get('thread-1');assert.equal(record.turns[0].turn.id,turn.id);assert.equal(record.turns[0].turn.status,'completed');assert.equal(record.turns[0].turn.items[1].text,'answer');assert.equal(record.activeRun,null);assert.ok(f.events.some(e=>e.method==='turn/completed'));});
test('mixed history survives read, resume, pagination and switching context both ways',async t=>{const f=fixture(t);await start(f);f.thread.turns=[{id:'old-codex',status:'completed',items:[{id:'a',type:'agentMessage',text:'codeword violet'}]}];await f.router.request('engine/mode/set',{threadId:'thread-1',engineMode:'claude'});const {turn}=await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'remember amber'}]});await tick();assert.match(f.runs[0].options.prompt,/violet/);f.runs[0].options.onEvent({type:'message-completed',id:'b',text:'amber stored'});f.runs[0].finish({status:'completed',nativeSessionId:'cc'});await tick();for(const method of ['thread/read','thread/resume']){const result=await f.router.request(method,{threadId:'thread-1',includeTurns:true});assert.deepEqual(result.thread.turns.map(x=>x.id),['old-codex',turn.id]);}const p1=await f.router.request('thread/turns/list',{threadId:'thread-1',limit:1,sortDirection:'asc'});const p2=await f.router.request('thread/turns/list',{threadId:'thread-1',limit:1,sortDirection:'asc',cursor:p1.nextCursor});assert.equal(p2.data[0].id,turn.id);const reverse=await f.router.request('thread/turns/list',{threadId:'thread-1',sortDirection:'desc',cursor:p2.backwardsCursor});assert.equal(reverse.data[0].id,turn.id);const items=await f.router.request('thread/items/list',{threadId:'thread-1',turnId:turn.id});assert.equal(items.data[1].item.text,'amber stored');await f.router.request('engine/mode/set',{threadId:'thread-1',engineMode:'codex'});await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'continue'}]});assert.equal(f.runs.length,1);assert.match(f.calls.find(c=>c.method==='turn/start').params.input[0].text,/amber stored/);});
test('Claude rejects unsupported attachment without creating active run',async t=>{const f=fixture(t);await start(f,'claude');await assert.rejects(()=>f.router.request('turn/start',{threadId:'thread-1',input:[{type:'image',url:'x'}]}),/Unsupported/);assert.equal(f.store.get('thread-1').activeRun,null);assert.equal(f.runs.length,0);});
test('interrupt is bound to the exact turn; pending permissions fail closed',async t=>{const f=fixture(t);await start(f,'claude');const {turn}=await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'run'}]});await tick();const permission=f.runs[0].options.onPermission({name:'Bash',input:{command:'touch sample'},id:'tool-1',signal:new AbortController().signal});await tick();const ask=f.events.find(e=>e.id&&e.method?.includes('requestApproval'));assert.ok(ask);await assert.rejects(()=>f.router.request('turn/interrupt',{threadId:'thread-1',turnId:'wrong'}),/ownership/);await f.router.request('turn/interrupt',{threadId:'thread-1',turnId:turn.id});assert.equal((await permission).decision,'decline');assert.equal(f.router.respond({id:ask.id,result:{decision:'accept'}}),false);assert.equal(f.store.get('thread-1').activeRun,null);});
test('approval answer authorizes only its pending request',async t=>{const f=fixture(t);await start(f,'claude');await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'run'}]});await tick();const options={name:'Bash',input:{command:'echo ok'},id:'tool-1',signal:new AbortController().signal};const pending=f.runs[0].options.onPermission(options);await tick();const ask=f.events.find(e=>e.id&&e.method?.includes('requestApproval'));assert.equal(f.router.respond({id:'unrelated',result:{decision:'accept'}}),false);assert.equal(f.router.respond({id:ask.id,result:{decision:'accept'}}),true);assert.deepEqual(await pending,{decision:'accept',updatedInput:options.input});});
test('prewarmed empty native shells can switch and Claude materializes without inference',async t=>{const f=fixture(t);await start(f);const original=f.router.native.request.bind(f.router.native);f.router.native.request=async(method,params)=>{if(method==='thread/read'&&params.includeTurns)throw Error('list_turns is not supported yet');if(method==='thread/read'){const r=await original(method,params);r.thread.historyMode='paginated';return r;}if(method==='thread/turns/list')throw Error('thread is not materialized yet; unavailable before first user message');return original(method,params);};await f.router.request('engine/mode/set',{threadId:'thread-1',engineMode:'claude'});await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'hello'}]});await tick();assert.equal(f.calls.filter(c=>c.method==='thread/inject_items').length,1);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);});
test('late native start response cannot resurrect a completed turn or leak injected context',async t=>{const f=fixture(t);await start(f);const original=f.router.native.request.bind(f.router.native);f.router.native.request=async(method,params)=>{if(method!=='turn/start')return original(method,params);const turn={id:'race',status:'inProgress',items:[{id:'user',type:'userMessage',content:params.input}]};f.router.nativeNotification({method:'turn/started',params:{threadId:'thread-1',turn}});f.router.nativeNotification({method:'turn/completed',params:{threadId:'thread-1',turn:{...turn,status:'completed'}}});return {turn};};await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'original prompt'}]});assert.equal(f.store.get('thread-1').turns[0].turn.status,'completed');assert.equal(f.store.get('thread-1').activeRun,null);});
test('native rollback removes discarded turns from the unified store and delete removes sidecar data',async t=>{const f=fixture(t);await start(f);f.thread.turns=[{id:'keep',items:[],status:'completed'},{id:'discard',items:[],status:'completed'}];await f.router.request('thread/read',{threadId:'thread-1',includeTurns:true});const original=f.router.native.request.bind(f.router.native);f.router.native.request=async(method,params)=>{if(method==='thread/rollback'){f.thread.turns=f.thread.turns.slice(0,1);return {thread:structuredClone(f.thread)};}return original(method,params);};await f.router.request('thread/rollback',{threadId:'thread-1',numTurns:1});const read=await f.router.request('thread/read',{threadId:'thread-1',includeTurns:true});assert.deepEqual(read.thread.turns.map(t=>t.id),['keep']);await f.router.request('thread/delete',{threadId:'thread-1'});assert.equal(f.store.get('thread-1'),null);assert.equal(new ConversationStore(f.dir).get('thread-1'),null);});
test('Codex steering keeps its distinct follow-up user message',async t=>{const f=fixture(t);await start(f);await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'first'}]});f.router.nativeNotification({method:'item/started',params:{threadId:'thread-1',turnId:'native-turn',item:{id:'second-user',type:'userMessage',content:[{type:'text',text:'second'}]}}});const stored=f.store.get('thread-1').turns[0].turn.items;assert.equal(stored.at(-1).content[0].text,'second');});
test('native rename survives sidebar refresh and Claude delete is blocked while active',async t=>{const f=fixture(t);await start(f,'claude');f.router.nativeNotification({method:'thread/name/updated',params:{threadId:'thread-1',threadName:'New name'}});const original=f.router.native.request.bind(f.router.native);f.router.native.request=async(method,params)=>method==='thread/list'?{data:[{...f.thread,name:'New name'}]}:original(method,params);assert.equal((await f.router.request('thread/list',{})).data[0].name,'New name');await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'working'}]});await tick();await assert.rejects(()=>f.router.request('thread/delete',{threadId:'thread-1'}),/active/);assert.ok(f.store.get('thread-1'));});
test('untouched Codex threads keep native cwd override semantics',async t=>{const f=fixture(t);await start(f);await f.router.request('turn/start',{threadId:'thread-1',cwd:tmpdir(),input:[{type:'text',text:'hello'}]});assert.equal(f.calls.find(c=>c.method==='turn/start').params.cwd,tmpdir());});
test('interrupted Claude output acknowledges history before native resume',async t=>{const f=fixture(t);await start(f);f.thread.turns=[{id:'old',status:'completed',items:[{id:'a',type:'agentMessage',text:'old codeword'}]}];await f.router.request('engine/mode/set',{threadId:'thread-1',engineMode:'claude'});const {turn}=await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'hello'}]});await tick();f.runs[0].options.onEvent({type:'session',sessionId:'cc'});f.runs[0].options.onEvent({type:'input-acknowledged'});f.runs[0].options.onEvent({type:'message-completed',id:'text-1',text:'received old codeword'});await f.router.request('turn/interrupt',{threadId:'thread-1',turnId:turn.id});await f.router.request('turn/start',{threadId:'thread-1',input:[{type:'text',text:'continue'}]});await tick();assert.equal(f.runs[1].options.prompt,'continue');});

test('a submission awaiting hydration cannot launch an engine after shutdown', async t => {
  const f = fixture(t); await start(f);
  const original = f.router.native.request.bind(f.router.native);
  let release;
  f.router.native.request = (method, params) => method === 'thread/read'
    ? new Promise(resolve => { release = () => resolve({ thread: structuredClone(f.thread) }); })
    : original(method, params);
  const pending = f.router.request('turn/start', { threadId: 'thread-1', engineMode: 'claude', input: [{ type: 'text', text: 'late request' }] });
  await tick(); assert.ok(release);
  await f.router.close(); release();
  await assert.rejects(pending, /shutting down/);
  await tick();
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.get('thread-1').activeRun, null);
});

for (const update of ['completion', 'delta']) {
  test(`delayed hydration preserves newer native ${update}`, async t => {
    const f = fixture(t); await start(f);
    await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'hello' }] });
    const oldTurn = f.store.get('thread-1').turns[0].turn;
    oldTurn.items.push({ id: 'answer', type: 'agentMessage', text: 'partial' });
    f.router.nativeNotification({ method: 'item/started', params: { threadId: 'thread-1', turnId: oldTurn.id, item: oldTurn.items.at(-1) } });
    let release;
    f.router.native.request = () => new Promise(resolve => { release = () => resolve({ thread: { ...f.thread, turns: [structuredClone(oldTurn)] } }); });
    const pending = f.router.hydrate('thread-1');
    if (update === 'completion') {
      f.router.nativeNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...oldTurn, status: 'completed', items: [...oldTurn.items.slice(0, -1), { ...oldTurn.items.at(-1), text: 'final answer' }] } } });
    } else f.router.nativeNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: oldTurn.id, itemId: 'answer', delta: ' plus new delta' } });
    release(); await pending;
    const saved = f.store.get('thread-1').turns[0].turn;
    assert.equal(saved.status, update === 'completion' ? 'completed' : 'inProgress');
    assert.equal(saved.items.at(-1).text, update === 'completion' ? 'final answer' : 'partial plus new delta');
  });
}

for (const status of ['interrupted', 'failed']) {
  test(`acknowledged ${status} Codex input is not reinjected into its own session`, async t => {
    const f = fixture(t); await start(f);
    const { turn } = await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'FIRST REQUEST' }] });
    f.router.nativeNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...turn, status, items: [...turn.items, { id: 'partial', type: 'agentMessage', text: 'PARTIAL ANSWER' }] } } });
    assert.equal(f.store.get('thread-1').bindings.codex.consumedSeq, 1);
    await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'continue' }] });
    assert.deepEqual(f.calls.filter(call => call.method === 'turn/start').at(-1).params.input, [{ type: 'text', text: 'continue' }]);
  });
}

test('a failed native turn without input acknowledgement does not consume context', async t => {
  const f = fixture(t); await start(f);
  const original = f.router.native.request.bind(f.router.native);
  f.router.native.request = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    const turn = { id: 'unaccepted', status: 'failed', items: [] };
    f.router.nativeNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
    return { turn };
  };
  await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'unaccepted input' }] });
  assert.equal(f.store.get('thread-1').bindings.codex.consumedSeq, 0);
  assert.equal(f.store.get('thread-1').activeRun, null);
});

test('a stale start response preserves user and assistant items already streamed', async t => {
  const f = fixture(t); await start(f);
  const original = f.router.native.request.bind(f.router.native);
  f.router.native.request = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    const turn = { id: 'streaming', status: 'inProgress', items: [] };
    f.router.nativeNotification({ method: 'turn/started', params: { threadId: 'thread-1', turn } });
    f.router.nativeNotification({ method: 'item/started', params: { threadId: 'thread-1', turnId: turn.id, item: { id: 'user', type: 'userMessage', content: params.input } } });
    f.router.nativeNotification({ method: 'item/started', params: { threadId: 'thread-1', turnId: turn.id, item: { id: 'assistant', type: 'agentMessage', text: '' } } });
    f.router.nativeNotification({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: turn.id, itemId: 'assistant', delta: 'NEWER PARTIAL' } });
    return { turn };
  };
  const result = await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'prompt' }] });
  for (const turn of [result.turn, f.store.get('thread-1').turns[0].turn]) {
    assert.equal(turn.items[0].content[0].text, 'prompt');
    assert.equal(turn.items[1].text, 'NEWER PARTIAL');
  }
});

test('a failed unacknowledged Codex start keeps Claude history for retry', async t => {
  const f = fixture(t); await start(f);
  f.store.putTurn('thread-1', { id: 'claude-fact', status: 'completed', items: [{ id: 'fact', type: 'agentMessage', text: 'IMPORTANT CLAUDE FACT' }] }, { engine: 'claude' });
  const original = f.router.native.request.bind(f.router.native);
  let attempts = 0;
  f.router.native.request = async (method, params) => {
    if (method !== 'turn/start' || attempts++ > 0) return original(method, params);
    const turn = { id: 'unaccepted', status: 'failed', items: [] };
    f.router.nativeNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
    return { turn };
  };
  await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'first attempt' }] });
  assert.equal(f.store.get('thread-1').bindings.codex.consumedSeq, 0);
  await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'retry' }] });
  assert.match(f.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text, /IMPORTANT CLAUDE FACT/);
});

test('cancelling a pending Claude permission resolves the exact frontend request once', async t => {
  const f = fixture(t); await start(f, 'claude');
  const { turn } = await f.router.request('turn/start', { threadId: 'thread-1', input: [{ type: 'text', text: 'request a tool' }] });
  await tick();
  const pending = f.runs[0].options.onPermission({ name: 'Bash', input: { command: 'echo fixture' }, id: 'tool-permission', signal: new AbortController().signal });
  const request = f.events.find(event => event.method === 'item/commandExecution/requestApproval');
  await f.router.request('turn/interrupt', { threadId: 'thread-1', turnId: turn.id });
  assert.equal((await pending).decision, 'decline');
  assert.deepEqual(f.events.filter(event => event.method === 'serverRequest/resolved').map(event => event.params), [{ threadId: 'thread-1', requestId: request.id }]);
  assert.equal(f.router.respond({ id: request.id, result: { decision: 'accept' } }), false);
});
