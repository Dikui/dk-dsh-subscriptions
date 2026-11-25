import { createRequire, findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PiAiAdapter, recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { createHttpHandler, createSubscriptions, fail, PROVIDERS, subscriptionBindings } from './core.js';
import { createAutoProxy } from './network.js';
import { createAccountModels, createAccountQuota } from './models.js';
import { accountQuotaSources, opencodeGoQuotaSource } from './quota-sources.js';
import { accountModelSources, speedAccountOf } from './model-sources.js';
import { registerVendorSkills } from './vendor-skills.js';
import { createSpeedHost } from './speed-host.js';
import { modelSpeed, withSpeedPayload } from './speed.js';
import packageInfo from './package.json' with { type: 'json' };

export const name = 'dk-dsh-subscriptions';
export const inject = ['authorization', 'credentials', 'llm', 'connection'];

export async function apply(ctx, { kimiDatasource = false, grokXSearch = false, opencodeGoQuota = false,
  opencodeApiKeyRef = 'OPENCODE_GO_API_KEY' } = {}) {
  if (typeof kimiDatasource !== 'boolean') throw new TypeError('kimiDatasource must be a boolean.');
  if (typeof grokXSearch !== 'boolean') throw new TypeError('grokXSearch must be a boolean.');
  if (typeof opencodeGoQuota !== 'boolean') throw new TypeError('opencodeGoQuota must be a boolean.');
  if (typeof opencodeApiKeyRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(opencodeApiKeyRef)) {
    throw new TypeError('opencodeApiKeyRef must be an environment variable name.');
  }
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
  const accountModels = new Map(), accountQuotas = new Map();
  const readOpencodeKey = async signal => {
    if (!opencodeGoQuota) return undefined;
    signal?.throwIfAborted();
    try {
      const resolved = await ctx.credentials.resolve(opencodeApiKeyRef);
      return typeof resolved?.value === 'string' && resolved.value ? resolved.value : undefined;
    } catch { return undefined; }
  };
  if (opencodeGoQuota) {
    accountQuotas.set('opencode-go', createAccountQuota(opencodeGoQuotaSource({
      readKey: readOpencodeKey,
      fetchCatalog: (url, options) => network.run(() => fetch(url, options)),
    })));
  }
  const authModels = createModels(bindings.auth);
  for (const profile of bindings.profiles().values()) authModels.setProvider(profile.piProvider);
  for (const provider of PROVIDERS) {
    const source = accountModelSources.get(provider.id);
    if (!bindings.profiles().has(provider.route)) continue;
    const native = catalog.find(item => item.id === provider.id);
    const quotaSource = accountQuotaSources.get(provider.id);
    if (quotaSource) accountQuotas.set(provider.id, createAccountQuota(quotaSource({
      readCredential: signal => bindings.auth.credentials.read(provider.route, { signal }),
      getAuth: signal => network.run(() => authModels.getAuth(provider.route, { signal })),
      fetchCatalog: (url, options) => network.run(() => fetch(url, options)),
    })));
    if (!source) {
      accountModels.set(provider.id, null);
      native.getModels = native.getAllModels = () => [];
      continue;
    }
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
    const models = modelsForRoute(provider);
    if (!models) fail('MODEL_CATALOG_UNAVAILABLE');
    await models.ensure({ signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
  }
  class SubscriptionAdapter extends PiAiAdapter {
    modelInfo(snapshot, provider, model) {
      const info = super.modelInfo(snapshot, provider, model);
      const defaultEffort = this.modelOf(snapshot, provider, model).defaultReasoningEffort;
      if (info.reasoning && !info.reasoning.defaultEffort && info.reasoning.efforts.some(effort => effort.id === defaultEffort)) {
        return { ...info, reasoning: { ...info.reasoning, defaultEffort } };
      }
      return info;
    }
    async *streamWithSnapshot(options, snapshot) {
      const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
      await ensureAccountModels(options.provider, signal);
      const models = modelsForRoute(options.provider);
      const live = models.getModels().find(model => model.id === options.model);
      if (!live) fail('UNKNOWN_MODEL');
      const descriptor = this.modelOf(snapshot, options.provider, options.model);
      // Authorize Speed from the current catalog, never the prepared snapshot.
      // The prepared descriptor still owns reasoning, context and transport.
      const tier = speedSelections?.capture(options, { ...live, provider: options.provider });
      if (tier !== undefined) {
        // A request-owned provider preserves the exact prepared descriptor and
        // hook. Never mutate the shared profile or another concurrent request.
        const profile = this.profileOf(snapshot, options.provider).piProvider;
        const requestModels = createModels(bindings.auth);
        requestModels.setProvider({ ...profile, getModels: () => [descriptor], getAllModels: () => [descriptor],
          streamSimple: (model, context, nativeOptions) => profile.streamSimple(model, context, withSpeedPayload(nativeOptions, tier, async () => {
            // pi-ai may have waited on attachments or rotated OAuth after entry.
            // Before adding a billable field, fence the actual bearer and canonical tier.
            await models.ensure({ signal: nativeOptions.signal });
            const grant = await bindings.auth.credentials.read(options.provider, { signal: nativeOptions.signal });
            const bearer = nativeOptions.apiKey ?? new Headers(nativeOptions.headers).get('authorization')?.replace(/^Bearer\s+/i, '');
            if (!grant || grant.access !== bearer || speedAccountOf(grant) !== live.speedAccount) fail('SPEED_MODEL_CHANGED');
            const current = models.getModels().find(item => item.id === options.model);
            if (!current || current.speedAccount !== live.speedAccount) fail('SPEED_MODEL_CHANGED');
            if (!modelSpeed({ ...current, provider: options.provider }).tiers.some(item => item.id === tier)) fail('UNSUPPORTED_SPEED');
          })),
        });
        snapshot = { ...snapshot, models: requestModels };
      }
      const reasoningEffort = options.reasoningEffort ?? descriptor.defaultReasoningEffort;
      yield* network.wrap(super.streamWithSnapshot({ ...options, ...(reasoningEffort ? { reasoningEffort } : {}), signal }, snapshot));
    }
    async listModels(provider) {
      if (lifetime.signal.aborted) return [];
      // Only this plugin's own routes are answered here; never a native static directory.
      if (!PROVIDERS.some(item => item.route === provider)) return [];
      const models = modelsForRoute(provider);
      // A supported route without a configured model source fails closed.
      if (!models) fail('MODEL_CATALOG_UNAVAILABLE');
      // The picker and the settings list are display reads: they answer from the display
      // validated for the current grant (or nothing) and never wait for an upstream refresh.
      // A cold read starts one background load that is announced through emitAdaptersUpdated.
      const view = await models.observe();
      if (view.failure) fail(view.failure);
      if (view.missing) return [];
      if (view.state === 'error' && view.error) fail(view.error);
      // Project the validated display directly. Reading the credential again here could
      // observe a newer grant while these descriptors still belong to the previous one.
      return view.models.map(model => ({ provider, id: model.id, name: model.name,
        inputModalities: [...(model.input ?? [])] }));
    }
    async resolveModel(provider, model, signal) {
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      signal.throwIfAborted();
      const models = modelsForRoute(provider);
      // A supported route without a configured model source must not resolve the SDK's
      // static directory; unknown routes keep the native adapter's own answer.
      if (!models && PROVIDERS.some(item => item.route === provider)) fail('MODEL_CATALOG_UNAVAILABLE');
      if (models) {
        // Selecting a model also stays display-first; only prepareCall/stream authorize it.
        const view = await models.observe({ signal });
        if (view.failure) fail(view.failure);
        if (view.missing) fail('MISSING_CREDENTIAL');
        if (view.state === 'error' && view.error) fail(view.error);
        // A remembered id may only resolve from a collection validated for the current
        // grant (the adapter's baseline contract). A ready collection answers instantly,
        // even while it refreshes; anything else waits for that grant's own catalog.
        if (!view.current) await ensureAccountModels(provider, signal);
      }
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
        return adapter.modelOf(adapter.current(), provider, model);
      },
      displayModelFor: async (provider, model, signal) => {
        const models = modelsForRoute(provider);
        if (!models) fail('MODEL_CATALOG_UNAVAILABLE');
        signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
        const view = await models.observe({ signal });
        if (view.failure || view.error || view.missing) fail(view.failure ?? view.error ?? 'MISSING_CREDENTIAL');
        if (!view.current) await models.ensure({ signal });
        const descriptor = (view.current ? view.models : models.getModels()).find(item => item.id === model);
        if (!descriptor) fail('UNKNOWN_MODEL');
        return { ...descriptor, provider };
      },
    });
    scope.effect(() => {
      speedSelections = selections;
      return () => { if (speedSelections === selections) speedSelections = undefined; };
    });
  });
  const routes = [...bindings.profiles().keys()];
  if (routes.length) ctx.llm.registerAdapter(routes, adapter);
  const vendorTools = await registerVendorSkills(ctx, { kimiDatasource, grokXSearch, adapterUrl,
    version: packageInfo.version, signal: lifetime.signal,
    getAuth: (route, signal) => network.run(() => authModels.getAuth(route, { signal })),
    fetchTool: (url, options) => network.run(() => fetch(url, options)),
    attachments: () => ctx.get('attachments'),
  });
  api = createSubscriptions({ authorization: {
    describe: key => ctx.authorization.describe(key),
    begin: request => network.run(() => ctx.authorization.begin(request)),
  }, credentials: ctx.credentials, llm: ctx.llm, catalog, keyFor: recordKeyFor, accountModels, accountQuotas,
    readQuotaKey: (id, signal) => id === 'opencode-go' ? readOpencodeKey(signal) : undefined,
    vendorTools });
  // Startup warmup is a single lifetime-owned metadata operation, not a timer.
  // Deliberately not awaited: a slow catalog endpoint would otherwise delay the
  // whole plugin load, and the picker refreshes when the catalog arrives.
  void api.status(lifetime.signal).catch(() => {});
  ctx.connection.fetch.register({ path: '/api/subscriptions-lite', methods: ['GET', 'POST'],
    requestBody: 'buffered', fetch: createHttpHandler(api) });
}
