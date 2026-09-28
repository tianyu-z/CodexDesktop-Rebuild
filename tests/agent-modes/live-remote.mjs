// CDX_LIVE_REMOTE=1 node tests/agent-modes/live-remote.mjs rno mixed|codex|claude|polly
// Optional CDX_LIVE_PARTICIPANT_A_MODEL / CDX_LIVE_PARTICIPANT_B_MODEL,
// CDX_LIVE_HOST_ENGINE / CDX_LIVE_HOST_MODEL / CDX_LIVE_HOST_MODE,
// CDX_LIVE_ROUNDS and CDX_LIVE_CASE select independent, retained cases.
// CDX_LIVE_SANDBOX=danger-full-access explicitly tests the desktop Full access
// selection on this script's newly created, isolated acceptance fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Duplex, Transform } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { nativeLoginWrapper } from './live-remote-login.mjs';
const require = createRequire(import.meta.url);
const helper = require('../../scripts/assets/agent-modes-remote.cjs');
if (process.env.CDX_LIVE_REMOTE !== '1') throw Error('Set CDX_LIVE_REMOTE=1 to invoke real cluster models.');
const host = process.argv[2] ?? 'rno', scenario = process.argv[3] ?? 'mixed';
if (!/^[a-z0-9-]+$/.test(host) || !['mixed', 'codex', 'claude', 'polly'].includes(scenario)) throw Error('Invalid live remote scenario.');
process.resourcesPath = resolve(process.env.CDX_REMOTE_TEST_RESOURCES ?? '.artifacts/remote-check-resources');
const connection = { ssh: '/usr/bin/ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host],
  sshConnection: { alias: host }, login: nativeLoginWrapper(), env: process.env, codex: 'codex' };
const caseName = process.env.CDX_LIVE_CASE ?? scenario;
const hostMode = process.env.CDX_LIVE_HOST_MODE ?? 'per-round';
const rounds = Number(process.env.CDX_LIVE_ROUNDS ?? 1);
const sandbox = process.env.CDX_LIVE_SANDBOX ?? 'workspace-write';
if (!['workspace-write', 'danger-full-access'].includes(sandbox)) throw Error('Invalid live sandbox selection.');
const hostEngine = process.env.CDX_LIVE_HOST_ENGINE ?? (scenario === 'codex' ? 'codex' : 'claude');
if (!/^[a-z0-9-]+$/.test(caseName) || !['per-round', 'final-only'].includes(hostMode) || !['codex', 'claude'].includes(hostEngine) || !Number.isInteger(rounds) || rounds < 0 || rounds > 5) throw Error('Invalid live role configuration.');
const transport = {};
const evidence = { host, scenario, caseName, hostMode, rounds, sandbox, startedAt: new Date().toISOString(), approvals: [], stages: [] };
const stage = (name, value = {}) => { evidence.stages.push({ name, ...value }); console.log(JSON.stringify({ host, scenario, stage: name, ...value })); };

const fixtureCode = [
  'import tempfile,pathlib,secrets,json,subprocess,hashlib',
  'd=pathlib.Path(tempfile.mkdtemp(prefix="cdx-remote-acceptance-"))',
  'm="REMOTE_"+secrets.token_hex(12)',
  '(d/"marker.txt").write_text(m+"\\n")',
  ...(scenario === 'polly' ? [
    '(d/"result.txt").write_text("BEFORE\\n")',
    "check=" + JSON.stringify("import assert from \"node:assert/strict\"; import { readFileSync } from \"node:fs\"; assert.equal(readFileSync(\"result.txt\",\"utf8\"),\"REMOTE_POLLY_OK\\n\"); assert.equal(readFileSync(\"marker.txt\",\"utf8\"),\"__MARKER__\\n\"); console.log(\"REMOTE_POLLY_VERIFIED\");\n") + '.replace("__MARKER__", m)',
    '(d/"verify.mjs").write_text(check)',
    'subprocess.run(["git","init","-q",str(d)],check=True)',
    'subprocess.run(["git","-C",str(d),"add","marker.txt","result.txt","verify.mjs"],check=True)',
    'subprocess.run(["git","-C",str(d),"-c","user.name=Remote acceptance","-c","user.email=acceptance@example.invalid","-c","commit.gpgsign=false","commit","-qm","Fixture baseline"],check=True)',
  ] : []),
  'print(json.dumps({"cwd":str(d),"marker":m,"verifierHash":hashlib.sha256((d/"verify.mjs").read_bytes()).hexdigest() if (d/"verify.mjs").exists() else None}))',
].join('\n');
let fixture;
const lastJsonLine = text => JSON.parse(text.trim().split(/\r?\n/).filter(Boolean).at(-1));
const connect = async () => {
  const marker = randomBytes(24);
  const child = spawn(connection.ssh, [...connection.args, connection.login(helper.proxyCommand(transport), marker)], { env: connection.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  // Match native createSshProxyStream: discard interactive login banners until
  // the random binary payload marker, retaining only a boundary-sized buffer.
  let framed = false, boundary = Buffer.alloc(0);
  const framedOutput = new Transform({ transform(bytes, encoding, callback) {
    if (!framed) {
      const combined = Buffer.concat([boundary, bytes]), index = combined.indexOf(marker);
      if (index < 0) { boundary = combined.subarray(Math.max(0, combined.length - marker.length + 1)); callback(); return; }
      framed = true; bytes = combined.subarray(index + marker.length); boundary = Buffer.alloc(0);
    }
    callback(null, bytes);
  } });
  const stream = Duplex.from({ writable: child.stdin, readable: child.stdout.pipe(framedOutput) });
  Object.assign(stream, { setTimeout: () => stream, setNoDelay: () => stream, setKeepAlive: () => stream });
  const ws = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => stream, perMessageDeflate: false });
  const pending = new Map(); let sequence = 0;
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timed out: ' + method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (message.id != null && !message.method) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); return;
    }
    if (message.id != null && message.method) void (async () => {
      const params = message.params ?? {};
      const declaredRoles = scenario === 'polly' ? ['planner', 'codex_worker', 'claude_worker', 'codex_reviewer', 'claude_reviewer', 'summary'] : ['participant_a', 'participant_b', 'host'];
      let owned = params.threadId === chatId && params.turnId === turnId && declaredRoles.includes(params.cdxRoleId);
      const question = params.questions?.find(value => value.id === 'permission')?.question ?? '';
      const match = question.match(/: Allow (Read|Write|Edit|StructuredOutput) once\?\n([\s\S]*)$/);
      let input; try { input = match && JSON.parse(match[2]); } catch {}
      let allow = owned && !!input && ((match[1] === 'Read' && input.file_path === fixture.cwd + '/marker.txt') || (match[1] === 'StructuredOutput' && (scenario === 'polly' || params.cdxRoleId === 'host')));
      if (owned && scenario === 'polly' && !allow) {
        const { workflows } = await rpc('engine/runs/read', { threadId: chatId, turnId });
        const child = workflows[0]?.runs.find(run => run.id === params.cdxRunId && run.roleId === params.cdxRoleId && run.engine === params.cdxEngineSource);
        owned = !!child;
        if (child) {
          const writableRole = ['codex_worker', 'claude_worker'].includes(child.roleId);
          const namedFixtureFile = ['marker.txt', 'result.txt', 'verify.mjs'].some(name => input?.file_path === child.cwd + '/' + name);
          if (match?.[1] === 'Read' && namedFixtureFile) allow = true;
          if (['Write', 'Edit'].includes(match?.[1]) && writableRole && input?.file_path === child.cwd + '/result.txt') allow = true;
          // Only these known fixture commands may receive native approval.
          // Models may use ordinary permitted tools; unknown escalations deny.
          const permitted = ['node verify.mjs', 'git diff --check', 'git diff -- result.txt', 'git status --short', "printf 'REMOTE_POLLY_OK\\n' > result.txt"];
          const commands = permitted.flatMap(command => [command, ...['/bin/sh', '/bin/bash', '/usr/bin/bash'].flatMap(shell => ['-c', '-lc'].flatMap(flag => [shell + ' ' + flag + ' ' + helper.quote(command), shell + ' ' + flag + ' ' + JSON.stringify(command)]))]);
          if (message.method === 'item/commandExecution/requestApproval' && writableRole && params.cwd === child.cwd && commands.includes(params.command)) allow = true;
        }
      }
      evidence.approvals.push({ method: message.method, allowed: allow, owned, id: message.id, roleId: params.cdxRoleId, ...(params.command ? { command: params.command } : {}) });
      ws.send(JSON.stringify({ id: message.id, result: message.method === 'item/tool/requestUserInput'
        ? { answers: { permission: { answers: [allow ? 'Allow once' : 'Deny'] } } } : { decision: allow ? 'accept' : 'decline' } }));
    })().catch(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, result: { decision: 'decline' } })); });
  });
  ws.on('error', () => {});
  ws.on('close', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('Remote controller disconnected.')); } pending.clear(); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const initialization = await rpc('initialize', { clientInfo: { name: 'remote_workflow_acceptance', version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { rpc, initialization, close: () => { ws.terminate(); child.kill(); } };
};
let client, chatId, turnId;
try {
  await helper.prepare(transport, connection); stage('gateway-ready');
  fixture = lastJsonLine(await helper.execute(connection, 'python3 -c ' + helper.quote(fixtureCode)));
  evidence.cwd = fixture.cwd;
  client = await connect();
  evidence.initialization = client.initialization;
  const capabilities = await client.rpc('engine/capabilities', { cwd: fixture.cwd });
  assert.equal(capabilities.bothAvailable, true); assert.equal(capabilities.localOnly, false); assert.ok(capabilities.claudeModels.length > 4, 'Full Claude API catalog was not discovered');
  const codexModels = { data: [] }; let modelCursor;
  do { const page = await client.rpc('model/list', { limit: 100, ...(modelCursor ? { cursor: modelCursor } : {}) }); codexModels.data.push(...page.data); modelCursor = page.nextCursor; } while (modelCursor);
  evidence.catalogs = { codex: codexModels.data.map(model => model.model), claude: capabilities.claudeModels.map(model => model.id ?? model.value ?? model.model) };
  const codexModel = process.env.CDX_LIVE_CODEX_MODEL ?? (codexModels.data.find(model => /luna/.test(model.model))?.model ?? codexModels.data[0]?.model);
  const claudeModel = process.env.CDX_LIVE_CLAUDE_MODEL ?? 'claude-haiku-4-5';
  assert.ok(codexModel);
  const models = { codex: codexModel, claude: claudeModel };
  const roles = scenario === 'polly' ? {
    planner: { engine: 'claude', model: claudeModel, prompt: 'Plan exactly one implementation task named fix_result, assigned to codex, with no dependencies, owning only result.txt. The task changes BEFORE to REMOTE_POLLY_OK plus a newline and runs the existing node verify.mjs check before and after. Preserve marker.txt and verify.mjs. Return only the required structured task plan with concrete acceptance criteria; do not add tasks or edit files.' },
    summary: { engine: hostEngine, model: process.env.CDX_LIVE_HOST_MODEL ?? models[hostEngine] },
  } : {
    participant_a: { engine: scenario === 'claude' ? 'claude' : 'codex', model: scenario === 'claude' ? claudeModel : codexModel },
    participant_b: { engine: scenario === 'codex' ? 'codex' : 'claude', model: scenario === 'codex' ? codexModel : claudeModel },
    host: { engine: hostEngine, model: process.env.CDX_LIVE_HOST_MODEL ?? models[hostEngine],
      prompt: 'Host this short factual verification fairly. Read only supplied participant outputs. For assessments output the requested JSON; if both found the exact same file marker, stop early. Final synthesis: quote the exact verified marker and identify each participant engine. Keep it brief.' },
  };
  if (scenario !== 'polly') {
    roles.participant_a.model = process.env.CDX_LIVE_PARTICIPANT_A_MODEL ?? roles.participant_a.model;
    roles.participant_b.model = process.env.CDX_LIVE_PARTICIPANT_B_MODEL ?? roles.participant_b.model;
  }
  evidence.models = models; evidence.roleOverrides = roles;
  stage('catalogs-ready', { codexModel, claudeModels: capabilities.claudeModels.length });
  const created = await client.rpc('thread/start', { cwd: fixture.cwd, model: codexModel, engineMode: 'both', engineModels: models,
    roleOverrides: roles, template: scenario === 'polly' ? { id: 'polly', revision: 1, parameters: {} } : { id: 'debby', revision: 2, parameters: { rounds, host_mode: hostMode } } });
  chatId = created.thread.id; evidence.threadId = chatId;
  const result = await client.rpc('turn/start', { threadId: chatId, cwd: fixture.cwd, model: codexModel, approvalPolicy: 'on-request', sandbox,
    input: [{ type: 'text', text: scenario === 'polly' ? 'Validate the collaboration workflow with exactly one implementation task, assigned to Codex, changing only result.txt from BEFORE to exactly REMOTE_POLLY_OK followed by a newline. Run node verify.mjs before editing to observe its expected failure, then edit result.txt and rerun the same check. verify.mjs already checks exact contents and preservation of marker.txt. Keep both marker.txt and verify.mjs unchanged. The opposite engine must review each immutable result. After integration, run node verify.mjs and the final independent review, then apply the accepted result to this original fixture. No packages, installs, network, new tests, or extra files are needed. Keep reports concise.' : 'Read marker.txt in this directory using your native file tool. Reply with its exact content and one short sentence identifying your tool. Do not modify files or read anything else. The host should compare the independent readings and finish once they agree.' }] });
  turnId = result.turn.id; evidence.turnId = turnId; stage('workflow-started', { threadId: chatId, turnId });
  // Exercise a real desktop transport loss immediately after submission.
  client.close(); await new Promise(resolve => setTimeout(resolve, 350)); client = await connect(); stage('reconnected');
  const deadline = Date.now() + Number(process.env.CDX_LIVE_TIMEOUT_MS ?? (scenario === 'polly' ? 600000 : 240000)); let last;
  while (Date.now() < deadline) {
    const { workflows } = await client.rpc('engine/runs/read', { threadId: chatId, turnId });
    const workflow = workflows[0]; assert.ok(workflow); evidence.workflow = workflow;
    const status = JSON.stringify(workflow.runs.map(run => [run.roleId, run.status, run.attempt]));
    if (status !== last) { stage('roles', { runs: workflow.runs.map(run => ({ role: run.roleId, engine: run.engine, status: run.status, model: run.actualModel })) }); last = status; }
    if (workflow.status === 'blocked' || workflow.runs.some(run => ['failed', 'interrupted'].includes(run.status))) { evidence.workflow = workflow; throw Error('Remote workflow has an unsuccessful role: ' + workflow.runs.filter(run => run.error).map(run => run.error).join('; ')); }
    if (workflow.status === 'completed') {
      evidence.workflow = workflow;
      if (scenario === 'polly') {
        const integration = workflow.state.outputs.sources['review.integration'];
        assert.equal(integration.application.status, 'applied');
        assert.ok(workflow.runs.some(run => run.roleId === 'codex_worker'));
        assert.ok(workflow.runs.some(run => run.roleId === 'claude_reviewer'));
        for (const run of workflow.runs) {
          const chosen = workflow.config.template.roles[run.roleId];
          assert.equal(run.engine, chosen.engine); assert.equal(run.requestedModel, chosen.model);
          assert.ok(run.actualModel === chosen.model || run.actualModel?.startsWith(chosen.model + '-'));
        }
        assert.ok(workflow.state.events.some(event => event.type === 'tool-completed' && event.input?.command?.includes('node verify.mjs')), 'Missing native verification command');
        const checked = lastJsonLine(await helper.execute(connection, helper.nodeCommand() + '\npython3 -c ' + helper.quote('import pathlib,json,subprocess,hashlib; d=pathlib.Path(' + JSON.stringify(fixture.cwd) + '); r=subprocess.run([\"node\",\"verify.mjs\"],cwd=d,capture_output=True,text=True); print(json.dumps({\"exitCode\":r.returncode,\"stdout\":r.stdout,\"result\":(d/\"result.txt\").read_text(),\"marker\":(d/\"marker.txt\").read_text(),\"verifierHash\":hashlib.sha256((d/\"verify.mjs\").read_bytes()).hexdigest()}))')));
        evidence.fixtureVerification = checked; assert.equal(checked.exitCode, 0);
        assert.equal(checked.result, 'REMOTE_POLLY_OK\n'); assert.equal(checked.marker, fixture.marker + '\n');
        assert.equal(checked.verifierHash, fixture.verifierHash);
      } else {
      const participants = workflow.runs.filter(run => ['participant_a', 'participant_b'].includes(run.roleId));
      assert.ok(participants.length >= 2);
      for (const role of ['participant_a', 'participant_b']) {
        const run = participants.find(run => run.roleId === role);
        assert.ok(run.text?.includes(fixture.marker), role + ' did not return the remote marker');
        assert.equal(run.engine, roles[role].engine); assert.equal(run.requestedModel, roles[role].model);
        assert.ok(run.nativeSessionId, role + ' has no native session');
        assert.ok(run.actualModel === roles[role].model || run.actualModel?.startsWith(roles[role].model + '-'), role + ' actual model differs from selected model');
        assert.ok(workflow.state.events.some(event => event.roleId === role && event.type === 'tool-completed' && (event.input?.file_path === fixture.cwd + '/marker.txt' || event.input?.command?.includes('marker.txt'))), role + ' has no native file-read evidence');
      }
      assert.notEqual(participants[0].nativeSessionId, participants[1].nativeSessionId);
      const hosts = workflow.runs.filter(run => run.roleId === 'host');
      for (const run of hosts) {
        assert.equal(run.engine, hostEngine); assert.equal(run.requestedModel, roles.host.model);
        assert.ok(run.actualModel === roles.host.model || run.actualModel?.startsWith(roles.host.model + '-'), 'Host actual model differs from selected model');
        assert.ok(run.nativeSessionId && !participants.some(participant => participant.nativeSessionId === run.nativeSessionId));
      }
      assert.ok(workflow.state.outputs.final.text?.includes(fixture.marker), 'Host final synthesis lost the verified marker');
      assert.ok(workflow.runs.every(run => run.round <= rounds), 'Round bound exceeded');
      if (hostMode === 'final-only') {
        assert.equal(workflow.state.outputs.sources['debate.assessments'].length, 0);
        assert.equal(workflow.runs.length, 2 * (rounds + 1) + 1);
        for (const role of ['participant_a', 'participant_b']) {
          const peers = participants.filter(run => run.roleId === role);
          assert.deepEqual(peers.map(run => run.round), Array.from({ length: rounds + 1 }, (_, round) => round));
          assert.equal(new Set(peers.map(run => run.nativeSessionId)).size, 1, role + ' did not resume its own session for critique');
        }
      }
      const unchanged = lastJsonLine(await helper.execute(connection, 'python3 -c ' + helper.quote('import pathlib,json; print(json.dumps(pathlib.Path(' + JSON.stringify(fixture.cwd + '/marker.txt') + ').read_text()))')));
      assert.equal(unchanged, fixture.marker + '\n');
      }
      const history = await client.rpc('thread/read', { threadId: chatId, includeTurns: true });
      assert.ok(JSON.stringify(history).includes(scenario === 'polly' ? 'REMOTE_POLLY_OK' : fixture.marker));
      evidence.passed = true; stage('passed', { runs: workflow.runs.length }); break;
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  assert.equal(evidence.passed, true, 'Remote workflow timed out');
} catch (error) {
  evidence.error = error.message; console.error(JSON.stringify({ host, scenario, error: error.message })); process.exitCode = 1;
  if (client && chatId && turnId) await client.rpc('turn/interrupt', { threadId: chatId, turnId }).catch(() => {});
} finally {
  client?.close(); evidence.finishedAt = new Date().toISOString();
  mkdirSync(resolve('.artifacts'), { recursive: true });
  let evidencePath = resolve('.artifacts', 'remote-live-' + host + '-' + caseName + '.json');
  if (existsSync(evidencePath)) evidencePath = evidencePath.replace(/\.json$/, '-' + Date.now() + '.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ host, scenario, evidencePath, passed: evidence.passed === true }));
}
