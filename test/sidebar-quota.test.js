// small/spec — sidebar quota gauge. Synthetic HTTP responses; no inference.
import assert from 'node:assert/strict';
import test from 'node:test';
import { panelHarness } from './panel-harness.js';

const at = value => Date.parse(value);
const window = (id, usedPercent, resetsAt, windowSeconds) => ({ id, usedPercent, resetsAt: at(resetsAt), windowSeconds });
const ready = (windows, updatedAt = '2026-11-10T15:24:57Z') => ({ source: 'account', state: 'ready', error: null, updatedAt: at(updatedAt), stale: false, windows });
const unavailable = { source: 'none', state: 'unsupported', error: null, updatedAt: null, stale: false, windows: [] };
const unloaded = { source: 'none', state: 'unloaded', error: null, updatedAt: null, stale: false, windows: [] };
const accountUnloaded = { source: 'account', state: 'unloaded', error: null, updatedAt: null, stale: false, windows: [] };

const openai = ready([window('limit_5h', 25, '2026-11-11T02:00:00Z', 18000), window('limit_7d', 60, '2026-11-16T02:00:00Z', 604800)]);
const kimi = ready([window('limit_5h', 10, '2026-11-11T02:00:00Z', 18000)]);
const opencode = ready([window('limit_5h', 80, '2026-11-11T02:00:00Z', 18000),
  window('limit_7d', 80, '2026-11-16T02:00:00Z', 604800), window('limit_month_total', 80, '2026-12-10T02:00:00Z', null)]);

function reply(value) {
  return { ok: true, json: async () => JSON.parse(JSON.stringify(value)) };
}

function fixture({ fail = false, failQuotaOnce = false, revokeOnForce = false, opencodeQuota = false, xaiConfigured = false, xaiQuota = unloaded } = {}) {
  const calls = [];
  const quotas = { 'openai-codex': openai, 'kimi-coding': kimi, xai: xaiQuota,
    'opencode-go': opencodeQuota ? opencode : unloaded };
  let pendingFailure = failQuotaOnce;
  const fetch = async (url, options) => {
    const input = JSON.parse(options.body);
    calls.push(input);
    if (fail) throw new Error('REQUEST_FAILED');
    if (input.action === 'quota') {
      if (pendingFailure) { pendingFailure = false; return { ok: false, json: async () => ({ error: 'QUOTA_FAILED' }) }; }
      if (revokeOnForce && input.provider === 'openai-codex') {
        quotas[input.provider] = accountUnloaded;
        return { ok: false, json: async () => ({ error: 'MISSING_CREDENTIAL' }) };
      }
      const source = quotas[input.provider];
      if (source.source !== 'account' || source.state === 'unsupported') {
        return { ok: false, json: async () => ({ error: 'QUOTA_UNSUPPORTED' }) };
      }
      quotas[input.provider] = { ...source, windows: source.windows.map(item => ({ ...item, usedPercent: Math.min(100, item.usedPercent + 10) })) };
      return reply({ ok: true });
    }
    const configured = input.provider === 'xai' ? xaiConfigured
      : input.provider === 'opencode-go' ? opencodeQuota
      : quotas[input.provider].state !== 'unloaded';
    return reply({ provider: input.provider, configured, quota: quotas[input.provider] });
  };
  return { fetch, calls, quotas };
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
    const bars = panel.nodes(open).filter(node => node.props?.className === 'sl-quota-bar');
    assert.equal(bars.length, 3, 'one bar per quota window');
    assert.deepEqual(bars.map(bar => bar.props.role), ['progressbar', 'progressbar', 'progressbar']);
    assert.deepEqual(bars.map(bar => bar.props['aria-valuenow']), [75, 40, 90]);
    const fills = bars.map(bar => panel.nodes(bar).find(node => node.props?.className === 'sl-quota-bar-fill'));
    assert.deepEqual(fills.map(fill => fill.props.style.width), ['75%', '40%', '90%'], 'fill width follows remaining quota');
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

test('refresh forces connected supported accounts then reads their fresh snapshot', async () => {
  const f = fixture();
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    f.calls.length = 0;
    const button = panel.nodes(dialog(panel)).find(node => node.type === 'button' && panel.text(node).startsWith('Refresh quota'));
    assert.ok(button, 'refresh button in the popover');
    button.props.onClick(); await panel.flush();
    const calls = provider => f.calls.filter(call => call.provider === provider).map(call => call.action);
    assert.deepEqual(calls('openai-codex'), ['quota', 'quota-state']);
    assert.deepEqual(calls('kimi-coding'), ['quota', 'quota-state']);
    assert.deepEqual(calls('xai'), ['quota-state']);
    assert.deepEqual(calls('opencode-go'), ['quota-state']);
    assert.ok(label(panel).includes('30%'), label(panel));
  } finally { panel.dispose(); }
});

test('a connected account without a quota endpoint is never force-refreshed and stays error-free', async () => {
  const f = fixture({ xaiConfigured: true, xaiQuota: unavailable });
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    const callsBefore = f.calls.length;
    const button = panel.nodes(dialog(panel)).find(node => node.type === 'button' && panel.text(node).startsWith('Refresh quota'));
    button.props.onClick(); await panel.flush();
    assert.deepEqual(f.calls.slice(callsBefore).filter(call => call.provider === 'xai').map(call => call.action), ['quota-state']);
    const text = panel.text(dialog(panel));
    assert.ok(!text.includes('Grok'), text);
    assert.ok(!text.includes('quota endpoint') && !text.includes('额度接口'), text);
  } finally { panel.dispose(); }
});

test('a transient quota failure still allows an immediate retry', async () => {
  const f = fixture({ failQuotaOnce: true });
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    const button = () => panel.nodes(dialog(panel)).find(node => node.type === 'button' && panel.text(node).startsWith('Refresh quota'));
    button().props.onClick(); await panel.flush();
    assert.ok(panel.text(dialog(panel)).includes('Could not fetch quota'), panel.text(dialog(panel)));
    button().props.onClick(); await panel.flush();
    const actions = f.calls.filter(call => call.provider === 'openai-codex').map(call => call.action);
    assert.equal(actions.filter(action => action === 'quota').length, 2, 'the failed force and the retry each asked the vendor');
    assert.deepEqual(actions.slice(-2), ['quota', 'quota-state'], 'the retry reads the fresh snapshot');
    assert.ok(label(panel).includes('30%'), label(panel));
    assert.ok(!panel.text(dialog(panel)).includes('Could not fetch quota'));
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

test('a revoked force drops eligibility and clears the error row with one narrow reread', async () => {
  const f = fixture({ revokeOnForce: true });
  const panel = await panelHarness({ ...f, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    f.calls.length = 0;
    const button = () => panel.nodes(dialog(panel)).find(node => node.type === 'button' && panel.text(node).startsWith('Refresh quota'));
    button().props.onClick(); await panel.flush();
    const text = panel.text(dialog(panel));
    assert.ok(!text.includes('OpenAI · ChatGPT'), 'the revoked account row is gone');
    assert.ok(!text.includes('Could not fetch'), text);
    assert.deepEqual(f.calls.filter(call => call.provider === 'openai-codex').map(call => call.action), ['quota', 'quota-state']);
    f.calls.length = 0;
    button().props.onClick(); await panel.flush();
    assert.deepEqual(f.calls.filter(call => call.provider === 'openai-codex').map(call => call.action), ['quota-state']);
  } finally { panel.dispose(); }
});

test('a superseded refresh cannot rewrite force eligibility', async () => {
  const calls = [];
  const stale = Promise.withResolvers();
  let phase = 'mount';
  const snapshot = configured => ({ provider: 'openai-codex', configured, quota: configured ? openai : unloaded });
  const fetch = async (url, options) => {
    const input = JSON.parse(options.body); calls.push(input);
    if (input.provider !== 'openai-codex') return reply({ provider: input.provider, configured: false, quota: unloaded });
    if (input.action === 'quota') {
      if (phase === 'stale') { await stale.promise; return reply({ ok: true }); }
      if (phase === 'fail') return { ok: false, json: async () => ({ error: 'QUOTA_FAILED' }) };
      return reply({ ok: true });
    }
    return reply(snapshot(phase !== 'stale'));
  };
  const panel = await panelHarness({ fetch, quota: true });
  try {
    trigger(panel).props.onClick(); await panel.flush();
    const button = () => panel.nodes(dialog(panel)).find(node => node.type === 'button' && panel.text(node).startsWith('Refresh quota'));
    phase = 'stale';
    const first = button().props.onClick();
    phase = 'fail';
    const second = button().props.onClick();
    await second; await panel.flush();
    phase = 'stale';
    stale.resolve(); await first; await panel.flush();
    calls.length = 0;
    phase = 'retry';
    button().props.onClick(); await panel.flush();
    assert.deepEqual(calls.filter(call => call.provider === 'openai-codex').map(call => call.action), ['quota', 'quota-state'],
      'eligibility comes from the accepted generation, not the superseded response');
  } finally { panel.dispose(); }
});
