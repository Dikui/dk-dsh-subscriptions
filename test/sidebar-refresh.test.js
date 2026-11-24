// small/spec — manual sidebar refresh over the real HTTP handler and synthetic upstream.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpHandler, createSubscriptions } from '../core.js';
import { createAccountModels, createAccountQuota } from '../models.js';
import { accountQuotaSources } from '../quota-sources.js';
import { panelHarness } from './panel-harness.js';

function fixture() {
  const records = new Map();
  const quotaCalls = [];
  const keyFor = id => `llm-pi-ai/${id}`;
  const grant = () => ({ kind: 'grant', payload: { type: 'oauth', access: 'ACCESS-SECRET', accountId: 'ACCOUNT-SECRET', expires: 3600000 } });
  for (const id of ['openai-codex', 'kimi-coding', 'xai']) records.set(keyFor(id), grant());
  const credentials = { readRecord: async key => records.get(key), async modifyRecord(key, mutate) {
    const next = await mutate(records.get(key)); if (next) records.set(key, next); return records.get(key);
  } };
  const accountModels = new Map(), accountQuotas = new Map();
  let pendingFailure = null;
  const counts = new Map();
  const catalog = ['openai-codex', 'kimi-coding', 'xai'].map(id => {
    const models = createAccountModels({ readIdentity: async () => records.get(keyFor(id))?.payload?.access,
      loadModels: async () => [{ id: `${id}-model`, name: `${id} model` }] });
    accountModels.set(id, models);
    const source = accountQuotaSources.get(id);
    if (source) accountQuotas.set(id, createAccountQuota(source({
      readCredential: async () => records.get(keyFor(id))?.payload,
      getAuth: async () => ({ source: 'OAuth', auth: { apiKey: records.get(keyFor(id))?.payload?.access } }),
      fetchCatalog: async () => {
        quotaCalls.push(id);
        if (pendingFailure === id) { pendingFailure = null; return new Response('SECRET', { status: 500 }); }
        const count = (counts.get(id) ?? 0) + 1; counts.set(id, count);
        return Response.json(id === 'openai-codex'
          ? { rate_limit: { primary_window: { used_percent: 15 + 10 * count }, secondary_window: { used_percent: 50 + 10 * count } } }
          : { usages: { limit_5h: { used_ratio: 0.4 + 0.1 * count } } });
      },
    })));
    return { id, auth: { oauth: {} }, getModels: models.getModels };
  });
  const api = createSubscriptions({ catalog, credentials, keyFor, accountModels, accountQuotas,
    authorization: { describe: () => ({ methods: [{ id: 'oauth' }] }), begin: async ({ key }) => { records.set(key, grant()); return { status: 'authorized' }; } },
    llm: { stream: () => assert.fail('quota must not send inference') } });
  const handler = createHttpHandler(api);
  const fetch = (path, options = {}) => handler(new Request(`http://localhost${path}`, { method: options.method ?? 'GET',
    headers: options.headers, body: options.body, signal: options.signal }));
  return { api, fetch, quotaCalls, failNext: id => { pendingFailure = id; } };
}

const trigger = panel => panel.nodes().find(node => node.props?.className === 'slq-trigger');
const dialog = panel => panel.nodes().find(node => node.props?.role === 'dialog');
const label = panel => trigger(panel).props['aria-label'];
const refreshButton = panel => panel.nodes(dialog(panel)).find(node => node.type === 'button' && panel.text(node).startsWith('Refresh quota'));

test('manual refresh updates the snapshot with exactly one vendor request per account', async () => {
  const f = fixture();
  const panel = await panelHarness({ ...f, quota: true });
  try {
    assert.deepEqual(f.quotaCalls, ['openai-codex', 'kimi-coding'], 'mount reads each supported account once');
    assert.ok(label(panel).includes('40%'), label(panel));
    trigger(panel).props.onClick(); await panel.flush();
    assert.deepEqual(f.quotaCalls, ['openai-codex', 'kimi-coding'], 'opening the popover reuses the fresh snapshot');
    refreshButton(panel).props.onClick(); await panel.flush();
    assert.deepEqual(f.quotaCalls, ['openai-codex', 'kimi-coding', 'openai-codex', 'kimi-coding'],
      'force refresh calls the vendor once, then the narrow read uses the cache');
    assert.ok(label(panel).includes('30%'), label(panel));
    assert.ok(!panel.text(dialog(panel)).includes('Could not fetch quota'));
  } finally { f.api.dispose(); panel.dispose(); }
});

test('a connected account without a quota endpoint is never force-refreshed and produces no error', async () => {
  const f = fixture();
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    const before = f.quotaCalls.length;
    refreshButton(panel).props.onClick(); await panel.flush();
    assert.equal(f.quotaCalls.length, before + 2, 'only the two supported accounts hit their vendors');
    assert.ok(!f.quotaCalls.includes('xai'));
    const text = panel.text(dialog(panel));
    assert.ok(!text.includes('Grok'), text);
    assert.ok(!text.includes('quota endpoint') && !text.includes('Unsupported'), text);
  } finally { f.api.dispose(); panel.dispose(); }
});

test('a failed force refresh keeps eligibility so the next click retries immediately', async () => {
  const f = fixture();
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    f.failNext('kimi-coding');
    refreshButton(panel).props.onClick(); await panel.flush();
    assert.ok(panel.text(dialog(panel)).includes('Could not fetch quota'), panel.text(dialog(panel)));
    assert.equal(f.quotaCalls.filter(id => id === 'kimi-coding').length, 2, 'first force failed at the vendor');
    refreshButton(panel).props.onClick(); await panel.flush();
    assert.equal(f.quotaCalls.filter(id => id === 'kimi-coding').length, 3, 'the retry asks the vendor again');
    assert.ok(!panel.text(dialog(panel)).includes('Could not fetch quota'));
    assert.ok(label(panel).includes('20%'), label(panel));
  } finally { f.api.dispose(); panel.dispose(); }
});
