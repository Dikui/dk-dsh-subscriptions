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
}, async () => {
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
    on(name, listener) { if (name === 'dispose') disposers.push(listener); else listeners.set(name, listener); },
    connection: { fetch: { register: value => routes.set(value.path, value.fetch) } },
  };
  async function request(action, sessionId, tier, confirmed) {
    return routes.get('/api/subscriptions-lite/speed')(new Request('http://dsh.internal/api/subscriptions-lite/speed', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-subscriptions-lite': '1' },
      body: JSON.stringify({ action, sessionId, ...selected.get(sessionId), ...(tier === undefined ? {} : { tier, confirmed }) }),
    }));
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
    mock.get('https://chatgpt.com').intercept({ method: 'GET', path: /^\/backend-api\/codex\/models\?/ }).reply(200, { models: [{
      slug: model, display_name: 'Tiered Model', visibility: 'list', supported_in_api: true,
      service_tiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }],
      supported_reasoning_levels: [{ effort: 'high' }], context_window: 100000,
    }] });
    await apply({ ...scope,
      inject(names, callback) { assert.deepEqual(names, ['agents', 'storageDomain']); injections.push(callback(scope)); },
      credentials: { readRecord: async key => records.get(key), async modifyRecord(key, change) { const value = await change(records.get(key)); if (value !== undefined) records.set(key, value); return records.get(key); } },
      authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }) },
      llm: { registerAdapter: (_routes, value) => { adapter = value; }, emitAdaptersUpdated() {} }, tools: { register() {} }, get() {},
    });
    await Promise.all(injections);
    adapter.config.profiles().get(provider).transport = 'sse';
    let state = await request('speed-state', 'session-a'); assert.equal(state.status, 200);
    assert.deepEqual((await state.json()).tiers.map(tier => tier.id), ['default', 'priority', 'ultrafast']);
    assert.equal((await request('speed-select', 'session-a', 'priority', false)).status, 400);
    assert.equal((await request('speed-select', 'session-a', 'flex', true)).status, 400);
    assert.equal((await request('speed-select', 'session-a', 'priority', true)).status, 200);
    await boundary('session-a'); await boundary('session-b');
    mock.get('https://chatgpt.com').intercept({ method: 'POST', path: '/backend-api/codex/responses' }).reply(200, async ({ body, headers }) => {
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      const decoded = new Headers(headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes;
      captured.push(JSON.parse(decoded.toString('utf8'))); return response('ok');
    }, { headers: { 'content-type': 'text/event-stream' } }).times(4);
    async function stream(sessionId, marked = true) {
      const options = { provider, model, sessionId, maxTokens: 16, reasoningEffort: 'high',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] };
      if (marked) markAgentLoopRequest(options);
      const prepared = await adapter.prepareCall(provider, model);
      // The real runtime may clone after file/image/tool projection. The
      // llm/stream observer must retain provenance without mutating the envelope.
      const chunks = await Array.fromAsync(listeners.get('llm/stream')(options, () => prepared.stream({ ...options })));
      assert.ok(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop'), JSON.stringify(chunks));
    }
    await stream('session-a'); await stream('session-b');
    assert.equal(captured[0].service_tier, 'priority');
    assert.equal(captured[0].reasoning.effort, 'high'); assert.equal(captured[0].model, model);
    assert.equal(Object.hasOwn(captured[1], 'service_tier'), false, 'Normal does not send a nonstandard Codex field');
    await request('speed-select', 'session-a', 'ultrafast', true);
    await stream('session-a'); // Same step/retry keeps priority.
    assert.equal(captured[2].service_tier, 'priority');
    await boundary('session-a'); await stream('session-a');
    assert.equal(captured[3].service_tier, 'ultrafast');
    state = await request('speed-state', 'session-a'); assert.equal((await state.json()).selected, 'ultrafast');
    const crossOrigin = await routes.get('/api/subscriptions-lite/speed')(new Request('http://dsh.internal/api/subscriptions-lite/speed', {
      method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-subscriptions-lite': '1' }, body: '{}',
    }));
    assert.equal(crossOrigin.status, 403);
    // xAI's documented priority scheduling shares the same per-session UI and
    // payload path, but never claims subscription entitlement or Build Fast.
    const grokProvider = 'subscription-xai';
    const grokModel = (await adapter.resolveModel(grokProvider, 'grok-4.7')).id;
    records.set(native.recordKeyFor('xai'), { kind: 'grant', payload: { type: 'oauth', access: 'SYNTHETIC-GROK', expires: Date.now() + 3600000 } });
    selected.set('session-b', { provider: grokProvider, model: grokModel });
    const grokState = await request('speed-state', 'session-b');
    assert.deepEqual((await grokState.json()).tiers.map(tier => tier.id), ['default', 'priority']);
    assert.equal((await request('speed-select', 'session-b', 'priority', true)).status, 200);
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
    mock.assertNoPendingInterceptors();
  } catch (error) { console.error(error); throw error; }
  finally {
    for (const dispose of disposers.reverse()) await dispose();
    hooks.deregister(); undici.setGlobalDispatcher(previous); await mock.close();
    if (env === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = env;
  }
});
