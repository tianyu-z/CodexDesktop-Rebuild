import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const gateway = fileURLToPath(new URL('../../runtime/agent-modes/gateway.mjs', import.meta.url));
async function fixture(t,args=['app-server'],nativeLogic='') {
 const dir=mkdtempSync(join(tmpdir(),'engine-gateway-'));const executable=join(dir,'fake-codex');
 writeFileSync(executable,`#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0)}\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);${nativeLogic}if(m.method==='approval'){console.log(JSON.stringify({id:m.id,method:'approval/native',params:{}}));return;}if(m.id!==undefined)console.log(JSON.stringify({id:m.id,result:m.method?{echo:m.params,method:m.method}:m.result}));});\n`,{mode:0o700});
 const child=spawn(process.execPath,[gateway,...args],{env:{...process.env,CDX_REAL_CODEX:executable,CDX_ENGINE_STORE:join(dir,'store')},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const lines=[],waiting=[];createInterface({input:child.stdout}).on('line',line=>{const next=waiting.shift();if(next)next(line);else lines.push(line);});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,stderr})));
 t.after(async()=>{child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),4000);await closed;clearTimeout(timer);rmSync(dir,{recursive:true,force:true});});
 return {send:m=>child.stdin.write(JSON.stringify(m)+'\n'),next:()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>{waiting.push(resolve);closed.then(result=>reject(new Error(result.stderr||'Gateway closed without response')));}),child,closed};
}
test('ordinary CLI commands are delegated',async t=>{const f=await fixture(t,['--version']);assert.equal(await f.next(),'codex-cli 0.153.4');assert.equal((await f.closed).code,0);});
test('parallel native requests retain original client ids and payloads',async t=>{const f=await fixture(t);f.send({id:1,method:'initialize',params:{clientInfo:{name:'fixture',version:'1'}}});f.send({id:'upstream:1',method:'config/read',params:{includeLayers:true}});const results=[JSON.parse(await f.next()),JSON.parse(await f.next())];assert.deepEqual(new Set(results.map(r=>r.id)),new Set([1,'upstream:1']));assert.equal(results.find(r=>r.id===1).result.echo.clientInfo.name,'fixture');});
test('server initiated request ids are remapped without stealing client responses',async t=>{const f=await fixture(t);f.send({id:1,method:'approval',params:{}});const approval=JSON.parse(await f.next());assert.notEqual(approval.id,1);assert.equal(approval.method,'approval/native');f.send({id:approval.id,result:{decision:'decline'}});const result=JSON.parse(await f.next());assert.equal(result.id,1);assert.equal(result.result.decision,'decline');});


test('shutdown closes native transport while Claude materialization is pending', async t => {
  const f = await fixture(t, ['app-server'], `
    if (m.method === 'thread/start') {
      console.log(JSON.stringify({id:m.id,result:{thread:{id:'pending-thread',cwd:m.params.cwd,turns:[],status:{type:'idle'}},model:'codex'}})); return;
    }
    if (m.method === 'thread/inject_items') {
      console.log(JSON.stringify({method:'fixture/materialization-pending',params:{}})); return;
    }
  `);
  f.send({ id: 1, method: 'thread/start', params: { cwd: tmpdir(), engineMode: 'claude' } });
  assert.ok(JSON.parse(await f.next()).result);
  f.send({ id: 2, method: 'turn/start', params: { threadId: 'pending-thread', input: [{ type: 'text', text: 'hello' }] } });
  while (JSON.parse(await f.next()).method !== 'fixture/materialization-pending') {}
  f.child.stdin.end();
  let timer;
  try {
    const result = await Promise.race([f.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gateway deadlocked during materialization shutdown')), 1800); })]);
    assert.equal(result.code, 0, result.stderr);
  } finally { clearTimeout(timer); }
});
