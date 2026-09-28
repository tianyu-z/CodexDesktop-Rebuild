/* Injected only into the pinned app-initial bundle; these names are validated by the patcher. */
function GSl(props) {
  const location = Ff(), state = Y(gdl), { accountId } = IA();
  const visibility = odl(state, accountId);
  const pinnedDestinationIds = props.sidebarCustomizationEnabled ? adl({ accountId, eligibleDestinations: props.availableDestinations, state }).filter(id => visibility[id] === true) : [];
  return (0, x8.jsx)(globalThis.__cdxSidebarNavigation.Rail, {
    ...props, React: ZSl, jsx: x8, pathname: location.pathname,
    pinnedDestinationIds,
    renderItem: item => (0, x8.jsx)(YSl, { item, showCustomizeSidebarAction: props.showCustomizeSidebarAction }, item.id),
    renderMore: items => (0, x8.jsx)(LSl, { items, iconOnly: true, showCustomizeSidebarAction: props.showCustomizeSidebarAction }),
    onSettings: () => fN('settings', 'sidebar_rail'),
  });
}
function __cdxContextualNavigation({ nativeContent }) {
  const location = Ff();
  return (0, g7.jsx)(globalThis.__cdxSidebarNavigation.Panel, {
    pathname: location.pathname, nativeContent,
    renderScheduled: () => (0, g7.jsx)(__cdxScheduledNavigation, {}),
    renderCustomize: () => (0, g7.jsx)(__cdxCustomizeNavigation, {}),
  });
}
function __cdxScheduledNavigation() {
  kCn(); kfl(); Hfl(); ols(); Qz();
  const local = Y(DCn), cloud = Y(bfl), accountId = Y(yfl), history = Ifl();
  const navigate = Lf(), location = Ff(), intl = pd(), openConversation = Zz();
  const select = (source, id) => {
    const params = new URLSearchParams({ automationId: id });
    if (source === 'cloud') params.set('automationSource', 'cloud');
    navigate('/automations?' + params.toString());
  };
  const rows = (local.data?.items ?? []).filter(item => item.status !== 'DELETED').map(item => ({
    key: 'local:' + item.id, title: item.name || 'Untitled task', status: item.status === 'PAUSED' ? 'paused' : 'active',
    schedule: lcs({ rrule: item.rrule, nextRunAt: item.nextRunAt, intl, fallbackMessage: 'Custom schedule' }),
    unread: history.unreadRunCounts?.automationIds?.includes(item.id),
    running: history.items.some(run => run.automationId === item.id && run.status === 'IN_PROGRESS'),
    runs: history.items.filter(run => run.automationId === item.id && run.status !== 'ARCHIVED').sort((a, b) => b.createdAt - a.createdAt),
    onSelect: () => select('local', item.id),
  }));
  if (accountId != null && cloud.data?.accountId === accountId) {
    for (const item of cloud.data.items ?? []) rows.push({
      key: 'cloud:' + item.automation.id, title: Jdl(item) || 'Untitled task', status: Xdl(item.automation),
      schedule: Zdl(item, intl), onSelect: () => select('cloud', item.automation.id),
    });
  }
  const params = new URLSearchParams(location.search), errors = [];
  if (local.error) errors.push({ title: 'Unable to load local tasks', retry: () => local.refetch() });
  if (accountId != null && cloud.error) errors.push({ title: 'Unable to load cloud tasks', retry: () => cloud.refetch() });
  return (0, g7.jsx)(globalThis.__cdxSidebarNavigation.Scheduled, {
    React: GKl, jsx: g7, rows, errors,
    loading: local.isLoading || (accountId != null && cloud.isLoading),
    selectedKey: (params.get('automationSource') === 'cloud' ? 'cloud:' : 'local:') + params.get('automationId'),
    onCreate: () => navigate('/automations?automationMode=create'), onOverview: () => navigate('/automations'),
    onOpenRun: run => { if (run.threadId) { history.markRead(run.id); openConversation(run.threadId); } },
  });
}
function __cdxCustomizeNavigation() {
  const [page, setPage] = GKl.useState(null), [error, setError] = GKl.useState(false), [attempt, setAttempt] = GKl.useState(0);
  const navigate = Lf();
  GKl.useEffect(() => {
    let active = true;
    setError(false);
    import('./plugins-page-DTKQBhc9.js').then(module => { module.s(); if (active) setPage(module); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  if (page) return (0, g7.jsx)(__cdxLoadedCustomizeNavigation, { page });
  return (0, g7.jsx)(globalThis.__cdxSidebarNavigation.Customize, {
    React: GKl, jsx: g7, plugins: [], pluginsAllowed: true, loading: !error, error,
    onRetry: () => setAttempt(value => value + 1), onPlugins: () => navigate('/plugins'),
    onSkills: () => navigate('/skills', { state: { initialTab: 'skills' } }),
  });
}
function __cdxLoadedCustomizeNavigation({ page }) {
  A_l(); f5i();
  const location = Ff(), navigate = Lf(), initial = lni(location.state), saved = ss(page.d, location.key);
  const initialHostId = saved?.selectedHostId ?? initial.initialHostId ?? 'local';
  const hostKey = { historyKey: location.key, initialHostId };
  const chosenHost = ss(page.u, hostKey), connections = jU(Y(GS) ?? []), directoryHost = dCs(chosenHost, connections);
  const tab = ss(page.c, { historyKey: location.key, initialTab: saved == null && initial.initialTab === 'skills' ? 'skills' : 'plugins' });
  const details = location.pathname.startsWith('/skills/plugins/');
  const hostId = details ? new URLSearchParams(location.search).get('hostId') ?? 'local' : directoryHost;
  const pluginsAllowed = ej({ enabled: true, hostId });
  const query = fj({ enabled: pluginsAllowed, hostId, roots: void 0, resolveActiveRoots: true });
  const hideChrome = u5i(), { value: directoryConfig } = xC('1349514884');
  const { hiddenPluginIds } = O_l(directoryConfig);
  const visible = query.data == null ? [] : xEc(query.data, hiddenPluginIds, hideChrome);
  const entries = gEc({ plugins: visible, query: '', dedupeSearchResults: true });
  const plugins = entries.map(entry => ({
    id: entry.plugin.id, title: entry.displayName ?? entry.plugin.interface?.displayName ?? entry.plugin.name,
    enabled: entry.plugin.enabled,
    onSelect: () => navigate(f9i(entry, { hostId }), { state: { initialHostId: hostId, pluginDisplayName: entry.displayName ?? entry.plugin.name } }),
  }));
  return (0, g7.jsx)(globalThis.__cdxSidebarNavigation.Customize, {
    React: GKl, jsx: g7, plugins, pluginsAllowed, loading: query.isLoading, error: query.error,
    onRetry: () => query.refetch(), tab, selectedId: details ? decodeURIComponent(location.pathname.slice('/skills/plugins/'.length)) : null,
    hostLabel: hostId === 'local' ? 'Local' : connections?.find(host => host.hostId === hostId)?.displayName ?? hostId,
    onPlugins: () => navigate('/plugins', { state: { initialHostId: hostId, initialTab: 'plugins' } }),
    onSkills: () => navigate('/skills', { state: { initialHostId: hostId, initialTab: 'skills' } }),
  }, hostId);
}
