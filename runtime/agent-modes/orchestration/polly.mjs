import { createHash } from 'node:crypto';
import { matchesGlob, posix } from 'node:path';
import { renderInputs } from './inputs.mjs';

const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const verdictSchema = {
  type: 'object', additionalProperties: false, required: ['passed', 'issues'], properties: {
    passed: { type: 'boolean' }, issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['message', 'path'], properties: { message: { type: 'string' }, path: { type: ['string', 'null'] } } } },
  },
};
const checkSchema = { ...verdictSchema, required: ['passed', 'issues', 'checks'], properties: { ...verdictSchema.properties,
  checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['description', 'status', 'details'], properties: { description: { type: 'string' }, status: { enum: ['passed', 'failed', 'not-run'] }, details: { type: ['string', 'null'] } } } },
} };

function validateVerdict(value, checks = false) {
  const object = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).every(key => keys.includes(key));
  const string = value => typeof value === 'string' && value.trim().length > 0;
  if (!object(value, checks ? ['passed', 'issues', 'checks'] : ['passed', 'issues']) || typeof value.passed !== 'boolean' || !Array.isArray(value.issues)
    || value.issues.some(issue => !object(issue, ['message', 'path']) || !string(issue.message) || (Object.hasOwn(issue, 'path') && issue.path !== null && !string(issue.path)))) throw new Error('Invalid structured review verdict; expected {passed:boolean,issues:[{message,path?}]}.');
  if (checks && (!Array.isArray(value.checks) || value.checks.some(check => !object(check, ['description', 'status', 'details']) || !string(check.description)
    || !['passed', 'failed', 'not-run'].includes(check.status) || (Object.hasOwn(check, 'details') && check.details !== null && typeof check.details !== 'string')))) throw new Error('Invalid structured integration checks.');
  if (checks && value.passed && (!value.checks.some(check => check.status === 'passed') || value.checks.some(check => check.status === 'failed'))) throw new Error('Passing integration requires evidence of passed checks and no failed checks.');
  const normalized = clone(value);
  for (const issue of normalized.issues) if (issue.path === null) delete issue.path;
  for (const check of normalized.checks ?? []) if (check.details === null) delete check.details;
  return normalized;
}

const nativePublic = result => Object.fromEntries(['id', 'engine', 'roleId', 'stepId', 'attempt', 'round', 'status', 'requestedModel', 'actualModel', 'text', 'structuredOutput', 'nativeSessionId', 'usage'].filter(key => result?.[key] !== undefined).map(key => [key, result[key]]));
const evidence = (result, roleId, options, details = result.structuredOutput?.checks) => ({ kind: 'model-reported', engine: options.template.roles[roleId].engine, roleId, requestedModel: Object.hasOwn(options.template.roles[roleId], 'model') ? options.template.roles[roleId].model : options.models[options.template.roles[roleId].engine], text: result.text ?? '', ...(details === undefined ? {} : { checks: clone(details) }) });
const taskSignature = dependencies => dependencies.map(entry => [entry.task.id, entry.artifact.head, entry.artifact.hash]);

/** Isolated artifact operations; all native work goes through the scheduler's global budget. */
export function createPollyOperations({ invoke, options, workspaces, signal, checkpoint = () => {}, getCheckpoint = () => undefined, getInvocation = () => undefined, notifySnapshot = () => {}, fail = () => {} }) {
  const pending = new Map(), writers = new Set();
  const alive = () => { if (signal?.aborted) throw new Error('Workflow interrupted.'); };
  const saved = async (key, produce) => {
    alive(); const name = `polly:${key}`, previous = getCheckpoint(name);
    if (previous !== undefined) return clone(previous);
    if (!pending.has(name)) pending.set(name, (async () => { const value = await produce(); alive(); checkpoint(name, value); notifySnapshot(); return value; })().finally(() => pending.delete(name)));
    return clone(await pending.get(name));
  };
  const base = () => saved('base', () => workspaces.prepare({ cwd: options.cwd, runId: options.runId, signal }));
  const call = (descriptor, values) => { alive(); return invoke({ ...descriptor, prompt: renderInputs(Object.keys(values), ref => values[ref]), inputValues: clone(values) }); };
  const context = values => ({ request: options.input, history: options.history, ...values });
  const instructions = (roleId, extra) => `${options.template.roles[roleId].prompt}\n\n${extra}`;
  const originalContract = (run, fallback) => {
    const source = getInvocation(run) ?? run.sourceContract ?? fallback;
    if (!source || typeof source.instructions !== 'string' || typeof source.prompt !== 'string' || !['read', 'write'].includes(source.access)) throw new Error('The original direct-run assignment is unavailable.');
    return clone({ instructions: source.instructions, prompt: source.prompt, access: source.access, purpose: source.purpose ?? 'default', ...(source.inputValues === undefined ? {} : { inputValues: source.inputValues }) });
  };
  const branches = async jobs => {
    const results = await Promise.allSettled(jobs.map(job => job.catch(error => { if (!signal?.aborted) fail(error); throw error; })));
    const failed = results.find(value => value.status === 'rejected'); if (failed) throw failed.reason;
    return results.map(value => value.value);
  };
  const prefix = scope => {
    const wildcard = scope.search(/[*?[{(+@!]/); if (wildcard < 0) return scope;
    const fixed = scope.slice(0, wildcard);
    return fixed.endsWith('/') ? fixed.slice(0, -1) : posix.dirname(fixed || '.');
  };
  const overlaps = (left, right) => left.some(a => right.some(b => { const x = prefix(a), y = prefix(b); return x === '.' || y === '.' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); }));
  function ownershipDependencies(tasks) {
    const byId = new Map(tasks.map(task => [task.id, task])), seen = new Set(), ordered = [];
    const visit = id => {
      if (seen.has(id)) return;
      seen.add(id); const task = byId.get(id);
      for (const dependency of [...task.dependsOn].sort()) visit(dependency);
      ordered.push(task);
    };
    for (const id of [...byId.keys()].sort()) visit(id);
    const dependencies = new Map(), ancestors = new Map(), writers = [];
    for (const task of ordered) {
      const direct = [...task.dependsOn], inherited = new Set();
      const inherit = id => { inherited.add(id); for (const ancestor of ancestors.get(id)) inherited.add(ancestor); };
      direct.forEach(inherit);
      if (task.purpose === 'implement') {
        // Orient ownership edges along the existing DAG. Later writers compose
        // against earlier snapshots instead of only waiting on their processes.
        for (const previous of [...writers].reverse()) {
          if (!inherited.has(previous.id) && overlaps(task.files, previous.files)) { direct.push(previous.id); inherit(previous.id); }
        }
        writers.push(task);
      }
      dependencies.set(task.id, direct); ancestors.set(task.id, inherited);
    }
    return dependencies;
  }
  async function withScopes(scopes, action) {
    const previous = [...writers].filter(writer => overlaps(scopes, writer.scopes));
    let release; const finished = new Promise(resolve => { release = resolve; });
    const writer = { scopes, finished }; writers.add(writer);
    try { await Promise.all(previous.map(writer => writer.finished)); alive(); return await action(); }
    finally { writers.delete(writer); release(); }
  }

  function validateFiles(artifact, base, scopes, writable) {
    const prefix = base.subdirectory ? `${base.subdirectory.replaceAll('\\', '/')}/` : '';
    for (const file of artifact.files) {
      const path = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : prefix ? null : file;
      if (!writable || path === null || !scopes.some(scope => scope === '**' || matchesGlob(path, scope) || (!/[*?[{]/.test(scope) && path.startsWith(`${scope}/`)))) throw new Error(`Task wrote outside its permitted file scope: ${file}`);
    }
  }

  async function executeTask(task, roleId, dependencies, frame, key, extra = {}, existingWorkspace, effectiveDependsOn = task.dependsOn) {
    const action = () => executeTaskUnlocked(task, roleId, dependencies, frame, key, extra, existingWorkspace, effectiveDependsOn);
    return task.purpose === 'implement' ? withScopes(task.files, action) : action();
  }
  async function executeTaskUnlocked(task, roleId, dependencies, frame, key, extra, existingWorkspace, effectiveDependsOn) {
    const baseline = await base();
    const dependencyReasons = effectiveDependsOn.filter(id => !task.dependsOn.includes(id)).map(id => ({ id, reason: 'overlapping-write-scopes' }));
    const workspace = await saved(`${key}:workspace`, () => existingWorkspace ?? workspaces.task(baseline, { id: task.id, dependsOn: effectiveDependsOn, dependencies: dependencies.map(entry => entry.artifact), signal }));
    const result = await call({ roleId, stepId: key, round: frame.round, cwd: workspace.cwd, access: task.purpose === 'implement' ? 'write' : 'read', purpose: 'task',
      instructions: instructions(roleId, 'Work only in this isolated project. File scopes are relative to the supplied working directory. Acceptance criteria are requirements, never commands to execute literally. Do not change files outside the assigned scopes. Preserve all dependency changes. Report actual checks accurately.'),
      validateResult: async native => {
        const artifact = await workspaces.freeze(workspace, { acceptance: task.acceptance, checks: [evidence(native, roleId, options)], signal });
        validateFiles(artifact, baseline, task.files, task.purpose === 'implement');
        return { artifact };
      },
    }, context({ task, execution: { effectiveDependsOn, dependencyReasons }, dependencies: dependencies.map(entry => ({ task: entry.task, result: nativePublic(entry.result), artifact: entry.artifact })), setupRequirements: baseline.setupRequirements, ...extra }));
    return { task: clone(task), effectiveDependsOn: clone(effectiveDependsOn), dependencyReasons, engine: task.engine, roleId, result, workspace, artifact: result.artifact };
  }

  const run = (step, frame) => withScopes(['**'], () => runUnlocked(step, frame));
  async function runUnlocked(step, frame) {
    const baseline = await base();
    const workspace = await saved(`${frame.path}:workspace`, () => workspaces.task(baseline, { id: frame.path, dependsOn: [], dependencies: [], signal }));
    const values = { ...frame.inputs, workspaceContract: { isolated: true, setupRequirements: baseline.setupRequirements } };
    const descriptor = { roleId: step.role, stepId: frame.path, round: frame.round, cwd: workspace.cwd, access: 'write', purpose: 'direct-write',
      instructions: instructions(step.role, `${step.prompt ?? ''}\nWork only in this isolated project. The result will be retained as an artifact. Do not modify other workspaces.`) };
    const fallback = { ...descriptor, inputValues: values, prompt: renderInputs(Object.keys(values), ref => values[ref]) };
    const result = await call({ ...descriptor,
      validateResult: async native => {
        const artifact = await workspaces.freeze(workspace, { checks: [evidence(native, step.role, options)], signal });
        validateFiles(artifact, baseline, ['**'], true);
        return { artifact, workspace, base: baseline, sourceContract: originalContract(descriptor, fallback) };
      },
    }, values);
    return result;
  }

  async function repairDirect(entry, frame, key, verdict, attempt) {
    const contract = entry.sourceContract;
    const values = { ...(contract.inputValues ?? { '$originalPrompt': contract.prompt }), '$repair': { attempt, review: verdict, previousResult: nativePublic(entry.result) } };
    const repair = async () => {
      const result = await call({ roleId: entry.roleId, stepId: key, round: frame.round, cwd: entry.workspace?.cwd ?? entry.result.cwd ?? options.cwd,
        access: contract.access, instructions: contract.instructions, purpose: contract.purpose,
        validateResult: async native => {
          if (!entry.artifact) return { sourceContract: contract };
          const baseline = await base();
          const artifact = await workspaces.freeze(entry.workspace, { acceptance: entry.artifact.acceptance, checks: [evidence(native, entry.roleId, options)], signal });
          validateFiles(artifact, baseline, ['**'], true);
          return { artifact, workspace: entry.workspace, base: baseline, sourceContract: contract };
        },
      }, values);
      return { ...entry, result, ...(result.artifact ? { artifact: result.artifact } : {}) };
    };
    return contract.access === 'write' ? withScopes(['**'], repair) : repair();
  }

  async function executeTasks(step, frame) {
    const plan = frame.resolve(step.plan), baseline = await base(), jobs = new Map(), effective = ownershipDependencies(plan.tasks);
    const schedule = task => {
      if (!jobs.has(task.id)) jobs.set(task.id, (async () => {
        const ids = effective.get(task.id), dependencies = await Promise.all(ids.map(id => schedule(plan.tasks.find(task => task.id === id))));
        const key = `${frame.path}.task.${task.id}${dependencies.length ? `.dependencies.${digest(taskSignature(dependencies))}` : ''}`;
        return executeTask(task, step.roles[task.engine], dependencies, frame, key, {}, undefined, ids);
      })());
      return jobs.get(task.id);
    };
    const tasks = await branches(plan.tasks.map(schedule));
    return { type: 'executeTasks', status: 'completed', tasks, base: baseline, roles: clone(step.roles) };
  }

  async function review(entry, step, frame, key, artifact = entry.artifact, { phase = 'task', entries = [entry] } = {}) {
    const roleId = step.reviewers[entry.engine];
    if (!roleId || options.template.roles[roleId]?.engine === entry.engine) throw new Error(`Missing opposite-engine reviewer for ${entry.engine}.`);
    const baseline = artifact ? await base() : null;
    const workspace = artifact ? await saved(`${key}:workspace`, () => workspaces.review(baseline, artifact, { id: key, signal })) : null;
    const scope = { taskIds: entries.map(value => value.task.id), files: [...new Set(entries.flatMap(value => value.task.files))], acceptance: entries.flatMap(value => value.task.acceptance) };
    const phaseInstructions = {
      task: 'Task review phase: evaluate the assigned task contract, its acceptance criteria, and its fixed diff/result. The workflow request supplies background for this task. Other independent task outputs and checks scheduled after integration are assessed in later phases; their absence from this task snapshot is not a defect. Raise concrete correctness, security, regression, or task-acceptance failures introduced by this task, including incompatibilities visible in its supplied dependency snapshot. Do not waive checks explicitly required by the assigned task contract.',
      integration: 'Integration review phase: evaluate the combined snapshot against the full request and all supplied task acceptance criteria. Assess all task outputs together, interactions between their changes, and the reported integration checks. Report missing required outputs, concrete correctness defects, and required acceptance checks that failed, were skipped, or were not run. A documented non-applicable check may be reported as not-run; determine applicability from the task contracts and project evidence. This fixed snapshot includes post-check modifications. Application to the original workspace is pending this review, so delivery has not happened yet.',
      direct: 'Direct-result review phase: assess the supplied direct result against sourceContract, which records the original instructions, step-specific prompt, and resolved input values. Treat that assignment as review evidence while remaining a read-only reviewer. This review does not imply integration or application to the original workspace.',
    }[phase];
    const target = { phase, scope, implementerEngine: entry.engine,
      ...(phase === 'integration' ? { tasks: entries.map(value => ({ task: value.task, engine: value.engine, result: nativePublic(value.result) })) } : { task: entry.task, result: nativePublic(entry.result) }),
      ...(phase === 'direct' ? { sourceContract: entry.sourceContract } : {}),
      ...(artifact ? { snapshot: { hash: artifact.hash, diffPath: artifact.diffPath, files: artifact.files, head: artifact.head, baseHead: artifact.baseHead, acceptance: artifact.acceptance, checks: artifact.checks }, baselineCwd: workspace.baseCwd } : {}) };
    const values = phase === 'task' ? { history: options.history, workflowContext: { request: options.input, meaning: 'Background for the assigned task; the task contract defines this review scope.' }, target } : context({ target });
    const result = await call({ roleId, stepId: key, round: frame.round, cwd: workspace?.cwd ?? options.cwd, access: 'read', purpose: 'cross-review', outputSchema: verdictSchema,
      instructions: instructions(roleId, `${phaseInstructions}\nReview only the supplied immutable snapshot and public result. Never enter an implementer workspace. Report a structured verdict; use null for an issue path that does not apply. Do not claim to execute checks unavailable to this read-only role.`),
      validateResult: native => ({ verdict: validateVerdict(native.structuredOutput), reviewPhase: phase, reviewScope: scope, implementerEngine: entry.engine, taskId: entry.task.id, ...(artifact ? { artifactHash: artifact.hash } : {}) }),
    }, values);
    return result;
  }

  async function crossReview(step, frame) {
    const target = frame.resolve(step.target), isTasks = target.type === 'executeTasks';
    const tasks = isTasks ? target.tasks : [{ task: { id: step.target, description: 'Review the direct result', purpose: target.artifact ? 'implement' : 'explore', engine: target.engine, dependsOn: [], files: ['**'], acceptance: [] }, engine: target.engine, roleId: target.roleId, result: target, workspace: target.workspace, artifact: target.artifact, sourceContract: originalContract(target) }];
    const maxRepairs = step.maxRepairs ?? Math.min(2, options.template.limits.rounds), jobs = new Map();
    const schedule = original => {
      if (!jobs.has(original.task.id)) jobs.set(original.task.id, (async () => {
        const effectiveDependsOn = original.effectiveDependsOn ?? original.task.dependsOn;
        const dependencies = await Promise.all(effectiveDependsOn.map(id => schedule(tasks.find(entry => entry.task.id === id))));
        if (dependencies.some(value => !value.passed)) return { entry: original, passed: false, reviews: [] };
        const latest = dependencies.map(value => value.entry), prefix = `${frame.path}.task.${original.task.id}`;
        let entry = original;
        if (entry.artifact && latest.some(dependency => entry.artifact.dependencies.find(value => value.id === dependency.task.id)?.head !== dependency.artifact.head)) {
          entry = await executeTask(entry.task, entry.roleId, latest, frame, `${prefix}.rebuild.${digest(taskSignature(latest))}`, { previousResult: nativePublic(entry.result), reason: 'Dependencies changed after independent review; rebuild this task against the supplied current dependency artifacts.' }, undefined, effectiveDependsOn);
        }
        const reviews = [];
        for (let attempt = 0; attempt <= maxRepairs; attempt++) {
          const revision = entry.artifact?.hash ?? digest(nativePublic(entry.result));
          const verdict = await review(entry, step, frame, `${prefix}.review.${attempt}.${revision}`, entry.artifact, { phase: isTasks ? 'task' : 'direct' }); reviews.push(verdict);
          if (verdict.verdict.passed) return { entry, passed: true, reviews };
          if (attempt === maxRepairs) return { entry, passed: false, reviews };
          const key = `${prefix}.repair.${attempt + 1}`;
          if (!isTasks) entry = await repairDirect(entry, frame, key, verdict, attempt + 1);
          else entry = await executeTask(entry.task, entry.roleId, latest, frame, key,
            { previousResult: nativePublic(entry.result), repair: { attempt: attempt + 1, review: verdict } }, entry.workspace, effectiveDependsOn);
        }
      })());
      return jobs.get(original.task.id);
    };
    const outcomes = await branches(tasks.map(schedule)), reviewedTasks = outcomes.map(value => value.entry), reviews = outcomes.flatMap(value => value.reviews);
    const result = { type: 'crossReview', status: outcomes.every(value => value.passed) ? 'completed' : 'blocked', tasks: reviewedTasks, reviews };
    if (!isTasks) return result;
    const implementations = reviewedTasks.filter(entry => entry.task.purpose === 'implement');
    if (!implementations.length) return { ...result, integration: { status: 'not-applicable', checks: [], application: { status: 'not-applicable' } } };
    if (result.status !== 'completed') return { ...result, integration: { status: 'blocked', checks: [], application: { status: 'not-applied' } } };
    const baseline = await base(), signature = digest(implementations.map(entry => entry.artifact.hash));
    let artifact = await saved(`${frame.path}:integration:${signature}`, () => workspaces.integrate(baseline, implementations.map(entry => entry.artifact), { signal }));
    const repairs = [], verifications = [], acceptance = implementations.flatMap(entry => entry.task.acceptance), scopes = implementations.flatMap(entry => entry.task.files);
    let owner = implementations[0];
    const integratedContext = () => ({ hash: artifact.hash, files: artifact.files, tasks: implementations.map(entry => entry.task), conflicts: artifact.conflicts });
    const finish = (status, application, reason) => ({ ...result, status: status === 'verified' ? 'completed' : 'blocked', reviews,
      integration: { status, ...(reason ? { reason } : {}), artifact, checks: artifact.checks, verification: verifications.at(-1), verifications, repairs, application } });
    const repair = async issues => {
      const repaired = await call({ roleId: owner.roleId, stepId: `${frame.path}.integration.repair.${repairs.length + 1}.${artifact.hash}`, round: frame.round, cwd: artifact.cwd, access: 'write', purpose: 'integration-repair',
        instructions: instructions(owner.roleId, 'Repair the supplied integration issues in this isolated project. Preserve the reviewed task changes and their acceptance requirements. Resolve and stage every Git conflict. Restrict edits to the combined implementation file scopes. Do not treat acceptance strings as shell commands. Report actual checks accurately.'),
        validateResult: async native => {
          const frozen = await workspaces.finalizeIntegration(baseline, artifact, { acceptance, checks: [evidence(native, owner.roleId, options)], signal });
          validateFiles(frozen, baseline, scopes, true); return { artifact: frozen };
        },
      }, context({ integration: integratedContext(), repair: { attempt: repairs.length + 1, issues } }));
      repairs.push(repaired); artifact = repaired.artifact;
    };
    while (true) {
      alive();
      if (artifact.status !== 'integrated') {
        if (repairs.length === maxRepairs) return finish('blocked', { status: 'not-applied' }, 'Integration conflicts exceeded the configured repair bound.');
        owner = implementations.find(entry => entry.task.id === artifact.conflicts[0]?.taskId) ?? owner;
        await repair(artifact.conflicts); continue;
      }
      const verification = await call({ roleId: owner.roleId, stepId: `${frame.path}.integration.check.${repairs.length}.${artifact.hash}`, round: frame.round, cwd: artifact.cwd, access: 'write', purpose: 'integration-check', outputSchema: checkSchema,
        instructions: instructions(owner.roleId, 'Verify the integrated project in this isolated workspace. Inspect project documentation and run appropriate actual checks. Acceptance strings are requirements, never literal shell commands. Restrict any edits to the supplied implementation scopes. Return {passed,checks:[{description,status,details}],issues:[{message,path}]}; use null for details or paths that do not apply. Set passed false when a required acceptance check is missing, failed, or not run. You may report a non-applicable check as not-run with explanatory details; passing overall requires at least one concrete passed check and no failed checks. Report skipped or unavailable checks honestly.'),
        validateResult: async native => {
          const verdict = validateVerdict(native.structuredOutput, true);
          const frozen = await workspaces.finalizeIntegration(baseline, artifact, { acceptance, checks: [evidence(native, owner.roleId, options, verdict.checks)], signal });
          validateFiles(frozen, baseline, scopes, true);
          return { artifact: frozen, verification: verdict };
        },
      }, context({ integration: integratedContext() }));
      verifications.push(verification); artifact = verification.artifact;
      const finalReview = await review(owner, step, frame, `${frame.path}.integration.review.${repairs.length}.${artifact.hash}`, artifact, { phase: 'integration', entries: implementations }); reviews.push(finalReview);
      if (!verification.verification.passed || !finalReview.verdict.passed) {
        if (repairs.length === maxRepairs) return finish('blocked', { status: 'not-applied' }, 'Integration checks or review exceeded the configured repair bound.');
        await repair([...verification.verification.issues, ...finalReview.verdict.issues]); continue;
      }
      try {
        const key = `apply:${artifact.hash}`, reused = getCheckpoint(`polly:${key}`) !== undefined || pending.has(`polly:${key}`);
        const application = await saved(key, () => workspaces.apply(baseline, artifact, { signal }));
        return finish('verified', { ...application, reused });
      } catch (error) {
        alive();
        return finish('blocked', { status: 'blocked', code: error.code ?? 'APPLICATION_FAILED', error: error.message, ...(error.details ? { details: clone(error.details) } : {}) }, 'The verified artifact could not be applied to the original workspace.');
      }
    }
  }

  return { prepare: base, run, executeTasks, crossReview };
}
