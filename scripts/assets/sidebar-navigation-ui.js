/* Appearance bridge for 26.820.71523. Native React, data and actions are supplied by the host. */
(() => {
  if (globalThis.__cdxSidebarNavigation) return;
  const matches = (path, prefix) => path === prefix || path.startsWith(prefix + '/');
  function areaForPath(path = '/') {
    path = path.split(/[?#]/, 1)[0];
    if (['/automations', '/scheduled'].some(prefix => matches(path, prefix))) return 'scheduled';
    if (['/plugins', '/skills', '/customize'].some(prefix => matches(path, prefix))) return 'customize';
    if (path === '/' || ['/thread', '/local', '/remote', '/chat', '/projects', '/archived', '/new', '/work/conversation', '/hotkey-window'].some(prefix => matches(path, prefix))) return 'home';
    return 'more';
  }
  function hasPanel(route = {}) {
    return ['scheduled', 'customize'].includes(areaForPath(route.routeTemplate ?? route.pathname ?? ''));
  }
  function partitionDestinations(items = []) {
    const primaryIds = ['builtin:automations', 'builtin:skills'];
    return { primary: primaryIds.flatMap(id => items.find(row => row.id === id) ?? []), more: items.filter(row => !primaryIds.includes(row.id)) };
  }
  // Official Codex 26.924.22138 navigation artwork.
  const officialIcons = {"homeSelected":"M9.16359 2.63179C9.7105 2.48208 10.2885 2.48214 10.8355 2.63179L11.0855 2.7148C11.212 2.76439 11.3333 2.82555 11.4546 2.89351C11.5671 2.95641 11.6803 3.02484 11.7935 3.10152C12.1006 3.30956 12.4552 3.5894 12.8902 3.93257L17.0786 7.23823L17.3316 7.43843V7.44038L18.3277 8.22749C18.6159 8.45506 18.6655 8.87284 18.438 9.16109C18.2104 9.44919 17.7916 9.49799 17.5034 9.27046L17.3316 9.13472V14C17.3316 14.4554 17.3325 14.8372 17.3071 15.1484C17.2811 15.4674 17.2242 15.771 17.0777 16.0585C16.8542 16.497 16.4975 16.8535 16.0591 17.0771C15.7716 17.2236 15.4679 17.2805 15.1489 17.3066C14.8378 17.332 14.4559 17.332 14.0005 17.332H12.0435V14.1669C12.0435 13.0387 11.1287 12.1234 10.0005 12.123C8.87201 12.123 7.95656 13.0384 7.95656 14.1669V17.332H6.00051C5.54496 17.332 5.1623 17.332 4.85109 17.3066C4.53232 17.2805 4.22932 17.2234 3.94191 17.0771C3.50329 16.8536 3.14594 16.4971 2.92238 16.0585C2.7759 15.771 2.71994 15.4673 2.69387 15.1484C2.66847 14.8372 2.66848 14.4554 2.66848 14V9.13277L2.49465 9.27046C2.20648 9.49779 1.78862 9.44906 1.56105 9.16109C1.33363 8.87297 1.38258 8.45514 1.67043 8.22749L2.66848 7.43941L2.92141 7.23823L7.10891 3.93355C7.54367 3.59031 7.89757 3.31064 8.20461 3.10249C8.23921 3.07904 8.27472 3.05734 8.3091 3.03511C8.38762 2.98434 8.46593 2.93742 8.54445 2.89351C8.74385 2.78197 8.94502 2.69167 9.16359 2.63179Z","customizeSelected":"M10.5218 1.88086C15.7229 1.88103 18.3087 5.71877 18.3089 9.1875C18.3089 10.6633 17.6937 12.1653 16.6029 13.0332C16.048 13.4746 15.3664 13.7516 14.5989 13.7559C13.9322 13.7595 13.2416 13.5567 12.5511 13.1387C11.9222 13.6401 11.204 13.9685 10.4544 14.0312C9.53599 14.108 8.63752 13.7834 7.91145 13.0293L7.87336 12.9893C7.85136 12.966 7.81965 12.9309 7.77961 12.8887C7.69927 12.8039 7.58563 12.685 7.45637 12.5488C7.19756 12.2762 6.87269 11.9347 6.60676 11.6572L6.54719 11.5889C6.27541 11.2404 6.30606 10.7359 6.63118 10.4229L6.84407 10.2168L6.10383 9.44629C5.84913 9.18168 5.85681 8.76056 6.12141 8.50586C6.38603 8.25141 6.80722 8.2599 7.06184 8.52441L7.80305 9.29395L9.59602 7.56836L8.85578 6.7998C8.60112 6.53524 8.60886 6.11408 8.87336 5.85938C9.13797 5.60468 9.55909 5.61235 9.81379 5.87695L10.554 6.64648L10.7757 6.43359C11.1245 6.09822 11.6802 6.10963 12.014 6.45996L13.3177 7.83008C14.0606 8.59515 14.354 9.50505 14.2347 10.4219C14.1544 11.0378 13.8892 11.6204 13.5052 12.1455C13.9128 12.3482 14.2767 12.4275 14.5921 12.4258C15.0287 12.4232 15.4267 12.269 15.7747 11.9922C16.4902 11.4228 16.9788 10.3386 16.9788 9.1875C16.9787 6.36412 14.9022 3.2111 10.5218 3.21094C6.86225 3.21102 3.70022 6.00757 3.45442 9.52734C3.17954 13.4659 5.9655 16.7889 10.2073 16.7891C11.819 16.789 13.4116 16.3859 14.5169 15.5303C14.8073 15.3056 15.2257 15.3591 15.4505 15.6494C15.6748 15.9397 15.6214 16.3573 15.3314 16.582C13.918 17.6763 12.0023 18.1191 10.2073 18.1191C5.14889 18.119 1.80185 14.0961 2.12727 9.43457C2.42565 5.16195 6.2212 1.88094 10.5218 1.88086Z","home":"M9.16491 2.63173C9.71169 2.48215 10.289 2.48212 10.8358 2.63173C11.1778 2.72543 11.48 2.8889 11.7938 3.10145C12.1009 3.3095 12.4556 3.58934 12.8905 3.93251L17.079 7.23817L17.3319 7.43837V7.44032L18.329 8.22841C18.6169 8.45595 18.6666 8.87383 18.4393 9.162C18.2118 9.4502 17.793 9.49877 17.5048 9.27138L17.3319 9.13466V13.9999C17.3319 14.4554 17.3329 14.8371 17.3075 15.1483C17.2814 15.4673 17.2245 15.7709 17.078 16.0585C16.8546 16.4969 16.4978 16.8535 16.0594 17.077C15.772 17.2235 15.4682 17.2804 15.1493 17.3065C14.8382 17.3319 14.4562 17.3319 14.0008 17.3319H11.4188V13.9579C11.4186 13.175 10.7837 12.5404 10.0008 12.5399C9.21764 12.5399 8.58209 13.1747 8.5819 13.9579V17.3319H6.00084C5.54535 17.3319 5.16262 17.3319 4.85143 17.3065C4.53266 17.2805 4.22966 17.2234 3.94225 17.077C3.5036 16.8535 3.14627 16.4971 2.92272 16.0585C2.77621 15.7709 2.72027 15.4673 2.6942 15.1483C2.6688 14.8371 2.66881 14.4554 2.66881 13.9999V9.13466L2.49596 9.27138C2.20783 9.49885 1.79002 9.44991 1.56237 9.162C1.33486 8.87382 1.3837 8.45603 1.67174 8.22841L2.66881 7.44032V7.43837L2.92174 7.23817L7.1112 3.93251C7.54597 3.58945 7.89989 3.30942 8.2069 3.10145C8.52085 2.88883 8.82275 2.7254 9.16491 2.63173ZM9.99596 3.8495C9.91933 3.84967 9.84263 3.85439 9.76647 3.86415C9.68232 3.87496 9.59887 3.89241 9.51647 3.91493C9.42142 3.94095 9.31925 3.98378 9.19127 4.05556C9.12054 4.09534 9.04147 4.14337 8.95202 4.20399C8.69423 4.37873 8.38416 4.62336 7.93444 4.97841L3.99889 8.08485V13.9999C3.99889 14.4775 3.99942 14.7964 4.0194 15.0409C4.03875 15.2773 4.07319 15.3861 4.10827 15.455C4.20432 15.6432 4.35748 15.7965 4.54577 15.8925C4.61466 15.9275 4.72363 15.962 4.95983 15.9813C5.20432 16.0013 5.52348 16.0018 6.00084 16.0018H7.25182V13.9579C7.25201 12.4402 8.4831 11.2099 10.0008 11.2099C11.5182 11.2103 12.7487 12.4405 12.7489 13.9579V16.0018H14.0008C14.478 16.0018 14.7965 16.0013 15.0409 15.9813C15.277 15.962 15.3861 15.9275 15.4549 15.8925C15.6432 15.7964 15.7975 15.6433 15.8934 15.455C15.9285 15.3861 15.962 15.2772 15.9813 15.0409C16.0013 14.7964 16.0018 14.4775 16.0018 13.9999V8.08388L12.0673 4.97841C11.6172 4.6231 11.3066 4.37881 11.0487 4.20399C10.7979 4.034 10.6327 3.95536 10.4852 3.91493C10.3662 3.88233 10.2442 3.86252 10.1219 3.85438C10.08 3.8516 10.038 3.8494 9.99596 3.8495Z","customize":"M10.5208 1.88086C15.7221 1.88086 18.3078 5.71869 18.3079 9.1875C18.3079 10.6634 17.6928 12.1653 16.6019 13.0332C16.0469 13.4746 15.3655 13.7517 14.598 13.7559C13.9313 13.7594 13.2416 13.5557 12.5511 13.1377C11.9219 13.6395 11.2034 13.9685 10.4534 14.0312C9.535 14.108 8.63654 13.7825 7.91047 13.0283L7.87238 12.9883C7.85039 12.965 7.8186 12.9309 7.77863 12.8887C7.69832 12.8039 7.58559 12.6849 7.45637 12.5488C7.19751 12.2762 6.87183 11.9348 6.60578 11.6572L6.54719 11.5889C6.27521 11.2405 6.30519 10.736 6.6302 10.4229L6.84504 10.2158L6.10383 9.44629C5.84919 9.18175 5.857 8.76058 6.12141 8.50586C6.38599 8.25118 6.80713 8.2589 7.06184 8.52344L7.80305 9.29297L9.59406 7.56836L8.85383 6.7998C8.59913 6.5352 8.60778 6.11407 8.87238 5.85938C9.13699 5.60473 9.55813 5.61237 9.81281 5.87695L10.553 6.64648L10.7747 6.43359C11.1235 6.098 11.6792 6.10952 12.013 6.45996L13.3167 7.8291C14.0599 8.59431 14.3531 9.50484 14.2337 10.4219C14.1535 11.0377 13.8891 11.6205 13.5052 12.1455C13.9126 12.3481 14.2758 12.4274 14.5911 12.4258C15.0278 12.4233 15.4257 12.269 15.7737 11.9922C16.4894 11.4229 16.9779 10.3387 16.9779 9.1875C16.9777 6.36405 14.9015 3.21094 10.5208 3.21094C6.8614 3.21118 3.69922 6.00766 3.45344 9.52734C3.17857 13.4658 5.9647 16.7887 10.2064 16.7891C11.8181 16.7891 13.4105 16.3859 14.5159 15.5303C14.8063 15.3055 15.2247 15.3591 15.4495 15.6494C15.6741 15.9398 15.6207 16.3573 15.3304 16.582C13.9169 17.6762 12.0013 18.1191 10.2064 18.1191C5.1481 18.1188 1.80089 14.096 2.12629 9.43457C2.42465 5.16205 6.22034 1.8811 10.5208 1.88086ZM7.8802 11.0654C8.06588 11.2601 8.25662 11.4605 8.42023 11.6328C8.54982 11.7693 8.66289 11.8886 8.74348 11.9736C8.78365 12.016 8.81607 12.0508 8.8382 12.0742L8.87238 12.1094C9.33016 12.583 9.83897 12.7472 10.3431 12.7051C10.8683 12.661 11.4519 12.3855 11.9945 11.8633C12.543 11.3352 12.848 10.7668 12.9154 10.25C12.9794 9.75778 12.8385 9.24516 12.3587 8.75293L12.3538 8.74707L11.3665 7.70996L7.8802 11.0654Z"};
  function Icon({ jsx, name, filled = false }) {
    const official = name === "home" ? officialIcons[filled ? "homeSelected" : "home"] : name === "plug" ? officialIcons[filled ? "customizeSelected" : "customize"] : null;
    if (official) return jsx.jsx("svg", { viewBox: "0 0 20 20", width: 20, height: 20, fill: "currentColor", "aria-hidden": true, children: jsx.jsx("path", { d: official, fillRule: "evenodd", clipRule: "evenodd" }) });
    const paths = {
      home: filled ? 'M3 10.5 10 4a3 3 0 0 1 4 0l7 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z' : 'm2.5 11 8-7a2.3 2.3 0 0 1 3 0l8 7M5 9v11h5v-6h4v6h5V9',
      clock: 'M12 7v5l-3 3M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
      plug: 'm9 7 2-2m4 8 2-2M8 8l8 8m-7-7-3 3 6 6 3-3M7 17l-3 3M22 12a10 10 0 1 0-4 8',
      settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
      plus: 'M12 5v14M5 12h14', search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
      skills: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z',
      chevron: 'm9 5 7 7-7 7',
    };
    return jsx.jsx('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, children: jsx.jsx('path', { d: paths[name] ?? paths.plug }) });
  }
  function Rail({ React, jsx, pathname, availableDestinations, home, onNavigate, renderItem, renderMore, onSettings, activity, pinnedDestinationIds = [] }) {
    const area = areaForPath(pathname), destinations = partitionDestinations(availableDestinations);
    React.useEffect(() => {
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.cdxAppearance = '2026-09';
        document.documentElement.dataset.cdxArea = area;
      }
    }, [area]);
    const wrap = item => ({ ...item, onSelect: () => { onNavigate?.(); item.onSelect?.(); } });
    const entries = [
      { ...home, label: 'Home', isCurrentDestination: area === 'home' || (area === 'more' && !availableDestinations.some(item => item.isCurrentDestination)), railIcon: jsx.jsx(Icon, { jsx, name: 'home', filled: area === 'home' }) },
      ...destinations.primary.map(item => ({ ...item, label: item.id === 'builtin:automations' ? 'Scheduled' : 'Customize', isCurrentDestination: area === (item.id === 'builtin:automations' ? 'scheduled' : 'customize'), railIcon: jsx.jsx(Icon, { jsx, name: item.id === 'builtin:automations' ? 'clock' : 'plug', filled: item.id === 'builtin:skills' && area === 'customize' }) })),
      ...pinnedDestinationIds.flatMap(id => destinations.more.find(item => item.id === id) ?? []),
    ];
    const more = destinations.more.filter(item => !pinnedDestinationIds.includes(item.id));
    return jsx.jsxs('nav', { className: 'cdx-nav-rail', 'aria-label': 'App navigation', children: [
      jsx.jsxs('div', { className: 'cdx-nav-rail-items', children: [entries.map(item => renderItem(wrap(item))), jsx.jsx('div', { className: 'cdx-nav-more', 'data-active': more.some(item => item.isCurrentDestination) || undefined, children: renderMore(more.map(wrap)) })] }),
      jsx.jsxs('div', { className: 'cdx-nav-rail-footer', children: [activity, renderItem({ id: 'builtin:settings', label: 'Settings', railIcon: jsx.jsx(Icon, { jsx, name: 'settings' }), onSelect: () => { onNavigate?.(); onSettings(); }, isCurrentDestination: false })] }),
    ] });
  }
  function Panel({ pathname, nativeContent, renderScheduled, renderCustomize }) {
    if (areaForPath(pathname) === 'scheduled') return renderScheduled();
    if (areaForPath(pathname) === 'customize') return renderCustomize();
    return nativeContent;
  }
  function PanelHeader({ jsx, title, children }) {
    return jsx.jsxs('div', { className: 'cdx-context-header', children: [jsx.jsx('h1', { children: title }), children] });
  }
  function ErrorRow({ jsx, title, retry }) {
    return jsx.jsxs('div', { className: 'cdx-context-error', role: 'status', children: [title, retry && jsx.jsx('button', { type: 'button', onClick: retry, children: 'Retry' })] });
  }
  function Scheduled({ React, jsx, rows, loading, errors = [], selectedKey, onCreate, onOverview, onOpenRun }) {
    const [query, setQuery] = React.useState(''), [filter, setFilter] = React.useState('all'), [search, setSearch] = React.useState(false);
    const searchButton = React.useRef(null), searchId = React.useId();
    const closeSearch = () => { setSearch(false); setQuery(''); searchButton.current?.focus(); };
    const visible = rows.filter(row => (filter === 'all' || row.status === filter) && row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return jsx.jsxs('section', { className: 'cdx-context-panel', 'aria-label': 'Scheduled', children: [
      jsx.jsx(PanelHeader, { jsx, title: 'Scheduled', children: jsx.jsx('button', { type: 'button', className: 'cdx-icon-button', ref: searchButton, 'aria-label': 'Search tasks', 'aria-expanded': search, 'aria-controls': search ? searchId : undefined, onClick: () => search ? closeSearch() : setSearch(true), children: jsx.jsx(Icon, { jsx, name: 'search' }) }) }),
      search && jsx.jsx('input', { id: searchId, className: 'cdx-context-search', type: 'search', 'aria-label': 'Search scheduled tasks', placeholder: 'Search tasks', value: query, autoFocus: true, onChange: event => setQuery(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); closeSearch(); } } }),
      jsx.jsxs('button', { type: 'button', className: 'cdx-context-row', onClick: () => { setQuery(''); setSearch(false); onCreate(); }, children: [jsx.jsx(Icon, { jsx, name: 'plus' }), 'New task'] }),
      jsx.jsxs('div', { className: 'cdx-context-section-heading', children: [jsx.jsx('button', { type: 'button', onClick: onOverview, children: 'Tasks' }), jsx.jsxs('select', { 'aria-label': 'Filter tasks by status', value: filter, onChange: event => setFilter(event.target.value), children: ['all', 'active', 'paused', 'completed'].map(value => jsx.jsx('option', { value, children: value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1) }, value)) })] }),
      jsx.jsxs('div', { className: 'cdx-context-scroll', children: [
        errors.map(error => jsx.jsx(ErrorRow, { jsx, ...error }, error.title)),
        loading && jsx.jsx('p', { className: 'cdx-context-hint', role: 'status', children: 'Loading tasks…' }),
        !loading && !visible.length && jsx.jsx('p', { className: 'cdx-context-hint', children: query ? 'No matching tasks' : errors.length ? 'Tasks could not be loaded.' : 'No tasks yet' }),
        visible.map(row => jsx.jsxs('div', { className: 'cdx-scheduled-item', children: [
          jsx.jsxs('button', { type: 'button', className: 'cdx-context-row cdx-task-row', 'aria-current': selectedKey === row.key ? 'page' : undefined, onClick: row.onSelect, children: [
            jsx.jsx('span', { className: 'cdx-task-status', 'data-status': row.running ? 'running' : row.status, 'aria-label': row.running ? 'Running' : row.status, children: jsx.jsx(Icon, { jsx, name: 'clock' }) }),
            jsx.jsxs('span', { className: 'cdx-context-row-text', children: [jsx.jsx('span', { className: 'cdx-task-title', children: row.title }), jsx.jsx('span', { className: 'cdx-task-description', children: row.schedule || row.status })] }),
            row.unread && jsx.jsx('span', { className: 'cdx-unread-dot', 'aria-label': 'Unread runs' }),
          ] }),
          selectedKey === row.key && (row.runs ?? []).slice(0, 3).map(run => jsx.jsx('button', { type: 'button', className: 'cdx-context-row cdx-task-run', disabled: !run.threadId, onClick: () => onOpenRun(run), children: run.title || 'Task run' }, run.id)),
        ] }, row.key)),
      ] }),
    ] });
  }
  function Customize({ React, jsx, plugins, pluginsAllowed, loading, error, onRetry, tab, selectedId, onPlugins, onSkills, hostLabel }) {
    const [query, setQuery] = React.useState('');
    const visible = plugins.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return jsx.jsxs('section', { className: 'cdx-context-panel', 'aria-label': 'Customize', children: [
      jsx.jsx(PanelHeader, { jsx, title: 'Customize' }),
      pluginsAllowed && jsx.jsxs('button', { type: 'button', className: 'cdx-context-row', 'aria-current': tab === 'plugins' && !selectedId ? 'page' : undefined, onClick: onPlugins, children: [jsx.jsx(Icon, { jsx, name: 'plug' }), 'Plugins'] }),
      jsx.jsxs('button', { type: 'button', className: 'cdx-context-row', 'aria-current': tab === 'skills' ? 'page' : undefined, onClick: onSkills, children: [jsx.jsx(Icon, { jsx, name: 'skills' }), 'Skills'] }),
      pluginsAllowed && jsx.jsxs(jsx.Fragment || 'div', { children: [
        jsx.jsxs('div', { className: 'cdx-context-section-heading', children: ['Installed', hostLabel && jsx.jsx('span', { className: 'cdx-host-label', children: hostLabel })] }),
        (plugins.length > 8 || query) && jsx.jsx('input', { className: 'cdx-context-search', type: 'search', 'aria-label': 'Search installed plugins', placeholder: 'Search installed', value: query, onChange: event => setQuery(event.target.value) }),
        jsx.jsxs('div', { className: 'cdx-context-scroll', children: [
          loading && jsx.jsx('p', { className: 'cdx-context-hint', role: 'status', children: 'Loading plugins…' }),
          error && jsx.jsx(ErrorRow, { jsx, title: 'Unable to load installed plugins', retry: onRetry }),
          !loading && !error && !visible.length && jsx.jsx('p', { className: 'cdx-context-hint', children: query ? 'No matching plugins' : 'No installed plugins' }),
          visible.map(item => jsx.jsxs('button', { type: 'button', className: 'cdx-context-row', 'aria-current': selectedId === item.id ? 'page' : undefined, onClick: item.onSelect, children: [jsx.jsx(Icon, { jsx, name: 'plug' }), jsx.jsx('span', { className: 'cdx-context-row-text', children: item.title }), !item.enabled && jsx.jsx('span', { className: 'cdx-host-label', children: 'Disabled' })] }, item.id)),
        ] }),
      ] }),
    ] });
  }
  globalThis.__cdxSidebarNavigation = { areaForPath, hasPanel, partitionDestinations, Rail, Panel, Scheduled, Customize };
})();
