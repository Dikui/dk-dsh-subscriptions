// small/spec — OpenCode Go quota-only source. Synthetic HTTP; no inference.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptions } from '../core.js';
import { createAccountQuota } from '../models.js';
import { opencodeGoQuotaSource } from '../quota-sources.js';

const usage = (rolling = 1, weekly = rolling + 1, monthly = rolling + 2) => Response.json({ usage: {
  rolling: { status: 'ok', percent: rolling, resetsAt: '2026-11-13T14:31:04.000Z' },
  weekly: { status: 'ok', percent: weekly, resetsAt: '2026-11-16T00:00:00.000Z' },
  monthly: { status: 'ok', percent: monthly, resetsAt: '2026-12-10T14:01:10.000Z' },
} });

function source({ key = 'oc_test', response = () => usage(), calls = [] } = {}) {
  return opencodeGoQuotaSource({
    readKey: async () => key,
    fetchCatalog: async (url, options) => { calls.push([url, options]); return response(options); },
  });
}

test('normalizes OpenCode rolling, weekly and monthly meters', async () => {
  const calls = [];
  const quota = createAccountQuota(source({ calls }));
  await quota.ensure();
  const state = quota.status();
  assert.equal(state.state, 'ready');
  assert.deepEqual(state.windows.map(window => window.id), ['limit_5h', 'limit_7d', 'limit_month_total']);
  assert.deepEqual(state.windows.map(window => window.usedPercent), [1, 2, 3]);
  assert.deepEqual(state.windows.map(window => window.windowSeconds), [18000, 604800, null]);
  assert.deepEqual(state.windows.map(window => window.resetsAt), [Date.parse('2026-11-13T14:31:04.000Z'),
    Date.parse('2026-11-16T00:00:00.000Z'), Date.parse('2026-12-10T14:01:10.000Z')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(calls[0][1].headers.authorization, 'Bearer oc_test');
  assert.doesNotMatch(JSON.stringify(state), /oc_test/);
});

test('a changed API key isolates the cached account and reloads', async () => {
  let key = 'oc_first';
  const seen = [];
  const quota = createAccountQuota(opencodeGoQuotaSource({
    readKey: async () => key,
    fetchCatalog: async (url, options) => { seen.push(options.headers.authorization); return usage(key === 'oc_second' ? 50 : 1); },
  }));
  await quota.ensure();
  assert.equal(quota.status().windows[0].usedPercent, 1);
  key = 'oc_second';
  await quota.ensure();
  assert.equal(seen.length, 2);
  assert.equal(quota.status().windows[0].usedPercent, 50);
});

test('HTTP denials and malformed payloads stay typed and redacted', async () => {
  for (const [status, code] of [[401, 'QUOTA_DENIED'], [403, 'QUOTA_DENIED'], [429, 'QUOTA_RATE_LIMIT'], [500, 'QUOTA_FAILED']]) {
    const quota = createAccountQuota(source({ response: () => new Response('SECRET-BODY', { status }) }));
    await assert.rejects(quota.ensure(), { code });
    assert.equal(quota.status().error, code);
    assert.doesNotMatch(JSON.stringify(quota.status()), /SECRET-BODY/);
  }
  const malformed = createAccountQuota(source({ response: () => Response.json({ usage: {} }) }));
  await assert.rejects(malformed.ensure(), { code: 'QUOTA_INVALID' });
  assert.equal(malformed.status().error, 'QUOTA_INVALID');
});

test('a missing window is partial rather than zero or unlimited', async () => {
  const quota = createAccountQuota(source({ response: () => Response.json({ usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-11-13T14:31:04.000Z' },
  } }) }));
  await quota.ensure();
  assert.equal(quota.status().state, 'partial');
  assert.deepEqual(quota.status().windows.map(window => window.id), ['limit_5h']);
});

test('quota-only provider is readable without an OAuth route and rejects auth actions', async () => {
  const calls = [];
  const api = createSubscriptions({
    credentials: { readRecord: async () => undefined },
    authorization: {}, llm: {}, catalog: [], keyFor: id => id,
    accountQuotas: new Map([['opencode-go', createAccountQuota(source({ calls }))]]),
    readQuotaKey: async id => id === 'opencode-go' ? 'oc_test' : undefined,
  });
  try {
    const state = await api.quotaState('opencode-go');
    assert.equal(state.configured, true);
    assert.equal(state.quota.windows.length, 3);
    assert.equal(calls.length, 1);
    assert.throws(() => api.login('opencode-go'), { code: 'UNAVAILABLE' });
    await assert.rejects(api.logout('opencode-go'), { code: 'UNAVAILABLE' });
    await api.refreshQuota('opencode-go');
    assert.equal(calls.length, 2);
  } finally { api.dispose(); }
});

test('quota-only provider stays hidden when the feature is disabled', async () => {
  const api = createSubscriptions({
    credentials: { readRecord: async () => undefined },
    authorization: {}, llm: {}, catalog: [], keyFor: id => id,
  });
  try {
    const state = await api.quotaState('opencode-go');
    assert.equal(state.configured, false);
    assert.equal(state.quota.state, 'unsupported');
  } finally { api.dispose(); }
});
