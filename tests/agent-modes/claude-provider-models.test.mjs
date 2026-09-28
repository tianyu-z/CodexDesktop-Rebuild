import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { discoverProviderModels } from '../../runtime/agent-modes/claude-provider-models.mjs';

const foundry = { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://provider.test/anthropic', ANTHROPIC_FOUNDRY_API_KEY: 'fixture-foundry-key' };
const page = (data, extra = {}, headers = {}) => Response.json({ data, ...extra }, { headers });

test('Foundry API includes all advertised Claude families and versions without version filtering', async () => {
  const requests = [];
  const ids = ['claude-opus-5-5-2', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-2', 'claude-fable-50-1', 'anthropic/claude-future-80', 'claude-opus-4-1'];
  const result = await discoverProviderModels({ env: foundry, fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return page([...ids.map(id => ({ id, lifecycle_status: id === 'claude-opus-4-1' ? 'deprecated' : 'preview' })), { id: ids[0] }, { id: 'gpt-99' }, { id: 'dall-e-20' }, { id: 'whisper-8' }]);
  } });
  assert.deepEqual(result.models.map(model => model.value), ids);
  assert.equal(result.provider, 'foundry');
  assert.equal(result.endpointPath, '/openai/v1/models');
  assert.equal(result.apiStatus, 'success');
  assert.equal(result.advertised, true);
  assert.equal(requests[0].url, 'https://provider.test/openai/v1/models');
  assert.equal(requests[0].options.headers['api-key'], 'fixture-foundry-key');
  assert.equal(requests[0].options.redirect, 'error');
  assert.match(result.models.at(-1).description, /deprecated/);
  assert.match(result.models[0].description, /advertised|not individually verified/i);
});

test('standard Anthropic models accept custom deployment IDs without Claude names or capability flags', async () => {
  let request;
  const result = await discoverProviderModels({ env: { ANTHROPIC_API_KEY: 'fixture-anthropic-key', ANTHROPIC_BASE_URL: 'https://anthropic.test' }, fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return page([{ id: 'claude-new-family-100', display_name: 'New Claude family' }, { id: 'custom/deployment-v42' }, { id: '--invalid' }]);
  } });
  assert.equal(request.url, 'https://anthropic.test/v1/models');
  assert.equal(request.options.headers['x-api-key'], 'fixture-anthropic-key');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(result.models[0].displayName, 'New Claude family');
  assert.deepEqual(result.models.map(row => row.value), ['claude-new-family-100', 'custom/deployment-v42']);
});

test('Foundry excludes explicitly non-chat models and accepts custom IDs with a Claude family', async () => {
  const result = await discoverProviderModels({ env: foundry, fetchImpl: async () => page([
    { id: 'claude-chat' },
    { id: 'claude-inference-disabled', capabilities: { inference: false } },
    { id: 'claude-chat-disabled', capabilities: { chat_completion: false } },
    { id: 'custom/deployment-v42', model_family: 'claude', capabilities: { inference: true } },
    { id: 'custom/future-v1', family: 'claude-future' },
    { id: 'gpt-chat', capabilities: { chat_completion: true } },
  ]) });
  assert.deepEqual(result.models.map(row => row.value), ['claude-chat', 'custom/deployment-v42', 'custom/future-v1']);
});

test('model pagination supports last_id, body next links and HTTP Link headers', async () => {
  const urls = [];
  const responses = [
    page([{ id: 'claude-a' }], { has_more: true, last_id: 'claude-a' }),
    page([{ id: 'claude-b' }], { next: '/openai/v1/models?page=3' }),
    page([{ id: 'claude-c' }], {}, { Link: '</openai/v1/models?page=4>; rel="next"' }),
    page([{ id: 'claude-d' }], { has_more: false }),
  ];
  const result = await discoverProviderModels({ env: foundry, fetchImpl: async url => { urls.push(String(url)); return responses.shift(); } });
  assert.deepEqual(result.models.map(row => row.value), ['claude-a', 'claude-b', 'claude-c', 'claude-d']);
  assert.equal(new URL(urls[1]).searchParams.get('after_id'), 'claude-a');
  assert.equal(new URL(urls[2]).searchParams.get('page'), '3');
  assert.equal(new URL(urls[3]).searchParams.get('page'), '4');
});

test('cross-origin pagination never receives provider credentials', async () => {
  let requests = 0;
  await assert.rejects(discoverProviderModels({ env: foundry, fetchImpl: async () => {
    requests += 1;
    return page([{ id: 'claude-a' }], { next: 'https://another-origin.test/models' });
  } }), /origin|pagination/i);
  assert.equal(requests, 1);
});

test('real HTTP redirects cannot forward the API key to another origin', async t => {
  let leakedRequests = 0;
  const other = createServer((_request, response) => { leakedRequests += 1; response.end('{}'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const source = createServer((_request, response) => { response.writeHead(302, { Location: `http://127.0.0.1:${other.address().port}/models` }); response.end(); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => { source.closeAllConnections(); other.closeAllConnections(); await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => other.close(resolve))]); });
  await assert.rejects(discoverProviderModels({ env: { ...foundry, ANTHROPIC_FOUNDRY_BASE_URL: `http://127.0.0.1:${source.address().port}/anthropic` } }));
  assert.equal(leakedRequests, 0);
});

test('Bedrock, Vertex, missing credentials and unrecognized Foundry routes make no guessed HTTP requests', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; throw new Error('must not request'); };
  for (const env of [
    { ANTHROPIC_API_KEY: 'key', CLAUDE_CODE_USE_BEDROCK: '1' },
    { ANTHROPIC_API_KEY: 'key', CLAUDE_CODE_USE_VERTEX: '1' },
    {},
    { ...foundry, ANTHROPIC_FOUNDRY_BASE_URL: 'https://provider.test/unknown' },
    { ...foundry, ANTHROPIC_FOUNDRY_BASE_URL: 'https://username:password@provider.test/anthropic' },
  ]) {
    const result = await discoverProviderModels({ env, fetchImpl });
    assert.equal(result.apiStatus, 'unsupported');
    assert.equal(result.models.length, 0);
  }
  assert.equal(requests, 0);
});

test('Google Cloud and Gateway never query a leftover Anthropic or Foundry configuration', async () => {
  for (const [flag, provider] of [['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'anthropic-google-cloud'], ['CLAUDE_CODE_USE_GATEWAY', 'gateway']]) {
    let requests = 0;
    const result = await discoverProviderModels({ env: { ...foundry, [flag]: '1', ANTHROPIC_API_KEY: 'fixture-key' }, fetchImpl: async () => { requests += 1; return page([{ id: 'claude-wrong-provider' }]); } });
    assert.equal(requests, 0);
    assert.equal(result.apiStatus, 'unsupported');
    assert.equal(result.provider, provider);
  }
});

test('provider catalog sends configured custom headers needed by the same API proxy', async () => {
  for (const env of [foundry, { ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: 'https://provider.test' }]) {
    let headers;
    await discoverProviderModels({ env: { ...env, ANTHROPIC_CUSTOM_HEADERS: 'X-User: fixture-user\nX-Region: fixture:region\n' }, fetchImpl: async (_url, options) => { headers = new Headers(options.headers); return page([]); } });
    assert.equal(headers.get('x-user'), 'fixture-user');
    assert.equal(headers.get('x-region'), 'fixture:region');
  }
});

test('pagination cycles and malformed pages fail instead of presenting a partial catalog as complete', async () => {
  await assert.rejects(discoverProviderModels({ env: foundry, fetchImpl: async () => page([{ id: 'claude-a' }], { next: '/openai/v1/models' }) }), /pagination/i);
  await assert.rejects(discoverProviderModels({ env: foundry, fetchImpl: async () => Response.json({ error: 'fixture-foundry-key' }) }), error => !error.message.includes('fixture-foundry-key'));
});

test('provider requests honor cancellation without exposing raw provider errors', async () => {
  const controller = new AbortController();
  let observedSignal;
  const promise = discoverProviderModels({ env: foundry, signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    observedSignal = signal;
    return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fixture-foundry-key')), { once: true }));
  } });
  controller.abort(new Error('Fixture request cancelled'));
  await assert.rejects(promise, /cancelled/);
  assert.equal(observedSignal, controller.signal);
});

test('Foundry takes precedence over a simultaneously enabled Vertex flag, matching native Claude', async () => {
  for (const value of ['1', 'TRUE', 'yes']) {
    const env = Object.freeze({ ...foundry, CLAUDE_CODE_USE_FOUNDRY: value, CLAUDE_CODE_USE_VERTEX: '1' });
    const requests = [];
    const result = await discoverProviderModels({ env, fetchImpl: async (url, options) => { requests.push({ url, headers: options.headers }); return page([{ id: 'claude-api-model' }]); } });
    assert.equal(result.provider, 'foundry');
    assert.equal(result.apiStatus, 'success');
    assert.deepEqual(result.models.map(model => model.value), ['claude-api-model']);
    assert.equal(requests[0].url, 'https://provider.test/openai/v1/models');
    assert.equal(requests[0].headers['api-key'], 'fixture-foundry-key');
    assert.equal(env.CLAUDE_CODE_USE_VERTEX, '1');
  }
});

test('disabled Foundry flags never redirect an enabled Vertex configuration to Foundry', async () => {
  for (const value of ['0', 'false', 'no', '']) {
    let requests = 0;
    const result = await discoverProviderModels({ env: { ...foundry, CLAUDE_CODE_USE_FOUNDRY: value, CLAUDE_CODE_USE_VERTEX: 'true' }, fetchImpl: async () => { requests++; return page([]); } });
    assert.equal(result.provider, 'vertex');
    assert.equal(result.apiStatus, 'unsupported');
    assert.equal(requests, 0);
  }
});
