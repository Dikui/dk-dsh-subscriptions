import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpHandler, createSubscriptions } from '../core.js';
import { createAccountModels, createAccountQuota } from '../models.js';
import { accountQuotaSources } from '../quota-sources.js';

// small/spec — status/HTTP public seam; memory credentials and synthetic external metadata.
function fixture() {
  const records = new Map(); const requests = [];
  const keyFor = id => `llm-pi-ai/${id}`;
  const grant = () => ({ kind: 'grant', payload: { type: 'oauth', access: 'ACCESS-SECRET', accountId: 'ACCOUNT-SECRET', expires: 3600000 } });
  const credentials = { readRecord: async key => records.get(key), async modifyRecord(key, mutate) {
    const next = await mutate(records.get(key)); if (next) records.set(key, next); return records.get(key);
  } };
  const accountModels = new Map(), accountQuotas = new Map();
  let denyQuota = false;
  const catalog = ['openai-codex', 'kimi-coding', 'xai'].map(id => {
    const models = createAccountModels({ readIdentity: async () => records.get(keyFor(id))?.payload?.access,
      loadModels: async () => [{ id: `${id}-model`, name: `${id} model` }] });
    accountModels.set(id, models);
    const source = accountQuotaSources.get(id);
    if (source) accountQuotas.set(id, createAccountQuota(source({
      readCredential: async () => records.get(keyFor(id))?.payload,
      getAuth: async () => ({ source: 'OAuth', auth: { apiKey: records.get(keyFor(id))?.payload?.access } }),
      fetchCatalog: async (url, { signal }) => { requests.push([id, url, signal]);
        return denyQuota ? new Response('SECRET', { status: 403 }) : Response.json(id === 'openai-codex'
          ? { rate_limit: { primary_window: { used_percent: 25 } } } : { usages: { limit_5h: { used_ratio: 0.5 } } });
      },
    })));
    return { id, auth: { oauth: {} }, getModels: models.getModels };
  });
  const api = createSubscriptions({ catalog, credentials, keyFor, accountModels, accountQuotas,
    authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }), begin: async ({ key }) => { records.set(key, grant()); return { status: 'authorized' }; } },
    llm: { stream: () => assert.fail('quota must not send inference') },
  });
  const post = (provider, action = 'quota') => createHttpHandler(api)(new Request('http://localhost/api/subscriptions-lite', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-subscriptions-lite': '1' }, body: JSON.stringify({ provider, action }),
  }));
  return { api, post, records, requests, accountQuotas, setGrant: id => records.set(keyFor(id), grant()), deny: () => { denyQuota = true; } };
}

test('status and explicit HTTP quota refresh share metadata without hiding model or auth status', async () => {
  const f = fixture();
  try {
    for (const id of ['openai-codex', 'kimi-coding', 'xai']) f.setGrant(id);
    let status = await f.api.status();
    assert.deepEqual(status.providers.map(p => p.quota.state), ['partial', 'partial', 'unsupported']);
    assert.equal(status.providers[0].quota.windows[0].usedPercent, 25);
    assert.equal(status.providers[1].quota.windows[0].usedPercent, 50);
    assert.ok(status.providers.every(p => p.configured && p.models.length === 1));
    assert.doesNotMatch(JSON.stringify(status), /SECRET/);
    await f.api.status(); assert.equal(f.requests.length, 2);
    assert.deepEqual(await (await f.post('openai-codex')).json(), { ok: true });
    assert.equal(f.requests.length, 3);
    assert.equal((await (await f.post('xai')).json()).error, 'QUOTA_UNSUPPORTED');
    f.deny();
    assert.equal((await (await f.post('kimi-coding')).json()).error, 'QUOTA_DENIED');
    status = await f.api.status();
    assert.equal(status.providers[1].quota.state, 'error');
    assert.deepEqual(status.providers[1].quota.windows, []);
    assert.equal(status.providers[1].configured, true);
    assert.equal(status.providers[1].models.length, 1);
    assert.equal(status.providers[1].modelCatalog.state, 'ready');
  } finally { f.api.dispose(); }
});

test('login, logout, missing OAuth and dispose invalidate only the owning quota', async () => {
  const f = fixture();
  try {
    assert.equal((await (await f.post('openai-codex')).json()).error, 'MISSING_CREDENTIAL');
    for (const id of ['openai-codex', 'kimi-coding']) f.setGrant(id);
    await f.api.status();
    const oldKimi = f.accountQuotas.get('kimi-coding').status();
    const attempt = f.api.login('openai-codex');
    assert.equal(f.accountQuotas.get('openai-codex').status().state, 'unloaded');
    await assert.rejects(f.api.refreshQuota('openai-codex'), { code: 'ALREADY_IN_FLIGHT' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.api.status()).providers[0].attempt.state, 'authorized');
    assert.equal(f.accountQuotas.get('openai-codex').status().state, 'partial');
    assert.deepEqual(f.accountQuotas.get('kimi-coding').status(), oldKimi);
    await f.api.logout('openai-codex');
    assert.deepEqual(f.accountQuotas.get('openai-codex').status().windows, []);
    assert.equal((await f.api.status()).providers[0].configured, false);
    f.records.set('llm-pi-ai/kimi-coding', { kind: 'api-key', key: 'PAID-SECRET' });
    const state = await f.api.status();
    assert.equal(state.providers[1].quota.state, 'unloaded');
    assert.deepEqual(state.providers[1].quota.windows, []);
    assert.ok(attempt.id);
  } finally { f.api.dispose(); }
  assert.ok([...f.accountQuotas.values()].every(quota => quota.status().state === 'unloaded'));
});

test('disposing during explicit quota credential lookup cannot start a new request', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const api = createSubscriptions({
    credentials: { readRecord: async () => { started.resolve(); return release.promise; } },
    authorization: {}, catalog: [{ id: 'kimi-coding', auth: { oauth: {} } }], keyFor: id => id, llm: {},
    accountQuotas: new Map([['kimi-coding', { clear() {}, ensure: () => assert.fail('disposed refresh must not query quota') }]]),
  });
  const refresh = api.refreshQuota('kimi-coding'); await started.promise;
  api.dispose();
  release.resolve({ kind: 'grant', payload: { type: 'oauth', access: 'SECRET', expires: 1 } });
  await assert.rejects(refresh, { code: 'UNAVAILABLE' });
});

test('disposing during status model discovery cannot start a new quota request', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const quota = createAccountQuota(accountQuotaSources.get('kimi-coding')({
    readCredential: async () => ({ type: 'oauth', access: 'SECRET' }),
    getAuth: () => assert.fail('disposed status must not resolve new auth'),
    fetchCatalog: () => assert.fail('disposed status must not query quota'),
  }));
  const models = createAccountModels({ readIdentity: async () => 'identity', loadModels: async () => {
    started.resolve(); await release.promise; return [];
  } });
  const api = createSubscriptions({ credentials: { readRecord: async () => ({ kind: 'grant', payload: { type: 'oauth', access: 'SECRET', expires: 1 } }) },
    authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }) }, catalog: [{ id: 'kimi-coding', auth: { oauth: {} }, getModels: models.getModels }],
    keyFor: id => id, llm: {}, accountModels: new Map([['kimi-coding', models]]), accountQuotas: new Map([['kimi-coding', quota]]) });
  const status = api.status(); await started.promise;
  api.dispose(); release.resolve();
  assert.equal((await status).providers[1].quota.state, 'unloaded');
});
