import assert from 'node:assert/strict';
import test from 'node:test';
import { accountModelSources } from '../model-sources.js';
import { createAccountModels } from '../models.js';
import { createSpeedSelections, modelSpeed } from '../speed.js';

// small/spec — user-requested model-specific Speed; synthetic account metadata, no network/auth.
const baseModels = [{ id: 'baseline', name: 'Baseline', provider: 'openai-codex', api: 'openai-codex-responses',
  contextWindow: 100000, maxTokens: 16000, input: ['text'] }];
async function discover(extra) {
  const source = accountModelSources.get('openai-codex')({ baseModels, clientVersion: '1.3.0',
    readCredential: async () => ({ type: 'oauth', access: 'SYNTHETIC', accountId: 'SYNTHETIC-ACCOUNT' }),
    getAuth: async () => ({ source: 'OAuth', auth: { apiKey: 'SYNTHETIC' } }),
    fetchCatalog: async () => Response.json({ models: [{ slug: 'account-model', display_name: 'Account Model',
      visibility: 'list', supported_in_api: true, ...extra }] }),
  });
  const models = createAccountModels(source);
  await models.ensure();
  return models.getModels()[0];
}

test('Speed choices come from the exact account model, including future catalog tiers', async () => {
  const model = await discover({ service_tiers: [
    { id: 'priority', name: 'Fast', description: 'Increased usage' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'Lowest latency' },
  ], default_service_tier: 'priority' });
  assert.deepEqual(model.speed, { tiers: [
    { id: 'default', name: 'Normal' },
    { id: 'priority', name: 'Fast', description: 'Increased usage', aliases: ['fast'] },
    { id: 'ultrafast', name: 'Ultrafast', description: 'Lowest latency' },
  ] }); // Elevated catalog defaults are not consent to increased usage.
});

// small/regression — normalization must preserve the catalog's bounded tier list at every public interface.
test('all 32 advertised non-default Speed tiers remain selectable after capability resolution', async () => {
  const model = await discover({ service_tiers: Array.from({ length: 32 }, (_, index) => ({ id: `tier-${index}`, name: `Tier ${index}` })) });
  let saved;
  const speeds = createSpeedSelections({ read: () => saved, write: async (_, value) => { saved = value; },
    modelFor: async () => model, sessionExists: () => true });
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  assert.equal((await speeds.state(input)).tiers.length, 33);
  assert.equal((await speeds.select({ ...input, tier: 'tier-31', confirmed: true })).selected, 'tier-31');
});

test('legacy Fast capability remains available alongside an empty newer tier list', async () => {
  const model = await discover({ service_tiers: [], additional_speed_tiers: ['fast'] });
  assert.deepEqual(model.speed.tiers.map(tier => tier.id), ['default', 'priority']);
});

test('changing subscription accounts does not reuse a higher-consumption Speed consent', async () => {
  let model = await discover({ service_tiers: [{ id: 'priority', name: 'Fast' }] });
  model = { ...model, speedAccount: 'synthetic-account-a' };
  const records = new Map();
  const speeds = createSpeedSelections({ read: id => records.get(id), write: async (id, value) => records.set(id, value),
    modelFor: async () => model, sessionExists: () => true });
  const input = { sessionId: 'session-a', provider: 'subscription-openai-codex', model: model.id };
  await speeds.select({ ...input, tier: 'priority', confirmed: true });
  await speeds.beginStep(input.sessionId, input);
  model = { ...model, speedAccount: 'synthetic-account-b' };
  assert.equal((await speeds.state(input)).selected, 'default');
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'default');
});

// small/spec — user clarification: model-declared tiers, request-level tiers, otherwise default.
test('Speed resolves model metadata before request capability without depending on a vendor whitelist', async () => {
  const codex = await discover({ service_tiers: [{ id: 'priority', name: 'Fast' }] });
  assert.equal(modelSpeed(codex).source, 'model');
  const syntheticModel = { provider: 'subscription-another-vendor', id: 'same-model',
    speed: { tiers: [{ id: 'default', name: 'Normal' }, { id: 'flex', name: 'Flex' }] } };
  assert.deepEqual(modelSpeed(syntheticModel).tiers.map(tier => tier.id), ['default', 'flex']);
  assert.equal(modelSpeed(syntheticModel).source, 'model');
  const grok = { provider: 'subscription-xai', api: 'openai-responses', type: 'chat', id: 'grok-4.7' };
  assert.equal(modelSpeed(grok).source, 'request');
  assert.deepEqual(modelSpeed(grok).tiers.map(tier => tier.id), ['default', 'priority']);
  for (const speed of [{ tiers: [{ id: 'default', name: 'Normal' }] }, { tiers: [] }, null]) {
    assert.deepEqual(modelSpeed({ ...grok, speed }).tiers.map(tier => tier.id), ['default'],
      'an explicit model declaration never inherits a broader request-level offer');
  }
});

// small/spec — unified Speed capability requested in this conversation; synthetic model metadata only.
test('model-declared Speed uses the same normalized capability contract for any provider', () => {
  const model = { provider: 'subscription-another-vendor', id: 'ordinary-model', speed: { tiers: [
    { id: 'priority', name: 'Priority', aliases: ['fast', 'fast', 'priority', 'default', 'INVALID'] },
    { id: 'priority', name: 'Duplicate' },
    { id: 'INVALID', name: 'Invalid' },
  ] } };
  assert.deepEqual(modelSpeed(model), { source: 'model', tiers: [
    { id: 'default', name: 'Normal' },
    { id: 'priority', name: 'Priority', aliases: ['fast'] },
  ] });
});

// small/regression — reported fast rejection; memory replaces durable storage, no vendor requests.
test('Speed aliases select one canonical tier for both model and request capabilities', async () => {
  const models = [
    { provider: 'subscription-xai', api: 'openai-responses', type: 'chat', id: 'grok-4.7' },
    { provider: 'subscription-another-vendor', id: 'ordinary-model', speed: { tiers: [
      { id: 'priority', name: 'Priority', aliases: ['fast'] },
    ] } },
    await discover({ service_tiers: [{ id: 'priority', name: 'Fast' }] }),
  ];
  for (const model of models) {
    let saved;
    const speeds = createSpeedSelections({ read: () => saved, write: async (_, value) => { saved = value; },
      modelFor: async () => model, sessionExists: () => true });
    const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
    await assert.rejects(speeds.select({ ...input, tier: 'fast', confirmed: false }), { code: 'SPEED_CONFIRMATION_REQUIRED' });
    const state = await speeds.select({ ...input, tier: 'fast', confirmed: true });
    assert.equal(state.selected, 'priority');
    assert.deepEqual(state.tiers.map(tier => tier.id), ['default', 'priority'], 'aliases are not additional speed choices');
    await speeds.beginStep(input.sessionId, input);
    assert.equal(speeds.capture({ ...input, conversation: true }, model), 'priority');
    await speeds.select({ ...input, tier: 'default' });
    assert.equal(speeds.capture({ ...input, conversation: true }, model), 'priority', 'current step retains its speed');
    await speeds.beginStep(input.sessionId, input);
    assert.equal(speeds.capture({ ...input, conversation: true }, model), 'default');
  }
});

// small/regression — saved aliases must follow the same resolver as new selections; memory replaces sidecar storage.
test('saved Speed aliases resolve canonically without being offered as separate tiers', async () => {
  const model = { provider: 'subscription-xai', api: 'openai-responses', type: 'chat', id: 'grok-4.7' };
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  const speeds = createSpeedSelections({ read: () => ({ choices: [{ ...input, tier: 'fast' }] }), write: async () => {},
    modelFor: async () => model, sessionExists: () => true });
  const state = await speeds.state(input);
  assert.equal(state.selected, 'priority'); assert.equal(state.stale, false);
  await speeds.beginStep(input.sessionId, input);
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'priority');
});

// small/regression — review found legacy alias re-resolution could change a retry's selected tier.
test('a step retains the canonical Speed when model metadata reassigns a saved alias', async () => {
  let model = { provider: 'subscription-another-vendor', id: 'ordinary-model', speed: { tiers: [
    { id: 'priority', name: 'Priority', aliases: ['fast'] }, { id: 'flex', name: 'Flex' },
  ] } };
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  const speeds = createSpeedSelections({ read: () => ({ choices: [{ ...input, tier: 'fast' }] }), write: async () => {},
    modelFor: async () => model, sessionExists: () => true });
  await speeds.beginStep(input.sessionId, input);
  model = { ...model, speed: { tiers: [
    { id: 'priority', name: 'Priority' }, { id: 'flex', name: 'Flex', aliases: ['fast'] },
  ] } };
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'priority', 'the step snapshots canonical ids, not aliases');
  assert.equal((await speeds.state(input)).selected, 'flex', 'the latest capability applies to the next step');
  await speeds.beginStep(input.sessionId, input);
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'flex');
});

// small/regression — a canonical step snapshot must not be reinterpreted through newly introduced aliases.
test('removing a snapshotted canonical Speed rejects the retry instead of changing tiers', async () => {
  let model = { provider: 'subscription-another-vendor', id: 'ordinary-model', speed: { tiers: [
    { id: 'priority', name: 'Priority' },
  ] } };
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  const speeds = createSpeedSelections({ read: () => ({ choices: [{ ...input, tier: 'priority' }] }), write: async () => {},
    modelFor: async () => model, sessionExists: () => true });
  await speeds.beginStep(input.sessionId, input);
  model = { ...model, speed: { tiers: [{ id: 'flex', name: 'Flex', aliases: ['priority'] }] } };
  assert.throws(() => speeds.capture({ ...input, conversation: true }, model), { code: 'UNSUPPORTED_SPEED' });
});

// small/spec — unified capability contract; neither protocol names nor another provider's aliases grant a tier.
test('Speed aliases are scoped to their declaration and cannot override canonical tier ids', async () => {
  for (const tiers of [
    [{ id: 'priority', name: 'Priority' }],
    [{ id: 'priority', name: 'Priority', aliases: ['fast'] }, { id: 'flex', name: 'Flex', aliases: ['fast'] }],
    [{ id: 'priority', name: 'Priority', aliases: ['fast'] }, { id: 'fast', name: 'Independent Fast' }],
  ]) {
    const model = { provider: 'subscription-another-vendor', id: 'ordinary-model', speed: { tiers } };
    const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
    let saved;
    const speeds = createSpeedSelections({ read: () => saved, write: async (_, value) => { saved = value; }, modelFor: async () => model, sessionExists: () => true });
    if (tiers.some(tier => tier.id === 'fast')) {
      assert.equal((await speeds.select({ ...input, tier: 'fast', confirmed: true })).selected, 'fast',
        'an explicitly independent tier remains independent');
      await speeds.beginStep(input.sessionId, input);
      assert.equal(speeds.capture({ ...input, conversation: true }, model), 'fast');
    } else {
      await assert.rejects(speeds.select({ ...input, tier: 'fast', confirmed: true }), { code: 'UNSUPPORTED_SPEED' });
    }
  }
});

// small/regression — review found truncation could turn a dropped canonical id into another tier's alias.
test('a truncated canonical Speed id is never reinterpreted as a different tier alias', async () => {
  for (const count of [31, 32]) {
    const model = { provider: 'subscription-another-vendor', id: 'ordinary-model', speed: { tiers: [
      { id: 'priority', name: 'Priority', aliases: ['fast'] },
      ...Array.from({ length: count }, (_, index) => ({ id: `tier-${index}`, name: `Tier ${index}` })),
      { id: 'fast', name: 'Independent Fast' },
    ] } };
    const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
    const speeds = createSpeedSelections({ read: () => undefined, write: async () => {}, modelFor: async () => model, sessionExists: () => true });
    await assert.rejects(speeds.select({ ...input, tier: 'fast', confirmed: true }), { code: 'UNSUPPORTED_SPEED' });
  }
});

test('models without Speed capability always use default even with a previously saved tier', async () => {
  for (const model of [
    { provider: 'subscription-kimi-coding', id: 'kimi-for-coding' },
    { provider: 'subscription-kimi-coding', id: 'kimi-for-coding-highspeed' },
    { provider: 'subscription-another-vendor', id: 'ordinary-model' },
    { provider: 'subscription-another-vendor', api: 'openai-responses', type: 'chat', id: 'ordinary-model' },
    { provider: 'subscription-xai', api: 'image-generation', type: 'image', id: 'image-model' },
  ]) {
    assert.equal(modelSpeed(model).source, 'default');
    const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
    const speeds = createSpeedSelections({
      read: () => ({ choices: [{ provider: model.provider, model: model.id, tier: 'priority' }] }),
      write: async () => {}, modelFor: async () => model, sessionExists: () => true,
    });
    const state = await speeds.state(input);
    assert.equal(state.selected, 'default'); assert.equal(state.stale, false);
    assert.deepEqual(state.tiers.map(tier => tier.id), ['default']);
    await speeds.beginStep(input.sessionId, input);
    assert.equal(speeds.capture({ ...input, conversation: true }, model), undefined, 'leave the model request untouched');
    await assert.rejects(speeds.select({ ...input, tier: 'priority', confirmed: true }), { code: 'UNSUPPORTED_SPEED' });
  }
});

test('a model switch during metadata lookup rejects the obsolete speed save', async () => {
  const model = await discover({ service_tiers: [{ id: 'priority', name: 'Fast' }] });
  let changed = false, written = false, lookups = 0;
  const speeds = createSpeedSelections({ read: () => undefined, write: async () => { written = true; },
    modelFor: async () => { if (++lookups === 2) changed = true; return model; }, sessionExists: () => true,
    validateSelection: () => { if (changed) throw new Error('SPEED_MODEL_CHANGED'); } });
  await assert.rejects(speeds.select({ sessionId: 'session-a', provider: 'subscription-openai-codex', model: model.id,
    tier: 'priority', confirmed: true }), /SPEED_MODEL_CHANGED/);
  assert.equal(written, false);
});

// small/spec — public session Speed interface; memory stands in for durable storage.
test('a Speed change waits for the next step and never affects another session or model', async () => {
  const model = await discover({ service_tiers: [{ id: 'priority', name: 'Fast' }] });
  const records = new Map();
  const speeds = createSpeedSelections({ read: id => records.get(id), write: async (id, value) => records.set(id, value),
    modelFor: async () => model, sessionExists: () => true });
  const input = { sessionId: 'session-a', provider: 'subscription-openai-codex', model: model.id };
  await speeds.beginStep(input.sessionId, input);
  await speeds.select({ ...input, tier: 'priority', confirmed: true });
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'default');
  await speeds.beginStep(input.sessionId, input);
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'priority');
  assert.equal(speeds.capture({ ...input, sessionId: 'session-b', conversation: true }, model), 'default');
  assert.equal(speeds.capture({ ...input, conversation: true }, { ...model, id: 'other-model' }), 'default');
  assert.equal(speeds.capture(input, model), undefined, 'auxiliary requests do not inherit conversation Speed');
});

// small/spec — user request: new sessions remember the last Speed for that model.
test('the last Speed chosen for a model is inherited by new sessions', async () => {
  const model = await discover({ service_tiers: [{ id: 'priority', name: 'Fast' }] });
  const records = new Map(), last = new Map();
  const speeds = createSpeedSelections({ read: id => records.get(id), write: async (id, value) => records.set(id, value),
    readLast: provider => last.get(provider), writeLast: async (provider, value) => last.set(provider, value),
    modelFor: async () => model, sessionExists: () => true });
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  await speeds.select({ ...input, tier: 'priority', confirmed: true });
  assert.equal(last.get(input.provider).model, model.id);
  assert.equal(last.get(input.provider).tier, 'priority');
  assert.equal((await speeds.state({ ...input, sessionId: 'session-b' })).selected, 'priority');
  await speeds.beginStep('session-b', input);
  assert.equal(speeds.capture({ ...input, sessionId: 'session-b', conversation: true }, model), 'priority',
    'a new session sends the remembered tier without another choice');
  await speeds.select({ ...input, sessionId: 'session-b', tier: 'default' });
  assert.equal((await speeds.state({ ...input, sessionId: 'session-c' })).selected, 'default', 'Normal overrides the memory');
});

// small/spec — user decision: switching models returns to Normal, like reasoning effort.
test('changing the model returns Speed to Normal', async () => {
  const model = await discover({ service_tiers: [{ id: 'priority', name: 'Fast' }] });
  const other = { ...model, id: 'another-model' };
  const records = new Map(), last = new Map();
  const speeds = createSpeedSelections({ read: id => records.get(id), write: async (id, value) => records.set(id, value),
    readLast: provider => last.get(provider), writeLast: async (provider, value) => last.set(provider, value),
    modelFor: async (provider, id) => id === other.id ? other : model, sessionExists: () => true });
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  await speeds.select({ ...input, tier: 'priority', confirmed: true });
  const switched = { ...input, model: other.id };
  assert.equal((await speeds.state(switched)).selected, 'default');
  await speeds.beginStep('session-a', switched);
  assert.equal(speeds.capture({ ...switched, conversation: true }, other), 'default',
    'the remembered tier belongs to the model it was chosen on');
});

test('a remembered Speed does not cross subscription account scopes', async () => {
  let model = { provider: 'subscription-another-vendor', id: 'ordinary-model',
    speed: { tiers: [{ id: 'priority', name: 'Priority' }] }, speedAccount: 'account-a' };
  const last = new Map();
  const speeds = createSpeedSelections({ read: () => undefined, write: async () => {},
    readLast: provider => last.get(provider), writeLast: async (provider, value) => last.set(provider, value),
    modelFor: async () => model, sessionExists: () => true });
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  await speeds.select({ ...input, tier: 'priority', confirmed: true });
  model = { ...model, speedAccount: 'account-b' };
  assert.equal((await speeds.state({ ...input, sessionId: 'session-b' })).selected, 'default');
});

test('a remembered Speed removed from the next model falls back to Normal', async () => {
  let model = { provider: 'subscription-another-vendor', id: 'ordinary-model', speed: { tiers: [{ id: 'priority', name: 'Priority' }] } };
  const last = new Map();
  const speeds = createSpeedSelections({ read: () => undefined, write: async () => {},
    readLast: provider => last.get(provider), writeLast: async (provider, value) => last.set(provider, value),
    modelFor: async () => model, sessionExists: () => true });
  const input = { sessionId: 'session-a', provider: model.provider, model: model.id };
  await speeds.select({ ...input, tier: 'priority', confirmed: true });
  model = { ...model, speed: { tiers: [{ id: 'flex', name: 'Flex' }] } };
  const next = { ...input, sessionId: 'session-b' };
  await speeds.beginStep(next.sessionId, next);
  assert.equal(speeds.capture({ ...next, conversation: true }, model), 'default');
});
