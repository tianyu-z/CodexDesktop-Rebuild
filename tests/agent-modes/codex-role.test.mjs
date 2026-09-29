import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { CodexRole } from '../../runtime/agent-modes/orchestration/codex-role.mjs';
import { NativeClient } from '../../runtime/agent-modes/upstream.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const capturedImage = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } });
function fixture({ replies = {}, options = {} } = {}) {
  const requests = [], notifications = [], responses = [], events = [];
  let callbacks, closes = 0;
  const client = {
    request: async (method, params) => { requests.push({ method, params }); if (replies[method]) return await replies[method](params); if (method === 'config/read') return { config: { mcp_servers: { filesystem: {}, 'server.with.dot': {} } } }; if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'session-1' }, model: 'native-resolved', sandbox: { type: 'readOnly' } }; if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }; return {}; },
    notify: message => notifications.push(message), respond: message => { responses.push(message); return true; }, close: async () => { closes++; },
  };
  const role = new CodexRole({ nativeClientFactory: config => { callbacks = config; return client; } });
  const run = role.start({ runId: 'run-1', cwd: '/workspace', prompt: 'Review it', access: 'write', onEvent: event => events.push(event), ...options });
  return { run, requests, notifications, responses, events, client, get callbacks() { return callbacks; }, get closes() { return closes; },
    emit: (method, params = {}) => callbacks.onNotification({ method, params: { threadId: 'session-1', turnId: 'turn-1', ...params } }),
    complete: (extra = {}) => callbacks.onNotification({ method: 'turn/completed', params: { threadId: 'session-1', turn: { id: 'turn-1', status: 'completed', items: [], ...extra } } }),
  };
}

test('native roles initialize a durable thread then pass the exact model and allowlisted options', async () => {
  const schema = { type: 'object' };
  const f = fixture({ options: { model: 'custom/provider-model', instructions: 'Review carefully.', outputSchema: schema, nativeOptions: { modelProvider: 'custom', effort: 'high', serviceTier: 'priority', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/source'] }, runtimeWorkspaceRoots: ['/source'], cwd: '/source', env: { API_KEY: 'must-not-copy' }, model: 'wrong-model', collaborationMode: { settings: { model: 'wrong-model' } } } } });
  await tick();
  assert.equal(f.callbacks.command, '/Applications/chatgpt-dev.app/Contents/Resources/codex');
  assert.deepEqual(f.callbacks.args, ['app-server']);
  assert.equal(f.requests[0].method, 'initialize');
  assert.equal(f.notifications[0].method, 'initialized');
  const start = f.requests.find(r => r.method === 'thread/start').params;
  assert.equal(start.model, 'custom/provider-model');
  assert.equal(start.modelProvider, 'custom');
  assert.equal(start.developerInstructions, 'Review carefully.');
  assert.equal(start.ephemeral, false);
  assert.equal(start.allowProviderModelFallback, false);
  assert.equal(start.cwd, '/workspace');
  assert.deepEqual(start.runtimeWorkspaceRoots, ['/workspace']);
  const turn = f.requests.find(r => r.method === 'turn/start').params;
  assert.equal(turn.model, start.model);
  assert.equal(turn.effort, 'high');
  assert.equal(turn.serviceTier, 'priority');
  assert.deepEqual(turn.outputSchema, schema);
  assert.deepEqual(turn.sandboxPolicy.writableRoots, ['/workspace']);
  assert.equal(turn.collaborationMode, undefined);
  assert.equal(start.env, undefined);
  assert.deepEqual(f.events.find(e => e.type === 'session'), { type: 'session', sessionId: 'session-1' });
  f.complete({ items: [{ id: 'output', type: 'agentMessage', text: '{}' }] });
  const result = await f.run.done;
  assert.equal(result.actualModel, 'native-resolved');
  assert.equal(result.status, 'completed');
  assert.equal(f.closes, 1);
});

test('Codex roles and live steering receive captured image bytes without reopening local paths', async () => {
  const inputContent = [capturedImage()], f = fixture({ options: { inputContent } });
  inputContent[0].source.data = 'changed caller array';
  await tick();
  try {
    const input = f.requests.find(request => request.method === 'turn/start').params.input;
    assert.deepEqual(input, [{ type: 'text', text: 'Review it', text_elements: [] }, { type: 'image', url: `data:image/png;base64,${capturedImage().source.data}` }]);
    await f.run.steer([capturedImage()]);
    assert.deepEqual(f.requests.at(-1).params.input, [{ type: 'image', url: `data:image/png;base64,${capturedImage().source.data}` }]);
  } finally { await f.run.interrupt(); }
});

test('read roles disable resolved MCP servers and delegation before using the native read-only sandbox', async () => {
  const f = fixture({ options: { access: 'read', nativeOptions: { sandbox: 'danger-full-access', permissions: 'unrestricted', approvalPolicy: 'never', approvalsReviewer: 'auto_review' } } });
  await tick();
  assert.deepEqual(f.requests.find(r => r.method === 'config/read').params, { cwd: '/workspace', includeLayers: true });
  const params = f.requests.find(r => r.method === 'thread/start').params;
  assert.equal(params.sandbox, 'read-only');
  assert.equal(params.permissions, undefined);
  assert.equal(params.approvalsReviewer, 'user');
  assert.equal(params.config['features.multi_agent'], false);
  assert.equal(params.config['mcp_servers.filesystem.enabled'], false);
  assert.equal(params.config['mcp_servers."server.with.dot".enabled'], false);
  assert.deepEqual(f.requests.find(r => r.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  f.complete(); await f.run.done;
});

test('resume uses the supplied durable session without importing native history or changing engines', async () => {
  const f = fixture({ options: { nativeSessionId: 'session-1' } });
  await tick();
  assert.equal(f.requests.some(r => r.method === 'thread/start'), false);
  const resume = f.requests.find(r => r.method === 'thread/resume').params;
  assert.equal(resume.threadId, 'session-1');
  assert.equal(resume.history, undefined);
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.model, undefined);
  f.complete(); await f.run.done;
});

test('public native items are retained and scoped without reasoning or duplicate text', async () => {
  const f = fixture({ options: { outputSchema: { type: 'object' } } });
  await tick();
  const command = { id: 'same', type: 'commandExecution', command: 'rg foo', cwd: '/workspace', commandActions: [], status: 'inProgress', aggregatedOutput: null };
  f.emit('item/started', { item: { id: 'secret', type: 'reasoning', summary: ['private'], content: ['private'] } });
  f.emit('item/reasoning/textDelta', { itemId: 'secret', delta: 'private' });
  f.emit('item/started', { item: command });
  f.emit('item/completed', { item: { ...command, status: 'completed', aggregatedOutput: 'found' } });
  f.emit('item/started', { item: { id: 'answer', type: 'agentMessage', text: '', phase: 'final_answer' } });
  f.emit('item/agentMessage/delta', { itemId: 'answer', delta: '{"ok":' });
  f.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: '{"ok":true}', phase: 'final_answer' } });
  f.emit('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 20 } } });
  f.complete();
  const result = await f.run.done;
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.structuredOutput, { ok: true });
  assert.equal(result.usage.total.totalTokens, 20);
  assert.equal(JSON.stringify(f.events).includes('private'), false);
  assert.equal(f.events.filter(e => e.type === 'text-delta').map(e => e.delta).join(''), result.text);
  const tool = f.events.find(e => e.type === 'tool-start');
  assert.equal(tool.id, 'run-1:same');
  assert.deepEqual(tool.nativeItem, command);
});

for (const type of ['commandExecution', 'fileChange']) {
  test(`declined native ${type} remains unsuccessful in shared tool events`, async () => {
    const f = fixture();
    await tick();
    const item = type === 'commandExecution'
      ? { id: 'denied', type, command: 'touch blocked', cwd: '/workspace', status: 'declined', aggregatedOutput: null, exitCode: null }
      : { id: 'denied', type, status: 'declined', changes: [{ path: '/workspace/blocked', kind: { type: 'add' }, diff: '+blocked' }] };
    f.emit('item/completed', { item });
    f.complete();
    await f.run.done;
    const event = f.events.find(event => event.type === 'tool-completed');
    assert.equal(event.isError, true);
    assert.deepEqual(event.nativeItem, item);
  });
}

test('native approval returns the exact typed native response and cancellation invalidates a pending reply', async () => {
  const pending = deferred(), received = [];
  const exact = { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } } };
  const f = fixture({ options: { onPermission: async request => { received.push(request); return received.length === 1 ? exact : pending.promise; } } });
  await tick();
  const request = { id: 'native-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'session-1', turnId: 'turn-1', itemId: 'tool', command: 'git status' } };
  f.callbacks.onRequest(request); await tick();
  assert.equal(received[0].engine, 'codex');
  assert.equal(received[0].method, request.method);
  assert.deepEqual(received[0].params, request.params);
  assert.deepEqual(f.responses[0], { id: request.id, result: exact });
  f.callbacks.onRequest({ ...request, id: 'native-2' }); await tick();
  await f.run.interrupt();
  assert.equal(received[1].signal.aborted, true);
  pending.resolve({ decision: 'accept' }); await tick();
  assert.equal(f.responses.some(r => r.id === 'native-2' && r.result?.decision === 'accept'), false);
  assert.equal((await f.run.done).status, 'interrupted');
});

test('read-role mutation and escalation requests cannot reach the user approval callback', async () => {
  let approvals = 0;
  const f = fixture({ options: { access: 'read', onPermission: async () => { approvals++; return { decision: 'accept' }; } } });
  await tick();
  for (const method of ['item/fileChange/requestApproval', 'item/commandExecution/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/call']) f.callbacks.onRequest({ id: method, method, params: { threadId: 'session-1', turnId: 'turn-1' } });
  await tick();
  assert.equal(approvals, 0);
  assert.equal(f.responses.length, 5);
  assert.deepEqual(f.responses.find(r => r.id === 'item/permissions/requestApproval').result.permissions, {});
  f.complete(); await f.run.done;
});

test('stop before launch, during initialization and before turn acknowledgment always settles and closes its client', async () => {
  const early = fixture();
  await early.run.interrupt();
  assert.equal(early.callbacks, undefined);
  for (const method of ['initialize', 'thread/start', 'turn/start']) {
    const gate = deferred();
    const signal = new AbortController();
    const f = fixture({ replies: { [method]: () => gate.promise }, options: { signal: signal.signal } });
    await tick();
    signal.abort();
    const result = await f.run.done;
    assert.equal(result.status, 'interrupted', method);
    assert.equal(f.closes, 1, method);
    gate.resolve({ thread: { id: 'late-session' }, turn: { id: 'late-turn' } });
    await tick();
    assert.equal(f.events.some(e => e.type === 'input-acknowledged'), false);
    assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  }
});

test('unexpected native exit fails the role and missing model evidence is never manufactured', async () => {
  const f = fixture({ replies: { 'thread/start': () => ({ thread: { id: 'session-1' } }) }, options: { model: 'requested-only' } });
  await tick();
  f.callbacks.onExit(3, null);
  const result = await f.run.done;
  assert.equal(result.status, 'failed');
  assert.match(result.error, /exited/);
  assert.equal(result.actualModel, undefined);
  assert.equal(f.closes, 1);
});

test('one role ignores other session and turn notifications', async () => {
  const f = fixture(); await tick();
  f.emit('item/completed', { threadId: 'unrelated', item: { id: 'no', type: 'agentMessage', text: 'foreign' } });
  f.emit('turn/completed', { turn: { id: 'other-turn', status: 'completed' } });
  await tick();
  assert.equal(f.closes, 0);
  f.complete(); await f.run.done;
  assert.equal(JSON.stringify(f.events).includes('foreign'), false);
});

test('read role fails closed when native policy differs or effective MCP config is unavailable', async () => {
  for (const replies of [
    { 'thread/start': () => ({ thread: { id: 'session-1' }, sandbox: { type: 'dangerFullAccess' } }) },
    { 'config/read': () => ({ config: { mcp_servers: [] } }) },
    { 'config/read': () => ({}) },
  ]) {
    const f = fixture({ replies, options: { access: 'read' } });
    await tick();
    const summary = await Promise.race([f.run.done, new Promise(resolve => setTimeout(() => resolve({ status: 'still-running' }), 30))]);
    if (summary.status === 'still-running') await f.run.interrupt();
    assert.equal(summary.status, 'failed');
    assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
  }
});

test('a session acknowledged during cancellation cleanup remains available for ownership filtering', async () => {
  const thread = deferred(), closing = deferred();
  const f = fixture({ replies: { 'thread/start': () => thread.promise } });
  f.client.close = async () => { await closing.promise; };
  await tick();
  const stop = f.run.interrupt();
  await tick();
  thread.resolve({ thread: { id: 'created-while-stopping' } });
  f.callbacks.onNotification({ method: 'thread/started', params: { thread: { id: 'created-while-stopping' } } });
  await tick(); closing.resolve();
  const summary = await stop;
  assert.equal(summary.nativeSessionId, 'created-while-stopping');
  assert.deepEqual(f.events.filter(e => e.type === 'session'), [{ type: 'session', sessionId: 'created-while-stopping' }]);
  assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
});

test('real native transport exchanges typed approvals and drains the owned process before completion', { timeout: 2500 }, async () => {
  let client;
  const script = `
    const send = value => console.log(JSON.stringify(value));
    const input = require('node:readline').createInterface({input: process.stdin});
    input.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') send({id: message.id, result: {}});
      if (message.method === 'thread/start') send({id: message.id, result: {thread: {id:'native-session'}, model:'native-model'}});
      if (message.method === 'turn/start') {
        send({id: message.id, result: {turn:{id:'native-turn',status:'inProgress',items:[]}}});
        send({id: 99, method:'item/commandExecution/requestApproval',params:{threadId:'native-session',turnId:'native-turn',command:'pwd'}});
      }
      if (message.id === 99) send({method:'turn/completed',params:{threadId:'native-session',turn:{id:'native-turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:JSON.stringify(message.result)}]}}});
    });
  `;
  const runner = new CodexRole({ nativeClientFactory: options => (client = new NativeClient({ ...options, command: process.execPath, args: ['-e', script] })) });
  const run = runner.start({ runId: 'real', cwd: process.cwd(), access: 'write', prompt: 'Run', onPermission: async () => ({ decision: 'decline' }) });
  const summary = await run.done;
  assert.equal(summary.status, 'completed');
  assert.equal(summary.text, '{"decision":"decline"}');
  assert.equal(client.child.exitCode, 0);
  assert.equal(client.child.stdout.destroyed, true);
});

test('a stuck native process is killed within the transport deadline and done awaits its exit', { timeout: 5000 }, async () => {
  let client;
  const ready = deferred();
  const script = `process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);console.log(JSON.stringify({method:'fixture/ready'}));`;
  const runner = new CodexRole({ nativeClientFactory: options => (client = new NativeClient({ ...options, command: process.execPath, args: ['-e', script], onNotification: message => { if (message.method === 'fixture/ready') ready.resolve(); else options.onNotification(message); } })) });
  const run = runner.start({ runId: 'stuck', cwd: process.cwd(), access: 'write', prompt: 'Run' });
  await ready.promise;
  const summary = await run.interrupt();
  assert.equal(summary.status, 'interrupted');
  assert.equal(client.child.signalCode, 'SIGKILL');
  assert.equal(client.child.stdout.destroyed, true);
});

test('steer targets the live native role turn and cannot restart a stopped role', async () => {
  const f = fixture(); await tick();
  assert.equal(typeof f.run.steer, 'function');
  await f.run.steer('New user constraint');
  assert.deepEqual(f.requests.at(-1), { method: 'turn/steer', params: { threadId: 'session-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'New user constraint', text_elements: [] }] } });
  await f.run.interrupt();
  const count = f.requests.length;
  await assert.rejects(f.run.steer('late'), /interrupt|active/i);
  assert.equal(f.requests.length, count);
});
