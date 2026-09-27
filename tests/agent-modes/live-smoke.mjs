// Explicit opt-in integration test using the user's configured engines, disposable
// workspace and conversation. Never reads or modifies an existing chat.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
mkdirSync(join(root, '.artifacts', 'live'), { recursive: true });
const runDir = mkdtempSync(join(root, '.artifacts', 'live', 'smoke-'));
const workspace = join(runDir, 'workspace'); mkdirSync(workspace);
writeFileSync(join(workspace, 'fixture.txt'), 'The file marker is AMBER-315.\n');
const includeClaude = process.argv.includes('--claude');
const events = [], completions = new Map(), waiters = new Map();
let client;
function connect() {
  return new NativeClient({ command: process.execPath, args: [join(root, 'runtime', 'agent-modes', 'gateway.mjs'), 'app-server'],
    env: { ...process.env, CDX_REAL_CODEX: '/Applications/chatgpt-dev.app/Contents/Resources/codex', CDX_ENGINE_STORE: join(runDir, 'store') },
    onNotification(message) { events.push(message); if (message.method === 'turn/completed') { const turn=message.params.turn; completions.set(turn.id,turn);waiters.get(turn.id)?.(turn); } },
    onRequest(message) { client.respond({ id: message.id, result: message.method.includes('requestUserInput') ? { answers: { permission: { answers: ['Deny'] } } } : { decision: 'decline' } }); },
  });
}
async function initialize() { await client.request('initialize', { clientInfo: { name: 'engine-mode-smoke', version: '1' }, capabilities: { experimentalApi: true } }); client.notify({ method: 'initialized' }); }
async function turn(threadId, prompt) {
  const {turn} = await client.request('turn/start', {threadId, input:[{type:'text',text:prompt}], effort:'low'});
  let timer;
  const completed = await Promise.race([completions.has(turn.id) ? completions.get(turn.id) : new Promise(resolve=>waiters.set(turn.id,resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Live turn timed out')),90000);})]).finally(()=>clearTimeout(timer));
  assert.equal(completed.status,'completed',JSON.stringify(completed.error));
  return completed.items.filter(item=>item.type==='agentMessage').map(item=>item.text).join('\n');
}
let threadId;
try {
  client=connect();await initialize();
  const started=await client.request('thread/start',{cwd:workspace,engineMode:'codex'});threadId=started.thread.id;
  const first=await turn(threadId,'Remember this conversation codeword: VIOLET-742. Reply briefly with the codeword. Do not use tools.');assert.match(first,/VIOLET-742/i);console.log('Codex round trip: PASS');
  if(includeClaude){
    await client.request('engine/mode/set',{threadId,engineMode:'claude',engineModel:'haiku'});
    const second=await turn(threadId,'What conversation codeword did we agree on? Read fixture.txt and include its marker. Also remember I chose CERULEAN-826 for the next step.');assert.match(second,/VIOLET-742/i);assert.match(second,/AMBER-315/i);console.log('Codex → Claude context and file: PASS');
    await client.request('engine/mode/set',{threadId,engineMode:'codex'});
    const third=await turn(threadId,'What marker did I choose for the next step in my previous message? Reply with it only, without tools.');assert.match(third,/CERULEAN-826/i);console.log('Claude → Codex context: PASS');
  }
  const before=await client.request('thread/read',{threadId,includeTurns:true});
  await client.close();client=connect();await initialize();
  const after=await client.request('thread/resume',{threadId,excludeTurns:false});
  assert.deepEqual(after.thread.turns.map(x=>x.id),before.thread.turns.map(x=>x.id));console.log('Gateway restart history: PASS');
  const items=await client.request('thread/items/list',{threadId,sortDirection:'asc',limit:500});assert.ok(items.data.length>=2);console.log('History pagination: PASS');
  writeFileSync(join(runDir,'report.json'),JSON.stringify({threadId,includeClaude,turns:after.thread.turns.map(t=>({id:t.id,engine:t.cdxEngineSource,status:t.status})),passed:true},null,2));
  console.log(`Evidence: ${runDir}`);
} finally {
  if(client){if(threadId)try{await client.request('thread/archive',{threadId});}catch{}await client.close();}
  writeFileSync(join(runDir,'events.json'),JSON.stringify(events,null,2));
}
