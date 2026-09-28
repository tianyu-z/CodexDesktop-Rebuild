/* Shared renderer helper. React is supplied by the host bundle after its factories initialize. */
(() => {
  if (globalThis.__cdxEngineModes) return;
  const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,255}$/;
  const MODEL_CACHE_TTL = 60_000;
  const modelCatalogs = new WeakMap();
  const codexCatalogs = new WeakMap();
  const disconnectedCodex = newCodexCatalog();
  const disconnectedCatalog = newCatalog();
  const drafts = new WeakMap();
  const templateCatalogs = new WeakMap();
  const disconnectedTemplates = { snapshot: { templates: [], byRevision: {}, loading: false, error: null, loaded: false }, listeners: new Set() };
  const threads = new Map();
  const managers = new Map();
  const key = (threadId, hostId) => `${hostId ?? 'local'}\0${threadId}`;
  const managerHost = manager => { const hostId = manager?.getHostId?.(); return typeof hostId === 'string' ? hostId : 'local'; };
  const copy = value => JSON.parse(JSON.stringify(value));
  const defaultTemplate = () => ({ id: 'polly', revision: 1, parameters: {} });
  function fresh() {
    return { snapshot: { engineMode: 'codex', models: { codex: null, claude: 'default' }, template: defaultTemplate(), roleOverrides: {}, bothAvailable: false, busy: false, pending: false, loading: false, available: null, error: null, turnEngines: {}, workflows: {}, runsError: null, runActions: {} }, listeners: new Set(), revision: 0, hydrated: false, creationIntent: null, read: null, sourcesRead: null, runsRead: new Map(), workflowReadOrder: 0, latestTurnOrder: 0, latestTurnId: null };
  }
  function record(scope, threadId, hostId = 'local') {
    hostId ??= 'local';
    if (threadId != null) {
      const id = key(threadId, hostId);
      if (!threads.has(id)) threads.set(id, fresh());
      return threads.get(id);
    }
    const node = scope?.node ?? scope;
    if (!node || typeof node !== 'object') throw Error('A composer scope is required');
    if (!drafts.has(node)) drafts.set(node, new Map());
    const hosts = drafts.get(node);
    if (!hosts.has(hostId)) hosts.set(hostId, fresh());
    return hosts.get(hostId);
  }
  function update(row, values) {
    const next = { ...row.snapshot, ...values };
    if (JSON.stringify(next) === JSON.stringify(row.snapshot)) return;
    row.snapshot = next;
    for (const listener of row.listeners) listener();
  }
  function latestWorkflowFlags(row, workflows, turnId, order) {
    if (order != null && order >= row.latestTurnOrder) { row.latestTurnId = turnId; row.latestTurnOrder = order; }
    if (!row.latestTurnOrder) return workflows;
    return Object.fromEntries(Object.entries(workflows).map(([id, workflow]) => [id, id === row.latestTurnId ? workflow : { ...workflow, isLatestTurn: false }]));
  }
  function validModelId(value) { return typeof value === 'string' && MODEL_ID.exec(value)?.[0] === value; }
  function displayText(value, limit = 512) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : ''; }
  function newCatalog() {
    return { snapshot: { claudeModels: [], modelListError: null, engines: null, bothAvailable: false, loading: false, loadedAt: null }, listeners: new Set(), revision: 0, promise: null };
  }
  function catalogRecord(manager, { hostId = managerHost(manager), threadId, cwd } = {}) {
    if (!manager || !['object', 'function'].includes(typeof manager)) return disconnectedCatalog;
    let contexts = modelCatalogs.get(manager);
    if (!contexts) { contexts = new Map(); modelCatalogs.set(manager, contexts); }
    const contextKey = JSON.stringify([hostId, threadId ?? null, cwd ?? null]);
    if (!contexts.has(contextKey)) contexts.set(contextKey, newCatalog());
    return contexts.get(contextKey);
  }
  function normalizeModels(models) {
    const result = [], seen = new Set();
    for (const raw of Array.isArray(models) ? models : []) {
      const model = typeof raw === 'string' ? { value: raw } : raw;
      if (!validModelId(model?.value) || seen.has(model.value)) continue;
      seen.add(model.value);
      result.push({ value: model.value, displayName: displayText(model.displayName, 128) || model.value, description: displayText(model.description), ...(validModelId(model.resolvedModel) ? { resolvedModel: model.resolvedModel } : {}) });
    }
    return result;
  }
  async function refreshCapabilities(manager, { hostId = managerHost(manager), threadId, cwd, force = false } = {}) {
    const row = catalogRecord(manager, { hostId, threadId, cwd });
    if (!manager) return row.snapshot;
    if (!force && row.promise) return row.promise;
    if (!force && row.snapshot.loadedAt != null && !row.snapshot.modelListError && Date.now() - row.snapshot.loadedAt < MODEL_CACHE_TTL) return row.snapshot;
    const revision = ++row.revision;
    update(row, { loading: true });
    let settled = false;
    const pending = (async () => {
      try {
        const response = await manager.sendRequest('engine/capabilities', { ...(threadId != null ? { threadId } : {}), ...(cwd != null ? { cwd } : {}), ...(force ? { refresh: true } : {}) });
        if (row.revision !== revision) return row.snapshot;
        const models = normalizeModels(response?.claudeModels), error = displayText(response?.modelListError) || null;
        update(row, { claudeModels: error && models.length === 0 ? row.snapshot.claudeModels : models, modelListError: error, engines: Array.isArray(response?.engines) ? response.engines.filter(value => typeof value === 'string') : row.snapshot.engines, bothAvailable: response?.bothAvailable === true, bothUnavailableReason: displayText(response?.bothUnavailableReason), loadedAt: Date.now() });
      } catch (error) {
        if (row.revision === revision) update(row, { modelListError: displayText(error?.message ?? String(error)) || 'Unable to discover Claude Code models', loadedAt: Date.now() });
      } finally {
        settled = true;
        if (row.revision === revision) { row.promise = null; update(row, { loading: false }); }
      }
      return row.snapshot;
    })();
    if (!settled && row.revision === revision) row.promise = pending;
    return pending;
  }
  function newCodexCatalog() { return { snapshot: { models: [], error: null, loading: false, loadedAt: null }, listeners: new Set(), revision: 0, promise: null }; }
  function codexCatalogRecord(manager, { hostId = managerHost(manager), threadId, cwd } = {}) {
    if (!manager || !['object', 'function'].includes(typeof manager)) return disconnectedCodex;
    if (!codexCatalogs.has(manager)) codexCatalogs.set(manager, new Map());
    const contexts = codexCatalogs.get(manager), id = JSON.stringify([hostId, threadId ?? null, cwd ?? null]);
    if (!contexts.has(id)) contexts.set(id, newCodexCatalog());
    return contexts.get(id);
  }
  async function refreshCodexModels(manager, context = {}) {
    const row = codexCatalogRecord(manager, context);
    if (!manager) return row.snapshot;
    if (!context.force && row.promise) return row.promise;
    if (!context.force && !row.snapshot.error && row.snapshot.loadedAt != null && Date.now() - row.snapshot.loadedAt < MODEL_CACHE_TTL) return row.snapshot;
    const revision = ++row.revision;
    update(row, { loading: true });
    row.promise = (async () => {
      await Promise.resolve();
      try {
        const models = [], seen = new Set(); let cursor;
        do {
          const response = await manager.sendRequest('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
          if (row.revision !== revision) return row.snapshot;
          if (!Array.isArray(response?.data)) throw Error('Invalid Codex model catalog');
          models.push(...response.data.map(model => ({ ...model, value: model.model ?? model.id })));
          cursor = response.nextCursor;
          if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw Error('Codex model pagination repeated its cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
        update(row, { models: normalizeModels(models), error: null, loadedAt: Date.now() });
      } catch (error) { if (row.revision === revision) update(row, { error: displayText(error?.message ?? String(error)), loadedAt: Date.now() }); }
      finally { if (row.revision === revision) { row.promise = null; update(row, { loading: false }); } }
      return row.snapshot;
    })();
    return row.promise;
  }
  function modelOptions(catalog, current) {
    const models = catalog.claudeModels;
    const options = [models.find(model => model.value === 'default') ?? { value: 'default', displayName: 'Claude default', description: 'Use the default model configured for Claude Code.' }, ...models.filter(model => model.value !== 'default')];
    if (typeof current === 'string' && current.length > 0 && !options.some(model => model.value === current)) {
      options.push({ value: current, displayName: ['opus', 'sonnet', 'haiku'].includes(current) ? 'Saved alias' : 'Saved model', description: 'Your saved selection is unchanged. This model was not returned by the latest discovery.' });
    }
    return options;
  }
  function nativeModelName(identity) {
    const match = /^claude-([a-z]+(?:-[a-z]+)*)-(\d{1,3})(?:-(\d{1,3}))?(?:-(\d{8}))?$/i.exec(identity.replace(/\[1m\]$/i, ''));
    if (!match) return null;
    const family = match[1].split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
    return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}${match[4] ? ` (${match[4]})` : ''}`;
  }
  function modelLabel(model) {
    const identity = model.resolvedModel ?? model.value;
    const nativeName = nativeModelName(identity);
    if (model.value === 'default') return nativeName ? `Default · ${nativeName}` : 'Claude default';
    if (nativeName) {
      const context = /\[1m\]$/i.test(identity) || /\[1m\]$/i.test(model.value) ? ' (1M context)' : '';
      const alias = model.resolvedModel && model.value !== model.resolvedModel ? ' (alias)' : '';
      return `${nativeName}${context}${alias}`;
    }
    return model.displayName && model.displayName !== identity ? `${model.displayName} — ${identity}` : identity;
  }
  function modelTitle(model) {
    return `${model.description ? `${model.description}\n` : ''}Model ID: ${model.value}${model.resolvedModel && model.resolvedModel !== model.value ? `\nResolves to: ${model.resolvedModel}` : ''}`;
  }
  function validate(selection) {
    if (!['codex', 'claude', 'both'].includes(selection.engineMode)) throw Error('Unknown chat engine mode');
    if (selection.engineMode === 'claude' && selection.engineModel != null && !validModelId(selection.engineModel)) throw Error('Invalid Claude Code model identifier');
    if (selection.engineModels != null && (typeof selection.engineModels !== 'object' || Array.isArray(selection.engineModels) || Object.entries(selection.engineModels).some(([engine, model]) => !['codex', 'claude'].includes(engine) || (model !== null && !validModelId(model))))) throw Error('Invalid engine model selection');
    if (selection.roleOverrides !== undefined) {
      const overrides = selection.roleOverrides;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 64) throw Error('Invalid role overrides');
      for (const [id, role] of Object.entries(overrides)) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || ['constructor', 'prototype', '__proto__', 'request', 'history', 'parameters', 'previousRound'].includes(id) || !role || typeof role !== 'object' || Array.isArray(role) || Object.keys(role).some(field => !['engine', 'model', 'prompt'].includes(field))) throw Error('Invalid role override');
        if (Object.hasOwn(role, 'engine') && !['codex', 'claude'].includes(role.engine)) throw Error('Invalid role engine');
        if (Object.hasOwn(role, 'model') && role.model !== null && !validModelId(role.model)) throw Error('Invalid role model');
        if (Object.hasOwn(role, 'prompt') && (typeof role.prompt !== 'string' || !role.prompt.trim() || role.prompt.length > 100000)) throw Error('Role prompt must contain 1–100000 characters');
      }
    }
    if (selection.template != null && (typeof selection.template !== 'object' || !/^[a-z][a-z0-9_-]{0,63}$/.test(selection.template.id) || !Number.isSafeInteger(selection.template.revision) || selection.template.revision < 1 || !selection.template.parameters || typeof selection.template.parameters !== 'object' || Array.isArray(selection.template.parameters))) throw Error('Invalid template selection');
  }
  function selectionOverrides(state, selection) {
    const changed = selection.template && (selection.template.id !== state.template.id || selection.template.revision !== state.template.revision);
    return copy(selection.roleOverrides ?? (changed ? {} : state.roleOverrides));
  }
  function applyState(row, state) {
    const values = { loading: false, available: true, error: null };
    if (['codex', 'claude', 'both'].includes(state?.engineMode)) values.engineMode = state.engineMode;
    if (state?.models) values.models = { ...row.snapshot.models, ...state.models };
    if (state?.template) values.template = copy(state.template);
    if (state?.roleOverrides != null) values.roleOverrides = copy(state.roleOverrides);
    if (state?.bothAvailable != null) values.bothAvailable = state.bothAvailable === true;
    if (state?.busy != null) values.busy = state.busy;
    if (state?.turnEngines) values.turnEngines = { ...row.snapshot.turnEngines, ...state.turnEngines };
    // A prewarmed shell still reports its old engine until the first turn reaches
    // the gateway. Reads may update busy/history, but cannot erase captured intent.
    if (row.creationIntent) {
      values.engineMode = row.creationIntent.engineMode;
      if (row.creationIntent.engineMode === 'claude') values.models = { ...row.snapshot.models, ...values.models, claude: row.creationIntent.engineModel };
      if (row.creationIntent.engineMode === 'both') { values.models = copy(row.creationIntent.engineModels); values.template = copy(row.creationIntent.template); values.roleOverrides = copy(row.creationIntent.roleOverrides ?? row.snapshot.roleOverrides); }
    }
    row.hydrated = true;
    update(row, values);
  }
  function requestFields(options) {
    if (options?.engineMode == null) return {};
    validate(options);
    if (options.engineMode === 'both') return { engineMode: 'both', engineModels: copy({ codex: null, claude: 'default', ...options.engineModels }), template: copy(options.template ?? defaultTemplate()), ...(options.roleOverrides !== undefined ? { roleOverrides: copy(options.roleOverrides) } : {}) };
    return options.engineMode === 'claude'
      ? { engineMode: 'claude', engineModel: options.engineModel ?? 'default' }
      : { engineMode: 'codex' };
  }
  function turnRequestFields(manager, threadId, options, clientUserMessageId, nativeModel) {
    const hostId = managerHost(manager);
    const row = threads.get(key(threadId, hostId));
    const selected = options?.engineMode != null ? options : row?.creationIntent ?? (row?.snapshot.engineMode === 'both' ? { engineMode: 'both', engineModels: row.snapshot.models, template: row.snapshot.template, roleOverrides: row.snapshot.roleOverrides } : options);
    const fields = requestFields(selected);
    if (fields.engineMode === 'both' && nativeModel !== undefined) {
      if (nativeModel !== null && !validModelId(nativeModel)) throw Error('Invalid Codex model identifier');
      fields.engineModels.codex = nativeModel;
    }
    if (!row?.creationIntent) return fields;
    // Preparation may fail before the first override reaches the gateway. The
    // ordinary existing-chat retry must carry that same captured selection.
    row.creationIntent = { ...fields, clientUserMessageId: clientUserMessageId ?? null };
    row.revision++;
    applyState(row, { engineMode: fields.engineMode });
    return fields;
  }
  function setDraftSelection(scope, selection, hostId = 'local') {
    validate(selection);
    const row = record(scope, null, hostId);
    if (row.snapshot.pending || row.snapshot.busy || row.nativeControlsBlocked) throw Error('Wait for the current turn to finish');
    row.revision++;
    update(row, { engineMode: selection.engineMode, models: { ...row.snapshot.models, ...copy(selection.engineModels ?? {}), ...(selection.engineMode === 'claude' && selection.engineModel != null ? { claude: selection.engineModel } : {}) }, template: copy(selection.template ?? row.snapshot.template), roleOverrides: selectionOverrides(row.snapshot, selection), error: null });
  }
  function capture(scope, hostId) {
    const state = record(scope, null, hostId).snapshot;
    if (state.engineMode === 'both') return { ...requestFields({ engineMode: 'both', engineModels: state.models, template: state.template, roleOverrides: state.roleOverrides }), skipAutoTitleGeneration: true };
    if (state.engineMode === 'claude') return { engineMode: 'claude', engineModel: state.models.claude ?? 'default', skipAutoTitleGeneration: true };
    return { engineMode: 'codex' };
  }
  function registerManager(manager, hostId = managerHost(manager)) {
    if (manager && managers.get(hostId) !== manager) managers.set(hostId, manager);
  }
  function noteStarted(manager, threadId, options) {
    registerManager(manager);
    if (options?.engineMode == null) return;
    const fields = requestFields(options), row = record(null, threadId, managerHost(manager));
    row.creationIntent = { ...fields, clientUserMessageId: options.clientUserMessageId ?? null };
    row.revision++;
    applyState(row, { ...fields, models: { ...row.snapshot.models, ...fields.engineModels, ...(fields.engineMode === 'claude' ? { claude: fields.engineModel } : {}) } });
  }
  function observe(manager, method, params, response, hostId = managerHost(manager)) {
    registerManager(manager, hostId);
    const threadId = params?.threadId ?? response?.thread?.id;
    if (!threadId) return;
    const row = record(null, threadId, hostId);
    // Reads are applied by their caller with a revision check. An old in-flight read
    // must never undo a newly acknowledged selection.
    if (method === 'engine/mode/set') { row.creationIntent = null; row.revision++; applyState(row, response); }
    const acknowledgedTurnId = method === 'turn/start' ? response?.turn?.id ?? response?.turn?.turnId : null;
    if (acknowledgedTurnId) update(row, { workflows: latestWorkflowFlags(row, row.snapshot.workflows, acknowledgedTurnId, ++row.workflowReadOrder) });
    const intent = row.creationIntent;
    if (method === 'turn/start' && response?.turn && intent && params.engineMode === intent.engineMode
      && (intent.clientUserMessageId == null || params.clientUserMessageId === intent.clientUserMessageId)) {
      row.creationIntent = null;
      row.revision++; // Invalidate mode reads that began before this acknowledgment.
      applyState(row, { engineMode: intent.engineMode, models: { ...row.snapshot.models, ...intent.engineModels }, template: intent.template ?? row.snapshot.template, roleOverrides: intent.roleOverrides ?? row.snapshot.roleOverrides });
    }
    const sources = { ...row.snapshot.turnEngines, ...(response?.turnEngines ?? {}), ...(method === 'engine/turns/read' ? response?.turns : {}) };
    const rawTurns = response?.thread?.turns ?? (Array.isArray(response?.turns) ? response.turns : []);
    for (const turn of rawTurns) {
      const engine = turnSource(turn, sources[turn.id ?? turn.turnId]);
      if (['codex', 'claude', 'both'].includes(engine)) sources[turn.id ?? turn.turnId] = engine;
    }
    update(row, { turnEngines: sources });
  }
  async function refreshThread(scope, threadId, hostId, manager) {
    if (!manager || threadId == null) return;
    registerManager(manager, hostId);
    const row = record(scope, threadId, hostId);
    if (row.read) return row.read;
    const revision = row.revision;
    if (!row.hydrated) update(row, { loading: true });
    row.read = (async () => {
      try {
        const state = await manager.sendRequest('engine/mode/read', { threadId });
        if (row.revision === revision && !row.snapshot.pending) applyState(row, state);
      } catch (error) {
        if (row.revision === revision) update(row, { loading: false, error: error.message ?? String(error), available: row.hydrated ? row.snapshot.available : false });
      } finally { row.read = null; }
    })();
    return row.read;
  }
  async function changeSelection(context, selection) {
    validate(selection);
    const { scope, threadId, hostId, manager } = context;
    const row = record(scope, threadId, hostId);
    if (row.snapshot.pending || row.snapshot.busy || row.nativeControlsBlocked) throw Error('Wait for the current turn to finish');
    if (threadId == null) { setDraftSelection(scope, selection, hostId); return; }
    row.revision++;
    update(row, { pending: true, error: null });
    try {
      const selected = requestFields({ ...selection, engineModel: selection.engineModel ?? row.snapshot.models.claude, engineModels: { ...row.snapshot.models, ...selection.engineModels }, template: selection.template ?? row.snapshot.template, ...(selection.engineMode === 'both' ? { roleOverrides: selectionOverrides(row.snapshot, selection) } : {}) });
      const state = await manager.sendRequest('engine/mode/set', { threadId, ...selected });
      row.creationIntent = null;
      applyState(row, state);
    } catch (error) {
      update(row, { error: error.message ?? String(error) });
      throw error;
    } finally { update(row, { pending: false }); }
  }
  async function permitsNativeMetadata(manager, threadId) {
    registerManager(manager);
    const row = record(null, threadId, managerHost(manager));
    // Explicit Claude intent can precede the first request on a prewarmed shell.
    // Never let that shell's temporary Codex default authorize metadata inference.
    if (['claude', 'both'].includes(row.creationIntent?.engineMode) || row.snapshot.pending || ['claude', 'both'].includes(row.snapshot.engineMode)) return false;
    const revision = row.revision;
    try {
      // Always use a new read here: another window may have changed the engine,
      // and a coalesced UI read could have started before that change.
      const state = await manager.sendRequest('engine/mode/read', { threadId });
      if (row.revision !== revision || row.snapshot.pending) return false;
      applyState(row, state);
      return state.engineMode === 'codex';
    } catch { return false; }
  }
  function turnSource(raw, known) {
    if (['codex', 'claude', 'both'].includes(raw?.cdxEngineSource)) return raw.cdxEngineSource;
    // Native turn normalization can keep item annotations while dropping the
    // turn extension. A workflow child's engine describes that child only.
    if (raw?.items?.some(item => item.cdxRunId)) return 'both';
    if (['codex', 'claude', 'both'].includes(known)) return known;
    return raw?.items?.find(item => ['codex', 'claude', 'both'].includes(item.cdxEngineSource))?.cdxEngineSource;
  }
  function sourceFor(threadId, hostId, turnId, raw) {
    const known = record(null, threadId, hostId).snapshot.turnEngines[turnId];
    return turnSource(raw, known) ?? 'codex';
  }
  async function refreshSources(threadId, hostId) {
    const manager = managers.get(hostId ?? 'local');
    if (!manager || !threadId) return;
    const row = record(null, threadId, hostId);
    if (row.sourcesRead) return row.sourcesRead;
    row.sourcesRead = (async () => {
      try {
        const response = await manager.sendRequest('engine/turns/read', { threadId });
        update(row, { turnEngines: { ...row.snapshot.turnEngines, ...response.turns } });
      } catch { /* Old, unannotated Codex turns retain their Codex label. */ }
      finally { row.sourcesRead = null; }
    })();
    return row.sourcesRead;
  }
  function useRecord(React, row) {
    return React.useSyncExternalStore(listener => { row.listeners.add(listener); return () => row.listeners.delete(listener); }, () => row.snapshot, () => row.snapshot);
  }
  function permitsNativeModelSelection(props) {
    const context = props?.cdxEngineSelectionContext;
    if (!context) return true;
    const row = record(context.scope, context.threadId, context.hostId);
    return row.snapshot.engineMode !== 'both' || !(row.nativeControlsBlocked || row.snapshot.busy || row.snapshot.pending || row.snapshot.loading || row.snapshot.available === false);
  }
  const selectStyle = { color: 'inherit', background: 'transparent', border: '1px solid var(--border, #8885)', borderRadius: 6, fontSize: 12, padding: '3px 5px', maxWidth: 160, cursor: 'pointer' };
  function Selector(props) {
    const { React, jsx, scope, threadId, nativeModelPicker, bothNativeModelPicker } = props;
    const hostId = props.hostId ?? props.getHost(scope, threadId) ?? 'local';
    const cwd = threadId == null ? props.cwd : undefined;
    const row = record(scope, threadId, hostId), state = useRecord(React, row);
    const inProgress = props.useAtom(props.busyAtom, threadId);
    const runtimeStatus = props.useAtom(props.runtimeStatusAtom, threadId);
    const requests = props.useAtom(props.requestsAtom, threadId);
    let manager, connectionError;
    // forHost() returns a callable RPC proxy, including an asynchronous getHostId.
    // The composer already knows its host; do not query that proxy during render.
    try { manager = props.getManager(scope, hostId); registerManager(manager, hostId); } catch (error) { connectionError = error.message; }
    const catalog = useRecord(React, catalogRecord(manager, { hostId, threadId, cwd }));
    React.useEffect(() => {
      if (!manager) return;
      refreshCapabilities(manager, { hostId, threadId, cwd });
      if (threadId != null) refreshThread(scope, threadId, hostId, manager);
      const interval = threadId == null ? null : setInterval(() => refreshThread(scope, threadId, hostId, manager), 2000);
      return () => { if (interval != null) clearInterval(interval); };
    }, [row, manager, hostId, threadId, cwd, scope]);
    const busy = Boolean(inProgress || state.busy || state.pending || requests?.length || runtimeStatus?.type === 'active');
    const unavailable = !manager || state.available === false;
    const disabled = busy || state.loading || unavailable;
    const claudeAvailable = state.available === true || catalog.engines?.includes('claude') === true;
    const bothAvailable = (catalog.loadedAt != null ? catalog.bothAvailable === true : state.bothAvailable === true);
    const reason = connectionError ?? state.error ?? (busy ? 'Wait for the current turn and approvals to finish' : 'Choose the engine for this chat');
    const mode = state.engineMode;
    // Native app-wide commands outlive individual button events. Their guard
    // reads this chat's current state, including the composer's native busy atoms.
    row.nativeControlsBlocked = mode === 'both' && disabled;
    const change = selection => { changeSelection({ scope, threadId, hostId, manager }, selection).catch(() => {}); };
    const modePicker = jsx.jsxs('select', {
      'aria-label': 'Chat engine', 'data-testid': 'chat-engine-selector', value: mode, disabled, title: reason, style: selectStyle,
      onChange: event => change({ engineMode: event.target.value }),
      onFocus: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      onPointerDown: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      children: [jsx.jsx('option', { value: 'codex', children: 'Only Codex' }), jsx.jsx('option', { value: 'claude', disabled: !claudeAvailable, children: 'Only Claude Code' }), jsx.jsx('option', { value: 'both', disabled: !bothAvailable, title: catalog.bothUnavailableReason || 'Configure independent participants and host roles', children: 'Multi-agent (Codex / Claude)' })],
    });
    const claudePicker = mode === 'claude' || mode === 'both' ? jsx.jsx('select', {
      'aria-label': 'Claude Code model', 'data-testid': 'claude-model-selector', value: state.models.claude ?? 'default', disabled: disabled || !claudeAvailable, title: 'Claude Code uses its own project/user permissions and per-tool approvals. The Codex permission selector applies only to Codex.', style: { ...selectStyle, maxWidth: 220 },
      onChange: event => change(mode === 'both' ? { engineMode: 'both', engineModels: { claude: event.target.value } } : { engineMode: 'claude', engineModel: event.target.value }),
      onFocus: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      onPointerDown: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      children: modelOptions(catalog, state.models.claude ?? 'default').map(model => jsx.jsx('option', { value: model.value, title: modelTitle(model), children: modelLabel(model) }, model.value)),
    }) : nativeModelPicker;
    const dualNativePicker = bothNativeModelPicker?.type ? jsx.jsx(bothNativeModelPicker.type, { ...bothNativeModelPicker.props, cdxEngineSelectionContext: { scope, threadId, hostId } }) : bothNativeModelPicker ?? nativeModelPicker;
    const modelPicker = mode === 'both' ? jsx.jsxs('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }, children: [jsx.jsxs('fieldset', { 'aria-label': 'Codex model controls', disabled, style: { border: 0, margin: 0, padding: 0, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 4, ...(disabled ? { pointerEvents: 'none', opacity: 0.6 } : {}) }, children: [jsx.jsx('span', { style: { fontSize: 11 }, children: 'Codex model' }), dualNativePicker] }), jsx.jsxs('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 }, children: [jsx.jsx('span', { style: { fontSize: 11 }, children: 'Claude model' }), claudePicker] })] }) : claudePicker;
    const refreshModels = (mode === 'claude' || mode === 'both' || catalog.modelListError) ? jsx.jsx('button', { type: 'button', 'aria-label': 'Refresh Claude models', title: 'Refresh models', disabled: !manager || catalog.loading, style: { ...selectStyle, border: 'none', padding: '2px 4px' }, onClick: () => refreshCapabilities(manager, { hostId, threadId, cwd, force: true }), children: '↻' }) : null;
    const errorStyle = { fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const modelError = catalog.modelListError ? jsx.jsx('span', { role: 'status', title: catalog.modelListError, style: errorStyle, children: `Model discovery: ${catalog.modelListError}` }) : null;
    return jsx.jsxs('span', { className: 'flex min-w-0 items-center gap-1', style: { display: 'inline-flex', flexWrap: 'wrap', minWidth: 0, gap: 4 }, 'data-cdx-engine-controls': true, children: [modePicker, modelPicker, refreshModels, mode === 'both' ? jsx.jsx(TemplateControls, { React, jsx, manager, hostId, selection: state.template, disabled, onChange: template => change({ engineMode: 'both', template }) }, hostId) : null, mode === 'both' ? jsx.jsx(RoleControls, { React, jsx, manager, hostId, threadId, cwd, selection: state.template, roleOverrides: state.roleOverrides, models: state.models, disabled, onChange: roleOverrides => change({ engineMode: 'both', roleOverrides }) }, `${hostId}:${threadId ?? ''}:${templateKey(state.template)}`) : null, modelError, state.error ? jsx.jsx('span', { role: 'alert', title: state.error, style: errorStyle, children: state.error }) : null] });
  }
  function templateRecord(manager, hostId = managerHost(manager)) {
    if (!manager || !['object', 'function'].includes(typeof manager)) return disconnectedTemplates;
    if (!templateCatalogs.has(manager)) templateCatalogs.set(manager, new Map());
    const hosts = templateCatalogs.get(manager);
    if (!hosts.has(hostId)) hosts.set(hostId, { snapshot: { templates: [], byRevision: {}, loading: false, error: null, loaded: false }, listeners: new Set(), promise: null });
    return hosts.get(hostId);
  }
  const templateKey = template => `${template.id}@${template.revision}`;
  function rememberTemplate(row, template) {
    if (!template?.id || !template.revision) return;
    update(row, { byRevision: { ...row.snapshot.byRevision, [templateKey(template)]: copy(template) } });
  }
  async function refreshTemplates(manager, hostId = managerHost(manager), force = false) {
    const row = templateRecord(manager, hostId);
    if (!manager) return row.snapshot;
    if (row.promise) { if (!force) return row.promise; await row.promise; return refreshTemplates(manager, hostId, true); }
    if (!force && row.snapshot.loaded) return row.snapshot;
    update(row, { loading: true, error: null });
    row.promise = (async () => {
      await Promise.resolve(); // Publish the pending request before a synchronous transport failure.
      try {
        const response = await manager.sendRequest('engine/templates/list', {});
        const templates = Array.isArray(response?.templates) ? copy(response.templates) : [];
        const byRevision = { ...row.snapshot.byRevision };
        for (const template of templates) byRevision[templateKey(template)] = template;
        update(row, { templates, byRevision, loaded: true });
      } catch (error) { update(row, { error: error.message ?? String(error) }); }
      finally { row.promise = null; update(row, { loading: false }); }
      return row.snapshot;
    })();
    return row.promise;
  }
  async function readTemplate(manager, hostId, selected) {
    if (!manager || !selected?.id) return;
    const row = templateRecord(manager, hostId);
    if (row.snapshot.byRevision[templateKey(selected)]) return;
    try {
      const response = await manager.sendRequest('engine/templates/read', { id: selected.id, revision: selected.revision });
      if (!response?.template) throw Error(`Template ${templateKey(selected)} is unavailable`);
      rememberTemplate(row, response.template);
    } catch (error) { update(row, { error: error.message ?? String(error) }); }
  }
  const unavailableTemplate = manager => !manager;
  const roleLabel = id => ({ participant_a: 'Participant A', participant_b: 'Participant B', host: 'Host' }[id] ?? id.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase()));
  function fixedRoleEngines(template) {
    const fixed = new Set();
    const visit = steps => { for (const step of steps ?? []) { if (step.type === 'executeTasks') Object.values(step.roles ?? {}).forEach(id => fixed.add(id)); if (step.type === 'crossReview') Object.values(step.reviewers ?? {}).forEach(id => fixed.add(id)); visit(step.steps); } };
    visit(template?.steps);
    return fixed;
  }
  function RoleControls({ React, jsx, manager, hostId = 'local', threadId, cwd, selection, roleOverrides = {}, models = {}, disabled = false, onChange }) {
    const catalog = useRecord(React, templateRecord(manager, hostId));
    const claude = useRecord(React, catalogRecord(manager, { hostId, threadId, cwd }));
    const codex = useRecord(React, codexCatalogRecord(manager, { hostId, threadId, cwd }));
    const [error, setError] = React.useState(null);
    React.useEffect(() => {
      refreshTemplates(manager, hostId).then(() => readTemplate(manager, hostId, selection));
      refreshCodexModels(manager, { hostId, threadId, cwd });
    }, [manager, hostId, threadId, cwd, selection.id, selection.revision]);
    const template = catalog.byRevision[templateKey(selection)], fixed = fixedRoleEngines(template);
    const change = (id, field, value) => {
      if (disabled || (field === 'engine' && fixed.has(id))) return;
      const next = copy(roleOverrides);
      if (field == null) delete next[id];
      else {
        next[id] = { ...next[id], [field]: value };
        if (value === undefined) delete next[id][field];
        if (field === 'engine') next[id].model = null;
      }
      try { validate({ engineMode: 'both', roleOverrides: next }); setError(null); onChange(next); }
      catch (error) { setError(error.message); }
    };
    const roles = Object.entries(template?.roles ?? {}).map(([id, role]) => {
      const override = roleOverrides[id] ?? {}, engine = override.engine ?? role.engine, name = roleLabel(id);
      const effectiveModel = Object.hasOwn(override, 'model') ? override.model : Object.hasOwn(role, 'model') ? role.model : models[engine];
      const effectivePrompt = override.prompt ?? role.prompt;
      const available = engine === 'claude' ? modelOptions(claude, effectiveModel).filter(model => model.value !== 'default') : [...codex.models];
      if (validModelId(effectiveModel) && !available.some(model => model.value === effectiveModel)) available.push({ value: effectiveModel, displayName: 'Saved model' });
      return jsx.jsxs('fieldset', { style: { border: '1px solid #8884', borderRadius: 6, padding: 6, minWidth: 0 }, children: [
        jsx.jsx('legend', { children: name }),
        jsx.jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }, children: [
          jsx.jsx('select', { 'aria-label': `${name} engine`, value: engine, disabled: disabled || fixed.has(id), title: fixed.has(id) ? 'This workflow requires this engine for its worker/reviewer topology.' : 'Engine for this role', style: selectStyle, onChange: event => change(id, 'engine', event.target.value), children: ['codex', 'claude'].map(value => jsx.jsx('option', { value, children: value === 'codex' ? 'Codex' : 'Claude Code' }, value)) }),
          jsx.jsx('select', { 'aria-label': `${name} model`, value: Object.hasOwn(override, 'model') ? override.model ?? '' : '__inherit__', disabled, style: { ...selectStyle, maxWidth: 240 }, onFocus: () => engine === 'codex' ? refreshCodexModels(manager, { hostId, threadId, cwd }) : refreshCapabilities(manager, { hostId, threadId, cwd }), onChange: event => change(id, 'model', event.target.value === '__inherit__' ? undefined : event.target.value || null), children: [
            jsx.jsx('option', { value: '__inherit__', children: `Use template/default · ${Object.hasOwn(role, 'model') ? role.model ?? 'engine default' : models[engine] ?? 'engine default'}` }),
            jsx.jsx('option', { value: '', children: `${engine === 'codex' ? 'Codex' : 'Claude'} default` }),
            ...available.map(model => jsx.jsx('option', { value: model.value, title: modelTitle(model), children: modelLabel(model) }, model.value)),
          ] }),
          jsx.jsx('button', { type: 'button', style: selectStyle, disabled: disabled || !Object.hasOwn(roleOverrides, id), 'aria-label': `Reset ${name}`, onClick: () => change(id), children: 'Reset' }),
        ] }),
        jsx.jsxs('details', { style: { marginTop: 6 }, children: [jsx.jsx('summary', { children: 'Role prompt' }), jsx.jsx('textarea', { 'aria-label': `${name} prompt`, defaultValue: effectivePrompt, disabled, maxLength: 100000, style: { ...selectStyle, width: '100%', maxWidth: '100%', boxSizing: 'border-box', minHeight: 90, resize: 'vertical' }, onBlur: event => { if (event.target.value !== effectivePrompt) change(id, 'prompt', event.target.value); } }, `${hostId}:${templateKey(selection)}:${id}:${effectivePrompt}`)] }),
      ] }, id);
    });
    return jsx.jsxs('details', { 'aria-label': 'Role configuration', style: { flexBasis: '100%', minWidth: 0, fontSize: 12 }, children: [
      jsx.jsx('summary', { style: { cursor: 'pointer' }, children: `Configure roles${roles.length ? ` · ${roles.length}` : ''}` }),
      jsx.jsx('div', { style: { display: 'grid', gap: 6, marginTop: 6, maxWidth: 620 }, children: roles.length ? roles : 'Loading template roles…' }),
      jsx.jsx('button', { type: 'button', style: selectStyle, disabled: codex.loading || claude.loading, onClick: () => Promise.all([refreshCodexModels(manager, { hostId, threadId, cwd, force: true }), refreshCapabilities(manager, { hostId, threadId, cwd, force: true })]), children: 'Refresh role models' }),
      error || codex.error ? jsx.jsx('span', { role: 'alert', children: error ?? codex.error }) : null,
    ] });
  }
  function TemplateControls({ React, jsx, manager, hostId = 'local', selection = defaultTemplate(), disabled, onChange }) {
    const row = templateRecord(manager, hostId), catalog = useRecord(React, row);
    const [manage, setManage] = React.useState(false);
    React.useEffect(() => { refreshTemplates(manager, hostId).then(() => readTemplate(manager, hostId, selection)); }, [manager, hostId, selection.id, selection.revision]);
    const template = catalog.byRevision[templateKey(selection)];
    const templates = [...catalog.templates];
    if (!templates.some(item => templateKey(item) === templateKey(selection))) templates.push(template ?? { ...selection, name: `${selection.id} (saved revision ${selection.revision})` });
    const setParameter = (name, value) => onChange({ ...copy(selection), parameters: { ...selection.parameters, [name]: value } });
    const parameters = Object.entries(template?.parameters ?? {}).map(([name, definition]) => {
      const value = selection.parameters[name] ?? definition.default;
      if (template.id === 'debby' && name === 'rounds') return jsx.jsxs('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' }, children: [
        jsx.jsxs('label', { children: [jsx.jsx('input', { type: 'checkbox', 'aria-label': 'Enable discussion', checked: value > 0, disabled, onChange: event => setParameter(name, event.target.checked ? 1 : 0) }), ' Discussion'] }),
        value > 0 ? jsx.jsxs('label', { children: ['Rounds ', jsx.jsx('input', { type: 'number', 'aria-label': 'Discussion rounds', min: 1, max: 5, step: 1, value, disabled, style: { ...selectStyle, width: 48 }, onChange: event => { const number = Number(event.target.value); if (Number.isInteger(number) && number >= 1 && number <= 5) setParameter(name, number); } })] }) : null,
      ] }, name);
      if (Array.isArray(definition.enum)) return jsx.jsxs('label', { title: definition.description, children: [name === 'host_mode' ? 'Host ' : `${name} `, jsx.jsx('select', { 'aria-label': name === 'host_mode' ? 'Host mode' : `Template parameter ${name}`, value, disabled, style: selectStyle, onChange: event => { if (definition.enum.includes(event.target.value)) setParameter(name, event.target.value); }, children: definition.enum.map(option => jsx.jsx('option', { value: option, children: option === 'per-round' ? 'Guide each round' : option === 'final-only' ? 'Final summary only' : option }, option)) })] }, name);
      return jsx.jsxs('label', { title: definition.description, children: [`${name} `, jsx.jsx('input', { 'aria-label': `Template parameter ${name}`, disabled, style: { ...selectStyle, maxWidth: 130 }, type: definition.type === 'boolean' ? 'checkbox' : ['integer', 'number'].includes(definition.type) ? 'number' : 'text', ...(definition.type === 'boolean' ? { checked: value } : { value }), min: definition.min, max: definition.max, step: definition.type === 'integer' ? 1 : 'any', onChange: event => {
        const next = definition.type === 'boolean' ? event.target.checked : ['integer', 'number'].includes(definition.type) ? Number(event.target.value) : event.target.value;
        if (['integer', 'number'].includes(definition.type) && (!Number.isFinite(next) || next < definition.min || next > definition.max || (definition.type === 'integer' && !Number.isSafeInteger(next)))) return;
        setParameter(name, next);
      } })] }, name);
    });
    return jsx.jsxs('span', { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12 }, children: [
      jsx.jsxs('label', { children: ['Template ', jsx.jsx('select', { 'aria-label': 'Workflow template', style: selectStyle, value: templateKey(selection), disabled: Boolean(disabled || (!catalog.loaded && catalog.loading)), onFocus: () => refreshTemplates(manager, hostId, true), onChange: event => { const selected = templates.find(item => templateKey(item) === event.target.value); if (selected) onChange({ id: selected.id, revision: selected.revision, parameters: {} }); }, children: templates.map(item => jsx.jsx('option', { value: templateKey(item), children: `${item.name} · r${item.revision}` }, templateKey(item))) })] }),
      ...parameters,
      jsx.jsx('button', { type: 'button', style: selectStyle, disabled: !catalog.loaded || unavailableTemplate(manager, hostId), onClick: () => setManage(!manage), children: manage ? 'Close templates' : 'Manage templates' }),
      jsx.jsx('span', { style: { flexBasis: '100%', opacity: 0.75, fontSize: 11, whiteSpace: 'normal' }, children: 'Each role can use its own engine, model and prompt.' }),
      catalog.error ? jsx.jsx('span', { role: 'alert', children: catalog.error }) : null,
      manage ? jsx.jsx(TemplateManager, { React, jsx, manager, hostId, initialId: selection.id }, hostId) : null,
    ] });
  }
  function unusedId(base, values) { let id = base, n = 2; while (values.includes(id)) id = `${base.slice(0, 58)}-${n++}`; return id; }
  function blankTemplate(id) {
    const role = engine => ({ engine, prompt: 'Answer the user request using the supplied context. Preserve attribution and report uncertainty.', access: 'read', session: 'fresh' });
    return { schemaVersion: 2, id, name: 'New dual template', description: '', builtin: false,
      roles: { participant_a: role('codex'), participant_b: role('claude'), host: { ...role('claude'), prompt: 'Guide the discussion using the supplied evidence. Attribute each participant, engine and model accurately and explain unresolved differences.' } },
      parameters: { rounds: { type: 'integer', default: 2, min: 0, max: 5 }, host_mode: { type: 'string', default: 'per-round', enum: ['per-round', 'final-only'] } }, limits: { concurrency: 2, tasks: 8, rounds: 5 },
      steps: [{ id: 'debate', type: 'hostedDebate', participants: { participant_a: 'participant_a', participant_b: 'participant_b' }, host: 'host', inputs: ['request', 'history'], count: { parameter: 'rounds' }, mode: { parameter: 'host_mode' } }, { id: 'summary', type: 'synthesize', dependsOn: ['debate'], role: 'host', inputs: ['request', 'debate.sources', 'debate.assessments'] }],
      output: { sources: ['debate.participant_a', 'debate.participant_b', 'debate.sources', 'debate.assessments', 'summary'], final: 'summary', format: 'markdown' } };
  }
  function TemplateManager({ React, jsx, manager, hostId = 'local', initialId }) {
    const row = templateRecord(manager, hostId), catalog = useRecord(React, row);
    const [draft, setDraft] = React.useState(() => copy(catalog.templates.find(item => item.id === initialId) ?? catalog.templates[0] ?? blankTemplate('new-template')));
    const [advanced, setAdvanced] = React.useState(false), [text, setText] = React.useState(''), [importText, setImportText] = React.useState('');
    const [exported, setExported] = React.useState(''), [format, setFormat] = React.useState('yaml'), [pending, setPending] = React.useState(false), [error, setError] = React.useState(null), [notice, setNotice] = React.useState(null);
    React.useEffect(() => { refreshTemplates(manager, hostId); }, [manager, hostId]);
    const readonly = draft.builtin === true || ['polly', 'debby'].includes(draft.id);
    const unavailable = !manager, locked = readonly || pending || unavailable;
    const load = template => { setDraft(copy(template)); setText(JSON.stringify(template, null, 2)); setAdvanced(false); setError(null); setExported(''); setNotice(null); };
    const edit = (name, value) => setDraft(current => ({ ...current, [name]: value }));
    const roleEdit = (id, name, value) => setDraft(current => ({ ...current, schemaVersion: 2, roles: { ...current.roles, [id]: { ...current.roles[id], [name]: value } } }));
    const parameterEdit = (id, name, value) => setDraft(current => ({ ...current, parameters: { ...current.parameters, [id]: { ...current.parameters[id], [name]: value } } }));
    const action = async run => { if (pending || unavailable) return; setPending(true); setError(null); setNotice(null); try { await run(); } catch (error) { setError(error.message ?? String(error)); } finally { setPending(false); } };
    const accept = async template => { rememberTemplate(row, template); await refreshTemplates(manager, hostId, true); load(template); setNotice(`Saved ${template.id} revision ${template.revision}. Select this revision in the chat to use it.`); };
    const control = (label, { multiline, ...props }) => jsx.jsxs('label', { style: { display: 'flex', flexDirection: 'column', gap: 3 }, children: [label, jsx.jsx(multiline ? 'textarea' : 'input', { 'aria-label': label, style: { ...selectStyle, maxWidth: '100%', width: '100%', boxSizing: 'border-box', ...(multiline ? { minHeight: 72, resize: 'vertical' } : {}) }, disabled: locked, ...props })] });
    const choice = (label, value, values, onChange, fixed = false) => jsx.jsxs('label', { children: [label, ' ', jsx.jsx('select', { 'aria-label': label, style: selectStyle, value, disabled: locked || fixed, onChange: event => { if (!locked && !fixed) onChange(event.target.value); }, children: values.map(option => jsx.jsx('option', { value: option, children: option }, option)) })] });
    const makeButton = (label, onClick, disabled = pending || unavailable) => jsx.jsx('button', { type: 'button', style: selectStyle, disabled, onClick, children: label });
    const basic = jsx.jsxs('div', { style: { display: 'grid', gap: 10 }, children: [
      control('Template ID', { value: draft.id, disabled: locked || Boolean(draft.revision), onChange: event => edit('id', event.target.value) }),
      control('Template name', { value: draft.name, onChange: event => edit('name', event.target.value) }),
      control('Template description', { multiline: true, value: draft.description, onChange: event => edit('description', event.target.value) }),
      jsx.jsx('p', { children: 'Each role can choose an engine, model and prompt. Access is limited by host permissions. Edit hosted discussion steps, workflow graph, limits and output in Advanced YAML / JSON.' }),
      ...Object.entries(draft.roles ?? {}).map(([id, role]) => jsx.jsxs('fieldset', { style: { border: '1px solid #8885', borderRadius: 6, padding: 8, display: 'grid', gap: 6 }, children: [jsx.jsx('legend', { children: `Role ${id}` }),
        choice(`Role ${id} engine`, role.engine, ['codex', 'claude'], value => roleEdit(id, 'engine', value), fixedRoleEngines(draft).has(id)),
        control(`Role ${id} model`, { value: role.model ?? '', placeholder: 'Engine default', onChange: event => roleEdit(id, 'model', event.target.value || null) }),
        choice(`Role ${id} access`, role.access, ['read', 'write'], value => roleEdit(id, 'access', value)),
        choice(`Role ${id} session`, role.session, ['fresh', 'reuse'], value => roleEdit(id, 'session', value)),
        control(`Role ${id} prompt`, { multiline: true, value: role.prompt, onChange: event => roleEdit(id, 'prompt', event.target.value) }),
      ] }, id)),
      jsx.jsx('strong', { children: 'Parameter definitions' }),
      ...Object.entries(draft.parameters ?? {}).map(([id, definition]) => jsx.jsxs('fieldset', { style: { border: '1px solid #8885', borderRadius: 6, padding: 8, display: 'grid', gap: 6 }, children: [jsx.jsx('legend', { children: id }),
        control(`Parameter ${id} name`, { defaultValue: id, onBlur: event => {
          const name = event.target.value.trim();
          if (name === id) return;
          if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || Object.hasOwn(draft.parameters, name)) { setError('Parameter names must be unique lowercase IDs.'); event.target.value = id; return; }
          setDraft(current => { const parameters = { ...current.parameters, [name]: current.parameters[id] }; delete parameters[id]; return { ...current, parameters }; });
        } }),
        choice(`Parameter ${id} type`, definition.type, ['integer', 'number', 'boolean', 'string'], type => { const numeric = ['integer', 'number'].includes(type); setDraft(current => ({ ...current, parameters: { ...current.parameters, [id]: { type, default: numeric ? 0 : type === 'boolean' ? false : '', ...(numeric ? { min: 0, max: 5 } : {}), description: definition.description ?? '' } } })); }),
        control(`Parameter ${id} default`, { type: definition.type === 'boolean' ? 'checkbox' : ['integer', 'number'].includes(definition.type) ? 'number' : 'text', ...(definition.type === 'boolean' ? { checked: definition.default } : { value: definition.default }), onChange: event => parameterEdit(id, 'default', definition.type === 'boolean' ? event.target.checked : ['integer', 'number'].includes(definition.type) ? Number(event.target.value) : event.target.value) }),
        ...(['integer', 'number'].includes(definition.type) ? ['min', 'max'].map(bound => control(`Parameter ${id} ${bound}`, { type: 'number', value: definition[bound], onChange: event => parameterEdit(id, bound, Number(event.target.value)) })) : []),
        control(`Parameter ${id} description`, { value: definition.description ?? '', onChange: event => parameterEdit(id, 'description', event.target.value) }),
        makeButton(`Remove parameter ${id}`, () => setDraft(current => { const parameters = { ...current.parameters }; delete parameters[id]; return { ...current, parameters }; }), locked),
      ] }, id)),
      makeButton('Add parameter', () => { const id = unusedId('parameter', Object.keys(draft.parameters ?? {})); edit('parameters', { ...draft.parameters, [id]: { type: 'integer', default: 0, min: 0, max: 5, description: '' } }); }, locked),
    ] });
    return jsx.jsxs('section', { 'aria-label': 'Template manager', style: { flexBasis: '100%', width: 'min(680px, 100%)', maxHeight: '65vh', overflow: 'auto', border: '1px solid #8885', borderRadius: 8, padding: 12, display: 'grid', gap: 10, whiteSpace: 'normal' }, children: [
      jsx.jsx('strong', { children: 'Workflow templates' }),
      jsx.jsx('select', { 'aria-label': 'Managed template', style: { ...selectStyle, maxWidth: '100%' }, value: catalog.templates.some(item => item.id === draft.id) ? draft.id : '', disabled: pending || unavailable, onChange: event => { const template = catalog.templates.find(item => item.id === event.target.value); if (template) load(template); }, children: [jsx.jsx('option', { value: '', disabled: true, children: 'Unsaved template' }), ...catalog.templates.map(template => jsx.jsx('option', { value: template.id, children: `${template.name} · r${template.revision}${template.builtin ? ' · Built-in' : ''}` }, template.id))] }),
      jsx.jsxs('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 }, children: [makeButton('New dual template', () => load(blankTemplate(unusedId('new-template', catalog.templates.map(item => item.id))))), makeButton('Duplicate template', () => { const duplicate = copy(draft); duplicate.id = unusedId(`${draft.id.slice(0, 55)}-copy`, catalog.templates.map(item => item.id)); duplicate.name = `${draft.name} copy`; duplicate.builtin = false; delete duplicate.revision; delete duplicate.contentHash; load(duplicate); }), makeButton(advanced ? 'Basic form' : 'Advanced YAML / JSON', () => { if (advanced && text !== JSON.stringify(draft, null, 2)) { setError('Save changes from the YAML / JSON editor before switching to the basic form.'); return; } if (!advanced) setText(JSON.stringify(draft, null, 2)); setAdvanced(!advanced); })] }),
      readonly ? jsx.jsx('p', { children: 'Built-in templates are read-only. Duplicate to make an editable template with a new ID.' }) : null,
      advanced ? control('Advanced YAML or JSON', { multiline: true, value: text, readOnly: readonly, style: { ...selectStyle, maxWidth: '100%', width: '100%', minHeight: 240, boxSizing: 'border-box', fontFamily: 'monospace', resize: 'vertical' }, onChange: event => setText(event.target.value) }) : basic,
      jsx.jsxs('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: [makeButton('Save template', () => action(async () => { if (readonly) return; const response = await manager.sendRequest(advanced ? 'engine/templates/import' : 'engine/templates/save', advanced ? { text } : { template: copy(draft) }); await accept(response.template); }), locked), makeButton('Delete template', () => action(async () => { if (readonly || !draft.revision) return; await manager.sendRequest('engine/templates/delete', { id: draft.id }); await refreshTemplates(manager, hostId, true); load(row.snapshot.templates[0] ?? blankTemplate('new-template')); setNotice('Template deleted. Historical turn revisions are retained.'); }), locked || !draft.revision)] }),
      jsx.jsxs('details', { children: [jsx.jsx('summary', { children: 'Import YAML or JSON' }), jsx.jsxs('div', { style: { display: 'grid', gap: 8 }, children: [control('Import YAML or JSON', { multiline: true, disabled: pending || unavailable, value: importText, onChange: event => setImportText(event.target.value) }), jsx.jsx('input', { type: 'file', accept: '.yaml,.yml,.json,application/json,text/yaml', 'aria-label': 'Import template file', disabled: pending || unavailable, onChange: event => { const file = event.target.files?.[0]; if (file) action(async () => { if (file.size > 2 * 1024 * 1024) throw Error('Template files must be at most 2 MiB'); setImportText(await file.text()); }); } }), makeButton('Import template', () => action(async () => { const response = await manager.sendRequest('engine/templates/import', { text: importText }); await accept(response.template); }), pending || unavailable || !importText.trim())] })] }),
      jsx.jsxs('div', { style: { display: 'flex', gap: 6 }, children: [jsx.jsx('select', { 'aria-label': 'Export format', style: selectStyle, value: format, onChange: event => setFormat(event.target.value), children: ['yaml', 'json'].map(value => jsx.jsx('option', { value, children: value.toUpperCase() }, value)) }), makeButton('Export template', () => action(async () => { const response = await manager.sendRequest('engine/templates/export', { id: draft.id, revision: draft.revision, format }); setExported(response.text); }), pending || unavailable || !draft.revision)] }),
      exported ? control('Exported template', { multiline: true, disabled: false, readOnly: true, value: exported }) : null,
      error ? jsx.jsx('div', { role: 'alert', style: { color: 'var(--text-danger, #c44)', overflowWrap: 'anywhere' }, children: error }) : null,
      notice ? jsx.jsx('div', { role: 'status', children: notice }) : null,
    ] });
  }
  async function refreshRuns(threadId, hostId = 'local', turnId) {
    const manager = managers.get(hostId);
    if (!manager || !threadId) return;
    const row = record(null, threadId, hostId), readKey = turnId ?? '*';
    if (row.runsRead.has(readKey)) return row.runsRead.get(readKey);
    const readOrder = ++row.workflowReadOrder;
    const pending = (async () => {
      await Promise.resolve(); // Ensure finally clears an already-published request.
      try {
        const response = await manager.sendRequest('engine/runs/read', { threadId, ...(turnId ? { turnId } : {}) });
        const returned = response?.workflows ?? [], workflows = { ...row.snapshot.workflows };
        for (const workflow of returned) workflows[workflow.turnId] = copy(workflow);
        const latest = returned.find(workflow => workflow.isLatestTurn === true);
        // A turn acknowledgment is newer evidence than every read already in flight.
        // Later-started reads can discover a new turn from another window.
        const lostLatest = returned.some(workflow => workflow.turnId === row.latestTurnId && workflow.isLatestTurn === false);
        update(row, { workflows: latestWorkflowFlags(row, workflows, latest?.turnId ?? null, latest || lostLatest ? readOrder : undefined), runsError: null });
      } catch (error) { update(row, { runsError: error.message ?? String(error) }); }
      finally { row.runsRead.delete(readKey); }
    })();
    row.runsRead.set(readKey, pending);
    return pending;
  }
  async function runAction(threadId, hostId, turnId, runId, method) {
    const manager = managers.get(hostId ?? 'local');
    if (!manager) return;
    const row = record(null, threadId, hostId), actionKey = `${turnId}:${runId ?? '*'}`;
    if (row.snapshot.runActions[actionKey]) return;
    update(row, { runActions: { ...row.snapshot.runActions, [actionKey]: true }, runsError: null });
    try {
      await manager.sendRequest(method, { threadId, turnId, ...(runId ? { runId } : {}) });
      // Wait out an earlier poll so the post-action read cannot reuse stale data.
      if (row.runsRead.has(turnId)) await row.runsRead.get(turnId);
      await refreshRuns(threadId, hostId, turnId);
    } catch (error) { update(row, { runsError: error.message ?? String(error) }); }
    finally { update(row, { runActions: { ...row.snapshot.runActions, [actionKey]: false } }); }
  }
  function SourceBadge({ React, jsx, threadId, hostId = 'local', turnId, raw }) {
    const row = record(null, threadId, hostId), state = useRecord(React, row);
    const source = sourceFor(threadId, hostId, turnId, raw);
    React.useEffect(() => { refreshSources(threadId, hostId); }, [threadId, hostId, turnId, raw?.status]);
    React.useEffect(() => {
      if (source !== 'both' || !threadId || !turnId || ['completed', 'interrupted', 'cancelled'].includes(state.workflows[turnId]?.status)) return;
      refreshRuns(threadId, hostId, turnId);
      const timer = setInterval(() => refreshRuns(threadId, hostId, turnId), 2000);
      return () => clearInterval(timer);
    }, [source, threadId, hostId, turnId, state.workflows[turnId]?.status]);
    if (!threadId || !turnId) return null;
    const label = source === 'both' ? 'Multi-agent (Codex / Claude)' : source === 'claude' ? 'Claude Code' : 'Codex';
    const workflow = state.workflows[turnId], runs = workflow?.runs ?? [];
    const blocked = ['blocked', 'failed', 'needs_attention'].includes(workflow?.status);
    const roleKey = run => JSON.stringify([run.stepId, run.roleId, run.round ?? 0]);
    const latestRuns = new Map();
    for (const run of runs) if (!latestRuns.has(roleKey(run)) || (latestRuns.get(roleKey(run)).attempt ?? 1) < (run.attempt ?? 1)) latestRuns.set(roleKey(run), run);
    const canRetry = run => workflow?.isLatestTurn !== false && ['blocked', 'failed', 'interrupted'].includes(workflow?.status)
      && ['failed', 'interrupted', 'cancelled', 'blocked'].includes(run.status) && latestRuns.get(roleKey(run))?.id === run.id
      && (!workflow.state?.invocations || Object.hasOwn(workflow.state.invocations, roleKey(run)));
    const canContinue = workflow?.isLatestTurn !== false && ['failed', 'interrupted'].includes(workflow?.status) && [...latestRuns.values()].every(run => run.status === 'completed');
    const interactive = managers.has(hostId);
    const actionButton = (label, aria, runId, method) => jsx.jsx('button', { type: 'button', 'aria-label': aria, style: selectStyle, disabled: !interactive || Boolean(state.runActions[`${turnId}:${runId ?? '*'}`]), onClick: () => runAction(threadId, hostId, turnId, runId, method), children: label });
    const errorText = error => typeof error === 'string' ? error : error?.message ?? (error ? JSON.stringify(error) : '');
    return jsx.jsxs('div', { 'data-cdx-engine-source': source, style: { fontSize: 11, margin: '8px 0 4px', minWidth: 0 }, children: [
      jsx.jsx('span', { style: { opacity: 0.65 }, children: label }),
      source === 'both' ? jsx.jsxs('details', { style: { marginTop: 4, border: '1px solid #8884', borderRadius: 6, padding: 6 }, children: [
        jsx.jsx('summary', { style: { cursor: 'pointer' }, children: `Workflow runs · ${workflow?.status ?? 'loading'} · ${runs.length} runs` }),
        canContinue ? jsx.jsxs('div', { role: 'status', style: { margin: '8px 0' }, children: ['Continue this workflow from its saved results. ', actionButton('Continue workflow', 'Continue workflow', null, 'engine/runs/retry')] }) : null,
        blocked && !canContinue ? jsx.jsxs('div', { role: 'status', style: { margin: '8px 0' }, children: ['Dependent work is blocked. Retry a failed run or end the turn to keep the partial results. ', actionButton('End turn', 'End workflow turn', null, 'turn/interrupt')] }) : null,
        ...runs.map(run => jsx.jsxs('details', { 'data-cdx-run-id': run.id, style: { margin: '6px 0', padding: 6, border: '1px solid #8884', borderRadius: 4 }, children: [
          jsx.jsx('summary', { style: { cursor: 'pointer', overflowWrap: 'anywhere' }, children: `${run.roleId ? roleLabel(run.roleId) : 'Role'} · ${run.stepId ?? run.taskId ?? run.id} · ${run.engine === 'claude' ? 'Claude Code' : run.engine === 'codex' ? 'Codex' : run.engine} · ${run.status}${run.round != null ? ` · round ${run.round}` : ''}${run.attempt != null ? ` · attempt ${run.attempt}` : ''}` }),
          jsx.jsx('div', { style: { overflowWrap: 'anywhere' }, children: `Requested model: ${run.requestedModel ?? 'engine default'}` }),
          run.actualModel ? jsx.jsx('div', { style: { overflowWrap: 'anywhere' }, children: `Actual model: ${run.actualModel}` }) : null,
          run.cwd ? jsx.jsx('div', { style: { overflowWrap: 'anywhere' }, children: `Workspace: ${run.cwd}` }) : null,
          run.artifact ? jsx.jsx('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, children: typeof run.artifact === 'string' ? run.artifact : JSON.stringify(run.artifact, null, 2) }) : null,
          run.text ? jsx.jsx('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto', userSelect: 'text' }, children: run.text }) : null,
          run.error ? jsx.jsx('div', { role: 'alert', style: { overflowWrap: 'anywhere' }, children: errorText(run.error) }) : null,
          ['queued', 'running', 'awaitingApproval'].includes(run.status) ? actionButton('Stop run', `Stop run ${run.id}`, run.id, 'engine/runs/interrupt') : null,
          canRetry(run) ? actionButton('Retry run', `Retry run ${run.id}`, run.id, 'engine/runs/retry') : null,
        ] }, run.id)),
        state.runsError ? jsx.jsx('div', { role: 'alert', children: state.runsError }) : null,
      ] }) : null,
    ] });
  }
  globalThis.__cdxEngineModes = {
    Selector, SourceBadge, TemplateControls, TemplateManager, RoleControls, refreshTemplates, refreshRuns, capture, requestFields, turnRequestFields, registerManager, noteStarted, observe,
    permitsNativeMetadata, permitsNativeModelSelection, sourceFor, setDraftSelection, changeSelection, refreshThread, refreshCapabilities,
    getCapabilities: (manager, context) => catalogRecord(manager, context).snapshot,
    refreshCodexModels, getCodexModels: (manager, context) => codexCatalogRecord(manager, context).snapshot,
    getSnapshot: (scope, threadId, hostId) => record(scope, threadId, hostId).snapshot,
  };
})();
