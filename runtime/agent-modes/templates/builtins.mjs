// Prompts adapted and substantially rewritten from omnigent-ai/omnigent (Apache-2.0).
// Source revision and modification details are in NOTICE.md; license is LICENSE-APACHE-2.0.
import { validateTemplate } from './schema.mjs';

const role = (engine, prompt, access = 'read', session = 'fresh') => ({ engine, prompt, access, session });
const answerPrompt = 'Answer the user request independently using the supplied public context. Read relevant reference material if needed. Do not modify the project. On a critique round, assess the supplied previous answer from the other engine, identify agreements and disagreements, and give your updated complete answer. Attribute views accurately; do not invent agreement.';

const debbyV1 = {
  schemaVersion: 1, id: 'debby', revision: 1, builtin: true,
  name: 'Debby · 双方讨论',
  description: 'Codex and Claude answer independently, optionally exchange critiques, then Claude summarizes the agreement and remaining differences. Read-only; the summary uses the selected Claude model.',
  roles: {
    codex: role('codex', answerPrompt, 'read', 'reuse'),
    claude: role('claude', answerPrompt, 'read', 'reuse'),
    moderator: role('claude', 'Present both final answers fairly with clear engine attribution. Explain shared ground, changes after critique, and unresolved disagreements. Synthesize only the supplied sources. Preserve access to both originals. Missing or failed answers are missing evidence, never agreement.'),
  },
  parameters: { rounds: { type: 'integer', default: 0, min: 0, max: 5, description: 'Cross-critique rounds; 0 keeps the initial independent answers.' } },
  limits: { concurrency: 2, tasks: 8, rounds: 5 },
  steps: [
    { id: 'answers', type: 'parallel', steps: [
      { id: 'codex', type: 'run', role: 'codex', inputs: ['request', 'history'] },
      { id: 'claude', type: 'run', role: 'claude', inputs: ['request', 'history'] },
    ] },
    { id: 'debate', type: 'repeat', dependsOn: ['answers'], count: { parameter: 'rounds' },
      initial: { codex: 'answers.codex', claude: 'answers.claude' },
      steps: [
        { id: 'codex', type: 'run', role: 'codex', inputs: ['request', 'previousRound.claude'] },
        { id: 'claude', type: 'run', role: 'claude', inputs: ['request', 'previousRound.codex'] },
      ],
      yields: { codex: 'codex', claude: 'claude' },
    },
    { id: 'summary', type: 'synthesize', dependsOn: ['debate'], role: 'moderator', inputs: ['request', 'answers.codex', 'answers.claude', 'debate.codex', 'debate.claude'] },
  ],
  output: { sources: ['debate.codex', 'debate.claude', 'summary'], final: 'summary', format: 'markdown' },
};

const debby = {
  schemaVersion: 2, id: 'debby', revision: 2, builtin: true,
  name: 'Debby · 主持讨论',
  description: 'Two independently configured participants answer and critique with a configurable host. The host guides each round and may stop early when evidence is sufficient. Final-only mode keeps fixed critique rounds.',
  roles: {
    participant_a: role('codex', 'Answer the user request independently from the supplied public context. Read relevant reference material if needed; do not modify the project. In guided critique rounds, inspect both previous answers and host guidance, identify agreements and disagreements, and return your updated complete answer. Attribute evidence and views to participant roles accurately; do not invent agreement.', 'read', 'reuse'),
    participant_b: role('claude', 'Answer the user request independently from the supplied public context. Read relevant reference material if needed; do not modify the project. In guided critique rounds, inspect both previous answers and host guidance, identify agreements and disagreements, and return your updated complete answer. Attribute evidence and views to participant roles accurately; do not invent agreement.', 'read', 'reuse'),
    host: role('claude', 'Host an evidence-based discussion between two independent participants. Assess their arguments fairly, identify unresolved material differences and give focused guidance when more critique would help. Base convergence only on available evidence. For final synthesis, present shared ground, changed views, remaining differences and limitations with accurate participant, engine and model attribution. Missing or failed answers are missing evidence, never agreement. Do not modify the project.'),
  },
  parameters: {
    rounds: { type: 'integer', default: 2, min: 0, max: 5, description: 'Maximum guided critique rounds after the independent answers.' },
    host_mode: { type: 'string', default: 'per-round', enum: ['per-round', 'final-only'], description: 'Guide and assess every round, or synthesize only after fixed critique rounds.' },
  },
  limits: { concurrency: 2, tasks: 8, rounds: 5 },
  steps: [
    { id: 'debate', type: 'hostedDebate', participants: { participant_a: 'participant_a', participant_b: 'participant_b' }, host: 'host', inputs: ['request', 'history'], count: { parameter: 'rounds' }, mode: { parameter: 'host_mode' } },
    { id: 'summary', type: 'synthesize', dependsOn: ['debate'], role: 'host', inputs: ['request', 'debate.sources', 'debate.assessments'], prompt: 'Produce the final synthesis using all supplied completed sources. State remaining uncertainty and unresolved disagreement, including when the configured round limit stopped critique.' },
  ],
  output: { sources: ['debate.participant_a', 'debate.participant_b', 'debate.sources', 'debate.assessments', 'summary'], final: 'summary', format: 'markdown' },
};

const reviewPrompt = 'Independently review the supplied immutable result snapshot and acceptance contract. Read the fixed diff, base/head evidence, and reported checks; do not enter or change the implementer workspace. Review only, never implement. Return JSON {"passed":boolean,"issues":[{"message":string,"path"?:string}]}. Raise concrete correctness or missing acceptance issues. Do not claim checks you did not run.';
const workerPrompt = 'Complete the assigned task in its supplied isolated workspace. Honor the task purpose, file scope, dependencies and acceptance contract. Implement and verify the requested change; for explore or review tasks remain read-only. Report the result and actual checks. Do not push, create a pull request, merge a remote branch, or modify another task workspace. Respond to review findings by repairing the same task and re-running relevant checks.';
const polly = {
  schemaVersion: 1, id: 'polly', revision: 1, builtin: true,
  name: 'Polly · 协作开发',
  description: 'Claude plans bounded coding tasks, Codex and Claude work in isolated workspaces, the opposite engine reviews each fixed result, and Claude summarizes the integrated result. All Claude roles use the selected Claude model.',
  roles: {
    planner: role('claude', 'You coordinate a coding task. Plan and delegate implementation, investigation and independent review; do not edit source or tests. Return only a JSON object {"tasks":[{"id":string,"description":string,"engine":"codex"|"claude","purpose":"implement"|"review"|"explore","dependsOn":string[],"files":string[],"acceptance":string[]}]}. Use stable lowercase IDs, an acyclic dependency graph, project-relative file scopes, and concrete acceptance criteria. Use only the two declared engines and respect the supplied maximum task count. Separate independent work and declare dependencies for shared file scopes. The runtime will assign opposite-engine reviews automatically.'),
    codex_worker: role('codex', workerPrompt, 'write'),
    claude_worker: role('claude', workerPrompt, 'write'),
    codex_reviewer: role('codex', reviewPrompt),
    claude_reviewer: role('claude', reviewPrompt),
    summary: role('claude', 'Summarize the supplied task results, independent reviews and integration evidence. Distinguish implementation completion, review approval, checks actually passed, delivery status and unresolved work. Link original outputs and diffs. Do not claim success for blocked tasks or failed integration. Do not modify code or invent validation results.'),
  },
  parameters: {}, limits: { concurrency: 2, tasks: 8, rounds: 2 },
  steps: [
    { id: 'plan', type: 'planTasks', role: 'planner', inputs: ['request', 'history'], maxTasks: 8 },
    { id: 'implementation', type: 'executeTasks', dependsOn: ['plan'], plan: 'plan',
      roles: { codex: 'codex_worker', claude: 'claude_worker' }, workspace: 'isolated' },
    { id: 'review', type: 'crossReview', dependsOn: ['implementation'], target: 'implementation',
      reviewers: { codex: 'claude_reviewer', claude: 'codex_reviewer' }, maxRepairs: 2, workspace: 'integration' },
    { id: 'summary', type: 'synthesize', dependsOn: ['review'], role: 'summary', inputs: ['request', 'plan', 'implementation', 'review', 'review.integration'] },
  ],
  output: { sources: ['implementation', 'review', 'review.integration', 'summary'], final: 'summary', format: 'markdown' },
};

function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export const BUILTIN_TEMPLATES = freeze([polly, debby].map(validateTemplate));

// Historical built-in snapshots remain addressable by their original revision.
export const BUILTIN_TEMPLATE_REVISIONS = freeze([polly, debbyV1, debby].map(validateTemplate));
