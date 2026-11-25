import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createHttpHandler, fail, PROVIDERS } from './core.js';
import { createSpeedSelections } from './speed.js';

// Use the host's existing storage/validation packages, not a second installation.
export async function createSpeedHost(ctx, { adapterUrl, modelFor, displayModelFor, isConversation }) {
  const require = createRequire(adapterUrl);
  const { defineDomain, domainTable } = await import(require.resolve('@deepseek-ai/dsh-storage-domain'));
  const { z } = await import(require.resolve('zod'));
  const choice = z.object({ provider: z.string().max(200), model: z.string().max(200), tier: z.string().max(64), account: z.string().max(64).optional() }).strict();
  const domain = await ctx.storageDomain.open(defineDomain({ name: 'dk_subscription_speed', version: 1, layout: 'per-record',
    tables: { sessions: domainTable(z.object({ sessionId: z.string().max(200), choices: z.array(choice).max(1000) }).strict()) },
  }));
  ctx.effect(() => () => domain.close());
  const table = domain.table('sessions');
  const key = id => createHash('sha256').update(id).digest('hex');
  // Remembered tier lives in the same table under a reserved id, so the domain
  // schema stays v1 and per-session records keep their exact shape.
  const lastId = provider => `dk-dsh-subscriptions:speed-last:${provider}`;
  // Process-local, tuple-specific view token; never expose the durable consent key.
  const viewKey = randomBytes(32);
  const selections = createSpeedSelections({
    viewScope: ({ sessionId, provider, model }, account) => createHmac('sha256', viewKey)
      .update(JSON.stringify([sessionId, provider, model, account])).digest('base64url'),
    read(id) { const value = table.get(key(id)); return value?.sessionId === id ? value : undefined; },
    write: (id, value) => table.put(key(id), { sessionId: id, ...value }),
    readLast(provider) { return table.get(key(lastId(provider)))?.choices?.[0]; },
    writeLast: (provider, value) => table.put(key(lastId(provider)), {
      sessionId: lastId(provider), choices: [{ provider, ...value }],
    }),
    sessionExists: id => !!ctx.agents.get(id), modelFor, displayModelFor,
    validateSelection: input => route(input),
  });
  const requestContext = new AsyncLocalStorage();
  ctx.on('llm/stream', (options, next) => {
    const context = { sessionId: options.sessionId, provider: options.provider, model: options.model,
      conversation: isConversation(options) };
    const run = fn => requestContext.run(context, fn);
    const stream = run(next)[Symbol.asyncIterator]();
    return { [Symbol.asyncIterator]() { return this; },
      next: value => run(() => stream.next(value)),
      return: value => run(() => stream.return?.(value) ?? Promise.resolve({ done: true, value })),
      throw: error => run(() => stream.throw ? stream.throw(error) : Promise.reject(error)),
    };
  });
  ctx.on('agent/pre-step', async ({ agent, modelSelection, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'reject' && !signal.aborted) {
      if (PROVIDERS.some(provider => provider.route === modelSelection.provider)) await selections.beginStep(agent.session.id, modelSelection, signal);
      else selections.endSession(agent.session.id);
    }
    return decision;
  });
  ctx.on('agent/disposed', ({ agent }) => selections.endSession(agent.session.id));
  const route = input => {
    const current = ctx.agents.get(input.sessionId)?.model.current();
    if (!current || current.provider !== input.provider || current.model !== input.model) fail('SPEED_MODEL_CHANGED');
  };
  // Exact Connection routes are authenticated and owner-only. Reuse the same
  // Origin/JSON/custom-header guard as credential mutations, without a tool API.
  const handler = createHttpHandler({
    status: () => { fail('INVALID_REQUEST'); },
    async speedState(input, signal) { route(input); return selections.state(input, signal); },
    async speedSelect(input, signal) { route(input); return selections.select(input, signal); },
  });
  ctx.connection.fetch.register({ path: '/api/subscriptions-lite/speed', methods: ['POST'], requestBody: 'buffered', fetch: handler });
  return { ...selections, capture(options, model) {
    const context = requestContext.getStore();
    const matches = context?.sessionId === options.sessionId && context?.provider === options.provider && context?.model === options.model;
    return selections.capture({ ...options, conversation: matches ? context.conversation : isConversation(options) }, model);
  } };
}
