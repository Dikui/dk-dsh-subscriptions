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
    { id: 'priority', name: 'Fast', description: 'Increased usage' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'Lowest latency' },
  ] }); // Elevated catalog defaults are not consent to increased usage.
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
  speeds.beginStep(input.sessionId, input);
  model = { ...model, speedAccount: 'synthetic-account-b' };
  assert.equal((await speeds.state(input)).selected, 'default');
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'default');
});

// small/spec — official xAI Priority Processing and Kimi model-ID contracts.
test('Grok offers Priority while Kimi highspeed remains an honestly named model variant', () => {
  assert.deepEqual(modelSpeed({ provider: 'subscription-xai', api: 'openai-responses', type: 'chat', id: 'grok-4.7' }).tiers.map(tier => tier.id), ['default', 'priority']);
  assert.equal(modelSpeed({ provider: 'subscription-kimi-coding', id: 'kimi-for-coding-highspeed' }).tiers[0].name, 'Highspeed');
  assert.deepEqual(modelSpeed({ provider: 'subscription-kimi-coding', id: 'kimi-for-coding' }).tiers.map(tier => tier.id), ['default']);
  assert.deepEqual(modelSpeed({ provider: 'subscription-xai', api: 'image-generation', type: 'image' }).tiers.map(tier => tier.id), ['default']);
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
  speeds.beginStep(input.sessionId, input);
  await speeds.select({ ...input, tier: 'priority', confirmed: true });
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'default');
  speeds.beginStep(input.sessionId, input);
  assert.equal(speeds.capture({ ...input, conversation: true }, model), 'priority');
  assert.equal(speeds.capture({ ...input, sessionId: 'session-b', conversation: true }, model), 'default');
  assert.equal(speeds.capture({ ...input, conversation: true }, { ...model, id: 'other-model' }), 'default');
  assert.equal(speeds.capture(input, model), undefined, 'auxiliary requests do not inherit conversation Speed');
});
