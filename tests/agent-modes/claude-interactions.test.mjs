import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeInteraction, selectedClaudePermissionUpdates } from '../../runtime/agent-modes/claude-interactions.mjs';

const question = (extra = {}) => ({ question: 'Which package?', header: 'Package', multiSelect: false, options: [{ label: 'API', description: 'Server' }, { label: 'UI', description: 'Client' }], ...extra });
const ask = questions => ({ name: 'AskUserQuestion', input: { questions }, id: 'native-question' });
const reply = (id, ...answers) => ({ answers: { [id]: { answers } } });
const suggestions = [
  { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], destination: 'session' },
  { type: 'addDirectories', directories: ['/workspace/tests'], destination: 'session' },
];
const permission = (extra = {}) => ({ name: 'Bash', input: { command: 'npm test' }, suggestions: structuredClone(suggestions), ...extra });

test('native multiple questions preserve labels, free text, previews, and native comma-separated answers', () => {
  const request = ask([question({ multiSelect: true }), question({ question: 'How to deploy?', options: [{ label: 'Container', description: 'Isolated', preview: 'FROM node:24' }, { label: 'Host', description: 'Direct' }] })]);
  const interaction = createClaudeInteraction(request);
  assert.equal(interaction.method, 'item/tool/requestUserInput');
  assert.deepEqual(interaction.params.questions[0], { question: 'Which package?', header: 'Package', options: question().options, id: 'question_0', isOther: true, isMultiSelect: true });
  assert.match(interaction.params.questions[1].options[0].description, /FROM node:24/);
  assert.deepEqual(interaction.respond({ answers: { question_0: { answers: ['API', 'UI', 'worker'] }, question_1: { answers: ['Custom deployment'] } }, updatedInput: { injected: true } }), {
    decision: 'accept', updatedInput: { ...request.input, answers: { 'Which package?': 'API, UI, worker', 'How to deploy?': 'Custom deployment' } },
  });
});

test('empty, incomplete, malformed and cancelled answers fail closed', () => {
  const interaction = createClaudeInteraction(ask([question(), question({ question: 'Second?' })]));
  for (const response of [null, {}, { answers: {} }, reply('question_0', 'API'), { answers: { question_0: { answers: ['API', 'UI'] }, question_1: { answers: ['UI'] } } }, { answers: { question_0: { answers: ['  '] }, question_1: { answers: ['UI'] } } }, { answers: { question_0: { answers: [42] }, question_1: { answers: ['UI'] } } }, ...['cancel', 'decline', 'acceptForSession'].map(decision => ({ decision, answers: { question_0: { answers: ['API'] }, question_1: { answers: ['UI'] } } }))]) {
    assert.equal(interaction.respond(response).decision, 'decline');
  }
});

test('questions that cannot be faithfully keyed or rendered are rejected', () => {
  for (const questions of [[], [question(), question()], [question({ options: [{ label: 'API' }, { label: 'API' }] })], [question({ question: '' })]]) {
    assert.throws(() => createClaudeInteraction(ask(questions)), /question|option/i);
  }
  const interaction = createClaudeInteraction(ask([question({ question: '__proto__' })]));
  const response = interaction.respond(reply('question_0', 'API'));
  assert.equal(Object.hasOwn(response.updatedInput.answers, '__proto__'), true);
  assert.equal(response.updatedInput.answers.__proto__, 'API');
});

test('plan approval shows the injected plan and offers only explicit default or acceptEdits modes', () => {
  const input = { plan: '# Plan\n1. Implement API', allowedPrompts: [{ tool: 'Bash', prompt: 'anything' }] };
  const interaction = createClaudeInteraction({ name: 'ExitPlanMode', input });
  assert.match(interaction.params.questions[0].question, /# Plan\n1. Implement API/);
  assert.doesNotMatch(interaction.params.questions[0].question, /allowedPrompts|anything/);
  assert.deepEqual(interaction.params.questions[0].options.map(option => option.label), ['Approve with manual permissions', 'Approve with automatic edits', 'Revise plan']);
  for (const [label, mode] of [['Approve with manual permissions', 'default'], ['Approve with automatic edits', 'acceptEdits']]) {
    const response = interaction.respond(reply('plan', label));
    assert.deepEqual(response, { decision: 'accept', updatedInput: input, permissionMode: mode });
    assert.deepEqual(selectedClaudePermissionUpdates({ name: 'ExitPlanMode', input }, response), [{ type: 'setMode', mode, destination: 'session' }]);
  }
  assert.deepEqual(interaction.respond(reply('plan', 'Please add rollback steps.')), { decision: 'decline', message: 'Please add rollback steps.' });
  assert.match(interaction.respond(reply('plan', 'Revise plan')).message, /revise/i);
});

test('a missing native plan cannot be approved invisibly', () => {
  const interaction = createClaudeInteraction({ name: 'ExitPlanMode', input: { allowedPrompts: [] } });
  assert.deepEqual(interaction.params.questions[0].options.map(option => option.label), ['Revise plan']);
  assert.equal(interaction.respond(reply('plan', 'Approve with automatic edits')).decision, 'decline');
});

test('generic approvals show native metadata and scope reusable permissions to the current run', () => {
  const request = permission({ title: 'Run project tests?', reason: 'Approval required', blockedPath: '/workspace/tests', description: 'Tests can write fixtures.' });
  const interaction = createClaudeInteraction(request), view = interaction.params.questions[0];
  for (const text of ['Run project tests?', 'Approval required', '/workspace/tests', 'Tests can write fixtures.', 'npm test']) assert.ok(view.question.includes(text));
  assert.deepEqual(view.options.map(option => option.label), ['Allow once', 'Allow for current run', 'Deny']);
  assert.doesNotMatch(JSON.stringify(view), /always allow|for (the )?session/i);
  assert.deepEqual(interaction.respond(reply('permission', 'Allow once')), { decision: 'accept', updatedInput: request.input });
  const response = interaction.respond({ ...reply('permission', 'Allow for current run'), updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' }] });
  assert.deepEqual(response, { decision: 'accept', updatedInput: request.input, updatedPermissions: suggestions });
  assert.deepEqual(selectedClaudePermissionUpdates(request, response), suggestions);
  assert.deepEqual(interaction.respond(reply('permission', 'Run this in a sandbox instead.')), { decision: 'decline', message: 'Run this in a sandbox instead.' });
  assert.equal(interaction.respond({ decision: 'acceptForSession' }).decision, 'decline');
});

test('suggestions and inputs remain the original pending values after request or response mutation', () => {
  const request = permission(), interaction = createClaudeInteraction(request);
  request.input.command = 'injected'; request.suggestions[0].rules[0].ruleContent = '*';
  const first = interaction.respond(reply('permission', 'Allow for current run'));
  assert.equal(first.updatedInput.command, 'npm test'); assert.deepEqual(first.updatedPermissions, suggestions);
  first.updatedPermissions[0].rules[0].ruleContent = '*';
  assert.deepEqual(interaction.respond(reply('permission', 'Allow for current run')).updatedPermissions, suggestions);
});

test('configuration changes, escalation, malformed or suppressed suggestions never offer reusable permission', () => {
  const unsupported = [undefined, [], [{ ...suggestions[0], destination: 'userSettings' }], [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }], [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 2 }] }], [{ ...suggestions[0], injected: true }]];
  for (const selected of unsupported) {
    const request = permission({ suggestions: selected }), interaction = createClaudeInteraction(request);
    assert.deepEqual(interaction.params.questions[0].options.map(option => option.label), ['Allow once', 'Deny']);
    assert.equal(interaction.respond(reply('permission', 'Allow for current run')).decision, 'decline');
    assert.throws(() => selectedClaudePermissionUpdates(request, { decision: 'accept', updatedPermissions: suggestions }), /permission/i);
  }
  assert.deepEqual(createClaudeInteraction(permission({ suppressAlwaysAllowRule: true })).params.questions[0].options.map(option => option.label), ['Allow once', 'Deny']);
  assert.throws(() => selectedClaudePermissionUpdates(permission(), { decision: 'accept', updatedPermissions: [{ ...suggestions[0], destination: 'userSettings' }] }), /permission/i);
  assert.throws(() => selectedClaudePermissionUpdates(permission(), { decision: 'accept', permissionMode: 'bypassPermissions' }), /permission/i);
});

test('native defaultToNo requests require a typed decision instead of a one-key approval', () => {
  const interaction = createClaudeInteraction(permission({ defaultToNo: true }));
  assert.deepEqual(interaction.params.questions[0].options, []);
  assert.match(interaction.params.questions[0].question, /Type.*Allow once/);
  assert.equal(interaction.respond(reply('permission', 'a')).decision, 'decline');
  assert.equal(interaction.respond(reply('permission', 'Allow once')).decision, 'accept');
});
