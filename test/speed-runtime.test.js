import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from 'node:module';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const require = module.createRequire(import.meta.url);
let undici, adapterEntry;
try {
  const selected = require.resolve(process.env.DSH_TEST_UNDICI ?? 'undici');
  undici = require(selected);
  adapterEntry = module.createRequire(selected).resolve('@deepseek-ai/dsh-llm-pi-ai');
} catch (error) { if (process.env.DSH_TEST_UNDICI) throw error; }

// small/regression — user-requested per-model Speed. Real public plugin + shipped adapter/SDK;
// MockAgent forbids external requests; synthetic OAuth and memory domain replace user storage.
test('session Speed survives native streamSimple conversion into the actual Codex HTTP body', {
  skip: !undici || !module.registerHooks ? 'Set DSH_TEST_UNDICI and use the desktop Node runtime.' : false,
}, async t => {
  const previous = undici.getGlobalDispatcher(), env = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://synthetic-proxy.invalid:80';
  const mock = new undici.MockAgent(); mock.disableNetConnect(); undici.setGlobalDispatcher(mock);
  const hooks = module.registerHooks({ resolve(specifier, context, next) {
    return specifier === '@deepseek-ai/dsh-llm-pi-ai' ? { url: pathToFileURL(adapterEntry).href, shortCircuit: true } : next(specifier, context);
  } });
  const disposers = [], listeners = new Map(), routes = new Map(), records = new Map(), stored = new Map(), injections = [];
  let adapter;
  const accountId = 'SYNTHETIC-ACCOUNT';
  const token = ['SYNTHETIC', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url'), 'SYNTHETIC'].join('.');
  const model = 'server-tiered-model', provider = 'subscription-openai-codex';
  const selected = new Map(['session-a', 'session-b'].map(id => [id, { provider, model }]));
  const scope = {
    agents: { get: id => selected.has(id) ? { session: { id }, model: { current: () => selected.get(id) } } : undefined },
    storageDomain: { async open(spec) {
      assert.equal(spec.name, 'dk_subscription_speed');
      return { table: () => ({ get: key => stored.get(key), async put(key, value) {
        assert.match(key, /^[a-f0-9]{64}$/); spec.tables.sessions.valueSchema.parse(value); stored.set(key, value);
      } }), close() {} };
    } },
    effect(callback) { const dispose = callback(); if (dispose) disposers.push(dispose); },
    on(name, listener) { listeners.set(name, listener); },
    connection: { fetch: { register: value => routes.set(value.path, value.fetch) } },
  };
  const views = new Map();
  async function request(action, sessionId, tier, confirmed, viewScope = views.get(sessionId)) {
    const result = await routes.get('/api/subscriptions-lite/speed')(new Request('http://dsh.internal/api/subscriptions-lite/speed', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-subscriptions-lite': '1' },
      body: JSON.stringify({ action, sessionId, ...selected.get(sessionId), ...(tier === undefined ? {} : { tier, confirmed, viewScope }) }),
    }));
    if (result.ok) views.set(sessionId, (await result.clone().json()).viewScope);
    return result;
  }
  async function boundary(id) {
    await listeners.get('agent/pre-step')({ agent: { session: { id } }, modelSelection: selected.get(id), signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }));
  }
  const captured = [];
  const response = text => {
    const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    return [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...item.content[0], text: '' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  };
  try {
    const native = await import(pathToFileURL(adapterEntry).href);
    const hostRequire = module.createRequire(adapterEntry);
    const { markAgentLoopRequest } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')).href);
    const { apply } = await import('../index.js');
    records.set(native.recordKeyFor('openai-codex'), { kind: 'grant', payload: { type: 'oauth', access: token, refresh: 'SYNTHETIC-REFRESH', accountId, expires: Date.now() + 3600000 } });
    const catalogRoute = { method: 'GET', path: /^\/backend-api\/codex\/models\?/ };
    const catalog = { models: [{
      slug: model, display_name: 'Tiered Model', visibility: 'list', supported_in_api: true,
      service_tiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }],
      supported_reasoning_levels: [{ effort: 'high' }], context_window: 100000,
    }] };
    mock.get('https://chatgpt.com').intercept(catalogRoute).reply(200, catalog);
    await apply({ ...scope,
      inject(names, callback) { assert.deepEqual(names, ['agents', 'storageDomain']); injections.push(callback(scope)); },
      credentials: { readRecord: async key => records.get(key), async modifyRecord(key, change) { const value = await change(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key); } },
      authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }) },
      llm: { registerAdapter: (_routes, value) => { adapter = value; }, emitAdaptersUpdated() {} }, tools: { register() {} }, get() {},
    });
    await Promise.all(injections);
    adapter.config.profiles().get(provider).transport = 'sse';
    let state = await request('speed-state', 'session-a'); assert.equal(state.status, 200);
    const codexState = await state.json();
    assert.equal(codexState.source, 'model');
    assert.deepEqual(codexState.tiers.map(tier => tier.id), ['default', 'priority', 'ultrafast']);
    assert.equal((await request('speed-select', 'session-a', 'priority', false)).status, 400);
    assert.equal((await request('speed-select', 'session-a', 'flex', true)).status, 400);
    // The warm picker and explicit Fast save are local, even when the TTL refresh hangs.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(60001);
    const release = Promise.withResolvers(), started = Promise.withResolvers();
    mock.get('https://chatgpt.com').intercept(catalogRoute).reply(200, async () => {
      started.resolve(); await release.promise; return catalog;
    });
    const local = async (work, label) => {
      const timeout = AbortSignal.timeout(1000);
      const result = await Promise.race([work, new Promise(resolve => timeout.addEventListener('abort', () => resolve(null)))]);
      assert.ok(result, `${label} waited for upstream`); return result;
    };
    try {
      assert.equal((await local(request('speed-state', 'session-a'), 'warm state')).status, 200);
      await local(started.promise.then(() => true), 'background refresh');
      assert.equal((await local(request('speed-select', 'session-a', 'fast', true), 'explicit Fast')).status, 200);
      let entered = false, inherited = false, prepared = false;
      const step = boundary('session-a').then(() => { entered = true; });
      const otherStep = boundary('session-b').then(() => { inherited = true; });
      const prepare = adapter.prepareCall(provider, model).then(() => { prepared = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual([entered, inherited, prepared], [false, false, false], 'both explicit and inherited Speed join strict validation');
      release.resolve(); await Promise.all([step, otherStep, prepare]);
    } finally { release.resolve(); }
    // New sessions inherit the model's last tier, so make session-b explicitly
    // Normal before checking that Normal omits the nonstandard Codex field.
    await request('speed-state', 'session-b');
    assert.equal((await request('speed-select', 'session-b', 'default', true)).status, 200);
    await boundary('session-a'); await boundary('session-b');
    mock.get('https://chatgpt.com').intercept({ method: 'POST', path: '/backend-api/codex/responses' }).reply(200, async ({ body, headers }) => {
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      const decoded = new Headers(headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes;
      captured.push(JSON.parse(decoded.toString('utf8'))); return response('ok');
    }, { headers: { 'content-type': 'text/event-stream' } }).times(4);
    async function stream(sessionId, prepared = null) {
      const options = { provider, model, sessionId, maxTokens: 16, reasoningEffort: 'high',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] };
      markAgentLoopRequest(options);
      prepared ??= await adapter.prepareCall(provider, model);
      // The real runtime may clone after file/image/tool projection. The
      // llm/stream observer must retain provenance without mutating the envelope.
      const chunks = await Array.fromAsync(listeners.get('llm/stream')(options, () => prepared.stream({ ...options })));
      assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop'), JSON.stringify(chunks));
    }
    await stream('session-a'); await stream('session-b');
    assert.equal(captured[0].service_tier, 'priority');
    assert.equal(captured[0].reasoning.effort, 'high'); assert.equal(captured[0].model, model);
    assert.equal(Object.hasOwn(captured[1], 'service_tier'), false, 'explicit Normal does not send a nonstandard Codex field');
    await request('speed-select', 'session-a', 'ultrafast', true);
    await stream('session-a'); // Same step/retry keeps priority.
    assert.equal(captured[2].service_tier, 'priority');
    await boundary('session-a'); await stream('session-a');
    assert.equal(captured[3].service_tier, 'ultrafast');
    state = await request('speed-state', 'session-a'); assert.equal((await state.json()).selected, 'ultrafast');
    // A prepared call keeps its reasoning/context, not authority for a removed tier.
    const beforeRemoval = await adapter.prepareCall(provider, model);
    t.mock.timers.tick(60001);
    const revalidating = Promise.withResolvers(), removed = Promise.withResolvers();
    mock.get('https://chatgpt.com').intercept(catalogRoute).reply(200, async () => {
      revalidating.resolve(); await removed.promise;
      return { models: [{ ...catalog.models[0], service_tiers: [{ id: 'priority', name: 'Fast' }] }] };
    });
    const obsolete = assert.rejects(stream('session-a', beforeRemoval), { code: 'UNSUPPORTED_SPEED' });
    try {
      await local(revalidating.promise.then(() => true), 'strict stream');
      assert.equal(captured.length, 4);
    } finally { removed.resolve(); }
    await obsolete;
    await assert.rejects(boundary('session-a'), { code: 'UNSUPPORTED_SPEED' });
    state = await request('speed-state', 'session-a'); assert.equal((await state.json()).stale, true);
    assert.equal((await request('speed-select', 'session-a', 'ultrafast', true)).status, 400);
    // Account B has the same model and offers Fast. A click from A's open page is not B's consent.
    const accountAView = views.get('session-a');
    const key = native.recordKeyFor('openai-codex');
    await request('speed-select', 'session-a', 'priority', true); await boundary('session-a');
    const beforeSwitch = await adapter.prepareCall(provider, model);
    // The native SDK resolves OAuth lazily, after the stream's initial catalog check.
    const resolveKey = adapter.config.resolveApiKey;
    const switchDuringAuth = t.mock.method(adapter.config, 'resolveApiKey', async (...args) => {
      records.set(key, { kind: 'grant', payload: { ...records.get(key).payload, accountId: 'SYNTHETIC-B' } });
      return resolveKey(...args);
    });
    mock.get('https://chatgpt.com').intercept(catalogRoute).reply(200, catalog);
    try { await assert.rejects(stream('session-a', beforeSwitch), /SPEED_MODEL_CHANGED/); }
    finally { switchDuringAuth.mock.restore(); }
    assert.equal(captured.length, 4);
    assert.equal((await request('speed-select', 'session-a', 'fast', true, accountAView)).status, 400);
    const bView = await (await request('speed-state', 'session-a')).json();
    assert.equal(bView.selected, 'default');
    assert.notEqual(bView.viewScope, accountAView);
    assert.equal((await request('speed-select', 'session-a', 'fast', true, null)).status, 400);
    assert.equal(JSON.stringify(bView).includes('SYNTHETIC'), false);
    assert.ok(!JSON.stringify(bView).includes([...stored.values()].find(value => value.sessionId === 'session-a').choices[0].account));
    assert.equal((await request('speed-select', 'session-a', 'priority', true)).status, 200);
    await boundary('session-a');
    const beforeDenial = await adapter.prepareCall(provider, model);
    t.mock.timers.tick(60001);
    mock.get('https://chatgpt.com').intercept(catalogRoute).reply(403, {});
    await assert.rejects(stream('session-a', beforeDenial), { code: 'MODEL_CATALOG_DENIED' });
    for (const action of ['speed-state', 'speed-select']) {
      const denied = await request(action, 'session-a', 'priority', true);
      assert.equal(denied.ok, false); assert.equal((await denied.json()).error, 'MODEL_CATALOG_DENIED');
    }
    records.delete(key);
    assert.equal((await (await request('speed-state', 'session-a')).json()).error, 'MISSING_CREDENTIAL');
    assert.equal(captured.length, 4);
    const crossOrigin = await routes.get('/api/subscriptions-lite/speed')(new Request('http://dsh.internal/api/subscriptions-lite/speed', {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-subscriptions-lite': '1' }, body: '{}',
    }));
    assert.equal(crossOrigin.status, 403);
    // xAI's documented priority scheduling shares the same per-session UI and
    // payload path, but never claims subscription entitlement or Build Fast.
    const grokProvider = 'subscription-xai';
    records.set(native.recordKeyFor('xai'), { kind: 'grant', payload: { type: 'oauth', access: 'SYNTHETIC-GROK', expires: Date.now() + 3600000 } });
    mock.get('https://api.x.ai').intercept({ method: 'GET', path: '/v1/models' }).reply(200, { data: [{ id: 'grok-4.7', context_length: 500000 }] });
    mock.get('https://api.x.ai').intercept({ method: 'GET', path: '/v1/language-models' }).reply(200, {
      models: [{ id: 'grok-4.7', input_modalities: ['text', 'image'], output_modalities: ['text'] }],
    });
    const grokModel = (await adapter.resolveModel(grokProvider, 'grok-4.7')).id;
    selected.set('session-b', { provider: grokProvider, model: grokModel });
    const grokState = await request('speed-state', 'session-b');
    const requestState = await grokState.json();
    assert.equal(requestState.source, 'request');
    assert.deepEqual(requestState.tiers.map(tier => tier.id), ['default', 'priority']);
    const grokSelected = await request('speed-select', 'session-b', 'fast', true);
    assert.equal(grokSelected.status, 200);
    assert.equal((await grokSelected.json()).selected, 'priority', 'HTTP accepts an alias but exposes only the canonical choice');
    await boundary('session-b');
    let grokBody;
    mock.get('https://api.x.ai').intercept({ method: 'POST', path: '/v1/responses' }).reply(200, async ({ body }) => {
      grokBody = JSON.parse(await new Response(body).text()); return response('ok');
    }, { headers: { 'content-type': 'text/event-stream' } });
    const grokOptions = markAgentLoopRequest({ provider: grokProvider, model: grokModel, sessionId: 'session-b', maxTokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] });
    await Array.fromAsync(listeners.get('llm/stream')(grokOptions, () => adapter.stream({ ...grokOptions })));
    assert.equal(grokBody.service_tier, 'priority');
    assert.equal(grokBody.model, grokModel);
    // No capability keeps the original default request, regardless of a model
    // name or a stale sidecar choice. This is not a model-switching mechanism.
    const kimiProvider = 'subscription-kimi-coding';
    const kimiModel = 'kimi-for-coding';
    records.set(native.recordKeyFor('kimi-coding'), { kind: 'grant', payload: { type: 'oauth', access: 'SYNTHETIC-KIMI', expires: Date.now() + 3600000 } });
    mock.get('https://api.kimi.com').intercept({ method: 'GET', path: '/coding/v1/models' }).reply(200, { data: [{
      id: kimiModel, context_length: 1048576, supports_reasoning: true,
      reasoning: { type: 'only', effort: { valid: ['low', 'high', 'max'], default: 'max' } },
    }] });
    selected.set('session-b', { provider: kimiProvider, model: kimiModel });
    const defaultState = await request('speed-state', 'session-b');
    const kimiState = await defaultState.json();
    assert.equal(kimiState.source, 'default');
    assert.equal(kimiState.selected, 'default');
    assert.deepEqual(kimiState.tiers.map(tier => tier.id), ['default']);
    assert.equal((await request('speed-select', 'session-b', 'priority', true)).status, 400);
    let kimiBody;
    mock.get('https://api.kimi.com').intercept({ method: 'POST', path: '/coding/v1/chat/completions' }).reply(200, async ({ body }) => {
      kimiBody = JSON.parse(await new Response(body).text());
      return `data: ${JSON.stringify({ id: 'chat_synthetic', object: 'chat.completion.chunk', model: kimiModel,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({
        id: 'chat_synthetic', object: 'chat.completion.chunk', model: kimiModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`;
    }, { headers: { 'content-type': 'text/event-stream' } });
    await boundary('session-b');
    const kimiOptions = markAgentLoopRequest({ provider: kimiProvider, model: kimiModel, sessionId: 'session-b', maxTokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] });
    const kimiChunks = await Array.fromAsync(listeners.get('llm/stream')(kimiOptions, () => adapter.stream({ ...kimiOptions })));
    assert.ok(kimiChunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop'), JSON.stringify(kimiChunks));
    assert.equal(kimiBody.model, kimiModel);
    assert.equal(Object.hasOwn(kimiBody, 'service_tier'), false);
    mock.assertNoPendingInterceptors();
  } catch (error) { console.error(error); throw error; }
  finally {
    for (const dispose of disposers.reverse()) await dispose();
    hooks.deregister(); undici.setGlobalDispatcher(previous); await mock.close();
    if (env === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = env;
  }
});
