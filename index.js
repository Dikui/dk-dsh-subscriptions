import { createRequire, findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PiAiAdapter, recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { createHttpHandler, createSubscriptions, PROVIDERS, safeError, subscriptionBindings } from './core.js';

export const name = 'dsh-dk-subscriptions';
export const inject = ['authorization', 'credentials', 'llm', 'connection', 'tools'];

export async function apply(ctx) {
  // Resolve the exact pi-ai version shipped with the official adapter, not a
  // second transport/auth installation or a package copied into this bundle.
  const require = createRequire(import.meta.url);
  const adapterUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai'));
  const piManifest = findPackageJSON('@earendil-works/pi-ai', adapterUrl);
  if (!piManifest) throw new Error('The official adapter’s pi-ai installation is unavailable.');
  const { builtinProviders } = await import(new URL('./dist/providers/all.js', pathToFileURL(piManifest)).href);
  const catalog = builtinProviders();
  const bindings = subscriptionBindings(ctx.credentials, catalog, recordKeyFor);
  class SubscriptionAdapter extends PiAiAdapter {
    async listModels(provider) {
      if (!await bindings.auth.credentials.read(provider)) return [];
      return super.listModels(provider);
    }
  }
  const adapter = new SubscriptionAdapter({ ...bindings, resolveAttachments: () => ctx.get('attachments') });
  const routes = [...bindings.profiles().keys()];
  if (routes.length) ctx.llm.registerAdapter(routes, adapter);
  const api = createSubscriptions({ authorization: ctx.authorization, credentials: ctx.credentials,
    llm: ctx.llm, catalog, keyFor: recordKeyFor });
  ctx.on('dispose', () => api.dispose());
  ctx.connection.fetch.register({ path: '/api/subscriptions-lite', methods: ['GET', 'POST'],
    requestBody: 'buffered', fetch: createHttpHandler(api) });
  ctx.tools.register({
    name: 'subscription_accounts',
    description: 'Inspect subscription connection status, test a selected subscription model, or clear its local OAuth secrets. Never starts or completes login: the user authorizes in Settings → dsh-dk-subscriptions. Tests consume subscription quota; no API-key fallback. Grok direct connection is unavailable. Logout atomically replaces the shared OAuth grant with a secret-free signed-out marker, also signing out the official pi-ai route; it does not cancel a plan or revoke the account remotely.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['status', 'test', 'logout'], description: 'status is read-only. test sends a small coding prompt. logout removes the shared local OAuth grant only.' },
        provider: { type: 'string', enum: PROVIDERS.map(p => p.id), description: 'Required for test and logout.' },
        model: { type: 'string', description: 'Required for test: exact model id from status.' },
      }, required: ['action'], additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 70000,
    async execute(args, exec) {
      try {
        if (args.action === 'status') {
          const result = await api.status();
          // OAuth codes/URLs and prompts belong only to the human interaction surface.
          return { providers: result.providers.map(({ attempt, ...p }) => ({ ...p, loginState: attempt?.state ?? null })) };
        }
        if (args.action === 'test') return await api.test(args.provider, args.model, exec.signal);
        if (args.action === 'logout') return await api.logout(args.provider);
        return { error: 'INVALID_ACTION' };
      } catch (error) { return safeError(error); }
    },
  });
}
