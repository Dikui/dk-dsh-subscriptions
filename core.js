import { randomUUID } from 'node:crypto';

export const PROVIDERS = Object.freeze([
  { id: 'openai-codex', name: 'OpenAI · ChatGPT', route: 'subscription-openai-codex' },
  { id: 'kimi-coding', name: 'Kimi Code', route: 'subscription-kimi-coding' },
  { id: 'xai', name: 'Grok', route: null },
]);

export class SubscriptionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function fail(code) { throw new SubscriptionError(code); }
export function safeError(error) {
  return { error: error instanceof SubscriptionError ? error.code : 'REQUEST_FAILED',
    message: 'The subscription operation did not complete. Check authorization and retry.' };
}
export function oauthRecord(record) {
  const grant = record?.kind === 'grant' ? record.payload : undefined;
  return grant?.type === 'oauth' && typeof grant.access === 'string' && grant.access.length > 0
    && Number.isFinite(grant.expires) ? grant : undefined;
}

// Only these two isolated routes can read the official adapter's OAuth records.
// There is deliberately no API-key handler, environment lookup or fallback route.
export function subscriptionBindings(credentials, catalog, keyFor) {
  const routes = new Map(PROVIDERS.filter(p => p.route).map(p => [p.route, p.id]));
  const key = route => keyFor(routes.get(route) ?? fail('UNKNOWN_PROVIDER'));
  const nativeContext = context => ({ ...context, messages: context.messages.map(message =>
    routes.has(message.provider) ? { ...message, provider: routes.get(message.provider) } : message) });
  const store = {
    async read(route, options) {
      options?.signal?.throwIfAborted();
      return oauthRecord(await credentials.readRecord(key(route)));
    },
    async modify(route, mutate, options) {
      options?.signal?.throwIfAborted();
      const result = await credentials.modifyRecord(key(route), async record => {
        options?.signal?.throwIfAborted();
        const current = oauthRecord(record);
        if (!current) return undefined; // Never resurrect a grant after logout.
        const next = await mutate(current);
        if (next === undefined) return undefined;
        if (!oauthRecord({ kind: 'grant', payload: next })) fail('INVALID_GRANT');
        return { kind: 'grant', payload: next };
      });
      return oauthRecord(result);
    },
  };
  const profiles = new Map();
  for (const p of PROVIDERS.filter(p => p.route)) {
    const native = catalog.find(provider => provider.id === p.id);
    if (!native?.auth?.oauth) continue;
    profiles.set(p.route, {
      displayName: `${p.name} · Subscription`,
      piProvider: {
        ...native, id: p.route, name: `${p.name} · Subscription`,
        auth: { oauth: native.auth.oauth },
        getModels: () => native.getModels().map(model => ({ ...model, provider: p.route })),
        getAllModels: () => native.getModels().map(model => ({ ...model, provider: p.route })),
        // Keep routing/auth isolated, but preserve native protocol identity for
        // provider-specific tool IDs and replay handling at the transport edge.
        stream: (model, context, options) => native.stream({ ...model, provider: p.id }, nativeContext(context), options),
        streamSimple: (model, context, options) => native.streamSimple({ ...model, provider: p.id }, nativeContext(context), options),
      },
      modelErrors: new Map(), configuredMaxTokens: new Map(),
      streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20971520,
      requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    });
  }
  return {
    profiles: () => profiles,
    auth: { credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } },
    async resolveApiKey(route) {
      if (!await store.read(route)) fail('MISSING_CREDENTIAL');
      return undefined;
    },
  };
}

function publicAttempt(attempt) {
  if (!attempt) return null;
  return { id: attempt.id, state: attempt.state, notices: attempt.notices,
    prompt: attempt.prompt?.view ?? null, ...(attempt.error ? { error: attempt.error } : {}) };
}
function safeNotice(notice) {
  const result = { message: String(notice.message ?? '').slice(0, 2000) };
  if (notice.code) result.code = String(notice.code).slice(0, 200);
  if (notice.url) {
    try {
      const url = new URL(notice.url);
      if (url.protocol === 'https:' && !url.username && !url.password) result.url = url.href;
    } catch { /* Invalid upstream links are never rendered. */ }
  }
  return result;
}

export function createSubscriptions({ authorization, credentials, llm, catalog, keyFor, timeoutMs = 15 * 60 * 1000 }) {
  const attempts = new Map();
  const tests = new Map();
  const loggingOut = new Set();
  const supported = new Set(catalog.filter(p => p.auth?.oauth).map(p => p.id));
  function provider(id) {
    const p = PROVIDERS.find(item => item.id === id);
    if (!p) fail('UNKNOWN_PROVIDER');
    if (!p.route || !supported.has(p.id)) fail('UNAVAILABLE');
    return p;
  }
  function active(id, attemptId) {
    const attempt = attempts.get(id);
    if (!attempt || attempt.id !== attemptId || attempt.state !== 'running') fail('STALE_ATTEMPT');
    return attempt;
  }
  function prompt(attempt, input) {
    if (attempt.controller.signal.aborted || input.signal?.aborted) return Promise.reject(new SubscriptionError('CANCELLED'));
    if (!['text', 'secret', 'select'].includes(input.kind)) return Promise.reject(new SubscriptionError('UNSUPPORTED_PROMPT'));
    if (input.kind === 'select' && (!Array.isArray(input.options) || !input.options.length
      || !input.options.every(option => typeof option?.id === 'string' && typeof option?.label === 'string'))) {
      return Promise.reject(new SubscriptionError('UNSUPPORTED_PROMPT'));
    }
    return new Promise((resolve, reject) => {
      const view = { id: randomUUID(), kind: input.kind, message: String(input.message ?? '').slice(0, 2000),
        placeholder: input.placeholder, ...(input.kind === 'select' ? { options: input.options } : {}) };
      const cleanup = () => {
        input.signal?.removeEventListener('abort', cancel);
        attempt.controller.signal.removeEventListener('abort', cancel);
        if (attempt.prompt?.view.id === view.id) attempt.prompt = null;
      };
      const cancel = () => { cleanup(); reject(new SubscriptionError('CANCELLED')); };
      attempt.prompt = { view, settle: value => { cleanup(); resolve(value); } };
      input.signal?.addEventListener('abort', cancel, { once: true });
      attempt.controller.signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async function status() {
    return { providers: await Promise.all(PROVIDERS.map(async p => {
      if (!p.route || !supported.has(p.id)) return { ...p, available: false, configured: false, credentialKind: null, models: [], attempt: null };
      const record = await credentials.readRecord(keyFor(p.id));
      const flow = authorization.describe(keyFor(p.id));
      return { ...p, available: !!flow?.methods.some(method => method.id === 'oauth'),
        configured: !!oauthRecord(record), credentialKind: record?.kind ?? null,
        models: catalog.find(item => item.id === p.id).getModels().map(({ id, name }) => ({ id, name })),
        attempt: publicAttempt(attempts.get(p.id)) };
    })) };
  }
  function login(id) {
    provider(id);
    const key = keyFor(id);
    const flow = authorization.describe(key);
    if (!flow?.methods.some(method => method.id === 'oauth')) fail('UNAVAILABLE');
    if (flow.inFlight || loggingOut.has(id) || attempts.get(id)?.state === 'running') fail('ALREADY_IN_FLIGHT');
    if (tests.has(id)) fail('TEST_IN_PROGRESS');
    const attempt = { id: randomUUID(), state: 'running', notices: [], prompt: null, controller: new AbortController() };
    attempts.set(id, attempt);
    const timer = setTimeout(() => attempt.controller.abort(), timeoutMs);
    timer.unref?.();
    attempt.done = Promise.resolve().then(() => authorization.begin({
      key, method: 'oauth', signal: attempt.controller.signal,
      interaction: {
        notify(notice) { if (!attempt.controller.signal.aborted) attempt.notices = [...attempt.notices.slice(-7), safeNotice(notice)]; },
        prompt: input => prompt(attempt, input),
      },
    })).then(outcome => {
      attempt.state = outcome.status === 'authorized' ? 'authorized' : 'cancelled';
    }).catch(error => {
      attempt.state = attempt.controller.signal.aborted ? 'cancelled' : 'failed';
      attempt.error = safeError(error).error;
    }).finally(() => { clearTimeout(timer); attempt.prompt = null; });
    return publicAttempt(attempt);
  }
  async function cancel(id, attemptId) {
    provider(id);
    const attempt = active(id, attemptId);
    attempt.controller.abort();
    await attempt.done;
    return { ok: true };
  }
  function answer(id, attemptId, promptId, value) {
    provider(id);
    const attempt = active(id, attemptId);
    if (!attempt.prompt || attempt.prompt.view.id !== promptId) fail('STALE_PROMPT');
    if (typeof value !== 'string' || value.length > 16384) fail('INVALID_ANSWER');
    const view = attempt.prompt.view;
    if (view.kind === 'select' && !view.options.some(option => option.id === value)) fail('INVALID_ANSWER');
    attempt.prompt.settle(value);
    return { ok: true };
  }
  async function logout(id) {
    provider(id);
    if (loggingOut.has(id)) fail('ALREADY_IN_FLIGHT');
    if (tests.has(id)) fail('TEST_IN_PROGRESS');
    loggingOut.add(id); // Reserve before the first await; do not orphan a newer login.
    const attempt = attempts.get(id);
    try {
      if (attempt?.state === 'running') await cancel(id, attempt.id);
      // The service has no conditional-delete primitive. Clear secrets under its
      // shared writer lock instead; a non-credential marker also blocks ambient
      // fallback in the official resolver. Never read-then-delete another writer.
      await credentials.modifyRecord(keyFor(id), record => {
        if (authorization.describe(keyFor(id))?.inFlight) fail('ALREADY_IN_FLIGHT');
        if (!record || (record.kind === 'grant' && record.payload?.type === 'subscription-revoked')) return undefined;
        if (!oauthRecord(record)) fail('NOT_SUBSCRIPTION_CREDENTIAL');
        return { kind: 'grant', payload: { type: 'subscription-revoked' } };
      });
      if (attempts.get(id) === attempt) attempts.delete(id);
      return { ok: true };
    } finally { loggingOut.delete(id); }
  }
  async function test(id, model, signal) {
    const p = provider(id);
    if (loggingOut.has(id) || attempts.get(id)?.state === 'running') fail('ALREADY_IN_FLIGHT');
    if (tests.has(id)) fail('TEST_IN_PROGRESS');
    const controller = new AbortController();
    tests.set(id, controller);
    try {
      if (!oauthRecord(await credentials.readRecord(keyFor(id)))) fail('MISSING_CREDENTIAL');
      const models = catalog.find(item => item.id === id).getModels();
      if (!models.some(item => item.id === model)) fail('UNKNOWN_MODEL');
      let text = '', finish;
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
      for await (const chunk of llm.stream({ provider: p.route, model, maxTokens: 256, signal: requestSignal,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Coding connection test: what does JavaScript String(1 + 1) return? Reply with just the result.' }] }] })) {
        if (chunk.type === 'text-delta') text = (text + chunk.text).slice(0, 2000);
        if (chunk.type === 'finish') finish = chunk.reason.kind;
      }
      if (!text || !['stop', 'max-tokens'].includes(finish)) fail('TEST_FAILED');
      return { ok: true, model, text };
    } finally { tests.delete(id); }
  }
  function dispose() {
    for (const attempt of attempts.values()) attempt.controller.abort();
    for (const controller of tests.values()) controller.abort();
  }
  return { status, login, answer, cancel, logout, test, dispose };
}

// Connection authenticates and validates the original HTTP authority before
// dispatch, but rewrites Request.url to http://dsh.internal. Retain its Host.
function sameAuthority(request, origin) {
  if (!origin) return true;
  try {
    const source = new URL(origin);
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false;
    const host = request.headers.get('host') ?? new URL(request.url).host;
    return new URL(`${source.protocol}//${host}`).host === source.host;
  } catch { return false; }
}

// The custom header also rejects browser form / cross-origin mutations.
export function createHttpHandler(api) {
  return async request => {
    const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
      if (request.method === 'GET') return json(await api.status());
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
      const origin = request.headers.get('origin');
      if (request.headers.get('x-subscriptions-lite') !== '1'
        || !request.headers.get('content-type')?.startsWith('application/json')
        || !sameAuthority(request, origin)) return json({ error: 'FORBIDDEN' }, 403);
      const raw = await request.text();
      if (raw.length > 20000) return json({ error: 'BODY_TOO_LARGE' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { fail('INVALID_REQUEST'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_REQUEST');
      const { action, provider, attemptId, promptId, value, model } = body;
      switch (action) {
        case 'login': return json(api.login(provider));
        case 'answer': return json(api.answer(provider, attemptId, promptId, value));
        case 'cancel': return json(await api.cancel(provider, attemptId));
        case 'logout': return json(await api.logout(provider));
        case 'test': return json(await api.test(provider, model, request.signal));
        default: fail('INVALID_ACTION');
      }
    } catch (error) { return json(safeError(error), 400); }
  };
}
