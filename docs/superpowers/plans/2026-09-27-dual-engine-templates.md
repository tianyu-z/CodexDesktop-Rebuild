# Dual-engine Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver Polly, Debby and editable custom workflows using actual Codex and Claude Code harnesses, with independent model selection in the existing desktop app.

**Architecture:** Extend the local gateway with versioned templates, a multi-run scheduler, isolated native role runners, and Git workspaces. Preserve single-engine routes, public chat identity, authentication and model discovery. Persist one user turn with attributed child runs and immutable execution configuration.

**Tech Stack:** Node.js ESM, node:test, official Claude Agent SDK, native Codex App Server, YAML parser isolated in runtime dependencies, current React asset patching and Electron repackaging.

Working directory: `/Users/tianyu.zhang/.codex/worktrees/claude-code-modes/New project 10`.
Design: `docs/superpowers/specs/2026-09-27-dual-engine-templates-design.md`.
Baseline: `ee5533c`, with unchanged production code relative to published `77ef39c`.

## Shared contracts

Engine is `codex|claude`; mode is `codex|claude|both`. Template roles bind an engine, not a model. A submitted turn freezes models, reasoning settings, template revision and parameters. Source attribution uses `runId`, `roleId`, `engine`, `stepId`, `round`, `attempt`.

```js
// Role runner: all callbacks belong to this execution, including cancellation.
runner.start({ runId, engine, model, cwd, prompt, instructions,
  nativeSessionId, access: 'read' /* or 'write' */, outputSchema,
  nativeOptions, signal, onEvent, onPermission });
// => { done: Promise<{status, text, nativeSessionId, actualModel?, usage?, error?}>, interrupt() }
// Events use existing Claude-normalizer public vocabulary for both engines.

// Versioned template store; snapshots are ordinary serializable objects.
templates.list(); templates.read(id, revision); templates.save(template);
templates.remove(id); templates.import(text); templates.export(id, revision, format);

// Scheduler never knows desktop/native transport internals.
new WorkflowScheduler({ runner, workspaces, onEvent, onPermission }).start({
  runId, template, parameters, models, nativeOptions, cwd, input, history,
  bindings, signal, onSnapshot
});
// => {done, interrupt(runId?), retry(runId), snapshot()}
```

## Task 1: Template schema, built-ins and version storage

Files: create `runtime/agent-modes/templates/{schema,builtins,store}.mjs`, template attribution/license files, and `tests/agent-modes/templates.test.mjs`; update only isolated runtime package/lock if YAML dependency is needed.

- [x] Write failing behavior tests for built-ins, YAML/JSON round trips, immutable revisions, invalid graphs/parameters and role references.

```js
const repository = new TemplateStore(tempDirectory);
assert.deepEqual(repository.list().filter(t => t.builtin).map(t => t.id).sort(), ['debby', 'polly']);
const copy = repository.read('debby');
copy.id = 'my-debate'; copy.name = 'My debate'; delete copy.revision;
const saved = repository.save(copy);
assert.equal(repository.read(saved.id, saved.revision).name, 'My debate');
assert.throws(() => repository.save({...copy, unexpected: true}), /unexpected/);
```

- [x] Run `node --test tests/agent-modes/templates.test.mjs`; establish meaningful failure before production implementation.
- [x] Implement strict declarative schema. Roles: `{engine,prompt,access,session}`; parameters: typed defaults/min/max; steps: run, parallel, repeat, synthesize, planTasks, executeTasks, crossReview; limits: concurrency 1–4, tasks 1–32, rounds 0–10. Validate unknown fields, IDs, DAGs, reachable dual engines, role/input references, bounded repeats and review ownership. Publish precise step schemas in a local README consumed by following tasks.
- [x] Built-in Debby: parallel independent answers, optional rounds referencing the other's previous answer, Claude synthesis; parameter `rounds` defaults 0 with UI toggle enabling 1. Polly: Claude planner, dynamically assigned Codex/Claude tasks, opposite-engine review, integration and Claude summary. Both share slot-bound models.
- [x] Implement atomic revision files and immutable read snapshots, read-only built-ins, safe IDs/paths, JSON/YAML import/export. Import parses only data and fails on unsupported upstream fields/tags. Preserve Apache 2.0 attribution to Omnigent revision `56c6a7f73024a257a5d359378e8ebb68a66dde7f`.
- [x] Run focused tests, then spec review and quality review. Commit only task files.

## Task 2: Native role runners and enforced role access

Files: create `runtime/agent-modes/orchestration/{role-runner,codex-role}.mjs`, modify `claude-adapter.mjs` for optional role options, add `tests/agent-modes/{role-runner,codex-role}.test.mjs` and relevant adapter tests.

- [x] Write failing tests for simultaneous isolated executions, exact per-engine model selection, restricted read tools, structured planning output, stream/error/cancel ownership, session resume and native approval mapping.

```js
const run = runner.start({runId:'r1',engine:'claude',model:'claude-opus-5-5',cwd,
  access:'read',prompt:'Inspect the fixture',instructions:'Report facts',signal,
  onEvent: events.push.bind(events),onPermission});
assert.equal((await run.done).status, 'completed');
assert.equal(recordedOptions.model, 'claude-opus-5-5');
assert.equal(recordedOptions.systemPrompt.preset, 'claude_code');
```

- [x] Run focused tests and observe failure.
- [x] Codex role owns an App Server client, initialization, internal thread and turn, normalized public tool/message events and mapped request/response IDs. Use original CLI path, not gateway wrapper. Use ephemeral threads where supported to avoid sidebar pollution; stable role sessions resume explicitly. Preserve native approval/sandbox options; read role uses native read-only sandbox and denies escalation/writes. No forced never-approve/bypass setting.
- [x] Claude optional role instructions append to preset, output schema uses supported SDK option, and read access exposes only read tools with strict MCP policy and denial hooks. Keep user/project settings for normal single-engine execution. For role restriction, ensure configured hooks, plugins or MCP cannot create a bypass; verify actual CLI support before advertising enforced read access.
- [x] Both adapters return the shared runner contract and capture requested/actual model separately. A terminal result settles once after process cleanup; stop before start, pending approval and unexpected exit are covered. Track only owned processes and native sessions.
- [x] Run focused and adapter regression tests. Review spec then quality; commit.

## Task 3: Workspaces, fixed review snapshots and integration

Files: create `runtime/agent-modes/workspaces/{git,manager}.mjs`, `tests/agent-modes/workspaces.test.mjs`.

- [x] Write real temporary-Git tests covering dirty tracked files, staged state, untracked files, binaries, task isolation, dependencies, fixed review artifacts, conflicts and safe application.

```js
const base = await workspaces.prepare({cwd, runId:'workflow'});
const worker = await workspaces.task(base, {id:'change-a', dependsOn:[]});
assert.notEqual(worker.cwd, cwd);
assert.equal(await readFile(join(worker.cwd,'existing.txt'),'utf8'), 'user edit');
assert.equal(await git(cwd,['diff','--cached']), originalIndexDiff);
```

- [x] Run tests before implementation.
- [x] Use private index/temp Git objects for startup snapshot, never reset/stash the user's checkout. Track owned worktrees under workflow data. Task worktrees start from base plus declared dependency outcomes. No two workers write one directory.
- [x] Freeze worker outcome into immutable commits/diffs including binary changes; prepare separate read-only review checkout and acceptance contract. Integration follows dependency order, reports conflicts for bounded repair, and records exact reviewed artifact hashes.
- [x] Apply integrated delta only if affected paths still match the baseline; preserve unrelated edits/index, detect symlink/type/path escapes, retain artifacts on error/cancel. Non-Git write workflow fails before mutation; no implicit git init. No remote push/PR behavior.
- [x] Run tests; spec and quality review; commit.

## Task 4: Workflow scheduling and durable multi-run state

Files: create `runtime/agent-modes/orchestration/{scheduler,inputs,polly}.mjs`, modify `store.mjs` and `handoff.mjs`; add `tests/agent-modes/{scheduler,polly}.test.mjs`, extend store/handoff tests.

- [x] Write deterministic runner tests with deferred results proving concurrency, predecessor barriers, immutable model/input snapshots, same-round cross-critique, opposite-engine review and bounded repairs.

```js
const handle = scheduler.start({runId:'w',template:debby,parameters:{rounds:1},
  models:{codex:'gpt-selected',claude:'claude-selected'},cwd,input:'Compare',history:''});
await waitForCalls(2);
assert.deepEqual(calls.map(c=>c.model).sort(), ['claude-selected','gpt-selected']);
complete('codex','C0'); complete('claude','A0');
await waitForCalls(4);
assert.match(calls[2].prompt, /A0/);
assert.match(calls[3].prompt, /C0/);
```

- [x] Run tests before implementing scheduler.
- [x] Interpreter executes validated graph, expands bounded repeat/parallel stages and dynamically planned tasks. Model slots bound on every dispatch. Coordinator planning has structured output contract; no execution of generated code. Event-driven readiness and inbox completion; no model polling.
- [x] Polly applies workspace contract, task limits, independent task parallelism, opposite-engine fixed-artifact review and at most configured repair rounds. Validate planner's file scopes/dependencies and review verdicts; missing or malformed output is a run failure, never silently accepted. Integrate and validate actual output; apply authorized edits with baseline protection.
- [x] Migrate v1 to backed-up v2 atomically. Persist template/model snapshots, active turn, role runs/events/attempts, scoped bindings and cursors. Old methods retain single-engine compatibility; mode validation separated from engine validation. Startup marks abandoned runs interrupted, with no automatic tool/turn replay.
- [x] Failed/cancelled role preserves siblings; dependent steps pause and can retry only selected failure with same immutable config. Whole-turn stop freezes scheduling, cancels approvals and waits for owned process cleanup. Persist public messages/tool results and source attribution for history handoff, without internal reasoning.
- [x] Run scheduler/store/handoff tests; spec and quality review; commit.

## Task 5: Router, template APIs and desktop frontend

Files: modify `router.mjs`, `gateway.mjs`, `codex-events.mjs`, `scripts/assets/agent-modes-ui.js`, `scripts/patch-agent-modes.js`; add focused dual-router tests and extend frontend/patch tests. Extract `orchestration/router.mjs` and `scripts/assets/agent-templates-ui.js` if needed to keep responsibilities readable.

- [x] Write tests for `both` mode turn creation, first-turn/prewarm races, separate model values, strict extended-field stripping, per-run approvals, interruption, metadata suppression and chat history pagination.

```js
api.setDraftSelection(scope,{engineMode:'both',engineModels:{codex:'gpt-x',claude:'claude-y'},
  template:{id:'debby',revision:1,parameters:{rounds:1}}});
const fields = api.capture(scope,'local');
assert.equal(fields.engineModels.codex,'gpt-x');
assert.equal(fields.engineModels.claude,'claude-y');
assert.equal(fields.template.id,'debby');
```

- [x] Implement template CRUD/import/export RPCs and multi-run read/interrupt/retry APIs. Capabilities reflect actually available local runner and schema versions, with remote still unavailable until remote gateway exists. Route all ownership keys through host/chat/turn/run identity.
- [x] Expose both model controls together, preserving native Codex picker and effort settings. Extend immutable creation intent/request capture to `engineModels` and `template`; snapshot at send time rather than reread mutable UI after thread creation. Disable only active chat controls.
- [x] Template management UI supports new/duplicate/edit/delete/import/export, basic role/name/parameter form plus YAML editor, field errors and built-in read-only behavior. Show built-in descriptions and coordinator engine; default Polly, Debby rounds switch.
- [x] Group attributed results in the existing turn, with role/task/engine/model/status, expandable outputs and individual stop/retry. Whole-turn stop uses normal composer control. Display partial failures accurately and allow ending the turn while retaining results. Preserve exact source across reload/mode changes.
- [x] Run router/frontend/patch tests and full existing suite; spec and quality review; commit.

## Task 6: Actual-harness validation, preview and installation

Files: create `tests/agent-modes/live-dual.mjs`; update `docs/agent-modes.md` and evidence under ignored `.artifacts/`.

- [x] Run `node --test tests/agent-modes/*.test.mjs`; require zero failures.
- [x] In an isolated temporary Git project, execute Debby with distinct exact models, a bounded debate, Polly with two independently modified files plus cross-review, and a custom reversed coordinator/step workflow. Verify live process/model evidence and actual file contents.
- [x] Exercise one-sided model failure, read-only mutation attempts, permission allow/deny, pending approval cancellation, role stop, whole-turn stop and gateway restart. Confirm no duplicate inputs, no unauthorized file writes and no owned process leaks.
- [x] Build independent preview with version-bound patches; verify ASAR integrity/signature. Do not rebuild a running preview.
- [ ] Through the native app GUI, select both models, change template and debate rounds, create/edit/export/import custom template, execute all workflows, inspect grouped output and retry/stop, reopen chat/app and verify persistence.
- [ ] Fix observed failures and rerun affected checks. Final spec/quality review before installation.
- [ ] Back up installed app and matching storage, confirm no active work would be interrupted, install using existing authorized workflow, verify installed hashes/signature/UI. Preserve code, user history and recovery artifacts; document any limits honestly.

## Review and execution notes

Use independently scoped implementers, then independent spec and quality review. Tasks 2 (native runners) and 3 (Git workspaces) have no dependency on each other and own disjoint source/tests: execute them concurrently under dispatching-parallel-agents, with commits serialized by the controller. Native runner review is complete. The generic scheduler may be implemented against the reviewed runner/template contracts while the workspace transaction fix is reviewed; actual Polly workspace integration and live file application still wait for workspace spec and quality approval. Frontend controls and request propagation are independently owned and may proceed against the documented RPC contract. The controller may perform capability research while implementation runs. Reuse the active worktree and preserve the published previous version. Do not push unfinished implementation merely because previous-version publishing was authorized; current task is to make and verify the feature locally.

All six tasks are necessary for the requested first release. The task is not complete when only the selector or Debby works.


## Execution checkpoint

- Templates, native role runners, conversation store/public handoff: spec and quality approved.
- Workspace manager: spec and quality approved after canonical diff settings, add/add integration, concurrent short-write publication and transition fixes; committed after review in `1ecb288`.
- Scheduler recovery, history cursors, permission failure propagation, early write preflight: reviewed and committed with router/frontend recovery fixes in `4b5eac7`.
- Frontend/template controls and native shortcut guards: spec/quality approved; cache ordering regression fixed; 71 frontend tests passed.
- Router/gateway: spec and quality approved, including host ownership and immediate-stop recovery. Gateway factory wiring awaits final Polly commit.
- Polly: spec approved including effective ownership dependencies. Live findings for strict output schemas, task-vs-integration review scope and optional skipped checks fixed. Final quality fixes for direct-run contract and shared application receipts approved.
- Real Debby and custom reversed-coordinator tests passed. Real Polly completed after explicit same-turn retry: 10 successful attempts plus one retained failed verification, both exact models, one user message, exact two-file application. All five real dual resilience scenarios passed. Final full source suite passed 379/379 after all custom-template fixes (`.artifacts/dual-final-verification.log`). Signed preview built. GUI blocked by locked Mac; unlock requested. Final GUI/installation remain required.
