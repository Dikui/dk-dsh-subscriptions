import { createRequire, findPackageJSON } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PiAiAdapter, recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { createHttpHandler, createSubscriptions, fail, PROVIDERS, safeError, subscriptionBindings } from './core.js';
import { createAutoProxy } from './network.js';
import { createAccountModels } from './models.js';
import { accountModelSources } from './model-sources.js';
import { createKimiTools } from './kimi-tools.js';
import { createGrokSearchTool } from './grok-tools.js';
import { createSpeedHost } from './speed-host.js';
import { withSpeedPayload } from './speed.js';
import packageInfo from './package.json' with { type: 'json' };

export const name = 'dk-subscriptions';
export const inject = ['authorization', 'credentials', 'llm', 'connection', 'tools'];

export async function apply(ctx, { kimiDatasource = false, grokXSearch = false } = {}) {
  if (typeof kimiDatasource !== 'boolean') throw new TypeError('kimiDatasource must be a boolean.');
  if (typeof grokXSearch !== 'boolean') throw new TypeError('grokXSearch must be a boolean.');
  const kimiDatasourceStatus = Object.freeze({ enabled: kimiDatasource, reason: kimiDatasource ? null : 'NOT_ENABLED' });
  const grokXSearchStatus = Object.freeze({ enabled: grokXSearch, reason: grokXSearch ? null : 'NOT_ENABLED' });
  // Resolve the exact pi-ai version shipped with the official adapter, not a
  // second transport/auth installation or a package copied into this bundle.
  const require = createRequire(import.meta.url);
  const adapterUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai'));
  const piManifest = findPackageJSON('@earendil-works/pi-ai', adapterUrl);
  if (!piManifest) throw new Error('The official adapter’s pi-ai installation is unavailable.');
  const { builtinProviders } = await import(new URL('./dist/providers/all.js', pathToFileURL(piManifest)).href);
  const { createModels } = await import(new URL('./dist/models.js', pathToFileURL(piManifest)).href);
  const { default: piPackage } = await import(pathToFileURL(piManifest).href, { with: { type: 'json' } });
  const { isAgentLoopRequest } = await import(createRequire(adapterUrl).resolve('@deepseek-ai/dsh-llm'));
  const catalog = builtinProviders();
  let speedSelections;
  const network = await createAutoProxy(() => createRequire(adapterUrl)('undici'));
  const lifetime = new AbortController();
  let api;
  ctx.effect(() => () => {
    lifetime.abort();
    api?.dispose();
    return network.dispose();
  });
  const bindings = subscriptionBindings(ctx.credentials, catalog, recordKeyFor);
  // Pin HTTPS SSE while automatic proxying is active; do not rely on WebSocket routing.
  const codex = bindings.profiles().get('subscription-openai-codex');
  if (network.enabled && codex) codex.transport = 'sse';
  const accountModels = new Map();
  const authModels = createModels(bindings.auth);
  for (const profile of bindings.profiles().values()) authModels.setProvider(profile.piProvider);
  for (const provider of PROVIDERS) {
    const source = accountModelSources.get(provider.id);
    if (!source || !bindings.profiles().has(provider.route)) continue;
    const native = catalog.find(item => item.id === provider.id);
    const models = createAccountModels({ ...source({ baseModels: native.getModels(), clientVersion: piPackage.version,
      readCredential: signal => bindings.auth.credentials.read(provider.route, { signal }),
      getAuth: signal => network.run(() => authModels.getAuth(provider.route, { signal })),
      fetchCatalog: (url, options) => network.run(() => fetch(url, options)),
    }), onChange: () => ctx.llm.emitAdaptersUpdated() });
    accountModels.set(provider.id, models);
    // One registered source feeds settings, resolution and streams for this vendor.
    native.getModels = models.getModels;
    native.getAllModels = models.getModels;
  }
  const modelsForRoute = route => accountModels.get(PROVIDERS.find(provider => provider.route === route)?.id);
  async function ensureAccountModels(provider, signal) {
    await modelsForRoute(provider)?.ensure({ signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
  }
  async function scopedSpeedModel(provider, descriptor) {
    const credential = await bindings.auth.credentials.read(provider);
    if (!credential) fail('MISSING_CREDENTIAL');
    const identity = credential.accountId ?? credential.subject ?? credential.refresh ?? credential.access;
    const speedAccount = createHash('sha256').update(`dk-subscriptions:speed:${identity}`).digest('hex');
    return { ...descriptor, speedAccount };
  }
  class SubscriptionAdapter extends PiAiAdapter {
    async *streamWithSnapshot(options, snapshot) {
      const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
      await ensureAccountModels(options.provider, signal);
      const models = modelsForRoute(options.provider);
      if (models && !models.getModels().some(model => model.id === options.model)) fail('UNKNOWN_MODEL');
      let descriptor = this.modelOf(snapshot, options.provider, options.model);
      // A prepared descriptor may outlive an account switch. Use the current
      // account scope when matching saved consumption consent, not the old one.
      if (speedSelections) descriptor = await scopedSpeedModel(options.provider, descriptor);
      const tier = speedSelections?.capture(options, descriptor);
      if (tier !== undefined) {
        // A request-owned provider preserves the exact prepared descriptor and
        // hook. Never mutate the shared profile or another concurrent request.
        const profile = this.profileOf(snapshot, options.provider).piProvider;
        const requestModels = createModels(bindings.auth);
        requestModels.setProvider({ ...profile, getModels: () => [descriptor], getAllModels: () => [descriptor],
          streamSimple: (model, context, nativeOptions) => profile.streamSimple(model, context, withSpeedPayload(nativeOptions, tier)),
        });
        snapshot = { ...snapshot, models: requestModels };
      }
      yield* network.wrap(super.streamWithSnapshot({ ...options, signal }, snapshot));
    }
    async listModels(provider) {
      if (!await bindings.auth.credentials.read(provider)) {
        modelsForRoute(provider)?.clear();
        return [];
      }
      await ensureAccountModels(provider);
      return super.listModels(provider);
    }
    async resolveModel(provider, model, signal) {
      await ensureAccountModels(provider, signal);
      return super.resolveModel(provider, model, signal);
    }
    async prepareCall(provider, model, signal) {
      await ensureAccountModels(provider, signal);
      if (!modelsForRoute(provider)) return super.prepareCall(provider, model, signal);
      const snapshot = this.current();
      const descriptor = this.modelOf(snapshot, provider, model);
      // Keep the descriptor validated by the caller, even if metadata refreshes before streaming.
      const frozen = createModels(bindings.auth);
      frozen.setProvider({ ...this.profileOf(snapshot, provider).piProvider,
        getModels: () => [descriptor], getAllModels: () => [descriptor] });
      const captured = { ...snapshot, models: frozen };
      return { model: this.modelInfo(captured, provider, model), stream: options => this.streamWithSnapshot(options, captured) };
    }
  }
  const adapter = new SubscriptionAdapter({ ...bindings, resolveAttachments: () => ctx.get('attachments') });
  await ctx.inject?.(['agents', 'storageDomain'], async scope => {
    const selections = await createSpeedHost(scope, { adapterUrl, isConversation: isAgentLoopRequest,
      modelFor: async (provider, model, signal) => {
        await ensureAccountModels(provider, signal);
        return scopedSpeedModel(provider, adapter.modelOf(adapter.current(), provider, model));
      },
    });
    scope.effect(() => {
      speedSelections = selections;
      return () => { if (speedSelections === selections) speedSelections = undefined; };
    });
  });
  const routes = [...bindings.profiles().keys()];
  if (routes.length) ctx.llm.registerAdapter(routes, adapter);
  api = createSubscriptions({ authorization: {
    describe: key => ctx.authorization.describe(key),
    begin: request => network.run(() => ctx.authorization.begin(request)),
  }, credentials: ctx.credentials, llm: ctx.llm, catalog, keyFor: recordKeyFor, accountModels,
    vendorTools: { kimiDatasource: kimiDatasourceStatus, grokXSearch: grokXSearchStatus } });
  ctx.connection.fetch.register({ path: '/api/subscriptions-lite', methods: ['GET', 'POST'],
    requestBody: 'buffered', fetch: createHttpHandler(api) });
  ctx.tools.register({
    name: 'subscription_accounts',
    description: 'Inspect subscription status and account model metadata, refresh a supported provider’s account model list, test a selected model, or clear local OAuth secrets. Status may refresh registered account model sources using official subscription credentials, but never sends inference. Never starts or completes login: the user authorizes in Settings → dk-subscriptions. Tests consume quota and Grok may incur server-side extra charges; no API-key fallback. Providers without a registered account source, including Grok, are explicitly labeled SDK-local; this is not verified account access or a subscription-only billing guarantee. Logout also signs out the shared official pi-ai route, without cancelling a plan or revoking the account remotely.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['status', 'models', 'test', 'logout'], description: 'status may query account model metadata. models forces a registered provider’s metadata refresh; unsupported discovery is reported explicitly. Neither sends inference. test sends a small coding prompt. logout removes the shared local OAuth grant only.' },
        provider: { type: 'string', enum: PROVIDERS.map(p => p.id), description: 'Required for models, test and logout.' },
        model: { type: 'string', description: 'Required for test: exact model id from status.' },
      }, required: ['action'], additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 70000,
    async execute(args, exec) {
      try {
        if (args.action === 'status') {
          const result = await api.status(exec.signal);
          // OAuth codes/URLs and prompts belong only to the human interaction surface.
          return { network: network.status(), vendorTools: result.vendorTools,
            providers: result.providers.map(({ attempt, ...p }) => ({ ...p, loginState: attempt?.state ?? null })) };
        }
        if (args.action === 'models') return await api.refreshModels(args.provider, exec.signal);
        if (args.action === 'test') return await api.test(args.provider, args.model, exec.signal);
        if (args.action === 'logout') return await api.logout(args.provider);
        return { error: 'INVALID_ACTION' };
      } catch (error) { return safeError(error); }
    },
  });
  for (const tool of createKimiTools({
    enabled: kimiDatasourceStatus.enabled, version: packageInfo.version, signal: lifetime.signal,
    getAuth: signal => network.run(() => authModels.getAuth('subscription-kimi-coding', { signal })),
    fetchTool: (url, options) => network.run(() => fetch(url, options)),
    attachments: () => ctx.get('attachments'),
  })) ctx.tools.register(tool);
  ctx.tools.register(createGrokSearchTool({
    enabled: grokXSearchStatus.enabled, signal: lifetime.signal,
    getAuth: signal => network.run(() => authModels.getAuth('subscription-xai', { signal })),
    fetchTool: (url, options) => network.run(() => fetch(url, options)),
    attachments: () => ctx.get('attachments'),
  }));
}
