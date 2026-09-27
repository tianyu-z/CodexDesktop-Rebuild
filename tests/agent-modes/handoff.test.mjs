import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff, inputText } from '../../runtime/agent-modes/handoff.mjs';

const record = (seq, engine, items) => ({ seq, engine, turn: { id: `t${seq}`, status: 'completed', items } });
const conversation = () => ({ id: 'chat', cwd: '/tmp/shared-project', bindings: {
  codex: { sessionId: 'codex-session', consumedSeq: 1 }, claude: { sessionId: null, consumedSeq: 0 },
}, turns: [
  record(1, 'codex', [{ type: 'userMessage', content: [{ type: 'text', text: 'The release code is maple-42.' }] },
    { type: 'agentMessage', text: 'I will remember maple-42.' }]),
  record(2, 'claude', [{ type: 'agentMessage', text: 'I changed src/app.js.' },
    { type: 'fileChange', changes: [{ path: '/tmp/shared-project/src/app.js', diff: '+ready' }] }]),
] });

test('first handoff has public messages and workspace but no private reasoning', () => {
  const c = conversation(); c.turns[0].turn.items.push({ type: 'reasoning', content: ['private-reasoning'] });
  const h = buildHandoff(c, 'claude');
  assert.match(h.text, /maple-42/); assert.match(h.text, /shared-project/);
  assert.doesNotMatch(h.text, /private-reasoning/);
  assert.match(h.text, /historical|history/i);
  assert.equal(h.throughSeq, 2);
  assert.equal(c.bindings.claude.consumedSeq, 0);
});

test('return to an existing engine transfers only unseen turns', () => {
  const h = buildHandoff(conversation(), 'codex');
  assert.doesNotMatch(h.text, /maple-42/);
  assert.match(h.text, /src\/app.js/);
  assert.match(h.text, /\+ready/);
  assert.equal(h.throughSeq, 2);
});

test('handoff bounded context explicitly links the preserved full history', () => {
  const c = conversation(); c.turns[0].turn.items[1].text = 'long history '.repeat(2000);
  const h = buildHandoff(c, 'claude', { maxChars: 1000, historyPath: '/tmp/history.md' });
  assert.ok(h.text.length <= 1300);
  assert.match(h.text, /truncat|omitted|bounded/i); assert.match(h.text, /\/tmp\/history.md/);
  assert.equal(h.throughSeq, 2);
});

test('already consumed history is not injected a second time', () => {
  const c = conversation(); c.bindings.codex.consumedSeq = 2;
  const h = buildHandoff(c, 'codex');
  assert.equal(h.text, ''); assert.equal(h.throughSeq, 2);
});

test('unsupported input types fail visibly instead of losing attachments', () => {
  assert.equal(inputText([{ type: 'text', text: 'hello' }]), 'hello');
  assert.throws(() => inputText([{ type: 'image', url: 'data:image/png;base64,abc' }]), /unsupported|attachment/i);
});

test('public handoff preserves image references, web results and completed collaborator output', () => {
  const value={cwd:'/repo',bindings:{claude:{consumedSeq:0}},turns:[{seq:1,engine:'codex',turn:{status:'completed',items:[
    {type:'userMessage',content:[{type:'text',text:'inspect'},{type:'localImage',path:'/repo/diagram.png'}]},
    {type:'webSearch',query:'answer',results:[{url:'https://example.com',title:'evidence'}]},
    {type:'collabAgentToolCall',tool:'wait',status:'completed',agentsStates:{child:{status:'completed',message:'public conclusion'}}},
  ]}}]};
  const text=buildHandoff(value,'claude').text;
  assert.match(text,/diagram.png/);assert.match(text,/pixels.*not transferred/);assert.match(text,/https:\/\/example.com/);assert.match(text,/public conclusion/);
});
