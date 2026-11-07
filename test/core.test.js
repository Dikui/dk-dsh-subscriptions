import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpHandler, createSubscriptions, oauthRecord, safeError, subscriptionBindings } from '../core.js';

const keyFor = id => `llm-pi-ai/${id}`;
const grant = () => ({ kind: 'grant', payload: { type: 'oauth', access: 'DO-NOT-EXPOSE', refresh: 'REFRESH-SECRET', expires: Date.now() + 3600000 } });
const catalog = ['openai-codex', 'kimi-coding', 'xai'].map(id => ({ id, name: id,
  auth: { oauth: { name: id }, apiKey: { resolve: () => { throw Error('PAID API MUST NOT RUN'); } } },
  getModels: () => [{ id: 'model-1', name: 'Model One', provider: id }],
  streamSimple: () => {}, stream: () => {},
}));
function fixture(begin) {
  const records = new Map(), calls = [];
  const credentials = {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, fn) => { const next = await fn(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); },
    deleteRecord: async key => records.delete(key),
  };
  const authorization = { describe: () => ({ methods: [{ id: 'oauth' }], inFlight: false }),
    begin: begin ?? (async () => ({ status: 'authorized' })) };
  const llm = { async *stream(args) { calls.push(args); yield { type: 'text-delta', text: '2' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const api = createSubscriptions({ authorization, credentials, llm, catalog, keyFor });
  return { api, records, credentials, authorization, calls };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

// small/regression — account discovery must feed status, routes and test validation.
test('account model discovery is shared instead of advertising the static baseline', async () => {
  const f = fixture(); f.records.set(keyFor('openai-codex'), grant());
  let models = catalog[0].getModels();
  const remoteCatalog = [{ ...catalog[0], getModels: () => models }, ...catalog.slice(1)];
  const accountModels = {
    async ensure() { models = [{ ...models[0], id: 'server-only-model', name: 'Account Model' }]; },
    getModels: () => models,
    status: () => ({ source: 'account', state: 'ready', error: null, updatedAt: 1 }),
    clear() { models = []; },
  };
  const api = createSubscriptions({ authorization: f.authorization, credentials: f.credentials, keyFor,
    catalog: remoteCatalog, accountModels: new Map([['openai-codex', accountModels]]),
    llm: { async *stream(args) { f.calls.push(args); yield { type: 'text-delta', text: '2' }; yield { type: 'finish', reason: { kind: 'stop' } }; } },
  });
  const state = await api.status();
  assert.deepEqual(state.providers[0].models, [{ id: 'server-only-model', name: 'Account Model' }]);
  assert.equal(state.providers[0].modelCatalog.source, 'account');
  const bindings = subscriptionBindings(f.credentials, remoteCatalog, keyFor);
  assert.equal(bindings.profiles().get('subscription-openai-codex').piProvider.getModels()[0].id, 'server-only-model');
  await assert.rejects(api.test('openai-codex', 'model-1'), { code: 'UNKNOWN_MODEL' });
  await api.test('openai-codex', 'server-only-model');
  assert.equal(f.calls[0].model, 'server-only-model');
  api.dispose();
});

test('account metadata refresh is available without sending an inference request', async () => {
  const f = fixture(); f.records.set(keyFor('openai-codex'), grant());
  let forced = false;
  const api = createSubscriptions({ authorization: f.authorization, credentials: f.credentials, llm: { stream: () => assert.fail('metadata refresh must not infer') }, catalog, keyFor,
    accountModels: new Map([['openai-codex', { ensure: async options => { forced = options.force; }, clear() {}, status: () => ({ source: 'account', state: 'ready', error: null, updatedAt: 1 }) }]]),
  });
  const request = new Request('http://localhost/api/subscriptions-lite', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Subscriptions-Lite': '1' },
    body: JSON.stringify({ action: 'models', provider: 'openai-codex' }),
  });
  const response = await createHttpHandler(api)(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(forced, true);
  api.dispose();
});

// small/spec — both registered sources use synthetic metadata and no inference transport.
test('registered vendors share model refresh and clear only their own discovery state', async () => {
  const f = fixture();
  const accountModels = new Map();
  const remote = catalog.map(native => {
    let models = [], queried = 0;
    if (native.id === 'xai') return native;
    f.records.set(keyFor(native.id), grant());
    accountModels.set(native.id, {
      async ensure({ force } = {}) {
        if (!queried || force) queried++;
        models = [{ id: `${native.id}-${queried}`, name: `${native.id} account model`, provider: native.id }];
      },
      getModels: () => models,
      status: () => ({ source: 'account', state: 'ready', error: null, updatedAt: 1 }),
      clear() { models = []; },
    });
    return { ...native, getModels: () => models };
  });
  const api = createSubscriptions({ authorization: f.authorization, credentials: f.credentials,
    llm: { stream: () => assert.fail('metadata must not infer') }, catalog: remote, keyFor, accountModels });
  try {
    const state = await api.status();
    assert.deepEqual(state.providers.slice(0, 2).map(provider => provider.models[0]?.id), ['openai-codex-1', 'kimi-coding-1']);
    assert.ok(state.providers.slice(0, 2).every(provider => provider.modelCatalog.source === 'account'));
    await api.refreshModels('kimi-coding');
    assert.equal(accountModels.get('kimi-coding').getModels()[0].id, 'kimi-coding-2');
    assert.equal(accountModels.get('openai-codex').getModels()[0].id, 'openai-codex-1');
    await api.logout('kimi-coding');
    assert.deepEqual(accountModels.get('kimi-coding').getModels(), []);
    assert.equal(accountModels.get('openai-codex').getModels()[0].id, 'openai-codex-1');
  } finally { api.dispose(); }
  await assert.rejects(f.api.refreshModels('kimi-coding'), { code: 'MODEL_CATALOG_UNAVAILABLE' });
});

test('OAuth validation rejects API keys and malformed grants', () => {
  assert.ok(oauthRecord(grant()));
  for (const value of [undefined, { kind: 'api-key', key: 'SECRET' }, { kind: 'grant', payload: { type: 'oauth', access: 'x' } }, { kind: 'grant', payload: { type: 'api_key', key: 'x' } }]) assert.equal(oauthRecord(value), undefined);
});
test('isolated routes have no API auth, ambient env, or Grok route', async () => {
  const f = fixture();
  const bindings = subscriptionBindings(f.credentials, catalog, keyFor);
  assert.deepEqual([...bindings.profiles().keys()], ['subscription-openai-codex', 'subscription-kimi-coding']);
  for (const [route, profile] of bindings.profiles()) {
    assert.deepEqual(Object.keys(profile.piProvider.auth), ['oauth']);
    assert.equal(profile.piProvider.getModels()[0].provider, route);
    await assert.rejects(bindings.resolveApiKey(route), { code: 'MISSING_CREDENTIAL' });
  }
  assert.equal(await bindings.auth.authContext.env('KIMI_API_KEY'), undefined);
  assert.equal(await bindings.auth.authContext.fileExists('/secret'), false);
  f.records.set(keyFor('kimi-coding'), { kind: 'api-key', key: 'PAID' });
  assert.equal(await bindings.auth.credentials.read('subscription-kimi-coding'), undefined);
  await assert.rejects(bindings.resolveApiKey('subscription-kimi-coding'), { code: 'MISSING_CREDENTIAL' });
  f.records.set(keyFor('kimi-coding'), grant());
  assert.equal(await bindings.resolveApiKey('subscription-kimi-coding'), undefined);
});
test('refresh writes canonical grant and never resurrects logout', async () => {
  const f = fixture(), b = subscriptionBindings(f.credentials, catalog, keyFor);
  f.records.set(keyFor('openai-codex'), grant());
  await b.auth.credentials.modify('subscription-openai-codex', async current => ({ ...current, access: 'ROTATED' }));
  assert.equal(f.records.get(keyFor('openai-codex')).payload.access, 'ROTATED');
  f.records.clear();
  let called = false;
  assert.equal(await b.auth.credentials.modify('subscription-openai-codex', async () => { called = true; return grant().payload; }), undefined);
  assert.equal(called, false);
  assert.equal(f.records.size, 0);
});
test('status exposes presence and catalog, not token payloads or fake Grok support', async () => {
  const f = fixture(); f.records.set(keyFor('openai-codex'), grant());
  const state = await f.api.status();
  assert.equal(state.providers[0].configured, true);
  assert.equal(state.providers[1].configured, false);
  assert.equal(state.providers[2].available, false);
  assert.equal(state.providers[2].route, null);
  assert.doesNotMatch(JSON.stringify(state), /DO-NOT-EXPOSE|REFRESH-SECRET/);
  assert.throws(() => f.api.login('xai'), { code: 'UNAVAILABLE' });
  assert.throws(() => f.api.login('__proto__'), { code: 'UNKNOWN_PROVIDER' });
});
test('login explicitly selects OAuth and captures human-only URL/code', async () => {
  const f = fixture(async request => {
    assert.equal(request.method, 'oauth'); assert.equal(request.key, keyFor('kimi-coding'));
    request.interaction.notify({ message: 'Verify', url: 'https://auth.kimi.com/verify', code: '1234' });
    f.records.set(request.key, grant());
    return { status: 'authorized' };
  });
  f.api.login('kimi-coding'); await turn();
  const p = (await f.api.status()).providers[1];
  assert.equal(p.attempt.state, 'authorized'); assert.equal(p.attempt.notices[0].code, '1234');
});
test('answers require current attempt and prompt; select validates choices', async () => {
  const f = fixture(async request => {
    const answer = await request.interaction.prompt({ kind: 'select', message: 'Mode', options: [{ id: 'a', label: 'A' }] });
    assert.equal(answer, 'a'); return { status: 'authorized' };
  });
  const attempt = f.api.login('openai-codex'); await turn();
  const prompt = (await f.api.status()).providers[0].attempt.prompt;
  assert.throws(() => f.api.answer('openai-codex', 'wrong', prompt.id, 'a'), { code: 'STALE_ATTEMPT' });
  assert.throws(() => f.api.answer('openai-codex', attempt.id, 'wrong', 'a'), { code: 'STALE_PROMPT' });
  assert.throws(() => f.api.answer('openai-codex', attempt.id, prompt.id, 'wrong'), { code: 'INVALID_ANSWER' });
  f.api.answer('openai-codex', attempt.id, prompt.id, 'a'); await turn();
  assert.equal((await f.api.status()).providers[0].attempt.state, 'authorized');
});
test('cancel withdraws prompt and does not delete an existing grant', async () => {
  const f = fixture(async request => { await request.interaction.prompt({ kind: 'text', message: 'Code' }); return { status: 'authorized' }; });
  f.records.set(keyFor('openai-codex'), grant());
  const attempt = f.api.login('openai-codex'); await turn();
  await f.api.cancel('openai-codex', attempt.id);
  assert.equal((await f.api.status()).providers[0].attempt.state, 'cancelled');
  assert.ok(f.records.has(keyFor('openai-codex')));
});
test('prompt signal abort withdraws only the losing prompt', async () => {
  const controller = new AbortController();
  const f = fixture(async request => {
    try { await request.interaction.prompt({ kind: 'text', message: 'Code', signal: controller.signal }); } catch { /* Callback won. */ }
    return { status: 'authorized' };
  });
  f.api.login('openai-codex'); await turn(); controller.abort(); await turn();
  const p = (await f.api.status()).providers[0];
  assert.equal(p.attempt.prompt, null); assert.equal(p.attempt.state, 'authorized');
});
test('errors and unsafe notice links are not leaked', async () => {
  assert.doesNotMatch(JSON.stringify(safeError(new Error('access_token=SECRET'))), /SECRET/);
  const f = fixture(async request => { request.interaction.notify({ message: 'Info', url: 'javascript:alert(1)' }); throw Error('REFRESH-SECRET'); });
  f.api.login('openai-codex'); await turn();
  const p = (await f.api.status()).providers[0];
  assert.equal(p.attempt.state, 'failed'); assert.equal(p.attempt.notices[0].url, undefined);
  assert.doesNotMatch(JSON.stringify(p), /REFRESH-SECRET/);
});
test('official OAuth failures retain actionable categories without exposing token responses', async () => {
  const cases = [
    ['OpenAI Codex token exchange failed (403): {"error":{"code":"unsupported_country_region_territory"},"access_token":"SECRET"}', 'OAUTH_REGION_UNSUPPORTED'],
    ['OpenAI Codex token exchange failed (400): {"error":"invalid_grant","refresh_token":"SECRET"}', 'OAUTH_EXCHANGE_FAILED'],
    ['OpenAI Codex token exchange response missing fields: {"access_token":"SECRET"}', 'OAUTH_EXCHANGE_FAILED'],
    ['State mismatch', 'OAUTH_CALLBACK_MISMATCH'],
    ['Missing authorization code', 'OAUTH_CALLBACK_MISMATCH'],
    ['Failed to extract accountId from token', 'OAUTH_ACCOUNT_INVALID'],
    ['fetch failed', 'NETWORK_FAILED'],
    ['Other failure SECRET', 'REQUEST_FAILED'],
  ];
  for (const [message, code] of cases) {
    const f = fixture(async () => { throw new Error(message); });
    f.api.login('openai-codex'); await turn();
    const state = await f.api.status();
    assert.equal(state.providers[0].attempt.error, code);
    assert.doesNotMatch(JSON.stringify(state), /SECRET|access_token|refresh_token/);
  }
  assert.equal(safeError(Object.assign(new Error('SECRET'), { code: 'NOT_COMMITTED' })).error, 'NOT_COMMITTED');
  assert.equal(safeError(Object.assign(new Error('SECRET'), { code: 'SECRET' })).error, 'REQUEST_FAILED');
});
test('test requires OAuth and exact catalog model; dispatch uses isolated route', async () => {
  const f = fixture();
  await assert.rejects(f.api.test('kimi-coding', 'model-1'), { code: 'MISSING_CREDENTIAL' });
  f.records.set(keyFor('kimi-coding'), grant());
  await assert.rejects(f.api.test('kimi-coding', 'guessed'), { code: 'UNKNOWN_MODEL' });
  assert.deepEqual(await f.api.test('kimi-coding', 'model-1'), { ok: true, model: 'model-1', text: '2' });
  assert.equal(f.calls[0].provider, 'subscription-kimi-coding');
  assert.equal(f.calls[0].maxTokens, 256);
});
test('logout atomically clears shared OAuth; blocks unrelated API key or external login', async () => {
  const f = fixture();
  f.records.set(keyFor('openai-codex'), grant()); await f.api.logout('openai-codex');
  assert.deepEqual(f.records.get(keyFor('openai-codex')), { kind: 'grant', payload: { type: 'subscription-revoked' } });
  assert.equal((await f.api.status()).providers[0].configured, false);
  await f.api.logout('openai-codex'); // Idempotent for our secret-free marker.
  f.records.set(keyFor('openai-codex'), { kind: 'api-key', key: 'PAID' });
  await assert.rejects(f.api.logout('openai-codex'), { code: 'NOT_SUBSCRIPTION_CREDENTIAL' });
  assert.equal(f.records.size, 1);
  f.authorization.describe = () => ({ methods: [{ id: 'oauth' }], inFlight: true });
  assert.throws(() => f.api.login('openai-codex'), { code: 'ALREADY_IN_FLIGHT' });
  await assert.rejects(f.api.logout('openai-codex'), { code: 'ALREADY_IN_FLIGHT' });
});
test('logout reserves the provider while awaiting the shared writer lock', async () => {
  const f = fixture(); f.records.set(keyFor('openai-codex'), grant());
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const modify = f.credentials.modifyRecord;
  f.credentials.modifyRecord = async (...args) => { await waiting; return modify(...args); };
  const logout = f.api.logout('openai-codex');
  assert.throws(() => f.api.login('openai-codex'), { code: 'ALREADY_IN_FLIGHT' });
  await assert.rejects(f.api.test('openai-codex', 'model-1'), { code: 'ALREADY_IN_FLIGHT' });
  await assert.rejects(f.api.logout('openai-codex'), { code: 'ALREADY_IN_FLIGHT' });
  release(); await logout;
  assert.equal((await f.api.status()).providers[0].attempt, null);
});
test('logout preserves a replacement API key written before acquiring the lock', async () => {
  const f = fixture(); f.records.set(keyFor('openai-codex'), grant());
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const modify = f.credentials.modifyRecord;
  f.credentials.modifyRecord = async (...args) => { await waiting; return modify(...args); };
  const logout = f.api.logout('openai-codex');
  const replacement = { kind: 'api-key', key: 'KEEP-THIS' };
  f.records.set(keyFor('openai-codex'), replacement);
  release();
  await assert.rejects(logout, { code: 'NOT_SUBSCRIPTION_CREDENTIAL' });
  assert.deepEqual(f.records.get(keyFor('openai-codex')), replacement);
});
test('cancel never claims to remove a grant persisted by an upstream late commit', async () => {
  const f = fixture(async request => new Promise(resolve => {
    request.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
  }));
  const attempt = f.api.login('openai-codex'); await turn();
  await f.api.cancel('openai-codex', attempt.id);
  f.records.set(keyFor('openai-codex'), grant()); // Model the documented upstream late write.
  assert.equal((await f.api.status()).providers[0].configured, true);
  await f.api.logout('openai-codex');
  assert.equal((await f.api.status()).providers[0].configured, false);
});
test('HTTP rejects cross-origin/missing header/unknown actions; status is no-store', async () => {
  const f = fixture(), handle = createHttpHandler(f.api), url = 'http://127.0.0.1:53381/api/subscriptions-lite';
  const post = (headers, body = '{"action":"login","provider":"xai"}') => new Request(url, { method: 'POST', headers, body });
  assert.equal((await handle(post({ 'content-type': 'application/json' }))).status, 403);
  const headers = { 'content-type': 'application/json', 'x-subscriptions-lite': '1' };
  assert.equal((await handle(post({ ...headers, origin: 'https://evil.example' }))).status, 403);
  assert.equal((await (await handle(post(headers))).json()).error, 'UNAVAILABLE');
  assert.equal((await (await handle(post(headers, 'null'))).json()).error, 'INVALID_REQUEST');
  assert.equal((await (await handle(post(headers, '{"action":"execute"}'))).json()).error, 'INVALID_ACTION');
  assert.equal((await handle(new Request(url))).headers.get('cache-control'), 'no-store');
});
test('HTTP accepts authenticated Connection synthetic URLs using preserved Host', async () => {
  const handle = createHttpHandler(fixture().api);
  const post = origin => new Request('http://dsh.internal/api/subscriptions-lite', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-subscriptions-lite': '1', host: '127.0.0.1:53381', origin },
    body: '{"action":"login","provider":"xai"}' });
  for (const origin of ['http://127.0.0.1:53381', 'https://127.0.0.1:53381']) {
    const reply = await handle(post(origin));
    assert.equal(reply.status, 400); // Reaches provider validation, not a false CSRF failure.
    assert.equal((await reply.json()).error, 'UNAVAILABLE');
  }
  for (const origin of ['null', 'https://evil.example', 'http://127.0.0.1:53381/path', 'http://user@127.0.0.1:53381']) {
    assert.equal((await handle(post(origin))).status, 403);
  }
});
test('native transport restores canonical model and history identities without mutating input', () => {
  const f = fixture();
  const seen = [];
  const nativeCatalog = catalog.map(p => ({ ...p, stream: (...args) => seen.push(args), streamSimple: (...args) => seen.push(args) }));
  const b = subscriptionBindings(f.credentials, nativeCatalog, keyFor);
  const provider = b.profiles().get('subscription-openai-codex').piProvider;
  const model = provider.getModels()[0];
  const context = { messages: [{ role: 'user', content: 'test' },
    { role: 'assistant', provider: 'subscription-openai-codex', content: [] },
    { role: 'assistant', provider: 'subscription-kimi-coding', content: [] }] };
  const options = {};
  provider.streamSimple(model, context, options); provider.stream(model, context, options);
  for (const [sentModel, sentContext, sentOptions] of seen) {
    assert.equal(sentModel.provider, 'openai-codex');
    assert.equal(sentContext.messages[1].provider, 'openai-codex');
    assert.equal(sentContext.messages[2].provider, 'kimi-coding');
    assert.equal(sentOptions, options);
  }
  assert.equal(model.provider, 'subscription-openai-codex');
  assert.equal(context.messages[1].provider, 'subscription-openai-codex');
});
