import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';
test('native shutdown is bounded after direct child exit with inherited pipes',async()=>{
 let pid,resolveReady;const ready=new Promise(r=>resolveReady=r);
 const script=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});c.unref();console.log(JSON.stringify({method:'fixture',params:{pid:c.pid}}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
 const client=new NativeClient({command:process.execPath,args:['-e',script],env:process.env,onNotification:m=>{pid=m.params.pid;resolveReady();},onRequest:()=>{}});
 let timer;try{await ready;await Promise.race([client.close(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('shutdown waited for descendant pipes')),1200))]);assert.equal(client.child.exitCode,0);assert.doesNotThrow(()=>process.kill(pid,0));}finally{clearTimeout(timer);if(pid)try{process.kill(pid,'SIGTERM');}catch{}await client.close();}
});

for (const resolveBeforeReply of [true, false]) {
  test(`native request resolution keeps its remapped id ${resolveBeforeReply ? 'before' : 'after'} a client reply`, async t => {
    let requested, resolveNotification;
    const notification = new Promise(resolve => { resolveNotification = resolve; });
    const script = `
      const send=value=>console.log(JSON.stringify(value));
      const resolved=()=>send({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:11}});
      const input=require('node:readline').createInterface({input:process.stdin});
      input.on('line',line=>{const message=JSON.parse(line);if(message.id===11)resolved();});
      send({id:11,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1'}});
      ${resolveBeforeReply ? 'resolved();' : ''}
    `;
    const client = new NativeClient({ command: process.execPath, args: ['-e', script], env: process.env,
      onRequest: message => { requested = message; if (!resolveBeforeReply) client.respond({ id: message.id, result: { decision: 'decline' } }); },
      onNotification: resolveNotification });
    t.after(() => client.close());
    const resolved = await notification;
    assert.notEqual(requested.id, 11);
    assert.equal(resolved.params.requestId, requested.id);
    assert.equal(client.respond({ id: requested.id, result: { decision: 'accept' } }), false);
  });
}
