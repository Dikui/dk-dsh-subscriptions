import assert from 'node:assert/strict';
import test from 'node:test';
import { panelHarness } from './panel-harness.js';

// small/spec — composer quota badge. Synthetic model directory and HTTP; no inference.
function fixture({ answer } = {}) {
  let current = { provider: 'subscription-openai-codex', model: 'gpt-5' };
  const calls = [], listeners = new Set();
  const resets = Date.UTC(2026, 10, 10, 20, 0);
  const directory = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => ({ current, pending: null }),
  };
  const ready = (id, windows) => ({ source: 'account', state: 'ready', error: null, stale: false,
    updatedAt: Date.UTC(2026, 10, 10, 19, 0), windows });
  const quotas = {
    'openai-codex': ready('openai-codex', [
      { id: 'limit_5h', usedPercent: 25, windowSeconds: 18000, resetsAt: resets },
      { id: 'limit_7d', usedPercent: 60, windowSeconds: 604800, resetsAt: resets + 604800000 },
    ]),
    'kimi-coding': ready('kimi-coding', [{ id: 'limit_5h', usedPercent: 10, windowSeconds: 18000, resetsAt: resets }]),
    xai: { source: 'none', state: 'unsupported', error: null, updatedAt: null, stale: false, windows: [] },
  };
  return {
    calls,
    quota: { directory, load() {} },
    setModel(provider, model = 'model') { current = { provider, model }; for (const listener of listeners) listener(); },
    async fetch(path, options) {
      assert.equal(path, '/api/subscriptions-lite');
      assert.equal(options.method, 'POST');
      const input = JSON.parse(options.body); calls.push(input);
      if (answer) return answer(input, calls);
      return Response.json({ provider: input.provider, configured: true, quota: quotas[input.provider] });
    },
    quotas,
  };
}

const trigger = panel => panel.nodes().find(node => node.props?.className === 'slq-trigger');
const dialog = panel => panel.nodes().find(node => node.props?.role === 'dialog');

test('composer badge shows the lowest remaining quota of the current subscription account', async () => {
  for (const language of ['en', 'zh']) {
    for (const [route, expected] of [['subscription-openai-codex', language === 'zh' ? '额度40%' : 'Quota40%'],
      ['subscription-kimi-coding', language === 'zh' ? '额度90%' : 'Quota90%']]) {
      const f = fixture(); f.setModel(route, 'model');
      const panel = await panelHarness({ ...f, language });
      try {
        const badge = trigger(panel);
        assert.ok(badge, 'badge renders next to the model selector');
        assert.equal(panel.text(badge), expected);
        assert.equal(badge.props['aria-haspopup'], 'dialog');
        assert.equal(badge.props['aria-expanded'], false);
        assert.deepEqual(f.calls, [{ action: 'quota-state', provider: route === 'subscription-kimi-coding' ? 'kimi-coding' : 'openai-codex' }]);
        assert.equal(panel.nodes().some(node => node.props?.role === 'dialog'), false);
      } finally { panel.dispose(); }
    }
  }
});

test('badge stays out of unrelated models and does not request quota for them', async () => {
  const f = fixture(); f.setModel('deepseek', 'deepseek-chat');
  const panel = await panelHarness(f);
  try {
    assert.equal(panel.tree, null);
    assert.deepEqual(f.calls, []);
  } finally { panel.dispose(); }
});

test('opening the popover lists limits, reset times and updates from the same snapshot', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture();
    const panel = await panelHarness({ ...f, language });
    try {
      trigger(panel).props.onClick(); await panel.flush();
      const popover = dialog(panel);
      assert.ok(popover, 'expanded dialog');
      assert.equal(trigger(panel).props['aria-expanded'], true);
      const text = panel.text(popover);
      for (const part of language === 'zh'
        ? ['5 小时限额', '剩余 75%', '重置', '7 天限额', '剩余 40%', '更新于']
        : ['5-hour limit', '75% remaining', 'Resets', '7-day limit', '40% remaining', 'Updated']) {
        assert.ok(text.includes(part), `missing "${part}" in ${text}`);
      }
      assert.equal(f.calls.filter(call => call.action === 'quota-state').length, 2, 'opening refreshes through the narrow read');
      const refresh = panel.nodes().find(node => node.type === 'button' && panel.text(node).startsWith(language === 'zh' ? '刷新额度' : 'Refresh quota'));
      assert.ok(refresh, 'manual refresh is offered');
      await refresh.props.onClick(); await panel.flush();
      assert.deepEqual(f.calls.at(-1), { action: 'quota', provider: 'openai-codex' }, 'manual refresh forces quota discovery');
    } finally { panel.dispose(); }
  }
});

test('unsupported, disconnected and failing accounts read as such instead of a false percentage', async () => {
  const unsupported = fixture(); unsupported.setModel('subscription-xai', 'grok-4');
  const grok = await panelHarness(unsupported);
  try {
    assert.equal(panelText(grok), 'QuotaUnsupported');
    trigger(grok).props.onClick(); await grok.flush();
    assert.equal(panelText(grok), 'QuotaUnsupported');
    assert.ok(grok.text(dialog(grok)).includes('No verified OAuth quota endpoint'));
    assert.equal(grok.nodes().some(node => node.type === 'button' && node.props.className !== 'slq-close' && grok.text(node).includes('Refresh quota')), false,
      'nothing to refresh without a verified endpoint');
  } finally { grok.dispose(); }

  const disconnected = fixture({ answer: input => Response.json({ provider: input.provider, configured: false,
    quota: { source: 'none', state: 'unloaded', error: null, updatedAt: null, stale: false, windows: [] } }) });
  const offline = await panelHarness(disconnected);
  try {
    assert.equal(panelText(offline), 'QuotaNot connected');
    trigger(offline).props.onClick(); await offline.flush();
    assert.ok(offline.text(dialog(offline)).includes('Connect to load quota'));
    assert.equal(offline.nodes().some(node => node.type === 'button' && offline.text(node).includes('Refresh quota')), false);
  } finally { offline.dispose(); }

  const failing = fixture({ answer: () => Response.json({ error: 'QUOTA_DENIED' }, { status: 400 }) });
  const error = await panelHarness(failing);
  try {
    assert.equal(panelText(error), 'QuotaUnavailable');
    trigger(error).props.onClick(); await error.flush();
    const text = error.text(dialog(error));
    assert.ok(text.includes('Quota endpoint rejected this credential'), text);
    const retry = error.nodes().find(node => node.type === 'button' && error.text(node).includes('Refresh quota'));
    assert.ok(retry, 'the user can retry after reconnecting');
    await retry.props.onClick(); await error.flush();
    assert.deepEqual(failing.calls.at(-1), { action: 'quota', provider: 'openai-codex' });
  } finally { error.dispose(); }
});

test('a reply for a provider the user already left never replaces the current account badge', async () => {
  const gates = new Map();
  const f = fixture({ answer: async input => {
    await new Promise(resolve => gates.set(input.provider, resolve));
    return Response.json({ provider: input.provider, configured: true, quota: f.quotas[input.provider] });
  } });
  const panel = await panelHarness(f);
  try {
    assert.equal(panelText(panel), 'Quota\u2026');
    f.setModel('subscription-kimi-coding', 'kimi-k2'); await panel.rerender();
    gates.get('kimi-coding')(); await panel.flush();
    assert.equal(panelText(panel), 'Quota90%');
    gates.get('openai-codex')(); await panel.flush();
    assert.equal(panelText(panel), 'Quota90%', 'stale OpenAI reply is ignored after switching to Kimi');
  } finally { panel.dispose(); }
});

function panelText(panel) {
  return panel.text(trigger(panel));
}
