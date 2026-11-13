// small/spec — sidebar quota gauge. Synthetic HTTP responses; no inference.
import assert from 'node:assert/strict';
import test from 'node:test';
import { panelHarness } from './panel-harness.js';

const at = value => Date.parse(value);
const window = (id, usedPercent, resetsAt, windowSeconds) => ({ id, usedPercent, resetsAt: at(resetsAt), windowSeconds });
const ready = (windows, updatedAt = '2026-11-10T15:24:57Z') => ({ source: 'account', state: 'ready', error: null, updatedAt: at(updatedAt), stale: false, windows });
const unavailable = { source: 'none', state: 'unsupported', error: null, updatedAt: null, stale: false, windows: [] };
const unloaded = { source: 'none', state: 'unloaded', error: null, updatedAt: null, stale: false, windows: [] };

const openai = ready([window('limit_5h', 25, '2026-11-11T02:00:00Z', 18000), window('limit_7d', 60, '2026-11-16T02:00:00Z', 604800)]);
const kimi = ready([window('limit_5h', 10, '2026-11-11T02:00:00Z', 18000)]);
const opencode = ready([window('limit_5h', 80, '2026-11-11T02:00:00Z', 18000),
  window('limit_7d', 80, '2026-11-16T02:00:00Z', 604800), window('limit_month_total', 80, '2026-12-10T02:00:00Z', null)]);

function reply(value) {
  return { ok: true, json: async () => JSON.parse(JSON.stringify(value)) };
}

function fixture({ fail = false, opencodeQuota = false, xaiConfigured = false, xaiQuota = unloaded } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    const input = JSON.parse(options.body);
    calls.push(input);
    if (fail) throw new Error('REQUEST_FAILED');
    const current = { 'openai-codex': { provider: 'openai-codex', configured: true, quota: openai },
      'kimi-coding': { provider: 'kimi-coding', configured: true, quota: kimi },
      xai: { provider: 'xai', configured: xaiConfigured, quota: xaiQuota },
      'opencode-go': { provider: 'opencode-go', configured: opencodeQuota, quota: opencodeQuota ? opencode : unloaded } };
    if (input.action === 'quota') {
      const source = input.provider === 'opencode-go' ? opencode : input.provider === 'xai' ? xaiQuota : openai;
      const windows = source.windows.map(item => ({ ...item, usedPercent: Math.min(100, item.usedPercent + 10) }));
      return reply({ ...current[input.provider], configured: true, quota: { ...source, windows } });
    }
    return reply(current[input.provider]);
  };
  return { fetch, calls };
}

const trigger = panel => panel.nodes().find(node => node.props?.className === 'slq-trigger');
const dialog = panel => panel.nodes().find(node => node.props?.role === 'dialog');
const label = panel => trigger(panel).props['aria-label'];

test('sidebar icon reports the lowest remaining quota across connected accounts', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture();
    const panel = await panelHarness({ ...f, quota: true, language });
    try {
      const icon = trigger(panel);
      assert.ok(icon, 'gauge renders in the sidebar footer');
      assert.equal(panel.text(icon), '', 'the trigger is icon-only');
      assert.ok(label(panel).includes('40%'), label(panel));
      assert.equal(icon.props.title, label(panel));
      assert.deepEqual(f.calls.map(call => call.action), ['quota-state', 'quota-state', 'quota-state', 'quota-state']);
      assert.deepEqual(f.calls.map(call => call.provider), ['openai-codex', 'kimi-coding', 'xai', 'opencode-go']);
    } finally { panel.dispose(); }
  }
});

test('hovering the gauge lists every connected account with remaining quota and reset times', async () => {
  const f = fixture();
  const panel = await panelHarness({ ...f, quota: true });
  try {
    assert.equal(dialog(panel), undefined);
    trigger(panel).props.onMouseEnter(); await panel.flush();
    const open = dialog(panel);
    assert.ok(open, 'hover opens the popover');
    const text = panel.text(open);
    assert.ok(text.includes('OpenAI · ChatGPT') && text.includes('Kimi Code'), text);
    assert.ok(text.includes('5-hour limit'), text);
    assert.ok(text.includes('40% remaining') && text.includes('90% remaining'), text);
    assert.ok(text.includes('Resets:'), text);
    assert.ok(text.includes('11/11/2026'), text);
    open.props.onMouseEnter();
    open.props.onMouseLeave();
    trigger(panel).props.onMouseLeave();
    await panel.poll();
    assert.equal(dialog(panel), undefined, 'leaving closes after the delay');
  } finally { panel.dispose(); }
});

test('OpenCode Go appears only when its quota source is configured', async () => {
  const f = fixture({ opencodeQuota: true });
  const panel = await panelHarness({ ...f, quota: true });
  try {
    assert.ok(label(panel).includes('20%'), label(panel));
    trigger(panel).props.onClick(); await panel.flush();
    const text = panel.text(dialog(panel));
    assert.ok(text.includes('OpenCode Go'), text);
    assert.ok(text.includes('20% remaining'), text);
    assert.ok(text.includes('Monthly total'), text);
  } finally { panel.dispose(); }
});

test('unconnected accounts stay out of the quota popover', async () => {
  const f = fixture();
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    const text = panel.text(dialog(panel));
    assert.ok(text.includes('OpenAI · ChatGPT') && text.includes('Kimi Code'), text);
    assert.ok(!text.includes('Grok') && !text.includes('Not connected'), text);
  } finally { panel.dispose(); }
});

test('accounts without a quota endpoint are omitted from the gauge and popover', async () => {
  const f = fixture({ xaiConfigured: true, xaiQuota: unavailable });
  const panel = await panelHarness({ ...f, quota: true });
  try {
    assert.ok(label(panel).includes('40%'), label(panel));
    trigger(panel).props.onClick(); await panel.flush();
    const text = panel.text(dialog(panel));
    assert.ok(text.includes('OpenAI · ChatGPT') && text.includes('Kimi Code'), text);
    assert.ok(!text.includes('Grok'), text);
    assert.ok(!text.includes('Unsupported') && !text.includes('不支持'), text);
  } finally { panel.dispose(); }
});

test('refresh forces quota for connected accounts and keeps others on the narrow read', async () => {
  const f = fixture();
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    f.calls.length = 0;
    const button = panel.nodes(dialog(panel)).find(node => node.type === 'button' && panel.text(node).startsWith('Refresh quota'));
    assert.ok(button, 'refresh button in the popover');
    button.props.onClick(); await panel.flush();
    assert.deepEqual(f.calls, [{ action: 'quota', provider: 'openai-codex' }, { action: 'quota', provider: 'kimi-coding' },
      { action: 'quota-state', provider: 'xai' }, { action: 'quota-state', provider: 'opencode-go' }]);
    assert.ok(label(panel).includes('30%'), label(panel));
  } finally { panel.dispose(); }
});

test('failures read as unavailable and the popover says so instead of a percentage', async () => {
  const f = fixture({ fail: true });
  const panel = await panelHarness({ ...f, quota: true, language: 'zh' });
  try {
    assert.ok(label(panel).includes('不可用'), label(panel));
    trigger(panel).props.onClick(); await panel.flush();
    const text = panel.text(dialog(panel));
    assert.ok(text.includes('OpenAI · ChatGPT') && text.includes('请求未完成'), text);
  } finally { panel.dispose(); }
});
