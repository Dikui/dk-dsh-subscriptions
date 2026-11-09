import { fail } from './core.js';

const normal = Object.freeze({ id: 'default', name: 'Normal' });
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

// Codex's account catalog is authoritative. Never inherit a template's tiers,
// infer speed from a model name, or treat the catalog default as paid-mode consent.
export function codexSpeed(row) {
  const tiers = new Map([['default', normal]]);
  if (Array.isArray(row.service_tiers)) {
    for (const tier of row.service_tiers.slice(0, 32)) {
      if (!validId(tier?.id) || tiers.has(tier.id)) continue;
      tiers.set(tier.id, { id: tier.id,
        name: typeof tier.name === 'string' && tier.name.trim() ? tier.name.slice(0, 80) : tier.id,
        ...(typeof tier.description === 'string' && tier.description.trim() ? { description: tier.description.slice(0, 300) } : {}),
      });
    }
  }
  if (!tiers.has('priority') && Array.isArray(row.additional_speed_tiers) && row.additional_speed_tiers.includes('fast')) {
    tiers.set('priority', { id: 'priority', name: 'Fast' }); // Official legacy fast -> priority mapping.
  }
  return { tiers: [...tiers.values()] };
}

// Provider adapters describe capabilities; selection/persistence/UI consume one
// shared shape. Protocol support alone never invents a model's available tiers.
const speedSources = new Map([
  ['subscription-openai-codex', model => model.speed ?? { tiers: [normal] }],
  ['subscription-xai', model => model.api === 'openai-responses' && model.type === 'chat'
    ? { tiers: [normal, { id: 'priority', name: 'Priority',
      description: 'Premium scheduling; OAuth entitlement and subscription-only billing unverified. Not Grok Build Fast.' }] }
    : { tiers: [normal] }],
  ['subscription-kimi-coding', model => ({ tiers: [model.id === 'kimi-for-coding-highspeed' || model.id === 'k3.1-pro-highspeed'
    ? { id: 'default', name: 'Highspeed', description: 'This exact Kimi model is already the highspeed version; speed is selected by model ID.' }
    : normal] })],
]);

export function modelSpeed(model) {
  const source = speedSources.get(model?.provider);
  if (source) return source(model);
  return model?.provider === 'openai-codex' ? model.speed ?? { tiers: [normal] } : { tiers: [normal] };
}

// One interface owns validation, durable per-session/model selection and request
// snapshots. Storage is a host sidecar, never a prompt or an experimental log event.
export function createSpeedSelections({ read, write, modelFor, sessionExists, validateSelection = () => {} }) {
  const pending = new Map(), steps = new Map();
  const key = (provider, model) => JSON.stringify([provider, model]);
  function check({ sessionId, provider, model }) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !sessionExists(sessionId)) fail('SPEED_SESSION_UNAVAILABLE');
    if (typeof provider !== 'string' || typeof model !== 'string' || !model || model.length > 200) fail('UNKNOWN_MODEL');
  }
  function choiceFor({ sessionId, provider, model }) {
    return read(sessionId)?.choices?.find(choice => choice.provider === provider && choice.model === model);
  }
  function selected(input, descriptor) {
    const choice = choiceFor(input);
    return choice?.account === descriptor?.speedAccount ? choice?.tier ?? 'default' : 'default';
  }
  async function state(input, signal) {
    check(input);
    const model = await modelFor(input.provider, input.model, signal);
    if (!model) fail('UNKNOWN_MODEL');
    const speed = modelSpeed(model), wanted = selected(input, model);
    return { sessionId: input.sessionId, provider: input.provider, model: input.model,
      tiers: speed.tiers, selected: speed.tiers.some(tier => tier.id === wanted) ? wanted : 'default',
      stale: !speed.tiers.some(tier => tier.id === wanted) };
  }
  async function select(input, signal) {
    const current = await state({ sessionId: input.sessionId, provider: input.provider, model: input.model }, signal);
    if (!current.tiers.some(tier => tier.id === input.tier)) fail('UNSUPPORTED_SPEED');
    if (input.tier !== 'default' && input.confirmed !== true) fail('SPEED_CONFIRMATION_REQUIRED');
    const previous = pending.get(input.sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      check(input);
      const choices = (read(input.sessionId)?.choices ?? []).filter(choice => key(choice.provider, choice.model) !== key(input.provider, input.model));
      if (input.tier !== 'default') {
        const descriptor = await modelFor(input.provider, input.model, signal);
        if (!modelSpeed(descriptor).tiers.some(tier => tier.id === input.tier)) fail('UNSUPPORTED_SPEED');
        choices.push({ provider: input.provider, model: input.model, tier: input.tier,
          ...(descriptor.speedAccount ? { account: descriptor.speedAccount } : {}) });
      }
      if (choices.length > 1000) fail('SPEED_SELECTION_LIMIT');
      signal?.throwIfAborted();
      validateSelection(input);
      await write(input.sessionId, { choices });
    });
    pending.set(input.sessionId, operation);
    try { await operation; } finally { if (pending.get(input.sessionId) === operation) pending.delete(input.sessionId); }
    return state(current, signal);
  }
  return {
    state, select,
    // Called at the accepted step boundary; retries keep this value even if the
    // user changes Speed while the model is working. No selection leaks to tools.
    beginStep(sessionId, selection) {
      const input = { sessionId, provider: selection.provider, model: selection.model };
      steps.set(sessionId, { ...input, ...choiceFor(input) });
    },
    endSession(sessionId) { steps.delete(sessionId); },
    capture(options, model) {
      const { sessionId, provider } = options;
      if (!sessionId || options.conversation !== true) return undefined;
      const step = steps.get(sessionId);
      const tier = step?.provider === provider && step.model === model.id
        ? step.account === model.speedAccount ? step.tier ?? 'default' : 'default'
        : selected({ sessionId, provider, model: model.id }, model);
      if (!modelSpeed(model).tiers.some(choice => choice.id === tier)) fail('UNSUPPORTED_SPEED');
      // Normal preserves standard Codex routing, never the elevated catalog default.
      return model.api === 'openai-codex-responses' || model.provider === 'subscription-xai' ? tier : undefined;
    },
  };
}

// onPayload survives pi-ai streamSimple; serviceTier alone is dropped by 1.3.0.
// The callback is request-local and preserves any pre-existing payload hook.
export function withSpeedPayload(options, tier) {
  if (tier === undefined) return options;
  return { ...options, onPayload: async (payload, model) => {
    const next = await options?.onPayload?.(payload, model) ?? payload;
    // Codex treats explicit `default` as a client sentinel: standard requests
    // omit the wire field (official openai_models.rs/config_types.rs contract).
    if (tier === 'default') { const { service_tier, ...standard } = next; return standard; }
    return { ...next, service_tier: tier };
  } };
}
