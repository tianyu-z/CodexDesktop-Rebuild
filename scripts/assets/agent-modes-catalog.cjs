const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Other app instances can populate the shared native catalog with role sessions.
// Filter this app's reads without archiving sessions or changing shared rows.
function createInternalThreadFilter(directory) {
  const registry = directory ? join(directory, 'internal-native-threads.json') : null;
  let known = new Set();
  function owned() {
    if (!registry) return known;
    let text;
    try { text = readFileSync(registry, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return known; throw error; }
    const ids = JSON.parse(text);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid internal native thread registry.');
    known = new Set(ids);
    return known;
  }
  return {
    visible(hostId, id) { return hostId !== 'local' || !owned().has(id); },
    publicIds(hostId, ids) {
      if (hostId !== 'local') return ids;
      const internal = owned();
      return ids.filter(id => !internal.has(id));
    },
    pageFilter(hostId, filter) {
      if (hostId !== 'local') return filter;
      const internal = owned();
      if (!internal.size) return filter;
      return { ...(filter ?? { includeAll: true }), excludeThreadIds: [...new Set([...(filter?.excludeThreadIds ?? []), ...internal])] };
    },
  };
}

module.exports = { createInternalThreadFilter };
