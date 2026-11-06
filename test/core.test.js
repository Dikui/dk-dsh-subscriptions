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
