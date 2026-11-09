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

const vendors = [
  { id: 'openai-codex', route: 'subscription-openai-codex', model: 'server-only-codex', context: 100000 },
  { id: 'kimi-coding', route: 'subscription-kimi-coding', model: 'k3.1-pro', context: 1048576 },
  { id: 'xai', route: 'subscription-xai', model: 'grok-next-server-only', context: 2000000 },
];
const codexRow = (id, context, effort = 'high') => ({ slug: id, display_name: 'Remote Codex', visibility: 'list',
  supported_in_api: true, input_modalities: ['text'], context_window: context,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: effort });
// Verified vendor response fields; the model data and grants are synthetic, not user/account data.
const kimiRows = () => [
  { id: 'k3.1-pro', display_name: 'K3.1 Pro', context_length: 1048576, supports_reasoning: true,
    supports_image_in: true, supports_video_in: true, supports_thinking_type: 'only',
    think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' } },
  { id: 'k3.1-pro-highspeed', display_name: 'K3.1 Pro Highspeed 2x Usage Cost', limit: { context: 1048576 },
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    reasoning: { type: 'only', effort: { valid: ['low', 'high', 'max'], default: 'high' } } },
];
const grokRows = () => [
  { id: 'grok-4.7', context_length: 500000 },
  { id: 'grok-next-server-only', context_length: 2000000, aliases: ['grok-unpublished-alias'],
    capabilities: { reasoning_effort: ['none', 'low', 'high'], default_reasoning_effort: 'high' },
    base_url: 'https://untrusted.invalid', api_key: 'REMOTE-PAID', headers: { authorization: 'Bearer REMOTE-PAID' } },
  { id: 'grok-imagine-image' }, { id: 'grok-imagine-video' }, { id: 'grok-4.20-multi-agent' },
  { id: 'grok-no-functions' },
];
const grokLanguageRows = () => [
  { id: 'grok-4.7', input_modalities: ['text', 'image'], output_modalities: ['text'] },
  { id: 'grok-next-server-only', input_modalities: ['text'], output_modalities: ['text'] },
  { id: 'grok-4.20-multi-agent', input_modalities: ['text'], output_modalities: ['text'] },
  { id: 'grok-no-functions', input_modalities: ['text'], output_modalities: ['text'], capabilities: { function_calling: false } },
  { id: 'grok-removed-from-models', input_modalities: ['text'], output_modalities: ['text'] },
];
const responseSse = (text = '2') => {
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...item.content[0], text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [item],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
};
const kimiSse = model => [
  { id: 'chat_synthetic', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '2' }, finish_reason: null }] },
  { id: 'chat_synthetic', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
const optionsFor = vendor => ({ provider: vendor.route, model: vendor.model, maxTokens: 32,
  apiKey: 'SYNTHETIC-CALLER-PAID', headers: { authorization: 'Bearer SYNTHETIC-CALLER-PAID' },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }] }] });

// medium/spec + regression — /tmp/dk-model-sync-spec.md: real apply(), shipped SDK and all
// three unmodified source factories. MockAgent replaces vendor HTTP only and forbids live traffic.
test('registered subscription routes use the same remote catalogs and native OAuth runtime', {
  skip: !undici || !module.registerHooks ? 'Set DSH_TEST_UNDICI and use the desktop Node runtime.' : false,
}, async t => {
  const previous = undici.getGlobalDispatcher();
  const envNames = ['HTTPS_PROXY', 'XAI_API_KEY', 'KIMI_API_KEY', 'OPENAI_API_KEY'];
  const environment = new Map(envNames.map(name => [name, process.env[name]]));
  process.env.HTTPS_PROXY = 'http://synthetic-explicit-proxy.invalid:80';
  for (const name of envNames.slice(1)) process.env[name] = 'SYNTHETIC-AMBIENT-PAID';
  const agent = new undici.MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  undici.setGlobalDispatcher(agent);
  const hooks = module.registerHooks({ resolve(specifier, context, next) {
    return specifier === '@deepseek-ai/dsh-llm-pi-ai'
      ? { url: pathToFileURL(adapterEntry).href, shortCircuit: true } : next(specifier, context);
  } });
  const dispose = [];
  const exec = { signal: new AbortController().signal };
  const calls = () => agent.getCallHistory().calls().map(call => [call.method, call.origin, call.path]);
  const inferenceCalls = () => calls().filter(([method, , path]) => method === 'POST' && /responses|completions|\/tools$/.test(path));
  const accessFor = (id, suffix = '') => id === 'openai-codex'
    ? ['SYNTHETIC', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'SYNTHETIC-ACCOUNT' } })).toString('base64url'), `SYNTHETIC${suffix}`].join('.')
    : `SYNTHETIC-${id}${suffix}`;
  let native;
  function metadata(id, { access = accessFor(id), context, effort = 'high', only = false, status = 200 } = {}) {
    const headers = { authorization: `Bearer ${access}` };
    if (id === 'openai-codex') {
      agent.get('https://chatgpt.com').intercept({ method: 'GET', path: /^\/backend-api\/codex\/models\?/, headers: {
        ...headers, 'chatgpt-account-id': 'SYNTHETIC-ACCOUNT', originator: 'pi',
      } }).reply(status, status === 200 ? { models: [codexRow('server-only-codex', context ?? 100000, effort)] }
        : { error: 'SYNTHETIC-UPSTREAM-SECRET' });
    } else if (id === 'kimi-coding') {
      const rows = kimiRows();
      if (context) rows[0].context_length = context;
      agent.get('https://api.kimi.com').intercept({ method: 'GET', path: '/coding/v1/models', headers })
        .reply(status, status === 200 ? { object: 'list', has_more: false, data: only ? rows.slice(0, 1) : rows }
          : { error: 'SYNTHETIC-UPSTREAM-SECRET' });
    } else {
      const rows = grokRows();
      if (context) rows[1].context_length = context;
      agent.get('https://api.x.ai').intercept({ method: 'GET', path: '/v1/models', headers })
        .reply(status, status === 200 ? { object: 'list', data: only ? [rows[1]] : rows }
          : { error: 'SYNTHETIC-UPSTREAM-SECRET' });
      if (status === 200) agent.get('https://api.x.ai').intercept({ method: 'GET', path: '/v1/language-models', headers })
        .reply(200, { models: grokLanguageRows() });
    }
  }
  async function mount({ ids = [], expired = false, config = {} } = {}) {
    const records = new Map(), tools = new Map(), saved = [];
    let adapter, settingsFetch;
    for (const id of ids) records.set(native.recordKeyFor(id), { kind: 'grant', payload: {
      type: 'oauth', access: accessFor(id), refresh: `SYNTHETIC-REFRESH-${id}`,
      ...(id === 'openai-codex' ? { accountId: 'SYNTHETIC-ACCOUNT' } : {}), expires: expired ? 0 : Date.now() + 3600000,
    } });
    const credentials = {
      readRecord: async key => records.get(key),
      async modifyRecord(key, change) {
        const value = await change(records.get(key));
        if (value !== undefined) records.set(key, value);
        return records.get(key);
      },
    };
    const llm = { registerAdapter(routes, value) {
      assert.deepEqual([...routes].sort(), vendors.map(vendor => vendor.route).sort()); adapter = value;
    }, emitAdaptersUpdated() {}, stream: request => adapter.stream({ ...request,
      apiKey: 'SYNTHETIC-CALLER-PAID', headers: { authorization: 'Bearer SYNTHETIC-CALLER-PAID' } }) };
    const { apply } = await import('../index.js');
    await apply({ credentials,
      effect(callback) { const cleanup = callback(); if (cleanup) dispose.push(cleanup); },
      get: () => ({ async saveFile(value) { saved.push(value); return { attachmentId: 'SYNTHETIC-REF', name: value.name, bytes: value.data.length }; } }),
      authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }), begin: () => assert.fail('No login in offline tests') },
      llm, connection: { fetch: { register({ fetch }) { settingsFetch = fetch; } } },
      tools: { register: value => tools.set(value.name, value) },
    }, config);
    adapter.config.profiles().get('subscription-openai-codex').transport = 'sse';
    return { adapter, records, credentials, tools, saved, settingsFetch, tool: tools.get('subscription_accounts') };
  }
  function inference(vendor, captured, { access = accessFor(vendor.id), times = 1 } = {}) {
    const [origin, path] = vendor.id === 'openai-codex' ? ['https://chatgpt.com', '/backend-api/codex/responses']
      : vendor.id === 'kimi-coding' ? ['https://api.kimi.com', '/coding/v1/chat/completions'] : ['https://api.x.ai', '/v1/responses'];
    agent.get(origin).intercept({ method: 'POST', path, headers: { authorization: `Bearer ${access}` } })
      .reply(200, async ({ body, headers }) => {
        const bytes = Buffer.from(await new Response(body).arrayBuffer());
        const decoded = new Headers(headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes;
        captured.push({ body: JSON.parse(decoded.toString('utf8')), bearer: new Headers(headers).get('authorization') });
        return vendor.id === 'kimi-coding' ? kimiSse(vendor.model) : responseSse();
      }, { headers: { 'content-type': 'text/event-stream' } }).times(times);
  }
  async function successful(stream) {
    const chunks = await Array.fromAsync(stream);
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '2');
    assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop', JSON.stringify(chunks));
  }
  try {
    native = await import(pathToFileURL(adapterEntry).href);
    let runtime;
    await t.test('already-authorized startup warms all three real metadata sources without inference', async () => {
      for (const vendor of vendors) metadata(vendor.id);
      runtime = await mount({ ids: vendors.map(vendor => vendor.id) });
      assert.deepEqual([...runtime.tools.keys()].sort(), ['grok_x_search', 'kimi_call_data_source_tool', 'kimi_get_data_source_desc', 'subscription_accounts']);
      assert.deepEqual(calls().map(([method, origin, path]) => [method, origin, path.split('?')[0]]).sort(), [
        ['GET', 'https://chatgpt.com', '/backend-api/codex/models'],
        ['GET', 'https://api.kimi.com', '/coding/v1/models'],
        ['GET', 'https://api.x.ai', '/v1/models'], ['GET', 'https://api.x.ai', '/v1/language-models'],
      ].sort());
      assert.deepEqual(inferenceCalls(), []);
      agent.assertNoPendingInterceptors();
    });
    await t.test('settings, status, list, resolve and prepare expose one remote collection within the TTL', async () => {
      const before = calls().length;
      const status = await runtime.tool.execute({ action: 'status' }, exec);
      const settingsResponse = await runtime.settingsFetch(new Request('http://dsh.internal/api/subscriptions-lite'));
      assert.equal(settingsResponse.status, 200);
      const settings = await settingsResponse.json();
      const expected = [['server-only-codex'], ['k3.1-pro', 'k3.1-pro-highspeed'], ['grok-4.7', 'grok-next-server-only']];
      for (const [index, vendor] of vendors.entries()) {
        const state = status.providers.find(item => item.id === vendor.id);
        assert.equal(state.available, true); assert.equal(state.configured, true);
        assert.equal(state.modelCatalog.source, 'account');
        assert.equal(state.modelCatalog.scope, vendor.id === 'xai' ? 'vendor' : 'account');
        assert.equal(state.modelCatalog.state, 'ready'); assert.equal(state.modelCatalog.error, null);
        assert.deepEqual(state.models.map(item => item.id), expected[index]);
        assert.deepEqual(settings.providers.find(item => item.id === vendor.id).models, state.models);
        const list = await runtime.adapter.listModels(vendor.route);
        assert.deepEqual(list.map(({ id, name }) => ({ id, name })), state.models);
        for (const model of list) {
          const resolved = await runtime.adapter.resolveModel(vendor.route, model.id);
          const prepared = await runtime.adapter.prepareCall(vendor.route, model.id);
          assert.deepEqual(prepared.model, resolved);
          assert.equal(resolved.name, model.name);
        }
        assert.equal((await runtime.adapter.resolveModel(vendor.route, vendor.model)).context.contextWindow, vendor.context);
      }
      assert.doesNotMatch(JSON.stringify({ status, settings }), /SYNTHETIC-|REMOTE-PAID|untrusted\.invalid/);
      assert.equal(calls().length, before, 'metadata is cached for 60 seconds, including settings/status reads');
    });
    await t.test('K3.1 exposes remote high defaults and low/high/max only in both resolve and prepare', async () => {
      for (const model of ['k3.1-pro', 'k3.1-pro-highspeed']) {
        const resolved = await runtime.adapter.resolveModel('subscription-kimi-coding', model);
        assert.equal(resolved.context.contextWindow, 1048576);
        assert.deepEqual(resolved.inputModalities, ['text', 'image'], 'video is not a Harness input modality');
        assert.deepEqual(resolved.reasoning?.efforts.map(item => item.id), ['low', 'high', 'max']);
        assert.equal(resolved.reasoning?.defaultEffort, 'high');
        assert.deepEqual((await runtime.adapter.prepareCall('subscription-kimi-coding', model)).model, resolved);
      }
    });
    await t.test('server-only IDs reach native inference with OAuth rather than caller or environment keys', async () => {
      for (const vendor of vendors) {
        const captured = [];
        inference(vendor, captured);
        const prepared = await runtime.adapter.prepareCall(vendor.route, vendor.model);
        await successful(prepared.stream(optionsFor(vendor)));
        assert.equal(captured[0].bearer, `Bearer ${accessFor(vendor.id)}`);
        assert.equal(captured[0].body.model, vendor.model);
        assert.equal(captured[0].body.stream, true);
        assert.doesNotMatch(JSON.stringify(captured[0].body), /SYNTHETIC-CALLER-PAID|SYNTHETIC-AMBIENT-PAID|REMOTE-PAID|untrusted\.invalid/);
        if (vendor.id === 'kimi-coding') {
          assert.equal(captured[0].body.reasoning_effort, 'high');
          assert.notEqual(captured[0].body.thinking?.type, 'disabled');
        } else {
          assert.equal(captured[0].body.reasoning.effort, 'high');
          assert.equal(captured[0].body.store, false);
        }
      }
      agent.assertNoPendingInterceptors();
    });
    await t.test('K3.1 refuses explicit off before any native HTTP request', async () => {
      const before = calls().length;
      for (const model of ['k3.1-pro', 'k3.1-pro-highspeed']) {
        const options = { ...optionsFor(vendors[1]), model, reasoningEffort: 'off' };
        await assert.rejects(Array.fromAsync(runtime.adapter.stream(options)), { code: 'UNSUPPORTED_REASONING_EFFORT' });
        const prepared = await runtime.adapter.prepareCall(options.provider, model);
        await assert.rejects(Array.fromAsync(prepared.stream(options)), { code: 'UNSUPPORTED_REASONING_EFFORT' });
      }
      assert.equal(calls().length, before);
    });
    await t.test('forced metadata refresh updates descriptors without changing an already-prepared stream', async () => {
      const vendor = vendors[0], captured = [];
      const prepared = await runtime.adapter.prepareCall(vendor.route, vendor.model);
      metadata(vendor.id, { context: 200000, effort: 'low' });
      assert.deepEqual(await runtime.tool.execute({ action: 'models', provider: vendor.id }, exec), { ok: true });
      assert.equal(prepared.model.context.contextWindow, 100000);
      assert.equal((await runtime.adapter.resolveModel(vendor.route, vendor.model)).context.contextWindow, 200000);
      inference(vendor, captured, { times: 2 });
      await successful(prepared.stream(optionsFor(vendor)));
      await successful(runtime.adapter.stream(optionsFor(vendor)));
      assert.deepEqual(captured.map(request => request.body.reasoning.effort), ['high', 'low']);
    });
    for (const vendor of vendors) await t.test(`${vendor.id} remote failure clears every public model path without static fallback`, async () => {
      agent.clearCallHistory();
      metadata(vendor.id, { status: 503 });
      assert.equal((await runtime.tool.execute({ action: 'models', provider: vendor.id }, exec)).error, 'MODEL_CATALOG_FAILED');
      const state = (await runtime.tool.execute({ action: 'status' }, exec)).providers.find(item => item.id === vendor.id);
      assert.deepEqual(state.models, []);
      assert.equal(state.modelCatalog.state, 'error'); assert.equal(state.modelCatalog.error, 'MODEL_CATALOG_FAILED');
      assert.equal(state.modelCatalog.scope, vendor.id === 'xai' ? 'vendor' : 'account');
      await assert.rejects(runtime.adapter.listModels(vendor.route), { code: 'MODEL_CATALOG_FAILED' });
      await assert.rejects(runtime.adapter.resolveModel(vendor.route, vendor.model), { code: 'MODEL_CATALOG_FAILED' });
      await assert.rejects(runtime.adapter.prepareCall(vendor.route, vendor.model), { code: 'MODEL_CATALOG_FAILED' });
      await assert.rejects(Array.fromAsync(runtime.adapter.stream(optionsFor(vendor))), { code: 'MODEL_CATALOG_FAILED' });
      assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC-UPSTREAM-SECRET|SYNTHETIC-/);
      assert.equal(calls().length, 1, 'cached failure must not retry or fall back to a paid/inference route');
      metadata(vendor.id, { only: true });
      assert.deepEqual(await runtime.tool.execute({ action: 'models', provider: vendor.id }, exec), { ok: true });
      const recovered = (await runtime.tool.execute({ action: 'status' }, exec)).providers.find(item => item.id === vendor.id);
      assert.deepEqual(recovered.models.map(item => item.id), [vendor.model]);
      assert.deepEqual((await runtime.adapter.listModels(vendor.route)).map(item => item.id), [vendor.model]);
      if (vendor.id !== 'openai-codex') {
        const removed = vendor.id === 'kimi-coding' ? 'k3.1-pro-highspeed' : 'grok-4.7';
        await assert.rejects(runtime.adapter.resolveModel(vendor.route, removed), { code: 'UNKNOWN_MODEL' });
        await assert.rejects(runtime.adapter.prepareCall(vendor.route, removed), { code: 'UNKNOWN_MODEL' });
      }
      agent.assertNoPendingInterceptors();
    });
    await t.test('missing OAuth and stored paid keys cannot use ambient or caller credentials for any vendor', async () => {
      agent.clearCallHistory();
      const isolated = await mount();
      for (const vendor of vendors) for (const record of [undefined, { kind: 'api-key', key: 'SYNTHETIC-STORED-PAID' }]) {
        if (record) isolated.records.set(native.recordKeyFor(vendor.id), record);
        else isolated.records.delete(native.recordKeyFor(vendor.id));
        assert.deepEqual(await isolated.adapter.listModels(vendor.route), []);
        await assert.rejects(isolated.adapter.resolveModel(vendor.route, vendor.model), { code: 'MISSING_CREDENTIAL' });
        await assert.rejects(isolated.adapter.prepareCall(vendor.route, vendor.model), { code: 'MISSING_CREDENTIAL' });
        await assert.rejects(Array.fromAsync(isolated.adapter.stream(optionsFor(vendor))), { code: 'MISSING_CREDENTIAL' });
        assert.equal((await isolated.tool.execute({ action: 'test', provider: vendor.id, model: vendor.model }, exec)).error, 'MISSING_CREDENTIAL');
      }
      assert.deepEqual(calls(), []);
    });
    await t.test('all three native OAuth resolvers rotate shared expired grants before metadata and inference', async () => {
      agent.clearCallHistory();
      const refreshBodies = new Map();
      const endpoints = [['openai-codex', 'https://auth.openai.com', '/oauth/token'],
        ['kimi-coding', 'https://auth.kimi.com', '/api/oauth/token'], ['xai', 'https://auth.x.ai', '/oauth2/token']];
      for (const [id, origin, path] of endpoints) {
        agent.get(origin).intercept({ method: 'POST', path }).reply(200, async ({ body }) => {
          refreshBodies.set(id, new URLSearchParams(await new Response(body).text()));
          return { access_token: accessFor(id, '-ROTATED'), refresh_token: `SYNTHETIC-ROTATED-REFRESH-${id}`, expires_in: 3600 };
        }, { headers: { 'content-type': 'application/json' } });
        metadata(id, { access: accessFor(id, '-ROTATED') });
      }
      const refreshed = await mount({ ids: vendors.map(vendor => vendor.id), expired: true });
      for (const vendor of vendors) {
        const record = refreshed.records.get(native.recordKeyFor(vendor.id));
        assert.equal(record.payload.access, accessFor(vendor.id, '-ROTATED'));
        assert.equal(record.payload.refresh, `SYNTHETIC-ROTATED-REFRESH-${vendor.id}`);
        assert.ok(record.payload.expires > Date.now());
        assert.equal(refreshBodies.get(vendor.id)?.get('grant_type'), 'refresh_token');
        assert.equal(refreshBodies.get(vendor.id)?.get('refresh_token'), `SYNTHETIC-REFRESH-${vendor.id}`);
        const captured = [];
        inference(vendor, captured, { access: accessFor(vendor.id, '-ROTATED') });
        await successful(refreshed.adapter.stream(optionsFor(vendor)));
        assert.equal(captured[0].bearer, `Bearer ${accessFor(vendor.id, '-ROTATED')}`);
      }
      assert.equal(calls().filter(([method, origin]) => method === 'POST' && origin.startsWith('https://auth.')).length, 3);
      agent.assertNoPendingInterceptors();
    });
    await t.test('disabled Datasource and X Search gates never read credentials or make HTTP requests', async () => {
      agent.clearCallHistory();
      const gated = await mount();
      gated.records.set(native.recordKeyFor('kimi-coding'), { kind: 'grant', payload: {
        type: 'oauth', access: 'SYNTHETIC-EXPIRED', refresh: 'SYNTHETIC-REFRESH', expires: 0,
      } });
      gated.credentials.readRecord = gated.credentials.modifyRecord = () => assert.fail('Disabled vendor tools must not touch credentials');
      for (const name of ['kimi_get_data_source_desc', 'kimi_call_data_source_tool']) {
        assert.deepEqual(await gated.tools.get(name).execute({}, exec), { error: 'KIMI_DATASOURCE_DISABLED' });
      }
      assert.deepEqual(await gated.tools.get('grok_x_search').execute({}, exec), { error: 'GROK_X_SEARCH_DISABLED' });
      assert.deepEqual(calls(), []);
    });
    await t.test('Datasource opt-in status permits metadata GETs but never probes paid tools or model inference', async () => {
      agent.clearCallHistory();
      const { apply } = await import('../index.js');
      await assert.rejects(apply({}, { kimiDatasource: 'true' }), /kimiDatasource must be a boolean/);
      metadata('kimi-coding');
      const enabled = await mount({ ids: ['kimi-coding'], config: { kimiDatasource: true } });
      const state = await enabled.tool.execute({ action: 'status' }, exec);
      assert.deepEqual(state.vendorTools.kimiDatasource, { enabled: true, reason: null });
      const settings = await enabled.settingsFetch(new Request('http://dsh.internal/api/subscriptions-lite'));
      assert.equal(settings.status, 200);
      assert.deepEqual((await settings.json()).vendorTools, state.vendorTools);
      assert.deepEqual(calls(), [['GET', 'https://api.kimi.com', '/coding/v1/models']]);
      let requestBody;
      agent.get('https://api.kimi.com').intercept({ method: 'POST', path: '/coding/v1/tools',
        headers: { authorization: `Bearer ${accessFor('kimi-coding')}` } }).reply(200, async ({ body }) => {
        requestBody = JSON.parse(await new Response(body).text()); return JSON.stringify('Synthetic source documentation');
      }, { headers: { 'content-type': 'application/json' } });
      const result = await enabled.tools.get('kimi_get_data_source_desc').execute({ name: 'world_bank_open_data' }, exec);
      assert.equal(result.text, 'Synthetic source documentation'); assert.equal(enabled.saved.length, 1);
      assert.deepEqual(requestBody, { method: 'get_data_source_desc', params: { name: 'world_bank_open_data' } });
      assert.deepEqual(inferenceCalls(), [['POST', 'https://api.kimi.com', '/coding/v1/tools']]);
      agent.assertNoPendingInterceptors();
    });
    await t.test('X Search opt-in refreshes OAuth for metadata but sends an X-only request only on explicit execution', async () => {
      agent.clearCallHistory();
      const { apply } = await import('../index.js');
      await assert.rejects(apply({}, { grokXSearch: 'true' }), /grokXSearch must be a boolean/);
      agent.get('https://auth.x.ai').intercept({ method: 'POST', path: '/oauth2/token' }).reply(200, {
        access_token: accessFor('xai', '-ROTATED'), refresh_token: 'SYNTHETIC-SEARCH-ROTATED-REFRESH', expires_in: 3600,
      }, { headers: { 'content-type': 'application/json' } });
      metadata('xai', { access: accessFor('xai', '-ROTATED') });
      const enabled = await mount({ ids: ['xai'], expired: true, config: { grokXSearch: true } });
      assert.deepEqual((await enabled.tool.execute({ action: 'status' }, exec)).vendorTools.grokXSearch, { enabled: true, reason: null });
      assert.deepEqual(inferenceCalls(), [], 'status may fetch metadata, never execute X Search');
      assert.deepEqual(calls(), [['POST', 'https://auth.x.ai', '/oauth2/token'],
        ['GET', 'https://api.x.ai', '/v1/models'], ['GET', 'https://api.x.ai', '/v1/language-models']]);
      let body;
      agent.get('https://api.x.ai').intercept({ method: 'POST', path: '/v1/responses',
        headers: { authorization: `Bearer ${accessFor('xai', '-ROTATED')}` } }).reply(200, async request => {
        body = JSON.parse(await new Response(request.body).text());
        return { status: 'completed', output: [{ type: 'custom_tool_call', name: 'x_keyword_search' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic X result',
            annotations: [{ type: 'url_citation', url: 'https://x.com/xai/status/123' }] }] }] };
      }, { headers: { 'content-type': 'application/json' } });
      const result = await enabled.tools.get('grok_x_search').execute({ query: 'Synthetic X query', max_turns: 1 }, exec);
      assert.equal(result.text, 'Synthetic X result', JSON.stringify(result));
      assert.deepEqual(result.citations, ['https://x.com/xai/status/123']); assert.equal(enabled.saved.length, 1);
      assert.equal(body.tool_choice, 'required');
      assert.deepEqual(body.tools, [{ type: 'x_search', enable_image_understanding: false, enable_video_understanding: false }]);
      assert.equal(body.store, false); assert.equal(body.stream, false);
      assert.doesNotMatch(JSON.stringify(body), /SYNTHETIC-AMBIENT-PAID/);
      assert.deepEqual(inferenceCalls(), [['POST', 'https://api.x.ai', '/v1/responses']]);
      agent.assertNoPendingInterceptors();
    });
    for (const status of [401, 403, 429]) await t.test(`Grok inference HTTP ${status} is sanitized without retry or paid fallback`, async () => {
      agent.clearCallHistory();
      agent.get('https://api.x.ai').intercept({ method: 'POST', path: '/v1/responses',
        headers: { authorization: `Bearer ${accessFor('xai')}` } })
        .reply(status, { error: { message: 'SYNTHETIC-SECRET SYNTHETIC-CALLER-PAID upstream diagnostic' } },
          { headers: { 'content-type': 'application/json' } });
      assert.deepEqual(await runtime.tool.execute({ action: 'test', provider: 'xai', model: vendors[2].model }, exec), {
        error: 'TEST_FAILED', message: 'The subscription operation did not complete. Check authorization and retry.',
      });
      assert.deepEqual(calls(), [['POST', 'https://api.x.ai', '/v1/responses']]);
      agent.assertNoPendingInterceptors();
    });
    agent.assertNoPendingInterceptors();
  } finally {
    for (const close of dispose.reverse()) await close();
    hooks.deregister(); undici.setGlobalDispatcher(previous);
    await agent.close();
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
