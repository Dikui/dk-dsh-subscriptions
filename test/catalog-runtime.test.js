import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from 'node:module';
import { pathToFileURL } from 'node:url';

const require = module.createRequire(import.meta.url);
let undici, adapterEntry;
try {
  const selected = require.resolve(process.env.DSH_TEST_UNDICI ?? 'undici');
  undici = require(selected);
  adapterEntry = module.createRequire(selected).resolve('@deepseek-ai/dsh-llm-pi-ai');
} catch (error) { if (process.env.DSH_TEST_UNDICI) throw error; }

// small/regression — subscription runtime task: real plugin apply + shipped adapter.
// Synthetic in-memory grants only; MockAgent replaces HTTP and forbids external connections.
test('registered subscription routes preserve their native runtime contracts', {
  skip: !undici || !module.registerHooks ? 'Set DSH_TEST_UNDICI and use the desktop Node runtime.' : false,
}, async t => {
  const previous = undici.getGlobalDispatcher();
  const env = process.env.HTTPS_PROXY, xaiKey = process.env.XAI_API_KEY;
  process.env.HTTPS_PROXY = 'http://synthetic-explicit-proxy.invalid:80'; // Leave automatic system discovery inactive.
  process.env.XAI_API_KEY = 'SYNTHETIC-AMBIENT-PAID';
  const agent = new undici.MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  const row = context => ({ slug: 'server-only-model', display_name: 'Account Model', visibility: 'list',
    supported_in_api: true, input_modalities: ['text'], context_window: context,
    supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }], default_reasoning_level: 'high' });
  const pool = agent.get('https://chatgpt.com');
  for (const context of [100000, 200000]) pool.intercept({ method: 'GET', path: /^\/backend-api\/codex\/models\?/ })
    .reply(200, { models: [row(context)] });
  undici.setGlobalDispatcher(agent);
  const hooks = module.registerHooks({ resolve(specifier, context, next) {
    return specifier === '@deepseek-ai/dsh-llm-pi-ai'
      ? { url: pathToFileURL(adapterEntry).href, shortCircuit: true } : next(specifier, context);
  } });
  const dispose = [], records = new Map();
  let adapter, tool, modelSources, originalKimiSource;
  try {
    const native = await import(pathToFileURL(adapterEntry).href);
    const { apply } = await import('../index.js');
    ({ accountModelSources: modelSources } = await import('../model-sources.js'));
    originalKimiSource = modelSources.get('kimi-coding');
    // A second source exercises generic wiring, not an invented Kimi account endpoint.
    modelSources.set('kimi-coding', ({ baseModels, readCredential }) => {
      let queries = 0;
      return {
        readIdentity: async signal => (await readCredential(signal))?.subject,
        loadModels: async () => [{ ...baseModels[0], id: 'second-server-model', name: 'Second Account Model', contextWindow: ++queries * 100000 }],
      };
    });
    const credentials = {
      readRecord: async key => records.get(key),
      async modifyRecord(key, change) {
        const value = await change(records.get(key));
        if (value !== undefined) records.set(key, value);
        return records.get(key);
      },
    };
    const llm = {
      registerAdapter(routes, value) { assert.ok(routes.includes('subscription-xai')); adapter = value; },
      emitAdaptersUpdated() {}, stream: () => assert.fail('No inference in metadata tests'),
    };
    await apply({ credentials,
      on(event, callback) { assert.equal(event, 'dispose'); dispose.push(callback); }, get() {},
      authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }), begin: () => assert.fail('No login in offline tests') },
      llm, connection: { fetch: { register() {} } }, tools: { register(value) { tool = value; } },
    });
    const exec = { signal: new AbortController().signal };
    const vendors = [
      { id: 'openai-codex', route: 'subscription-openai-codex', model: 'server-only-model' },
      { id: 'kimi-coding', route: 'subscription-kimi-coding', model: 'second-server-model' },
    ];
    for (const vendor of vendors) assert.deepEqual(await adapter.listModels(vendor.route), []);
    records.set(native.recordKeyFor('openai-codex'), { kind: 'grant', payload: {
      type: 'oauth', access: 'SYNTHETIC-ACCESS', refresh: 'SYNTHETIC-REFRESH', accountId: 'SYNTHETIC-ACCOUNT', expires: Date.now() + 3600000,
    } });
    records.set(native.recordKeyFor('kimi-coding'), { kind: 'grant', payload: {
      type: 'oauth', access: 'SYNTHETIC-KIMI', subject: 'SYNTHETIC-SUBJECT', expires: Date.now() + 3600000,
    } });
    for (const vendor of vendors) {
      const { route, model } = vendor;
      assert.deepEqual((await adapter.listModels(route)).map(item => item.id), [model]);
      const status = await tool.execute({ action: 'status' }, exec);
      const state = status.providers.find(item => item.id === vendor.id);
      assert.deepEqual(state.models.map(item => item.id), [model]);
      assert.equal(state.modelCatalog.source, 'account');
      assert.ok(!JSON.stringify(status).includes('SYNTHETIC-'));
      assert.equal((await adapter.resolveModel(route, model)).context.contextWindow, 100000);
      const sent = [];
      adapter.config.profiles().get(route).piProvider.streamSimple = value => {
        sent.push(value); throw new Error('SYNTHETIC_TRANSPORT_STOP');
      };
      const prepared = await adapter.prepareCall(route, model);
      assert.equal(prepared.model.context.contextWindow, 100000);
      assert.deepEqual(await tool.execute({ action: 'models', provider: vendor.id }, exec), { ok: true });
      assert.equal((await adapter.resolveModel(route, model)).context.contextWindow, 200000);
      const options = { provider: route, model, maxTokens: 8, messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] };
      async function consume(stream) {
        try { for await (const _chunk of stream) {} }
        catch (error) { assert.match(error.message, /SYNTHETIC_TRANSPORT_STOP/); }
      }
      await consume(prepared.stream(options));
      assert.equal(sent[0]?.contextWindow, 100000);
      await consume(adapter.stream(options));
      assert.equal(sent[1]?.contextWindow, 200000);
    }
    // Grok has SDK-local descriptors, not a verified account-discovery endpoint.
    agent.clearCallHistory();
    const route = 'subscription-xai', key = native.recordKeyFor('xai');
    const state = (await tool.execute({ action: 'status' }, exec)).providers.find(item => item.id === 'xai');
    assert.equal(state.available, true);
    assert.equal(state.configured, false);
    assert.deepEqual(state.modelCatalog, { source: 'local', state: 'ready', error: null, updatedAt: null });
    const model = state.models[0]?.id;
    assert.ok(model);
    assert.equal((await tool.execute({ action: 'models', provider: 'xai' }, exec)).error, 'MODEL_CATALOG_UNAVAILABLE');
    const options = { provider: route, model, maxTokens: 32,
      apiKey: 'SYNTHETIC-CALLER-PAID', headers: { authorization: 'Bearer SYNTHETIC-CALLER-PAID' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] };
    llm.stream = request => adapter.stream({ ...request, apiKey: options.apiKey, headers: options.headers });
    await t.test('Grok rejects missing OAuth and stored paid keys despite ambient or caller keys', async () => {
      for (const record of [undefined, { kind: 'api-key', key: 'SYNTHETIC-STORED-PAID' }]) {
        if (record) records.set(key, record); else records.delete(key);
        assert.deepEqual(await adapter.listModels(route), []);
        await assert.rejects(Array.fromAsync(adapter.stream(options)), { code: 'MISSING_CREDENTIAL' });
        const prepared = await adapter.prepareCall(route, model);
        await assert.rejects(Array.fromAsync(prepared.stream(options)), { code: 'MISSING_CREDENTIAL' });
        assert.equal((await tool.execute({ action: 'test', provider: 'xai', model }, exec)).error, 'MISSING_CREDENTIAL');
      }
      assert.equal(agent.getCallHistory().calls().length, 0);
    });
    await t.test('Grok refreshes expired OAuth before native Responses inference without paid-key fallback', async () => {
      records.set(key, { kind: 'grant', payload: { type: 'oauth', access: 'SYNTHETIC-XAI-EXPIRED',
        refresh: 'SYNTHETIC-XAI-REFRESH', expires: Date.now() - 1 } });
      let refreshBody;
      agent.get('https://auth.x.ai').intercept({ method: 'POST', path: '/oauth2/token' })
        .reply(200, async ({ body }) => {
          refreshBody = new URLSearchParams(await new Response(body).text());
          return { access_token: 'SYNTHETIC-XAI-ROTATED', refresh_token: 'SYNTHETIC-XAI-ROTATED-REFRESH', expires_in: 3600 };
        }, { headers: { 'content-type': 'application/json' } });
      const item = { id: 'msg_SYNTHETIC', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '2', annotations: [] }] };
      const sse = [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...item.content[0], text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '2' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_SYNTHETIC', status: 'completed', output: [item],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      const requests = [];
      agent.get('https://api.x.ai').intercept({ method: 'POST', path: '/v1/responses' })
        .reply(200, async ({ headers, body }) => {
          requests.push({ bearer: new Headers(headers).get('authorization'), body: JSON.parse(await new Response(body).text()) });
          return sse;
        }, { headers: { 'content-type': 'text/event-stream' } }).times(2);
      assert.deepEqual((await adapter.listModels(route)).map(item => item.id), state.models.map(item => item.id));
      const prepared = await adapter.prepareCall(route, model);
      const chunks = await Array.fromAsync(prepared.stream(options));
      assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '2');
      assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop');
      assert.deepEqual(await tool.execute({ action: 'test', provider: 'xai', model }, exec), { ok: true, model, text: '2' });
      assert.equal(refreshBody.get('grant_type'), 'refresh_token');
      assert.equal(refreshBody.get('refresh_token'), 'SYNTHETIC-XAI-REFRESH');
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.bearer, 'Bearer SYNTHETIC-XAI-ROTATED');
        assert.equal(request.body.model, model);
        assert.equal(request.body.stream, true);
        assert.equal(request.body.store, false);
        assert.ok(Array.isArray(request.body.input));
        assert.ok(!JSON.stringify(request.body).includes('SYNTHETIC-CALLER-PAID'));
      }
      assert.deepEqual(requests.map(request => request.body.max_output_tokens), [32, 256]);
      assert.deepEqual(agent.getCallHistory().calls().map(call => [call.method, call.origin, call.path]), [
        ['POST', 'https://auth.x.ai', '/oauth2/token'],
        ['POST', 'https://api.x.ai', '/v1/responses'], ['POST', 'https://api.x.ai', '/v1/responses'],
      ]);
    });
    for (const status of [401, 403, 429]) await t.test(`Grok HTTP ${status} is sanitized after one OAuth request without retry or fallback`, async () => {
      agent.clearCallHistory();
      agent.get('https://api.x.ai').intercept({ method: 'POST', path: '/v1/responses',
        headers: { authorization: 'Bearer SYNTHETIC-XAI-ROTATED' } })
        .reply(status, { error: { message: 'SYNTHETIC-XAI-ROTATED SYNTHETIC-CALLER-PAID upstream diagnostic' } },
          { headers: { 'content-type': 'application/json' } });
      assert.deepEqual(await tool.execute({ action: 'test', provider: 'xai', model }, exec), {
        error: 'TEST_FAILED', message: 'The subscription operation did not complete. Check authorization and retry.',
      });
      assert.deepEqual(agent.getCallHistory().calls().map(call => [call.method, call.origin, call.path]), [
        ['POST', 'https://api.x.ai', '/v1/responses'],
      ]);
      assert.equal(agent.pendingInterceptors().length, 0);
    });
    assert.equal(agent.pendingInterceptors().length, 0);
  } finally {
    for (const close of dispose.reverse()) await close();
    if (modelSources) {
      if (originalKimiSource === undefined) modelSources.delete('kimi-coding');
      else modelSources.set('kimi-coding', originalKimiSource);
    }
    hooks.deregister(); undici.setGlobalDispatcher(previous);
    await agent.close();
    if (env === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = env;
    if (xaiKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = xaiKey;
  }
});
