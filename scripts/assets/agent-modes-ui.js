/* Shared renderer helper. React is supplied by the host bundle after its factories initialize. */
(() => {
  if (globalThis.__cdxEngineModes) return;
  const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,255}$/;
  const MODEL_CACHE_TTL = 60_000;
  const modelCatalogs = new WeakMap();
  const disconnectedCatalog = newCatalog();
  const drafts = new WeakMap();
  const threads = new Map();
  const managers = new Map();
  const key = (threadId, hostId) => `${hostId ?? 'local'}\0${threadId}`;
  const local = hostId => hostId == null || hostId === 'local';
  function fresh() {
    return { snapshot: { engineMode: 'codex', models: { codex: null, claude: 'default' }, busy: false, pending: false, loading: false, available: null, error: null, turnEngines: {} }, listeners: new Set(), revision: 0, hydrated: false, creationIntent: null, read: null, sourcesRead: null };
  }
  function record(scope, threadId, hostId = 'local') {
    if (threadId != null) {
      const id = key(threadId, hostId);
      if (!threads.has(id)) threads.set(id, fresh());
      return threads.get(id);
    }
    const node = scope?.node ?? scope;
    if (!node || typeof node !== 'object') throw Error('A composer scope is required');
    if (!drafts.has(node)) drafts.set(node, fresh());
    return drafts.get(node);
  }
  function update(row, values) {
    const next = { ...row.snapshot, ...values };
    if (JSON.stringify(next) === JSON.stringify(row.snapshot)) return;
    row.snapshot = next;
    for (const listener of row.listeners) listener();
  }
  function validModelId(value) { return typeof value === 'string' && MODEL_ID.exec(value)?.[0] === value; }
  function displayText(value, limit = 512) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : ''; }
  function newCatalog() {
    return { snapshot: { claudeModels: [], modelListError: null, engines: null, loading: false, loadedAt: null }, listeners: new Set(), revision: 0, promise: null };
  }
  function catalogRecord(manager, { threadId, cwd } = {}) {
    if (!manager || !['object', 'function'].includes(typeof manager)) return disconnectedCatalog;
    let contexts = modelCatalogs.get(manager);
    if (!contexts) { contexts = new Map(); modelCatalogs.set(manager, contexts); }
    const contextKey = JSON.stringify([threadId ?? null, cwd ?? null]);
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
  async function refreshCapabilities(manager, { hostId = 'local', threadId, cwd, force = false } = {}) {
    const row = catalogRecord(manager, { threadId, cwd });
    if (!manager || !local(hostId)) return row.snapshot;
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
        update(row, { claudeModels: error && models.length === 0 ? row.snapshot.claudeModels : models, modelListError: error, engines: Array.isArray(response?.engines) ? response.engines.filter(value => typeof value === 'string') : row.snapshot.engines, loadedAt: Date.now() });
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
    if (!['codex', 'claude'].includes(selection.engineMode)) throw Error('Codex + Claude Code is not available yet');
    if (selection.engineMode === 'claude' && selection.engineModel != null && !validModelId(selection.engineModel)) throw Error('Invalid Claude Code model identifier');
  }
  function applyState(row, state) {
    const values = { loading: false, available: true, error: null };
    if (['codex', 'claude'].includes(state?.engineMode)) values.engineMode = state.engineMode;
    if (state?.models) values.models = { ...row.snapshot.models, ...state.models };
    if (state?.busy != null) values.busy = state.busy;
    if (state?.turnEngines) values.turnEngines = { ...row.snapshot.turnEngines, ...state.turnEngines };
    // A prewarmed shell still reports its old engine until the first turn reaches
    // the gateway. Reads may update busy/history, but cannot erase captured intent.
    if (row.creationIntent) {
      values.engineMode = row.creationIntent.engineMode;
      if (row.creationIntent.engineMode === 'claude') values.models = { ...row.snapshot.models, ...values.models, claude: row.creationIntent.engineModel };
    }
    row.hydrated = true;
    update(row, values);
  }
  function requestFields(options) {
    if (options?.engineMode == null) return {};
    validate(options);
    return options.engineMode === 'claude'
      ? { engineMode: 'claude', engineModel: options.engineModel ?? 'default' }
      : { engineMode: 'codex' };
  }
  function turnRequestFields(manager, threadId, options, clientUserMessageId) {
    const hostId = manager?.getHostId?.() ?? 'local';
    const row = local(hostId) ? threads.get(key(threadId, hostId)) : null;
    if (!row?.creationIntent) return requestFields(options);
    // Preparation may fail before the first override reaches the gateway. The
    // ordinary existing-chat retry must carry that same captured selection.
    const fields = requestFields(options?.engineMode == null ? row.creationIntent : options);
    row.creationIntent = { ...fields, clientUserMessageId: clientUserMessageId ?? null };
    row.revision++;
    applyState(row, { engineMode: fields.engineMode });
    return fields;
  }
  function setDraftSelection(scope, selection) {
    validate(selection);
    const row = record(scope, null);
    if (row.snapshot.pending || row.snapshot.busy) throw Error('Wait for the current turn to finish');
    row.revision++;
    update(row, { engineMode: selection.engineMode, models: { ...row.snapshot.models, ...(selection.engineMode === 'claude' && selection.engineModel != null ? { claude: selection.engineModel } : {}) }, error: null });
  }
  function capture(scope, hostId) {
    if (!local(hostId)) return {};
    const state = record(scope, null).snapshot;
    if (state.engineMode === 'claude') return { engineMode: 'claude', engineModel: state.models.claude ?? 'default', skipAutoTitleGeneration: true };
    return { engineMode: 'codex' };
  }
  function registerManager(manager, hostId = manager?.getHostId?.() ?? 'local') {
    if (manager && managers.get(hostId) !== manager) managers.set(hostId, manager);
  }
  function noteStarted(manager, threadId, options) {
    registerManager(manager);
    if (options?.engineMode == null || !local(manager?.getHostId?.())) return;
    const fields = requestFields(options), row = record(null, threadId, 'local');
    row.creationIntent = { ...fields, clientUserMessageId: options.clientUserMessageId ?? null };
    row.revision++;
    applyState(row, { ...fields, models: { ...row.snapshot.models, ...(fields.engineMode === 'claude' ? { claude: fields.engineModel } : {}) } });
  }
  function observe(manager, method, params, response) {
    registerManager(manager);
    const hostId = manager?.getHostId?.() ?? 'local';
    if (!local(hostId)) return;
    const threadId = params?.threadId ?? response?.thread?.id;
    if (!threadId) return;
    const row = record(null, threadId, hostId);
    // Reads are applied by their caller with a revision check. An old in-flight read
    // must never undo a newly acknowledged selection.
    if (method === 'engine/mode/set') { row.creationIntent = null; row.revision++; applyState(row, response); }
    const intent = row.creationIntent;
    if (method === 'turn/start' && response?.turn && intent && params.engineMode === intent.engineMode
      && (intent.clientUserMessageId == null || params.clientUserMessageId === intent.clientUserMessageId)) {
      row.creationIntent = null;
      row.revision++; // Invalidate mode reads that began before this acknowledgment.
      applyState(row, { engineMode: intent.engineMode, models: row.snapshot.models });
    }
    const sources = { ...row.snapshot.turnEngines, ...(response?.turnEngines ?? {}), ...(method === 'engine/turns/read' ? response?.turns : {}) };
    const rawTurns = response?.thread?.turns ?? (Array.isArray(response?.turns) ? response.turns : []);
    for (const turn of rawTurns) {
      const engine = turn.cdxEngineSource ?? turn.items?.find(item => item.cdxEngineSource)?.cdxEngineSource;
      if (['codex', 'claude'].includes(engine)) sources[turn.id ?? turn.turnId] = engine;
    }
    update(row, { turnEngines: sources });
  }
  async function refreshThread(scope, threadId, hostId, manager) {
    if (!local(hostId) || threadId == null) return;
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
    if (!local(hostId)) throw Error('Claude Code is available for local chats only');
    const row = record(scope, threadId, hostId);
    if (row.snapshot.pending || row.snapshot.busy) throw Error('Wait for the current turn to finish');
    if (threadId == null) { setDraftSelection(scope, selection); return; }
    row.revision++;
    update(row, { pending: true, error: null });
    try {
      const selected = requestFields({ ...selection, engineModel: selection.engineModel ?? row.snapshot.models.claude });
      const state = await manager.sendRequest('engine/mode/set', { threadId, ...selected });
      row.creationIntent = null;
      applyState(row, state);
    } catch (error) {
      update(row, { error: error.message ?? String(error) });
      throw error;
    } finally { update(row, { pending: false }); }
  }
  async function permitsNativeMetadata(manager, threadId) {
    if (!local(manager?.getHostId?.())) return true;
    registerManager(manager);
    const row = record(null, threadId, 'local');
    // Explicit Claude intent can precede the first request on a prewarmed shell.
    // Never let that shell's temporary Codex default authorize metadata inference.
    if (row.creationIntent?.engineMode === 'claude' || row.snapshot.pending || row.snapshot.engineMode === 'claude') return false;
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
  function sourceFor(threadId, hostId, turnId, raw) {
    const explicit = raw?.cdxEngineSource ?? raw?.items?.find(item => item.cdxEngineSource)?.cdxEngineSource;
    if (['codex', 'claude'].includes(explicit)) return explicit;
    if (!local(hostId)) return 'codex';
    return record(null, threadId, hostId).snapshot.turnEngines[turnId] ?? 'codex';
  }
  async function refreshSources(threadId, hostId) {
    const manager = managers.get(hostId ?? 'local');
    if (!local(hostId) || !manager || !threadId) return;
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
  const selectStyle = { color: 'inherit', background: 'transparent', border: '1px solid var(--border, #8885)', borderRadius: 6, fontSize: 12, padding: '3px 5px', maxWidth: 160, cursor: 'pointer' };
  function Selector(props) {
    const { React, jsx, scope, threadId, nativeModelPicker } = props;
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
    const catalog = useRecord(React, catalogRecord(manager, { threadId, cwd }));
    React.useEffect(() => {
      if (!local(hostId) || !manager) return;
      refreshCapabilities(manager, { hostId, threadId, cwd });
      if (threadId != null) refreshThread(scope, threadId, hostId, manager);
      const interval = threadId == null ? null : setInterval(() => refreshThread(scope, threadId, hostId, manager), 2000);
      return () => { if (interval != null) clearInterval(interval); };
    }, [row, manager, hostId, threadId, cwd, scope]);
    const busy = Boolean(inProgress || state.busy || state.pending || requests?.length || runtimeStatus?.type === 'active');
    const unavailable = !local(hostId) || !manager || state.available === false;
    const disabled = busy || state.loading || unavailable;
    const claudeAvailable = state.available === true || catalog.engines?.includes('claude') === true;
    const reason = !local(hostId) ? 'Claude Code is available for local chats only' : connectionError ?? state.error ?? (busy ? 'Wait for the current turn and approvals to finish' : 'Choose the engine for this chat');
    const mode = local(hostId) ? state.engineMode : 'codex';
    const change = selection => { changeSelection({ scope, threadId, hostId, manager }, selection).catch(() => {}); };
    const modePicker = jsx.jsxs('select', {
      'aria-label': 'Chat engine', 'data-testid': 'chat-engine-selector', value: mode, disabled, title: reason, style: selectStyle,
      onChange: event => change({ engineMode: event.target.value }),
      onFocus: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      onPointerDown: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      children: [jsx.jsx('option', { value: 'codex', children: 'Only Codex' }), jsx.jsx('option', { value: 'claude', disabled: !local(hostId) || !claudeAvailable, children: 'Only Claude Code' }), jsx.jsx('option', { value: 'both', disabled: true, children: 'Codex + Claude Code (coming later)' })],
    });
    const modelPicker = mode === 'claude' ? jsx.jsx('select', {
      'aria-label': 'Claude Code model', 'data-testid': 'claude-model-selector', value: state.models.claude ?? 'default', disabled: disabled || !claudeAvailable, title: 'Claude Code uses its own project/user permissions and per-tool approvals. The Codex permission selector applies only to Codex.', style: { ...selectStyle, maxWidth: 220 },
      onChange: event => change({ engineMode: 'claude', engineModel: event.target.value }),
      onFocus: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      onPointerDown: () => refreshCapabilities(manager, { hostId, threadId, cwd }),
      children: modelOptions(catalog, state.models.claude ?? 'default').map(model => jsx.jsx('option', { value: model.value, title: modelTitle(model), children: modelLabel(model) }, model.value)),
    }) : nativeModelPicker;
    const refreshModels = (mode === 'claude' || catalog.modelListError) && local(hostId) ? jsx.jsx('button', { type: 'button', 'aria-label': 'Refresh Claude models', title: 'Refresh models', disabled: !manager || catalog.loading, style: { ...selectStyle, border: 'none', padding: '2px 4px' }, onClick: () => refreshCapabilities(manager, { hostId, threadId, cwd, force: true }), children: '↻' }) : null;
    const errorStyle = { fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const modelError = local(hostId) && catalog.modelListError ? jsx.jsx('span', { role: 'status', title: catalog.modelListError, style: errorStyle, children: `Model discovery: ${catalog.modelListError}` }) : null;
    return jsx.jsxs('span', { className: 'flex min-w-0 items-center gap-1', 'data-cdx-engine-controls': true, children: [modePicker, modelPicker, refreshModels, modelError, state.error && local(hostId) ? jsx.jsx('span', { role: 'alert', title: state.error, style: errorStyle, children: state.error }) : null] });
  }
  function SourceBadge({ React, jsx, threadId, hostId, turnId, raw }) {
    const row = record(null, threadId, hostId);
    useRecord(React, row);
    React.useEffect(() => { refreshSources(threadId, hostId); }, [threadId, hostId, turnId, raw?.status]);
    if (!threadId || !turnId) return null;
    const source = sourceFor(threadId, hostId, turnId, raw), label = source === 'claude' ? 'Claude Code' : 'Codex';
    return jsx.jsx('div', { 'data-cdx-engine-source': source, style: { fontSize: 11, opacity: 0.65, margin: '8px 0 4px', userSelect: 'none' }, children: label });
  }
  globalThis.__cdxEngineModes = {
    Selector, SourceBadge, capture, requestFields, turnRequestFields, registerManager, noteStarted, observe,
    permitsNativeMetadata, sourceFor, setDraftSelection, changeSelection, refreshThread, refreshCapabilities,
    getCapabilities: (manager, context) => catalogRecord(manager, context).snapshot,
    getSnapshot: (scope, threadId, hostId) => record(scope, threadId, hostId).snapshot,
  };
})();
