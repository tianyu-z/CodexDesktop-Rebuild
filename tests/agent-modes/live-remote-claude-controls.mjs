// CDX_LIVE_REMOTE=1 node tests/agent-modes/live-remote-claude-controls.mjs [HOST...]
// Packages this checkout into a unique gateway scope. No inference prompts,
// user settings changes, production gateway restarts, or permissive tool replies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Duplex, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import WebSocket from '../../runtime/agent-modes/node_modules/ws/wrapper.mjs';
import { nativeLoginWrapper } from './live-remote-login.mjs';

if (process.env.CDX_LIVE_REMOTE !== '1') throw Error('Set CDX_LIVE_REMOTE=1 to run isolated remote acceptance.');
const allowedHosts = ['rno', 'bar', 'ala', 'blc', 'blc-2', 'sko'];
const hosts = process.argv.slice(2).length ? process.argv.slice(2) : allowedHosts;
assert.ok(hosts.every(host => allowedHosts.includes(host)), 'Unknown cluster alias.');
const targetedTimeout = process.env.CDX_CONTROLS_TARGETED_TIMEOUT === '1';
if (targetedTimeout) assert.deepEqual(hosts, ['rno'], 'The focused timeout acceptance is restricted to rno.');
const require = createRequire(import.meta.url), helper = require('../../scripts/assets/agent-modes-remote.cjs');
const { packageRemoteRuntime } = require('../../scripts/remote-runtime-package.js');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
mkdirSync(join(root, '.artifacts'), { recursive: true });
const replay = process.env.CDX_CONTROLS_ARTIFACT;
const artifact = replay ? resolve(replay) : mkdtempSync(join(root, '.artifacts', 'remote-claude-controls-'));
const previousReport = replay ? JSON.parse(readFileSync(join(artifact, 'report.json'))) : null;
const appName = previousReport?.appName ?? 'cdx-claude-controls-' + Date.now().toString(36);
assert.match(appName, /^cdx-claude-controls-[a-z0-9]+$/);
process.resourcesPath = join(artifact, 'resources');
const resources = join(process.resourcesPath, 'agent-modes'); mkdirSync(resources, { recursive: true });
const sourceFiles = ['claude-adapter.mjs', 'claude-events.mjs', 'claude-commands.mjs', 'claude-command-router.mjs', 'claude-live-controls.mjs', 'claude-permissions.mjs', 'router.mjs', 'orchestration/router.mjs', 'orchestration/scheduler.mjs'];
const sourceHashes = previousReport?.sourceHashes ?? Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(readFileSync(join(root, 'runtime/agent-modes', name))).digest('hex')]));
const manifest = previousReport?.runtime ?? packageRemoteRuntime(join(root, 'runtime/agent-modes'), join(resources, 'remote-runtime.tar.gz'));
writeFileSync(join(resources, 'build.json'), JSON.stringify({ appName }));
writeFileSync(join(resources, 'remote-build.json'), JSON.stringify(manifest));
const report = previousReport ?? { appName, runtime: manifest, sourceHashes, startedAt: new Date().toISOString(), hosts: [], inferencePrompts: 0 };
if (targetedTimeout) report.check = 'native-context-timeout-and-same-chat-recovery';
report.hosts = report.hosts.filter(entry => !hosts.includes(entry.host));
console.log(JSON.stringify({ artifact, appName, runtimeVersion: manifest.sha256 }));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const lastJson = output => JSON.parse(output.trim().split(/\r?\n/).at(-1));
const category = error => {
  const value = String(error?.message ?? error).toLowerCase();
  return ['timeout', 'timed out', 'not found', 'unavailable', 'unsupported', 'unknown', 'failed', 'denied', 'permission', 'auto mode', 'bypass', 'disabled', 'managed', 'policy', 'authentication', 'session', 'assertion'].filter(word => value.includes(word));
};
const stage = (entry, name, detail = {}) => { entry.stages.push({ name, ...detail }); console.log(JSON.stringify({ host: entry.host, stage: name, ...detail })); };
const safeError = (error, context) => ({ context, name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : undefined, categories: category(error) });
const login = nativeLoginWrapper();

async function connect(connection, transport) {
  const marker = randomBytes(24), child = spawn(connection.ssh, [...connection.args, connection.login(helper.proxyCommand(transport), marker)], { env: connection.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let framed = false, boundary = Buffer.alloc(0);
  const output = new Transform({ transform(bytes, encoding, callback) {
    if (!framed) {
      const combined = Buffer.concat([boundary, bytes]), index = combined.indexOf(marker);
      if (index < 0) { boundary = combined.subarray(Math.max(0, combined.length - marker.length + 1)); callback(); return; }
      framed = true; bytes = combined.subarray(index + marker.length); boundary = Buffer.alloc(0);
    }
    callback(null, bytes);
  } });
  const stream = Duplex.from({ writable: child.stdin, readable: child.stdout.pipe(output) });
  Object.assign(stream, { setTimeout: () => stream, setNoDelay: () => stream, setKeepAlive: () => stream });
  const ws = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => stream, perMessageDeflate: false });
  const pending = new Map(), completed = new Map(), approvals = []; let sequence = 0;
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (message.id != null && !message.method) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
    } else if (message.id != null) {
      approvals.push({ method: message.method, threadId: message.params?.threadId, roleId: message.params?.cdxRoleId });
      const result = message.method === 'item/tool/requestUserInput' ? { answers: { permission: { answers: ['Deny'] } } } : { decision: 'decline' };
      ws.send(JSON.stringify({ id: message.id, result }));
    } else if (message.method === 'turn/completed') completed.set(message.params.turn.id, message.params.turn);
  });
  ws.on('close', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('Gateway disconnected.')); } pending.clear(); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timed out: ' + method)); }, 40000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Remote proxy timed out.')), 45000); ws.once('open', () => { clearTimeout(timer); resolve(); }); ws.once('error', error => { clearTimeout(timer); reject(error); }); });
  await rpc('initialize', { clientInfo: { name: 'isolated_claude_controls_acceptance', version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { rpc, completed, approvals, close: () => { ws.terminate(); child.kill(); } };
}

// This code runs on each host against the packaged SDK and that host's native
// Claude executable. Output contains only mode enums, booleans and counts.
const probe = String.raw`
import { spawn } from 'node:child_process';
const root = process.env.CDX_REMOTE_ROOT;
const { query } = await import(root + '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const { remoteClaudeEnvironment } = await import(root + '/remote/environment.mjs');
const cwd = process.env.CDX_CONTROLS_CWD, env = await remoteClaudeEnvironment({ cwd });
const modes = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const bounded = async (promise, ms) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('probe timeout')), ms); })]); } finally { clearTimeout(timer); } };
const results = [];
for (const mode of modes) {
  const result = { mode, initialized: false, accepted: false, actualMode: null, userMessages: 0 };
  const abort = new AbortController(); let release, child, exit, handle, seen = '';
  const closed = new Promise(resolve => { release = resolve; });
  try {
    handle = query({ prompt: (async function* () { await closed; })(), options: {
      cwd, env, pathToClaudeCodeExecutable: process.env.CDX_CLAUDE_PATH,
      settingSources: ['user', 'project', 'local'], tools: ['Read', 'Grep', 'Glob'], mcpServers: {}, strictMcpConfig: true,
      hooks: {}, settings: { disableAllHooks: true }, persistSession: false, permissionMode: mode,
      ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}), abortController: abort,
      spawnClaudeCodeProcess(options) {
        child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        exit = new Promise(resolve => { child.once('exit', resolve); child.once('error', () => { if (child.pid === undefined) resolve(); }); });
        child.stderr.resume();
        child.stdout.on('data', bytes => {
          seen += bytes;
          while (seen.includes('\n')) {
            const index = seen.indexOf('\n'), line = seen.slice(0, index); seen = seen.slice(index + 1);
            try { const frame = JSON.parse(line); if (frame.type === 'system' && modes.includes(frame.permissionMode)) result.actualMode = frame.permissionMode; } catch {}
          }
        }); return child;
      },
    } });
    const init = await bounded(handle.initializationResult(), 12000); result.initialized = true;
    result.autoAdvertised = init.models?.some(model => model.supportsAutoMode === true) ?? false;
    await bounded(handle.setPermissionMode(mode), 5000); result.accepted = true;
    if (typeof handle.getSettings === 'function') {
      const settings = await bounded(handle.getSettings(), 5000);
      if (modes.includes(settings?.applied?.permissionMode)) result.actualMode = settings.applied.permissionMode;
      result.bypassDisabledBySettings = settings?.effective?.permissions?.disableBypassPermissionsMode === 'disable';
    }
  } catch (error) {
    const value = String(error?.message ?? error).toLowerCase();
    result.rejectionCategories = ['timeout', 'auto', 'bypass', 'disabled', 'managed', 'policy', 'permission', 'not supported', 'not available'].filter(word => value.includes(word));
  } finally {
    release(); try { handle?.close(); } catch {} abort.abort();
    await bounded(Promise.resolve().then(() => handle?.return()), 1500).catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exit) { try { await bounded(exit, 1000); } catch { child.kill('SIGKILL'); await bounded(exit, 1000); } }
    if (child) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); result.childExited = child.exitCode !== null || child.signalCode !== null; }
  }
  results.push(result);
}
console.log(JSON.stringify({ modes: results }));
`;
const probeFile = join(artifact, 'native-init-probe.mjs'); writeFileSync(probeFile, probe);

async function runHost(host) {
  const entry = { host, stages: [], commands: [], errors: [], startedAt: new Date().toISOString() }; report.hosts.push(entry);
  const connection = { ssh: '/usr/bin/ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host], sshConnection: { alias: host }, login, env: process.env, codex: 'codex' };
  const transport = {}, info = helper.layout(connection), chats = []; let client, fixture, currentTurn, currentChat, prepared = false, context = 'prepare';
  const gatewayPids = async () => lastJson(await helper.execute(connection, 'python3 -c ' + helper.quote('import subprocess,re,json; lines=subprocess.check_output(["ps","-eo","pid=,args="],text=True).splitlines(); print(json.dumps([int(line.split()[0]) for line in lines if re.search(r"^\\s*\\d+\\s+\\S*node\\s+\\S+/remote/daemon\\.mjs serve(?:\\s|$)",line)]))')));
  const readState = async id => {
    const code = 'import json,sys,hashlib; d=json.load(open(sys.argv[1]+"/conversations/"+hashlib.sha256(sys.argv[2].encode()).hexdigest()+".json")); print(json.dumps({k:d.get(k) for k in ["bindings","roleBindings","roleOverrides","models","nextSeq","claudePermissionMode"]}))';
    return lastJson(await helper.execute(connection, 'python3 -c ' + helper.quote(code) + ' ' + info.data + ' ' + helper.quote(id)));
  };
  const command = async (chatId, input, target, during, { expectedStatus = 'completed', waitMs = input === '/context' ? 65000 : 45000 } = {}) => {
    context = input + (target ? ':' + target : ''); currentChat = chatId;
    const { turn } = await client.rpc('turn/start', { threadId: chatId, input: [{ type: 'text', text: input }], ...(target ? { claudeCommandTarget: target } : {}) }); currentTurn = turn.id;
    const started = Date.now(), deadline = started + waitMs;
    if (during) await during(turn.id);
    while (!client.completed.has(turn.id) && Date.now() < deadline) await pause(100);
    const completed = client.completed.get(turn.id); assert.ok(completed, 'Native command timed out.'); currentTurn = null;
    const text = completed.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
    const row = { command: input, threadId: chatId, target: target ?? null, status: completed.status, durationMilliseconds: Date.now() - started, outputCharacters: text.length, outputSha256: createHash('sha256').update(text).digest('hex'),
      ...(completed.error ? { errorCategories: category(completed.error.message) } : {}) };
    entry.commands.push(row); stage(entry, 'command', row); assert.equal(completed.status, expectedStatus, 'Unexpected native command status.');
    if (expectedStatus === 'completed') assert.ok(text.length > 0 || input === '/clear', 'Expected native command output.');
    return completed;
  };
  const attemptCommand = async (...args) => {
    try { return await command(...args); }
    catch (error) {
      const failure = safeError(error, context); entry.errors.push(failure); stage(entry, 'command-failed', failure);
      if (currentTurn) { await client.rpc('turn/interrupt', { threadId: currentChat, turnId: currentTurn }).catch(() => {}); currentTurn = null; }
      return null;
    }
  };
  try {
    entry.preexistingGatewayPids = await gatewayPids();
    await helper.prepare(transport, connection); prepared = true; stage(entry, 'isolated-gateway-ready', { scope: info.scope, runtimeVersion: info.version });
    entry.nativeVersion = (await helper.execute(connection, helper.setupCommand(info, connection.codex).replace('"$CDX_REMOTE_NODE" "$CDX_REMOTE_ROOT/remote/daemon.mjs" ensure', '"$CDX_CLAUDE_PATH" --version'))).trim().split(/\r?\n/).at(-1);
    context = 'fixture';
    const code = 'import tempfile,pathlib,secrets,json; d=pathlib.Path(tempfile.mkdtemp(prefix="cdx-claude-controls-")); names=["cdx-control-"+secrets.token_hex(5) for _ in range(2)]; dirs=[d/str(i) for i in range(2)]; [(p/".claude"/"skills"/n).mkdir(parents=True) for p,n in zip(dirs,names)]; [(p/".claude"/"skills"/n/"SKILL.md").write_text("---\\nname: "+n+"\\ndescription: Disposable remote catalog acceptance skill\\ndisable-model-invocation: true\\n---\\nDo not use tools. Reply with FIXTURE only.\\n") for p,n in zip(dirs,names)]; [(p/".claude"/"settings.local.json").write_text(json.dumps({"disableAllHooks":True})) for p in dirs]; print(json.dumps({"root":str(d),"directories":[str(p) for p in dirs],"names":names}))';
    fixture = lastJson(await helper.execute(connection, 'python3 -c ' + helper.quote(code))); entry.fixture = fixture;
    if (targetedTimeout) {
      client = await connect(connection, transport);
      const { thread } = await client.rpc('thread/start', { cwd: fixture.directories[0], engineMode: 'claude', engineModel: 'claude-haiku-4-5' });
      const chatId = thread.id; chats.push(chatId); entry.threadId = chatId;
      const result = await command(chatId, '/context', undefined, async turnId => {
        await pause(2500);
        const response = await client.rpc('engine/claude/control', { threadId: chatId, turnId, command: '/status' });
        const output = response.turn.items.at(-1);
        entry.liveControl = { sameTurn: response.turn.id === turnId, outputCharacters: response.text.length,
          localCommand: output.cdxClaudeLocalCommand === true, claudeSource: output.cdxEngineSource === 'claude', roleId: response.roleId };
        assert.ok(entry.liveControl.sameTurn && entry.liveControl.outputCharacters > 0 && entry.liveControl.localCommand && entry.liveControl.claudeSource);
        assert.equal(response.roleId, null); stage(entry, 'live-control-attribution', entry.liveControl);
      }, { expectedStatus: 'failed', waitMs: 65000 });
      const message = result.error?.message ?? '';
      assert.ok(message.includes('Native context accounting timed out.'));
      const state = await client.rpc('engine/mode/read', { threadId: chatId });
      assert.equal(state.busy, false);
      entry.timeout = { explicitNativeTimeout: true, idleAfterFailure: true, durationMilliseconds: entry.commands.at(-1).durationMilliseconds };
      const saved = await readState(chatId), session = saved.bindings.claude.sessionId;
      entry.timeout.nativeSessionIdPresent = Boolean(session);
      if (session) {
        const inspect = 'import pathlib,os,re,sys,json; projects=pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR",str(pathlib.Path.home()/".claude")))/"projects"; assert re.fullmatch(r"[a-f0-9-]{36}",sys.argv[2]); path=projects/re.sub(r"[^a-zA-Z0-9]","-",sys.argv[1])/(sys.argv[2]+".jsonl"); print(json.dumps({"nativeTranscriptExists":path.exists()}))';
        Object.assign(entry.timeout, lastJson(await helper.execute(connection, 'python3 -c ' + helper.quote(inspect) + ' ' + helper.quote(fixture.directories[0]) + ' ' + helper.quote(session))));
      }
      const status = await attemptCommand(chatId, '/status'), model = await attemptCommand(chatId, '/model');
      assert.equal((await client.rpc('engine/mode/read', { threadId: chatId })).busy, false);
      assert.equal(client.approvals.length, 0);
      entry.sameChatRecovery = { statusCompleted: status?.status === 'completed', modelCompleted: model?.status === 'completed', idleAfterRecovery: true };
      entry.passed = entry.errors.length === 0; stage(entry, 'timeout-and-same-chat-recovery', { ...entry.timeout, ...entry.sameChatRecovery });
      return;
    }
    context = 'native-permission-init';
    const setup = helper.setupCommand(info, connection.codex).replace('"$CDX_REMOTE_NODE" "$CDX_REMOTE_ROOT/remote/daemon.mjs" ensure', 'export CDX_REMOTE_ROOT\nCDX_CONTROLS_CWD=' + helper.quote(fixture.directories[0]) + '\nexport CDX_CONTROLS_CWD\n"$CDX_REMOTE_NODE" --input-type=module');
    entry.permissions = lastJson(await helper.execute(connection, setup, probeFile)).modes;
    entry.nativeModeRejections = entry.permissions.filter(row => !row.accepted).map(row => ({ mode: row.mode, categories: row.rejectionCategories }));
    if (!entry.permissions.every(row => row.initialized && row.childExited && row.userMessages === 0)) entry.errors.push({ context, categories: ['native mode initialization or cleanup unverified'] });
    stage(entry, 'native-permission-init', { modes: entry.permissions });
    client = await connect(connection, transport);
    context = 'catalog';
    const catalogs = [];
    for (let index = 0; index < 2; index++) {
      const catalog = await client.rpc('engine/claude/commands', { cwd: fixture.directories[index], refresh: true });
      const rows = catalog.commands; assert.ok(rows.some(row => row.name === fixture.names[index])); assert.ok(!rows.some(row => row.name === fixture.names[1 - index]));
      catalogs.push({ count: rows.length, ownSkill: true, otherSkill: false, commands: ['status', 'permissions', 'context', 'model', 'clear'].map(name => { const row = rows.find(row => row.name === name); assert.ok(row); return { name, origin: row.origin, execution: row.execution }; }) });
    }
    entry.catalogs = catalogs; stage(entry, 'host-cwd-catalogs', { counts: catalogs.map(row => row.count), isolated: true });
    const freshChat = async () => { const created = await client.rpc('thread/start', { cwd: fixture.directories[0], engineMode: 'claude', engineModel: 'claude-haiku-4-5' }); chats.push(created.thread.id); return created.thread.id; };
    const liveControls = async (chatId, turnId) => {
      await pause(2000);
      if (client.completed.has(turnId)) { entry.liveControls = { skipped: true, reason: 'The native command completed before controls were sent.' }; return; }
      const before = await readState(chatId), rows = [];
      for (const command of ['/status', '/permissions', '/tasks']) {
        try {
          const response = await client.rpc('engine/claude/control', { threadId: chatId, turnId, command });
          assert.equal(response.turn.id, turnId); assert.ok(response.text.length > 0);
          rows.push({ command, completed: true, outputCharacters: response.text.length, outputSha256: createHash('sha256').update(response.text).digest('hex') });
        } catch (error) { rows.push({ command, completed: false, error: safeError(error, 'live-control') }); }
      }
      const after = await readState(chatId);
      entry.liveControls = { rows, samePublicTurn: before.nextSeq === after.nextSeq, sameNativeBinding: JSON.stringify(before.bindings.claude) === JSON.stringify(after.bindings.claude) };
      stage(entry, 'live-controls', entry.liveControls);
      if (rows.some(row => !row.completed) || !entry.liveControls.samePublicTurn || !entry.liveControls.sameNativeBinding) entry.errors.push({ context: 'live-controls', categories: ['native live control failed or changed owner'] });
    };
    const chat = await freshChat(); entry.threadId = chat;
    const authoritative = await client.rpc('engine/claude/commands', { threadId: chat, cwd: fixture.directories[1], refresh: true });
    assert.ok(authoritative.commands.some(row => row.name === fixture.names[0])); assert.ok(!authoritative.commands.some(row => row.name === fixture.names[1]));
    // A timed-out native command may never materialize a resumable transcript.
    // Each independent acceptance gets a fresh public/native session.
    for (const input of ['/status', '/permissions', '/context', '/model', '/model claude-haiku-4-5']) {
      const commandChat = await freshChat(); await attemptCommand(commandChat, input, undefined, input === '/context' ? turnId => liveControls(commandChat, turnId) : undefined);
      const state = await readState(commandChat); assert.equal(state.claudePermissionMode, 'default');
      if (input === '/model claude-haiku-4-5' && entry.commands.at(-1)?.status === 'completed') assert.equal(state.models.claude, 'claude-haiku-4-5');
    }
    const clearChat = await freshChat(); await attemptCommand(clearChat, '/clear');
    const singleState = await readState(clearChat); assert.equal(singleState.claudePermissionMode, 'default');
    entry.single = { contextCleared: singleState.bindings.claude.consumedSeq === singleState.nextSeq - 1, nativeSessionId: singleState.bindings.claude.sessionId };
    if (!entry.single.contextCleared) entry.errors.push({ context: 'clear-watermark', categories: ['context reset unverified'] });
    context = 'roles';
    if (!entry.commands.some(row => row.command === '/model' && row.status === 'completed')) {
      entry.roleIsolation = { skipped: true, reason: 'Native /model did not complete; no compatible role session to seed without inference.' };
    } else {
    const both = await client.rpc('thread/start', { cwd: fixture.directories[1], engineMode: 'both', template: { id: 'debby', revision: 2, parameters: {} },
      roleOverrides: { participant_a: { engine: 'claude', model: 'claude-haiku-4-5' }, participant_b: { engine: 'claude', model: 'claude-haiku-4-5' } } });
    chats.push(both.thread.id); entry.roleThreadId = both.thread.id;
    await command(both.thread.id, '/model', 'participant_a'); await command(both.thread.id, '/model', 'participant_b');
    const before = await readState(both.thread.id), keys = Object.keys(before.roleBindings);
    const first = keys.find(key => key.includes('/participant_a/')), second = keys.find(key => key.includes('/participant_b/'));
    assert.ok(first && second); assert.ok(before.roleBindings[first].sessionId); assert.notEqual(before.roleBindings[first].sessionId, before.roleBindings[second].sessionId);
    await command(both.thread.id, '/status', 'participant_b'); await command(both.thread.id, '/clear', 'participant_a');
    const after = await readState(both.thread.id);
    assert.notEqual(after.roleBindings[first].sessionId, before.roleBindings[first].sessionId); assert.deepEqual(after.roleBindings[second], before.roleBindings[second]);
    assert.deepEqual(after.bindings.claude, before.bindings.claude); assert.equal((await client.rpc('engine/runs/read', { threadId: both.thread.id })).workflows.length, 0);
    entry.roleIsolation = { distinctSessions: true, clearedOnlyTarget: true, noWorkflowInference: true }; stage(entry, 'role-target-isolation', entry.roleIsolation);
    }
    assert.equal(client.approvals.length, 0, 'Unexpected tool approval during no-inference commands.');
    entry.passed = entry.errors.length === 0;
  } catch (error) { entry.error = safeError(error, context); stage(entry, 'failed', entry.error); }
  finally {
    if (client && currentTurn) await client.rpc('turn/interrupt', { threadId: currentChat, turnId: currentTurn }).catch(() => {});
    if (client) for (const threadId of chats) await client.rpc('thread/archive', { threadId }).catch(() => {});
    entry.approvals = client?.approvals ?? []; client?.close();
    try {
      await helper.stop(transport, connection);
      const cleanup = 'import pathlib,shutil,sys,hashlib,tempfile,os,re; data=pathlib.Path(sys.argv[1]); assert data.name.startswith("' + appName + '-"); shutil.rmtree(data,ignore_errors=True); socket=pathlib.Path(tempfile.gettempdir())/("cdx-engines-"+str(os.getuid())+"-"+hashlib.sha256(str(data/"conversations").encode()).hexdigest()[:20]); shutil.rmtree(socket,ignore_errors=True); fixture=pathlib.Path(sys.argv[2]) if len(sys.argv)>2 else None; assert fixture is None or fixture.name.startswith("cdx-claude-controls-"); projects=pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR",str(pathlib.Path.home()/".claude")))/"projects"; [shutil.rmtree(projects/re.sub(r"[^a-zA-Z0-9]","-",str(fixture/str(index))),ignore_errors=True) for index in range(2)] if fixture else None; shutil.rmtree(fixture,ignore_errors=True) if fixture else None; assert not data.exists() and not socket.exists() and (fixture is None or not fixture.exists()); assert fixture is None or all(not (projects/re.sub(r"[^a-zA-Z0-9]","-",str(fixture/str(index)))).exists() for index in range(2)); print("CLEANED")';
      await helper.execute(connection, 'python3 -c ' + helper.quote(cleanup) + ' ' + info.data + (fixture ? ' ' + helper.quote(fixture.root) : '')); entry.cleaned = true;
      const remaining = await gatewayPids(); entry.preexistingGatewaysPreserved = (entry.preexistingGatewayPids ?? []).every(pid => remaining.includes(pid));
      assert.equal(entry.preexistingGatewaysPreserved, true, 'A preexisting gateway exited during acceptance.');
    } catch (error) { entry.cleanupError = safeError(error, 'cleanup'); entry.passed = false; }
    entry.finishedAt = new Date().toISOString(); writeFileSync(join(artifact, host + '.json'), JSON.stringify(entry, null, 2));
  }
}
const queue = [...hosts];
await Promise.all(Array.from({ length: Math.min(2, hosts.length) }, async () => { while (queue.length) await runHost(queue.shift()); }));
report.finishedAt = new Date().toISOString(); report.passed = report.hosts.length >= hosts.length && report.hosts.every(host => host.passed && host.cleaned);
writeFileSync(join(artifact, process.env.CDX_CONTROLS_REPORT_FILE ?? 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ artifact, passed: report.passed, hosts: report.hosts.map(entry => ({ host: entry.host, passed: entry.passed ?? false, cleaned: entry.cleaned ?? false })) }));
if (!report.passed) process.exitCode = 1;
