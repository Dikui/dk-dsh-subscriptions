import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountModels } from '../models.js';
import { accountModelSources } from '../model-sources.js';

const codexCatalog = options => createAccountModels(accountModelSources.get('openai-codex')(options));

// small/spec — account model-list request; credentials and HTTP are synthetic.
const row = (slug, extra = {}) => ({ slug, display_name: slug.toUpperCase(), visibility: 'list',
  supported_in_api: true, priority: 1, input_modalities: ['text'], context_window: 128000,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }], default_reasoning_level: 'low', ...extra });
const baseModels = [{ id: 'static-spark', name: 'Static Spark', provider: 'openai-codex',
  api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', input: ['text', 'image'],
  contextWindow: 100000, maxTokens: 16000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
function fixture(fetchCatalog = async () => Response.json({ models: [row('account-model')] })) {
  let credential = { type: 'oauth', access: 'ACCESS-SECRET', accountId: 'ACCOUNT-SECRET', expires: Date.now() + 3600000 };
  const calls = [];
  const models = codexCatalog({ baseModels, clientVersion: '1.1.0',
    readCredential: async () => credential,
    getAuth: async () => ({ source: 'OAuth', auth: { apiKey: (credential?.access) } }),
    fetchCatalog: async (url, options) => { calls.push({ url, options }); return fetchCatalog(url, options); },
  });
  return { models, calls, setCredential: value => { credential = value; }, getCredential: () => credential };
}

test('account discovery replaces the baseline and accepts new server model ids', async () => {
  const f = fixture(async () => Response.json({ models: [
    row('later', { priority: 5 }), row('fresh-model', { display_name: 'Actual Account Name', priority: 0, input_modalities: ['text', 'image'] }),
    row('hidden', { visibility: 'hide' }), row('gpt-reserve', { visibility: 'hide' }),
    row('not-api', { supported_in_api: false }), row('no-visibility', { visibility: undefined }), row('later'),
  ] }));
  assert.deepEqual(f.models.getModels(), []);
  await f.models.ensure();
  const list = f.models.getModels();
  assert.deepEqual(list.map(model => model.id), ['fresh-model', 'later']);
  assert.equal(list[0].name, 'Actual Account Name');
  assert.equal(list[0].api, 'openai-codex-responses');
  assert.equal(list[0].maxTokens, 16000);
  assert.deepEqual(list[0].input, ['text', 'image']);
  assert.equal(list[0].thinkingLevelMap.high, 'high');
  assert.equal(list[0].thinkingLevelMap.max, 'max');
  assert.equal(list[0].thinkingLevelMap.medium, null);
  assert.equal(f.models.status().state, 'ready');
  assert.doesNotMatch(JSON.stringify({ list, state: f.models.status() }), /ACCESS-SECRET|ACCOUNT-SECRET|static-spark/);
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer ACCESS-SECRET');
  assert.equal(f.calls[0].options.headers['chatgpt-account-id'], 'ACCOUNT-SECRET');
  assert.equal(new URL(f.calls[0].url).searchParams.get('client_version'), '1.1.0');
});

test('catalog failure clears old names instead of falling back to static models', async () => {
  let failed = false;
  const f = fixture(async () => failed ? new Response('TOKEN-SECRET', { status: 403 }) : Response.json({ models: [row('account-model')] }));
  await f.models.ensure();
  failed = true;
  await assert.rejects(f.models.ensure({ force: true }), { code: 'MODEL_CATALOG_DENIED' });
  assert.deepEqual(f.models.getModels(), []);
  assert.equal(f.models.status().error, 'MODEL_CATALOG_DENIED');
  assert.doesNotMatch(JSON.stringify(f.models.status()), /SECRET|account-model|static-spark/);
});

test('catalog rejects invalid responses but accepts an empty selectable account list', async () => {
  for (const payload of [{ data: [] }, { models: 'wrong' }, { models: [row('bad\nidentifier')] }]) {
    const f = fixture(async () => Response.json(payload));
    await assert.rejects(f.models.ensure(), { code: 'MODEL_CATALOG_INVALID' });
    assert.deepEqual(f.models.getModels(), []);
  }
  const f = fixture(async () => Response.json({ models: [] }));
  await f.models.ensure();
  assert.equal(f.models.status().state, 'ready');
  assert.deepEqual(f.models.getModels(), []);
});

test('catalog uses the refreshed official credential and refuses non-OAuth auth', async () => {
  let credential = { type: 'oauth', access: 'OLD', accountId: 'ACCOUNT', expires: 0 };
  let calls = 0;
  const modelCatalog = codexCatalog({ baseModels, clientVersion: '1.1.0',
    readCredential: async () => credential,
    getAuth: async () => { credential = { ...credential, access: 'ROTATED', expires: Date.now() + 3600000 }; return { source: 'OAuth', auth: { apiKey: 'ROTATED' } }; },
    fetchCatalog: async (_url, options) => { calls++; assert.equal(options.headers.authorization, 'Bearer ROTATED'); return Response.json({ models: [] }); },
  });
  await modelCatalog.ensure();
  assert.equal(calls, 1);
  credential = undefined;
  await assert.rejects(modelCatalog.ensure(), { code: 'MISSING_CREDENTIAL' });
  assert.deepEqual(modelCatalog.getModels(), []);
  const unauthorized = codexCatalog({ baseModels, clientVersion: '1.1.0',
    readCredential: async () => ({ type: 'oauth', access: 'x', accountId: 'A' }),
    getAuth: async () => ({ source: 'api_key', auth: { apiKey: 'PAID' } }),
    fetchCatalog: () => assert.fail('paid auth must not query the subscription catalog'),
  });
  await assert.rejects(unauthorized.ensure(), { code: 'MODEL_CATALOG_DENIED' });
});

test('catalog invalidates account changes and ignores late responses after clearing', async () => {
  let release;
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Response.json({ models: [row('account-b-model')] }));
  const old = f.models.ensure();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.setCredential({ ...f.getCredential(), access: 'B-SECRET', accountId: 'B-ACCOUNT' });
  await f.models.ensure();
  release(Response.json({ models: [row('account-a-model')] }));
  await assert.rejects(old, { code: 'MODEL_CATALOG_CHANGED' });
  assert.deepEqual(f.models.getModels().map(model => model.id), ['account-b-model']);
  f.models.clear();
  assert.deepEqual(f.models.getModels(), []);
  assert.equal(f.models.status().state, 'unloaded');
});

test('cancelling one catalog caller does not poison shared discovery', async () => {
  let release;
  const f = fixture(async (_url, { signal }) => new Promise((resolve, reject) => {
    release = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const leaving = f.models.ensure({ signal: controller.signal });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const staying = f.models.ensure().then(() => ({ ok: true }), error => ({ error }));
  controller.abort();
  await assert.rejects(leaving, { name: 'AbortError' });
  release(Response.json({ models: [row('account-model')] }));
  assert.deepEqual(await staying, { ok: true });
  await f.models.ensure();
  assert.equal(f.calls.length, 1);
  assert.equal(f.models.status().state, 'ready');
});

// small/spec — provider-neutral discovery; these two sources are synthetic, not vendor endpoints.
test('different model sources share discovery without sharing account caches or failures', async () => {
  let failSecond = false;
  const calls = [0, 0];
  const catalogs = ['first', 'second'].map((provider, index) => createAccountModels({
    readIdentity: async () => 'same-opaque-account-id',
    loadModels: async () => {
      calls[index]++;
      if (index === 1 && failSecond) throw new Error('UPSTREAM-SECRET');
      return [{ id: `${provider}-model`, name: `${provider} model`, provider, api: `${provider}-api` }];
    },
  }));
  await Promise.all(catalogs.map(models => Promise.all([models.ensure(), models.ensure()])));
  assert.deepEqual(calls, [1, 1]);
  for (let index = 0; index < 2; index++) assert.equal(catalogs[index].getModels()[0].provider, ['first', 'second'][index]);
  failSecond = true;
  await assert.rejects(catalogs[1].ensure({ force: true }), { code: 'MODEL_CATALOG_FAILED' });
  assert.deepEqual(catalogs[1].getModels(), []);
  assert.equal(catalogs[0].getModels()[0].id, 'first-model');
  assert.doesNotMatch(JSON.stringify(catalogs.map(models => models.status())), /SECRET|same-opaque-account-id/);
  catalogs[1].clear();
  await catalogs[0].ensure();
  assert.deepEqual(calls, [1, 2]);
});

// small/regression — a cancelled generation's identity read must not clear a new account.
test('late identity results cannot replace or clear a newer account catalog', async () => {
  for (const outcome of ['reject', 'old-account', 'missing', 'new-account']) {
    const pending = Promise.withResolvers();
    let reads = 0, loads = 0;
    const catalog = createAccountModels({
      readIdentity: async () => ++reads === 1 ? pending.promise : 'new-account',
      loadModels: async () => { loads++; return [{ id: 'new-model', name: 'New Model' }]; },
    });
    const obsolete = catalog.ensure().then(() => undefined, error => error);
    catalog.clear();
    await catalog.ensure();
    const ready = catalog.status();
    if (outcome === 'reject') pending.reject(new Error('UPSTREAM-SECRET'));
    else pending.resolve(outcome === 'missing' ? undefined : outcome);
    assert.equal((await obsolete)?.code, 'MODEL_CATALOG_CHANGED', outcome);
    assert.deepEqual(catalog.getModels().map(model => model.id), ['new-model']);
    assert.deepEqual(catalog.status(), ready);
    assert.equal(loads, 1);
  }
});

// small/spec — every source returns the same validated descriptor shape.
test('registered model sources share descriptor validation', async () => {
  for (const invalid of [null, {}, new Array(1001).fill({ id: 'x', name: 'X' }),
    [{ id: '', name: 'Empty' }], [{ id: 'bad\nname', name: 'Bad' }], [{ id: 'id', name: 5 }]]) {
    const catalog = createAccountModels({ readIdentity: async () => 'account', loadModels: async () => invalid });
    await assert.rejects(catalog.ensure(), { code: 'MODEL_CATALOG_INVALID' });
    assert.deepEqual(catalog.getModels(), []);
  }
  const catalog = createAccountModels({ readIdentity: async () => 'account', loadModels: async () => [
    { id: 'same', name: 'First' }, { id: 'same', name: 'Second' },
  ] });
  await catalog.ensure();
  assert.deepEqual(catalog.getModels(), [{ id: 'same', name: 'First' }]);
});

test('catalog caches account metadata and explicit refresh fetches it again', async () => {
  const f = fixture();
  await Promise.all([f.models.ensure(), f.models.ensure()]);
  await f.models.ensure();
  assert.equal(f.calls.length, 1);
  await f.models.ensure({ force: true });
  assert.equal(f.calls.length, 2);
});
