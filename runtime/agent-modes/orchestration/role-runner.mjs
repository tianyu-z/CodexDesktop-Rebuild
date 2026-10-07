import { ClaudeAdapter } from '../claude-adapter.mjs';
import { CodexRole } from './codex-role.mjs';
import { claudeNativeContent } from '../claude-input.mjs';
import { normalizeClaudeSessionOptions } from '../claude-native-controls.mjs';

/** Each role owns a native harness run; credentials and model slots stay local. */
export class RoleRunner {
  constructor({ claudeAdapter = new ClaudeAdapter(), codexCommand, codexArgs, codexReadArgs, nativeClientFactory } = {}) {
    this.claudeAdapter = claudeAdapter;
    this.codexRole = new CodexRole({ codexCommand, codexArgs, codexReadArgs, nativeClientFactory });
  }

  start(options) {
    if (!['codex', 'claude'].includes(options.engine)) throw new TypeError('Invalid role engine.');
    if (!['read', 'write'].includes(options.access)) throw new TypeError('Invalid role access.');
    if (typeof options.runId !== 'string' || !options.runId) throw new TypeError('Invalid role run ID.');
    if (options.engine === 'codex') return this.codexRole.start(options);
    const scope = id => `${options.runId}:${id}`;
    const scopeReferences = value => value && typeof value === 'object' ? {
      ...value,
      ...(value.parentToolUseId ? { parentToolUseId: scope(value.parentToolUseId) } : {}),
      ...(Array.isArray(value.nativeTasks) ? { nativeTasks: value.nativeTasks.map(task => ({ ...task, ...(task.toolUseId ? { toolUseId: scope(task.toolUseId) } : {}) })) } : {}),
    } : value;
    const run = this.claudeAdapter.start({ ...options,
      claudeOptions: normalizeClaudeSessionOptions(options.claudeOptions),
      // Generated role content may begin with a slash in a custom template.
      // A plain prefix prevents command dispatch on every CLI version while
      // retaining Claude's normal project-instruction and skill attachments.
      prompt: `[Workflow role input]\n${options.prompt}`,
      ...(options.inputContent?.length ? { content: claudeNativeContent([{ type: 'text', text: `[Workflow role input]\n${options.prompt}` }, ...options.inputContent]) } : {}),
      model: options.model === 'default' || options.model == null ? undefined : options.model,
      onEvent: event => options.onEvent?.({ ...scopeReferences(event), ...(event.id ? { id: scope(event.id) } : {}) }),
      onPermission: typeof options.onPermission === 'function' ? request => options.onPermission({ ...request, id: scope(request.id), engine: 'claude', method: 'canUseTool' }) : undefined,
    });
    // The scheduler also consumes terminal/control snapshots, which must use
    // the same tool references as the streamed events that preceded them.
    return { ...run, done: run.done.then(scopeReferences),
      ...(typeof run.interrupt === 'function' ? { interrupt: async (...args) => scopeReferences(await run.interrupt(...args)) } : {}),
      ...(typeof run.control === 'function' ? { control: async (...args) => scopeReferences(await run.control(...args)) } : {}),
    };
  }
}
