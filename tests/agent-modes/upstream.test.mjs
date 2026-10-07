import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';

test('native timeouts drop repeated stalled mutations without replay and ignore late replies', { timeout: 5000 }, async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const script = `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    let starts = 0;
    const stalledIds = [];
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'turn/start') {
        starts++; stalledIds.push(message.id);
      } else if (message.method === 'fixture/release') {
        for (const id of stalledIds) console.log(JSON.stringify({ id, result: { turn: 'late' } }));
        console.log(JSON.stringify({ id: message.id, result: { released: true } }));
      } else if (message.method === 'fixture/count') {
        console.log(JSON.stringify({ id: message.id, result: starts }));
      } else {
        console.log(JSON.stringify({ id: message.id, result: { ok: true } }));
      }
    });
    console.log(JSON.stringify({ method: 'fixture/ready' }));
  `;
  const client = new NativeClient({ command: process.execPath, args: ['-e', script], env: process.env,
    requestTimeoutMs: 50, onNotification: () => ready(), onRequest: () => {} });
  t.after(() => client.close());
  await started;
  for (let attempt = 0; attempt < 3; attempt++) {
    let timer;
    try {
      await assert.rejects(Promise.race([
        client.request('turn/start', {}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('native request did not time out')), 350); }),
      ]), error => /native backend failed to respond/i.test(error.message) && !/cancel|did not occur/i.test(error.message));
    } finally { clearTimeout(timer); }
    assert.equal(client.pending.size, 0);
  }
  assert.deepEqual(await client.request('fixture/release', {}), { released: true });
  assert.equal(client.pending.size, 0);
  assert.equal(await client.request('fixture/count', {}), 3);
  assert.deepEqual(await client.request('fixture/healthy', {}), { ok: true });
  assert.equal(client.pending.size, 0);
});

test('native shutdown rejects a pending request and removes its timeout', { timeout: 5000 }, async () => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const script = `
    require('node:readline').createInterface({ input: process.stdin }).on('line', () => {});
    process.stdin.on('end', () => process.exit(0));
    console.log(JSON.stringify({ method: 'fixture/ready' }));
  `;
  const client = new NativeClient({ command: process.execPath, args: ['-e', script], env: process.env,
    requestTimeoutMs: 1000, onNotification: () => ready(), onRequest: () => {} });
  await started;
  const request = client.request('turn/start', {});
  const rejected = assert.rejects(request, /Native Codex is shutting down/);
  await client.close();
  await rejected;
  assert.equal(client.pending.size, 0);
});
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
