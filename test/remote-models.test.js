import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountModels } from '../models.js';
import { accountModelSources } from '../model-sources.js';

// small/spec — automatic remote catalogs task. Synthetic OAuth + HTTP replace vendor services;
// only the public source factory and account-catalog seam are exercised.
const baselines = {
  'kimi-coding': [{ id: 'sdk-only-kimi', name: 'SDK Kimi', provider: 'kimi-coding', api: 'openai-completions',
    baseUrl: 'https://api.kimi.com/coding/v1', contextWindow: 128000, maxTokens: 32000,
    input: ['text', 'image'], reasoning: true, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { low: 'low', high: 'high', max: 'max' } }],
  xai: [{ id: 'sdk-only-grok', name: 'SDK Grok', provider: 'xai', api: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1', contextWindow: 128000, maxTokens: 16000, input: ['text', 'image'], reasoning: true,
    thinkingLevelMap: { high: 'high' } }],
};
function fixture(provider, fetchCatalog) {
  let credential = { type: 'oauth', access: 'SYNTHETIC-OLD', refresh: 'SYNTHETIC-REFRESH', expires: 0 };
  const requests = [];
  const catalog = createAccountModels(accountModelSources.get(provider)({ baseModels: baselines[provider],
    readCredential: async () => credential,
    getAuth: async () => {
      if (credential?.expires === 0) credential = { ...credential, access: 'SYNTHETIC-ROTATED', refresh: 'SYNTHETIC-ROTATED-REFRESH', expires: Date.now() + 3600000 };
      return { source: 'OAuth', auth: provider === 'kimi-coding' ? { headers: { Authorization: `Bearer ${credential?.access}` } } : { apiKey: credential?.access } };
    },
    fetchCatalog: async (url, options) => { requests.push({ url, options }); return fetchCatalog(url, options); },
  }));
  return { catalog, requests, setCredential: value => { credential = value; } };
}

test('Kimi discovers new IDs after official OAuth refresh without stable account fields', async () => {
  const f = fixture('kimi-coding', async () => Response.json({ data: [
    { id: 'k3.1-pro', display_name: 'Kimi K3.1 Pro', context_length: 1048576, supports_reasoning: true, supports_image_in: true, supports_video_in: true,
      think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' } },
    { id: 'k3.1-pro-highspeed', context_length: 1048576, supports_reasoning: true,
      reasoning: { type: 'only', effort: { valid: ['low', 'high', 'max'], default: 'max' } } },
    { id: 'kimi-for-coding-highspeed', context_length: 262144, supports_reasoning: false },
    { id: 'future-kimi', context_length: 2000000, supports_reasoning: false },
  ] }));
  await f.catalog.ensure();
  const models = f.catalog.getModels();
  assert.deepEqual(models.map(model => model.id), ['k3.1-pro', 'k3.1-pro-highspeed', 'kimi-for-coding-highspeed', 'future-kimi']);
  assert.equal(models[0].contextWindow, 1048576);
  assert.equal(models[0].name, 'Kimi K3.1 Pro');
  assert.equal(models[0].api, 'openai-completions');
  assert.deepEqual(models[0].input, ['text', 'image']);
  assert.deepEqual(models[0].thinkingLevelMap, { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
  assert.equal(models[0].defaultReasoningEffort, 'high');
  assert.equal(models[1].thinkingLevelMap.low, 'low');
  assert.equal(models[2].thinkingLevelMap.high, null);
  assert.equal(models[3].reasoning, false);
  assert.deepEqual(models[3].input, ['text']);
  assert.equal(f.requests[0].url, 'https://api.kimi.com/coding/v1/models');
  assert.equal(f.requests[0].options.method, 'GET');
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.requests[0].options.headers.authorization, 'Bearer SYNTHETIC-ROTATED');
  assert.doesNotMatch(JSON.stringify({ models, status: f.catalog.status() }), /SYNTHETIC|sdk-only/);
});

// small/spec — exact join with language metadata excludes image/video and non-tool multi-agent models.
test('Grok discovers remote text models and their own capabilities without SDK or alias expansion', async () => {
  const f = fixture('xai', async url => url.endsWith('/language-models') ? Response.json({ models: [
    { id: 'grok-4.7', input_modalities: ['text', 'image'], output_modalities: ['text'] },
    { id: 'grok-build-0.1', input_modalities: ['text'], output_modalities: ['text'] },
    { id: 'future-grok', input_modalities: ['text'], output_modalities: ['text'] },
    { id: 'removed-grok', input_modalities: ['text'], output_modalities: ['text'] },
    { id: 'grok-4.20-multi-agent', input_modalities: ['text'], output_modalities: ['text'] },
  ] }) : Response.json({ data: [
    { id: 'grok-4.7', aliases: ['grok-latest'], context_length: 500000,
      capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'high' } },
    { id: 'grok-build-0.1', context_length: 1000000 },
    { id: 'future-grok', context_length: 2000000, base_url: 'https://evil.invalid', headers: { authorization: 'REMOTE-SECRET' } },
    { id: 'grok-imagine-image' }, { id: 'grok-imagine-video' }, { id: 'grok-4.20-multi-agent' },
  ] }));
  await f.catalog.ensure();
  const models = f.catalog.getModels();
  assert.deepEqual(models.map(model => model.id), ['grok-4.7', 'grok-build-0.1', 'future-grok']);
  assert.deepEqual(models[0].input, ['text', 'image']);
  assert.equal(models[0].thinkingLevelMap.off, 'none');
  assert.equal(models[0].thinkingLevelMap.xhigh, 'xhigh');
  assert.equal(models[0].thinkingLevelMap.max, null);
  assert.equal(models[0].defaultReasoningEffort, 'high');
  assert.equal(models[2].api, 'openai-responses');
  assert.equal(models[2].baseUrl, 'https://api.x.ai/v1');
  assert.equal(models[2].contextWindow, 2000000);
  assert.equal(models[2].reasoning, false);
  assert.deepEqual(models[2].input, ['text']);
  assert.equal(models[2].thinkingLevelMap.high, null);
  assert.doesNotMatch(JSON.stringify(models), /REMOTE-SECRET|evil|sdk-only/);
  assert.deepEqual(f.requests.map(request => request.url), ['https://api.x.ai/v1/models', 'https://api.x.ai/v1/language-models']);
});

// small/regression — a wire-level none default is exposed and dispatched as Harness off.
test('remote wire defaults use the same canonical effort IDs as selectable capabilities', async () => {
  const f = fixture('xai', async url => url.endsWith('/language-models') ? Response.json({ models: [
    { id: 'grok-default-off', input_modalities: ['text'], output_modalities: ['text'] },
  ] }) : Response.json({ data: [{ id: 'grok-default-off', context_length: 100000,
    capabilities: { reasoning_effort: ['none', 'low', 'high'], default_reasoning_effort: 'none' } }] }));
  await f.catalog.ensure();
  const model = f.catalog.getModels()[0];
  assert.equal(model.defaultReasoningEffort, 'off');
  assert.equal(model.thinkingLevelMap[model.defaultReasoningEffort], 'none');
});

// small/regression — untrusted metadata must not disable required thinking or advertise non-text chat.
test('remote capability constraints override unsafe effort and modality declarations', async () => {
  const kimi = fixture('kimi-coding', async () => Response.json({ data: [{ id: 'new-thinking', context_length: 100000,
    reasoning: { type: 'only', effort: { valid: ['none', 'low', 'high'], default: 'high' } } }] }));
  await kimi.catalog.ensure();
  assert.equal(kimi.catalog.getModels()[0].thinkingLevelMap.off, null);
  const grok = fixture('xai', async url => url.endsWith('/language-models') ? Response.json({ models: [
    { id: 'audio-only', input_modalities: ['audio'], output_modalities: ['text'] },
  ] }) : Response.json({ data: [{ id: 'audio-only', context_length: 100000 }] }));
  await grok.catalog.ensure();
  assert.deepEqual(grok.catalog.getModels(), []);
});

// small/spec — metadata failures never substitute an SDK list or expose upstream diagnostics.
test('all remote sources reject failed or oversized catalogs without stale names', async () => {
  for (const provider of ['kimi-coding', 'xai']) {
    let broken;
    const f = fixture(provider, async url => {
      if (broken) return broken();
      return url.endsWith('/language-models') ? Response.json({ models: [{ id: 'remote', input_modalities: ['text'], output_modalities: ['text'] }] })
        : Response.json({ data: [{ id: 'remote', context_length: 100000 }] });
    });
    await f.catalog.ensure();
    assert.equal(f.catalog.getModels()[0].id, 'remote');
    for (const [response, code] of [
      [() => new Response('UPSTREAM-SECRET', { status: 403 }), 'MODEL_CATALOG_DENIED'],
      [() => new Response('UPSTREAM-SECRET', { status: 429 }), 'MODEL_CATALOG_RATE_LIMIT'],
      [() => Response.json({ data: [] }, { headers: { 'content-length': '2000000' } }), 'MODEL_CATALOG_INVALID'],
      [() => new Response(' '.repeat(1048577)), 'MODEL_CATALOG_INVALID'],
    ]) {
      broken = response;
      await assert.rejects(f.catalog.ensure({ force: true }), { code });
      assert.deepEqual(f.catalog.getModels(), []);
      assert.doesNotMatch(JSON.stringify(f.catalog.status()), /SECRET|sdk-only/);
    }
  }
});

// small/regression — the metadata deadline also bounds an official OAuth refresh.
test('catalog auth refresh is bounded by the same ten-second metadata deadline', async t => {
  const originalTimeout = AbortSignal.timeout;
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => ms === 10000 ? deadline.signal : originalTimeout(ms));
  const refreshing = Promise.withResolvers();
  const catalog = createAccountModels(accountModelSources.get('kimi-coding')({ baseModels: baselines['kimi-coding'],
    readCredential: async () => ({ type: 'oauth', access: 'SYNTHETIC', expires: 0 }),
    getAuth: async () => { refreshing.resolve(); return new Promise(() => {}); },
    fetchCatalog: () => assert.fail('refresh has not completed'),
  }));
  const outcome = catalog.ensure().then(() => 'ready', error => error.code);
  await refreshing.promise;
  deadline.abort();
  const result = await Promise.race([outcome, new Promise(resolve => setImmediate(() => resolve('unbounded')))]);
  assert.equal(result, 'MODEL_CATALOG_FAILED');
  assert.deepEqual(catalog.getModels(), []);
});

// small/regression — OAuth resolution belongs to the shared failure TTL, not every list reader.
test('failed OAuth refresh is shared, visible and cached until refresh or credential replacement', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let credential = { type: 'oauth', access: 'SYNTHETIC-EXPIRED', refresh: 'SYNTHETIC-REFRESH', expires: 0 };
  let authCalls = 0, denied = true;
  const catalog = createAccountModels(accountModelSources.get('kimi-coding')({ baseModels: baselines['kimi-coding'],
    readCredential: async () => credential,
    getAuth: async () => {
      authCalls++;
      if (denied) throw new Error('UPSTREAM-TOKEN-SECRET');
      return { source: 'OAuth', auth: { headers: { Authorization: `Bearer ${credential.access}` } } };
    },
    fetchCatalog: async () => Response.json({ data: [{ id: 'remote', context_length: 100000 }] }),
  }));
  const failures = await Promise.all(Array.from({ length: 5 }, () => catalog.ensure().then(() => 'ready', error => error.code)));
  assert.deepEqual(failures, Array(5).fill('MODEL_CATALOG_FAILED'));
  assert.equal(authCalls, 1);
  assert.equal(catalog.status().state, 'error');
  assert.equal(catalog.status().error, 'MODEL_CATALOG_FAILED');
  assert.deepEqual(catalog.getModels(), []);
  await assert.rejects(catalog.ensure(), { code: 'MODEL_CATALOG_FAILED' });
  assert.equal(authCalls, 1);
  t.mock.timers.tick(60001);
  await assert.rejects(catalog.ensure(), { code: 'MODEL_CATALOG_FAILED' });
  assert.equal(authCalls, 2);
  await assert.rejects(catalog.ensure({ force: true }), { code: 'MODEL_CATALOG_FAILED' });
  assert.equal(authCalls, 3);
  denied = false;
  credential = { ...credential, access: 'SYNTHETIC-RECONNECTED', refresh: 'SYNTHETIC-RECONNECTED-REFRESH' };
  await catalog.ensure();
  assert.equal(authCalls, 4);
  assert.equal(catalog.status().state, 'ready');
  assert.deepEqual(catalog.getModels().map(model => model.id), ['remote']);
  assert.doesNotMatch(JSON.stringify(catalog.status()), /SECRET|SYNTHETIC/);
});

// small/regression — token rotation must not make concurrent readers invalidate each other.
test('concurrent readers share the refreshed token catalog after credential rotation', async () => {
  const f = fixture('kimi-coding', async () => Response.json({ data: [{ id: 'remote', context_length: 100000 }] }));
  await f.catalog.ensure();
  f.setCredential({ type: 'oauth', access: 'SYNTHETIC-ROTATED-AGAIN', refresh: 'SYNTHETIC-NEW-REFRESH', expires: Date.now() + 3600000 });
  const outcomes = await Promise.allSettled([f.catalog.ensure(), f.catalog.ensure(), f.catalog.ensure()]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(f.requests.length, 2);
});

// small/spec — TTL is demand-driven, not a background polling loop.
test('remote catalogs revalidate after TTL and token-only identities invalidate immediately', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let revision = 0;
  const f = fixture('kimi-coding', async () => Response.json({ data: [{ id: `remote-${++revision}`, context_length: 100000 }] }));
  await f.catalog.ensure();
  await f.catalog.ensure();
  assert.deepEqual(f.catalog.getModels().map(model => model.id), ['remote-1']);
  t.mock.timers.tick(60001);
  await f.catalog.ensure();
  assert.deepEqual(f.catalog.getModels().map(model => model.id), ['remote-2']);
  f.setCredential({ type: 'oauth', access: 'SYNTHETIC-OTHER-ACCOUNT', refresh: 'SYNTHETIC-OTHER-REFRESH', expires: 3600000 });
  await f.catalog.ensure();
  assert.deepEqual(f.catalog.getModels().map(model => model.id), ['remote-3']);
  f.setCredential({ type: 'api_key', key: 'SYNTHETIC-PAID' });
  await assert.rejects(f.catalog.ensure(), { code: 'MISSING_CREDENTIAL' });
  assert.deepEqual(f.catalog.getModels(), []);
});
