import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSpeedHost } from '../speed-host.js';

const require = createRequire(import.meta.url);
let hostRequire;
try { hostRequire = createRequire(require.resolve(process.env.DSH_TEST_UNDICI ?? 'undici')); }
catch (error) { if (process.env.DSH_TEST_UNDICI) throw error; }

// small/regression — reported Speed unavailable after reload. Real Cordis and
// DomainFacility own lifecycle; a synthetic backend replaces all user storage.
test('Speed releases its storage domain so a reloaded host can serve the toolbar again', {
  skip: !hostRequire ? 'Set DSH_TEST_UNDICI to the desktop runtime.' : false,
}, async () => {
  const { Context } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
  const { HostConnectionService } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-client-connection')).href);
  const { DomainFacility } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-storage-domain')).href);
  const ctx = new Context();
  const model = { provider: 'subscription-xai', api: 'openai-responses', type: 'chat', id: 'grok-4.7' };
  const selection = { provider: model.provider, model: model.id };
  ctx.provide('agents', { get: id => id === 'synthetic-session' ? { model: { current: () => selection } } : undefined });
  const connection = new HostConnectionService(ctx, ['127.0.0.1'], {});
  const handler = connection.createSharedFetchHandler('/api');
  const peer = { principal: { kind: 'owner' } };
  const backend = { kv: { async open() {
    return { async loadAll() { return { tables: {}, global: null }; }, async close() {} };
  } } };
  const facility = new DomainFacility(ctx.extend({ storage: { backend: { get: () => backend } } }), { backend: 'synthetic-memory', routes: {} });
  ctx.provide('storageDomain', facility);
  const options = { adapterUrl: pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')),
    modelFor: async () => model, isConversation: () => false };
  const mount = () => ctx.inject(['agents', 'storageDomain'], async scope => { await createSpeedHost(scope, options); });
  try {
    for (let round = 0; round < 2; round++) {
      const fiber = mount(); await fiber;
      const response = await handler.fetch(new Request('http://dsh.internal/api/subscriptions-lite/speed', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-subscriptions-lite': '1' },
        body: JSON.stringify({ action: 'speed-state', sessionId: 'synthetic-session', ...selection }),
      }), peer);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).tiers.map(tier => tier.id), ['default', 'priority']);
      await fiber.dispose();
      assert.equal(facility.get('dk_subscription_speed'), undefined, 'unload closes and releases the domain before reload');
    }
  } finally {
    await ctx.fiber.dispose();
    await facility.closeAll();
  }
});
