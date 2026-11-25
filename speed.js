import { fail } from './core.js';

const normal = Object.freeze({ id: 'default', name: 'Normal' });
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

// All capability sources use this contract: default is always available;
// non-default ids are canonical wire values, aliases are explicit and scoped.
function normalizeSpeed(capability) {
  const tiers = new Map([['default', normal]]), aliases = new Map();
  const rows = Array.isArray(capability?.tiers) ? capability.tiers : [];
  // Reject oversized declarations instead of aliasing a truncated canonical id.
  if (rows.length > 33) return { tiers: [normal] };
  const declaredIds = new Set(rows.filter(tier => validId(tier?.id)).map(tier => tier.id));
  for (const tier of rows) {
    if (tiers.size >= 33) break;
    if (!validId(tier?.id) || tiers.has(tier.id)) continue;
    tiers.set(tier.id, { id: tier.id,
      name: typeof tier.name === 'string' && tier.name.trim() ? tier.name.slice(0, 80) : tier.id,
      ...(typeof tier.description === 'string' && tier.description.trim() ? { description: tier.description.slice(0, 300) } : {}),
    });
    aliases.set(tier.id, Array.isArray(tier.aliases) ? tier.aliases.slice(0, 32) : []);
  }
  const owners = new Map();
  for (const [id, names] of aliases) {
    for (const alias of names) {
      if (!validId(alias) || alias === 'default' || declaredIds.has(alias)) continue;
      if (!owners.has(alias)) owners.set(alias, id);
      else if (owners.get(alias) !== id) owners.set(alias, null);
    }
  }
  for (const tier of tiers.values()) {
    const names = [...owners].filter(([, id]) => id === tier.id).map(([alias]) => alias);
    if (names.length) tier.aliases = names;
  }
  return { tiers: [...tiers.values()] };
}

// Catalog adapters only translate source data, never choose the resolution path.
// Never inherit a template's tiers or treat a paid catalog default as consent.
export function codexSpeed(row) {
  if (Array.isArray(row.service_tiers) && row.service_tiers.length > 33) return { tiers: [normal] };
  const tiers = Array.isArray(row.service_tiers) ? [...row.service_tiers] : [];
  if (!tiers.some(tier => tier?.id === 'priority') && Array.isArray(row.additional_speed_tiers) && row.additional_speed_tiers.includes('fast')) {
    tiers.unshift({ id: 'priority', name: 'Fast' }); // Official legacy fast -> priority mapping.
  }
  return normalizeSpeed({ tiers: tiers.map(tier => tier?.id === 'priority' ? { ...tier, aliases: ['fast'] } : tier) });
}

// Verified interface contracts are data with explicit applicability, not a
// second vendor-specific resolver. A shared API name alone proves nothing.
const requestSpeedCapabilities = [
  { appliesTo: { provider: 'subscription-xai', api: 'openai-responses', type: 'chat' },
    speed: { tiers: [{ id: 'priority', name: 'Priority', aliases: ['fast'],
      description: 'Premium scheduling; OAuth entitlement and subscription-only billing unverified. Not Grok Build Fast.' }] } },
];

export function modelSpeed(model) {
  // Even an empty/invalid explicit declaration must not enable a broader fallback.
  if (model?.speed !== undefined) return { ...normalizeSpeed(model.speed), source: 'model' };
  const request = requestSpeedCapabilities.find(({ appliesTo }) => Object.entries(appliesTo).every(([key, value]) => model?.[key] === value));
  return { ...normalizeSpeed(request?.speed), source: request ? 'request' : 'default' };
}

function canonicalTier(speed, value) {
  const exact = speed.tiers.find(tier => tier.id === value);
  return (exact ?? speed.tiers.find(tier => tier.aliases?.includes(value)))?.id;
}

// One interface owns validation, durable per-session/model selection and request
// snapshots. Storage is a host sidecar, never a prompt or an experimental log event.
// readLast/writeLast remember the latest choice for the model it was made on, so
// new sessions inherit it while switching models returns to Normal.
export function createSpeedSelections({ read, write, readLast = () => undefined, writeLast = async () => {},
  modelFor, displayModelFor = modelFor, viewScope, sessionExists, validateSelection = () => {} }) {
  const pending = new Map(), steps = new Map();
  const key = (provider, model) => JSON.stringify([provider, model]);
  function check({ sessionId, provider, model }) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !sessionExists(sessionId)) fail('SPEED_SESSION_UNAVAILABLE');
    if (typeof provider !== 'string' || typeof model !== 'string' || !model || model.length > 200) fail('UNKNOWN_MODEL');
  }
  function choiceFor({ sessionId, provider, model }) {
    return read(sessionId)?.choices?.find(choice => choice.provider === provider && choice.model === model);
  }
  function remembered(input, descriptor) {
    const last = readLast(input.provider);
    if (!last || last.model !== input.model) return undefined;
    // Without a descriptor the account check is deferred to capture().
    return descriptor && last.account !== descriptor.speedAccount ? undefined : last;
  }
  function selected(input, descriptor, speed) {
    const choice = choiceFor(input);
    if (choice) return choice.account === descriptor?.speedAccount ? choice.tier ?? 'default' : 'default';
    const last = remembered(input, descriptor);
    // A remembered tier only applies while the current model still offers it.
    return last ? canonicalTier(speed, last.tier) ?? 'default' : 'default';
  }
  async function display(input, signal) {
    check(input);
    const model = await displayModelFor(input.provider, input.model, signal);
    if (!model) fail('UNKNOWN_MODEL');
    return model;
  }
  function stateOf(input, model) {
    const speed = modelSpeed(model), wanted = speed.tiers.length > 1 ? selected(input, model, speed) : 'default';
    const tier = canonicalTier(speed, wanted);
    return { sessionId: input.sessionId, provider: input.provider, model: input.model,
      source: speed.source, tiers: speed.tiers, selected: tier ?? 'default', stale: tier === undefined,
      ...(viewScope ? { viewScope: viewScope(input, model.speedAccount) } : {}) };
  }
  async function state(input, signal) { return stateOf(input, await display(input, signal)); }
  async function select(input, signal) {
    check(input);
    // Reserve the click's queue position synchronously, even if its identity read
    // is slow or fails. Later saves cannot overtake a pending write.
    const previous = pending.get(input.sessionId);
    const operation = Promise.allSettled([previous, display(input, signal)]).then(async ([, observed]) => {
      signal?.throwIfAborted();
      if (observed.status === 'rejected') throw observed.reason;
      const model = observed.value, account = model.speedAccount;
      if (viewScope && input.viewScope !== viewScope(input, account)) fail('SPEED_MODEL_CHANGED');
      const tier = canonicalTier(modelSpeed(model), input.tier);
      if (tier === undefined) fail('UNSUPPORTED_SPEED');
      if (tier !== 'default' && input.confirmed !== true) fail('SPEED_CONFIRMATION_REQUIRED');
      if (previous) {
        const latest = await display(input, signal);
        if (latest.speedAccount !== account) fail('SPEED_MODEL_CHANGED');
        if (canonicalTier(modelSpeed(latest), input.tier) !== tier) fail('UNSUPPORTED_SPEED');
      }
      const choices = (read(input.sessionId)?.choices ?? []).filter(choice => key(choice.provider, choice.model) !== key(input.provider, input.model));
      // An explicit Normal is stored too, so it overrides the remembered tier.
      choices.push({ provider: input.provider, model: input.model, tier, ...(account ? { account } : {}) });
      if (choices.length > 1000) fail('SPEED_SELECTION_LIMIT');
      signal?.throwIfAborted();
      validateSelection(input);
      await write(input.sessionId, { choices });
      await writeLast(input.provider, { model: input.model, tier, ...(account ? { account } : {}) });
    });
    pending.set(input.sessionId, operation);
    try { await operation; } finally { if (pending.get(input.sessionId) === operation) pending.delete(input.sessionId); }
    return state(input, signal);
  }
  return {
    state, select,
    // Called at the accepted step boundary; retries keep this value even if the
    // user changes Speed while the model is working. No selection leaks to tools.
    async beginStep(sessionId, selection, signal) {
      const input = { sessionId, provider: selection.provider, model: selection.model };
      const choice = choiceFor(input), last = choice ? undefined : remembered(input);
      // A remembered tier is snapshotted like an explicit choice; when metadata
      // drops it before the request, capture falls back to Normal instead of failing.
      const step = choice ? { ...input, ...choice }
        : { ...input, remembered: true, tier: last?.tier ?? 'default', ...(last?.account ? { account: last.account } : {}) };
      steps.set(sessionId, step);
      const descriptor = await modelFor(input.provider, input.model, signal);
      if (!descriptor) fail('UNKNOWN_MODEL');
      const speed = modelSpeed(descriptor);
      const tier = step.account === descriptor.speedAccount && speed.tiers.length > 1 ? canonicalTier(speed, step.tier) : 'default';
      if (tier === undefined && !step.remembered) fail('UNSUPPORTED_SPEED');
      signal?.throwIfAborted();
      if (steps.get(sessionId) === step) step.tier = tier ?? 'default';
    },
    endSession(sessionId) { steps.delete(sessionId); },
    capture(options, model) {
      const { sessionId, provider } = options;
      if (!sessionId || options.conversation !== true) return undefined;
      const speed = modelSpeed(model);
      if (speed.tiers.length < 2) return undefined; // No capability means an untouched default request.
      const step = steps.get(sessionId);
      const matches = step?.provider === provider && step.model === model.id;
      const tier = !matches ? selected({ sessionId, provider, model: model.id }, model, speed)
        : step.account === model.speedAccount ? step.tier ?? 'default' : 'default';
      // A step already owns a canonical id; aliases may only resolve unsnapshotted choices.
      const canonical = !matches ? canonicalTier(speed, tier)
        : speed.tiers.find(choice => choice.id === tier)?.id ?? (step.remembered ? 'default' : undefined);
      if (canonical === undefined) fail('UNSUPPORTED_SPEED');
      // Both capability adapters describe request tiers, never replacement models.
      return canonical;
    },
  };
}

// onPayload survives pi-ai streamSimple; serviceTier alone is dropped by 1.3.0.
// The callback is request-local and preserves any pre-existing payload hook.
export function withSpeedPayload(options, tier, authorize) {
  if (tier === undefined) return options;
  return { ...options, onPayload: async (payload, model) => {
    const next = await options?.onPayload?.(payload, model) ?? payload;
    // Codex treats explicit `default` as a client sentinel: standard requests
    // omit the wire field (official openai_models.rs/config_types.rs contract).
    if (tier === 'default') { const { service_tier, ...standard } = next; return standard; }
    await authorize(); // Positive consent must still match the finalized OAuth request and live catalog.
    return { ...next, service_tier: tier };
  } };
}
