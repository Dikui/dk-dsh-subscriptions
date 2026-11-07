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

// small/regression — real plugin apply + shipped adapter; all credentials are
// in memory, metadata uses MockAgent, inference is a throw-only fake transport.
test('registered model sources share native routes and freeze each vendor’s prepared descriptors', {
  skip: !undici || !module.registerHooks ? 'Set DSH_TEST_UNDICI and use the desktop Node runtime.' : false,
}, async () => {
  const previous = undici.getGlobalDispatcher();
  const env = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://synthetic-explicit-proxy.invalid:80'; // Leave automatic system discovery inactive.
  const agent = new undici.MockAgent();
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
    await apply({ credentials,
      on(event, callback) { assert.equal(event, 'dispose'); dispose.push(callback); }, get() {},
      authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }), begin: () => assert.fail('No login in metadata tests') },
      llm: { registerAdapter(_routes, value) { adapter = value; }, emitAdaptersUpdated() {}, stream: () => assert.fail('No inference in metadata tests') },
      connection: { fetch: { register() {} } }, tools: { register(value) { tool = value; } },
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
  }
});
