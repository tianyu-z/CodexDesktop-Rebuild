const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const enabled = (value) => typeof value === 'string' && /^(1|true|yes)$/i.test(value);
const nonempty = (value) => typeof value === 'string' && value.length > 0;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,255}$/.exec(value)?.[0] === value;
const claudeFamily = (value) => typeof value === 'string' && /(?:^|[/:.])claude(?:[-._:/@\[]|$)/i.test(value);

class ProviderCatalogError extends Error {
  constructor(message, configuration) {
    super(message);
    this.provider = configuration.provider;
    this.endpointPath = configuration.endpoint?.pathname ?? null;
  }
}

function baseUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function configuration(env) {
  // These providers use different authentication/protocols. Never redirect
  // their credentials to an Anthropic-compatible endpoint by guesswork.
  for (const [flag, provider] of [['CLAUDE_CODE_USE_BEDROCK', 'bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'vertex'], ['CLAUDE_CODE_USE_MANTLE', 'mantle'], ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'anthropic-aws'], ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'anthropic-google-cloud'], ['CLAUDE_CODE_USE_GATEWAY', 'gateway']]) {
    // Native Claude accountInfo selects Foundry when both Foundry and Vertex
    // flags are enabled. Preserve the environment and all other provider guards.
    if (provider === 'vertex' && enabled(env.CLAUDE_CODE_USE_FOUNDRY)) continue;
    if (enabled(env[flag])) return { provider };
  }
  if (enabled(env.CLAUDE_CODE_USE_FOUNDRY)) {
    const result = { provider: 'foundry' };
    const base = baseUrl(env.ANTHROPIC_FOUNDRY_BASE_URL);
    if (!base || base.pathname.replace(/\/+$/, '') !== '/anthropic' || !nonempty(env.ANTHROPIC_FOUNDRY_API_KEY)) return result;
    return { ...result, endpoint: new URL('/openai/v1/models', base), headers: { 'api-key': env.ANTHROPIC_FOUNDRY_API_KEY } };
  }
  const result = { provider: 'anthropic' };
  const base = baseUrl(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  if (!base || (!nonempty(env.ANTHROPIC_API_KEY) && !nonempty(env.ANTHROPIC_AUTH_TOKEN))) return result;
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = path.endsWith('/v1') ? `${path}/models` : `${path}/v1/models`;
  const authentication = nonempty(env.ANTHROPIC_AUTH_TOKEN) ? { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` } : { 'x-api-key': env.ANTHROPIC_API_KEY };
  return { ...result, endpoint: base, headers: { ...authentication, 'anthropic-version': '2023-06-01' } };
}

/** Safe configuration metadata, including when a request times out. */
export function providerCatalogInfo(env) {
  const config = configuration(env);
  return { provider: config.provider, endpointPath: config.endpoint?.pathname ?? null };
}

function requestHeaders(env, defaults) {
  const headers = new Headers(defaults);
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('Invalid provider custom header.');
    headers.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return Object.fromEntries(headers);
}

function nextLink(body, headers, current, rows) {
  for (const value of [body.next, body.next_link, body.nextLink, body.links?.next, body.links?.next?.href]) {
    if (nonempty(value)) return new URL(value, current);
  }
  for (const part of (headers?.get('link') ?? '').split(',')) {
    const target = part.match(/<([^>]+)>/);
    const relation = part.match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i);
    if (target && (relation?.[1] ?? relation?.[2] ?? '').split(/\s+/).includes('next')) return new URL(target[1], current);
  }
  if (body.has_more === true) {
    const cursor = nonempty(body.last_id) ? body.last_id : rows.at(-1)?.id;
    if (!nonempty(cursor)) throw new Error('Missing pagination cursor.');
    const next = new URL(current);
    next.searchParams.set('after_id', cursor);
    return next;
  }
  return null;
}

function advertisedModel(row, provider) {
  if (!record(row) || !identifier(row.id)) return null;
  // Foundry is a mixed-provider catalog; Anthropic's dedicated protocol also
  // permits deployment names that do not contain the word Claude.
  if (provider === 'foundry') {
    if (!claudeFamily(row.id) && !claudeFamily(row.model_family) && !claudeFamily(row.family)) return null;
    if (row.capabilities?.inference === false || row.capabilities?.chat_completion === false) return null;
  }
  const descriptions = [];
  if (nonempty(row.description)) descriptions.push(row.description);
  descriptions.push('Advertised by the provider API; not individually verified.');
  if (nonempty(row.lifecycle_status)) descriptions.push(`Lifecycle: ${row.lifecycle_status}.`);
  return {
    value: row.id,
    resolvedModel: row.id,
    displayName: nonempty(row.display_name) ? row.display_name : nonempty(row.displayName) ? row.displayName : row.id,
    description: descriptions.join(' '),
  };
}

/** Read only advertised model metadata; never send inference requests. */
export async function discoverProviderModels({ env, signal, fetchImpl = globalThis.fetch }) {
  signal?.throwIfAborted();
  const config = configuration(env);
  if (!config.endpoint) return { models: [], provider: config.provider, endpointPath: null, apiStatus: 'unsupported', advertised: true };
  const seenPages = new Set();
  const models = new Map();
  let current = config.endpoint;
  try {
    const headers = requestHeaders(env, config.headers);
    while (current) {
      signal?.throwIfAborted();
      if (current.origin !== config.endpoint.origin || current.username || current.password) throw new ProviderCatalogError('Provider model catalog pagination changed origin.', config);
      if (seenPages.has(current.href) || seenPages.size >= 100) throw new ProviderCatalogError('Provider model catalog pagination did not complete.', config);
      seenPages.add(current.href);
      // Even a same-origin redirect is rejected. The configured endpoint and
      // checked pagination links are the only destinations receiving the key.
      const response = await fetchImpl(current.href, { method: 'GET', headers, redirect: 'error', signal });
      if (!response.ok || (response.url && new URL(response.url).origin !== config.endpoint.origin)) {
        await response.body?.cancel();
        throw new ProviderCatalogError('Provider model catalog request was unsuccessful.', config);
      }
      const body = await response.json();
      const rows = record(body) ? body.data : null;
      if (!Array.isArray(rows)) throw new ProviderCatalogError('Provider returned an invalid model catalog.', config);
      for (const row of rows) {
        const model = advertisedModel(row, config.provider);
        if (model && !models.has(model.value)) models.set(model.value, model);
      }
      current = nextLink(body, response.headers, current, rows);
    }
    return { models: [...models.values()], provider: config.provider, endpointPath: config.endpoint.pathname, apiStatus: 'success', advertised: true };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ProviderCatalogError) throw error;
    // Never include response bodies, URLs with query strings, or raw errors:
    // proxies can echo credentials in any of those fields.
    throw new ProviderCatalogError('Provider model catalog request or pagination failed.', config);
  }
}
