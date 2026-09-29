import { isDeepStrictEqual } from 'node:util';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const deny = message => ({ decision: 'decline', message });
const once = 'Allow once', reusable = 'Allow for current run';
const manualPlan = 'Approve with manual permissions', editsPlan = 'Approve with automatic edits';
const knownKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

// A native session rule lives in the owned process. This app closes that process
// after every turn; neither settings-file writes nor cross-turn grants are implied.
function reusableSuggestions(request) {
  const values = request.suggestions;
  if (request.suppressAlwaysAllowRule === true || !Array.isArray(values) || !values.length) return [];
  const valid = values.every(update => {
    if (!record(update) || update.destination !== 'session') return false;
    if (update.type === 'addRules') return knownKeys(update, ['type', 'destination', 'behavior', 'rules']) && update.behavior === 'allow' &&
      Array.isArray(update.rules) && update.rules.length > 0 && update.rules.every(rule => record(rule) && knownKeys(rule, ['toolName', 'ruleContent']) && nonempty(rule.toolName) && (rule.ruleContent === undefined || typeof rule.ruleContent === 'string'));
    return update.type === 'addDirectories' && knownKeys(update, ['type', 'destination', 'directories']) &&
      Array.isArray(update.directories) && update.directories.length > 0 && update.directories.every(nonempty);
  });
  return valid ? structuredClone(values) : [];
}

/** Validate grants at the SDK boundary against the native pending request. */
export function selectedClaudePermissionUpdates(request, response) {
  if (response.permissionMode !== undefined) {
    if (request.name !== 'ExitPlanMode' || !nonempty(request.input?.plan) || !['default', 'acceptEdits'].includes(response.permissionMode) || response.updatedPermissions !== undefined) throw new Error('Invalid plan permission selection.');
    return [{ type: 'setMode', mode: response.permissionMode, destination: 'session' }];
  }
  if (response.updatedPermissions === undefined) return undefined;
  const suggestions = reusableSuggestions(request);
  if (request.name === 'AskUserQuestion' || request.name === 'ExitPlanMode' || !suggestions.length || !isDeepStrictEqual(response.updatedPermissions, suggestions)) throw new Error('Permission updates do not match the native current-run suggestions.');
  return suggestions;
}

function answerValues(response, id, multiSelect = false) {
  if (!record(response) || response.decision !== undefined || !record(response.answers) || !Object.hasOwn(response.answers, id)) return null;
  const values = response.answers[id]?.answers;
  if (!Array.isArray(values) || !values.length || !values.every(nonempty) || (!multiSelect && values.length !== 1)) return null;
  return [...new Set(values.map(value => value.trim()))];
}

function userInput(questions, respond) {
  return { method: 'item/tool/requestUserInput', params: { isBlocking: true, questions }, respond };
}

/** Keep only server-owned input/suggestions in the closure, never client grants. */
export function createClaudeInteraction(nativeRequest) {
  const { signal, ...serializable } = nativeRequest;
  const request = structuredClone(serializable), input = request.input;
  if (!record(input)) throw new Error('Claude supplied malformed tool input.');
  if (request.name === 'AskUserQuestion') {
    const nativeQuestions = input.questions;
    if (!Array.isArray(nativeQuestions) || nativeQuestions.length < 1 || nativeQuestions.length > 4 ||
      nativeQuestions.some(question => !record(question) || !nonempty(question.question)) ||
      new Set(nativeQuestions.map(question => question.question)).size !== nativeQuestions.length) throw new Error('Claude supplied missing or duplicate question text.');
    const questions = nativeQuestions.map((question, index) => {
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4 ||
        question.options.some(option => !record(option) || !nonempty(option.label)) ||
        new Set(question.options.map(option => option.label.trim())).size !== question.options.length) throw new Error('Claude supplied malformed question options.');
      return {
        id: `question_${index}`, header: nonempty(question.header) ? question.header : 'Claude Code', question: question.question,
        isOther: true, isMultiSelect: question.multiSelect === true,
        // The app renders text descriptions, so preserve previews as text rather
        // than promising the native preview viewer or dropping their content.
        options: question.options.map(option => ({ label: option.label, description: [option.description, option.preview].filter(nonempty).join('\n\n') })),
      };
    });
    return userInput(questions, response => {
      const entries = questions.map((question, index) => {
        const values = answerValues(response, question.id, question.isMultiSelect);
        return values ? [nativeQuestions[index].question, values.join(', ')] : null;
      });
      if (entries.some(entry => entry === null)) return deny('Questions were cancelled or answered incompletely. Please ask again if needed.');
      return { decision: 'accept', updatedInput: { ...structuredClone(input), answers: Object.fromEntries(entries) } };
    });
  }
  if (request.name === 'ExitPlanMode') {
    const hasPlan = nonempty(input.plan);
    const question = {
      id: 'plan', header: 'Claude plan', isOther: true,
      question: [request.title, hasPlan ? input.plan : 'Claude did not supply a plan to review.', 'Choose how to proceed, or describe the changes Claude should make to the plan.'].filter(nonempty).join('\n\n'),
      options: [
        ...(hasPlan ? [{ label: manualPlan, description: 'Leave plan mode using native default permissions.' }, { label: editsPlan, description: 'Leave plan mode and allow native automatic file edits (acceptEdits).' }] : []),
        { label: 'Revise plan', description: 'Keep planning and ask Claude to revise the plan.' },
      ],
    };
    return userInput([question], response => {
      const answer = answerValues(response, 'plan')?.[0];
      if (hasPlan && [manualPlan, editsPlan].includes(answer)) return { decision: 'accept', updatedInput: structuredClone(input), permissionMode: answer === manualPlan ? 'default' : 'acceptEdits' };
      return deny(answer && ![manualPlan, editsPlan, 'Revise plan'].includes(answer) ? answer : 'Please stay in plan mode and revise the plan before asking for approval again.');
    });
  }
  const suggestions = reusableSuggestions(request);
  const options = [{ label: once, description: 'Authorize only this tool request.' },
    ...(suggestions.length ? [{ label: reusable, description: `Apply these native rules until this Claude run ends:\n${JSON.stringify(suggestions, null, 2)}` }] : []),
    { label: 'Deny', description: 'Decline, or type feedback to explain what Claude should do instead.' }];
  const question = {
    id: 'permission', header: 'Claude Code', isOther: true,
    question: [request.title || `Allow Claude Code tool ${request.name}?`, request.description, request.reason,
      request.blockedPath ? `Blocked path: ${request.blockedPath}` : '', JSON.stringify(input, null, 2),
      request.defaultToNo === true ? `Type "${once}"${suggestions.length ? ` or "${reusable}"` : ''} to authorize. Type any other feedback to decline.` : 'Choose an option, or type feedback to decline and guide Claude.'].filter(nonempty).join('\n\n'),
    // Native defaultToNo forbids a one-key approval. The free-text-only widget
    // requires an explicit full phrase and cannot approve from a stray shortcut.
    options: request.defaultToNo === true ? [] : options,
  };
  if (request.defaultToNo === true && suggestions.length) question.question += `\n\nCurrent-run native rules:\n${JSON.stringify(suggestions, null, 2)}`;
  return userInput([question], response => {
    const answer = answerValues(response, 'permission')?.[0];
    if (answer === once) return { decision: 'accept', updatedInput: structuredClone(input) };
    if (answer === reusable && suggestions.length) return { decision: 'accept', updatedInput: structuredClone(input), updatedPermissions: structuredClone(suggestions) };
    if (response?.decision === 'acceptForSession' || answer === reusable) return deny('A permission for the entire chat session is unavailable. Please choose an offered permission scope.');
    return deny(answer && answer !== 'Deny' ? answer : 'Permission declined by user.');
  });
}
