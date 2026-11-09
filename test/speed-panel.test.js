import assert from 'node:assert/strict';
import test from 'node:test';
import { panelHarness } from './panel-harness.js';

// small/spec — user-requested per-model Speed UI. Synthetic directory/HTTP replace host; no inference.
function fixture() {
  let current = { provider: 'subscription-openai-codex', model: 'tiered-model' };
  const saved = new Map(), calls = [];
  return {
    calls,
    speed: { sessionId: 'session-a', directory: { subscribe: () => () => {}, getSnapshot: () => ({ current, pending: null }) }, load() {} },
    setModel(provider, model) { current = { provider, model }; },
    async fetch(path, options) {
      assert.equal(path, '/api/subscriptions-lite/speed');
      assert.equal(options.method, 'POST');
      const input = JSON.parse(options.body); calls.push(input);
      const key = [input.sessionId, input.provider, input.model].join('/');
      if (input.action === 'speed-select') saved.set(key, input.tier);
      return Response.json({ sessionId: input.sessionId, provider: input.provider, model: input.model,
        selected: saved.get(key) ?? 'default', stale: false,
        tiers: input.model === 'tiered-model' ? [{ id: 'default', name: 'Normal' }, { id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }]
          : input.provider === 'subscription-xai' ? [{ id: 'default', name: 'Normal' }, { id: 'priority', name: 'Priority' }]
            : [{ id: 'default', name: 'Normal' }],
      });
    },
  };
}

test('selecting Fast or Ultrafast saves directly without a confirmation popup', async () => {
  for (const language of ['en', 'zh']) {
    for (const tier of ['priority', 'ultrafast']) {
      const server = fixture(); let confirmations = 0;
      const panel = await panelHarness({ ...server, language, confirm: () => { confirmations++; return false; } });
      try {
        assert.equal(panel.nodes().some(node => node.type === 'label'), false, 'no visible Speed heading');
        const select = panel.nodes().find(node => node.type === 'select');
        assert.deepEqual(select.props.children.map(node => node.props.value), ['default', 'priority', 'ultrafast']);
        assert.equal(select.props.value, 'default');
        await select.props.onChange({ target: { value: tier } }); await panel.flush();
        assert.equal(confirmations, 0);
        assert.equal(server.calls.filter(call => call.action === 'speed-select').length, 1);
        assert.equal(panel.nodes().find(node => node.type === 'select').props.value, tier);
      } finally { panel.dispose(); }
    }
  }
});

// small/regression — reported missing Speed: default-only metadata must not remove the indicator.
test('default-only models retain a visible speed indicator without offering invented tiers', async () => {
  for (const [provider, model] of [
    ['subscription-openai-codex', 'default-codex-model'],
    ['subscription-kimi-coding', 'kimi-for-coding'],
  ]) {
    for (const language of ['en', 'zh']) {
      const server = fixture(); server.setModel(provider, model);
      const panel = await panelHarness({ ...server, language });
      try {
        const select = panel.nodes().find(node => node.type === 'select');
        assert.ok(select, 'default speed remains visible');
        assert.equal(panel.text(panel.nodes().find(node => node.props.className === 'sl-speed-value')), language === 'en' ? 'Normal' : '正常');
        assert.equal(select.props.disabled, true);
        assert.equal(select.props.children.length, 1);
        assert.equal(select.props.value, 'default');
        assert.equal(panel.nodes().some(node => node.props.className === 'sl-speed-chevron'), false);
        assert.equal(panel.nodes().some(node => node.type === 'label'), false);
        assert.equal(server.calls.some(call => call.action === 'speed-select'), false);
      } finally { panel.dispose(); }
    }
  }
});

// small/regression — reported Speed flicker; a delayed synthetic save replaces HTTP/storage.
test('saving Speed shows the chosen tier without transient toolbar text', async () => {
  for (const language of ['en', 'zh']) {
    const server = fixture(), pending = Promise.withResolvers();
    const panel = await panelHarness({ ...server, language, fetch: async (path, options) => {
      if (JSON.parse(options.body).action === 'speed-select') await pending.promise;
      return server.fetch(path, options);
    } });
    let savingWork;
    try {
      savingWork = panel.nodes().find(node => node.type === 'select').props.onChange({ target: { value: 'priority' } });
      await panel.flush();
      const savingSelect = panel.nodes().find(node => node.type === 'select');
      assert.equal(savingSelect.props.value, 'priority');
      assert.equal(panel.text(panel.nodes().find(node => node.props.className === 'sl-speed-value')), 'Fast',
        'the visible tier updates immediately, not only the transparent select');
      assert.equal(panel.nodes().some(node => node.props.role === 'status'), false,
        'saving must not insert visible loading/saving text that shifts the toolbar');
      assert.equal(savingSelect.props.disabled, true, 'prevent overlapping saves');
      pending.resolve(); await savingWork; await panel.flush();
      assert.equal(panel.nodes().find(node => node.type === 'select').props.value, 'priority');
      assert.equal(panel.nodes().find(node => node.type === 'select').props.disabled, false);
    } finally { pending.resolve(); await savingWork; panel.dispose(); }
  }
});

// small/regression — optimistic Speed must not claim persistence when the synthetic HTTP save fails.
test('a failed Speed save reports an error and retry restores the persisted tier', async () => {
  const server = fixture();
  const panel = await panelHarness({ ...server, fetch: async (path, options) => {
    if (JSON.parse(options.body).action === 'speed-select') return Response.json({ error: 'SAVE_FAILED' }, { status: 500 });
    return server.fetch(path, options);
  } });
  try {
    await panel.nodes().find(node => node.type === 'select').props.onChange({ target: { value: 'priority' } });
    await panel.flush();
    assert.equal(panel.nodes().some(node => node.type === 'select'), false);
    await panel.click('Speed unavailable · retry', null);
    assert.equal(panel.nodes().find(node => node.type === 'select').props.value, 'default');
  } finally { panel.dispose(); }
});

test('a late save response cannot replace the newly selected model’s Speed', async () => {
  const server = fixture();
  const pending = Promise.withResolvers();
  let saving = false;
  const panel = await panelHarness({ ...server, fetch: async (path, options) => {
    if (JSON.parse(options.body).action === 'speed-select') { saving = true; await pending.promise; }
    return server.fetch(path, options); // Deliberately ignore abort to test generation protection.
  } });
  try {
    const savingWork = panel.nodes().find(node => node.type === 'select').props.onChange({ target: { value: 'priority' } });
    await panel.flush(); assert.equal(saving, true);
    server.setModel('subscription-kimi-coding', 'kimi-model'); await panel.rerender();
    pending.resolve(); await savingWork; await panel.flush();
    const select = panel.nodes().find(node => node.type === 'select');
    assert.ok(select, 'keep the default speed indicator after switching to a model with no extra tiers');
    assert.equal(select.props.value, 'default');
    assert.equal(select.props.disabled, true);
    assert.equal(panel.nodes().some(node => node.type === 'button'), false);
  } finally { pending.resolve(); panel.dispose(); }
});

// small/spec — user clarification: the host's resolved capability, not a client vendor list, owns the control.
test('the toolbar uses resolved Speed tiers for both model and request capability sources', async () => {
  const server = fixture(), panel = await panelHarness(server);
  try {
    server.setModel('subscription-xai', 'grok-model'); await panel.rerender();
    let select = panel.nodes().find(node => node.type === 'select');
    assert.deepEqual(select.props.children.map(node => panel.text(node)), ['Normal', 'Priority']);
    await select.props.onChange({ target: { value: 'priority' } }); await panel.flush();
    assert.equal(panel.nodes().find(node => node.type === 'select').props.value, 'priority');
    server.setModel('subscription-another-vendor', 'tiered-model'); await panel.rerender();
    select = panel.nodes().find(node => node.type === 'select');
    assert.ok(select, 'a host-advertised model capability needs no additional client vendor entry');
    assert.deepEqual(select.props.children.map(node => node.props.value), ['default', 'priority', 'ultrafast']);
    server.setModel('subscription-kimi-coding', 'kimi-for-coding'); await panel.rerender();
    select = panel.nodes().find(node => node.type === 'select');
    assert.equal(select.props.value, 'default');
    assert.equal(select.props.disabled, true);
    assert.equal(panel.nodes().some(node => node.props.className === 'sl-speed-chevron'), false);
    assert.equal(server.calls.at(-1).action, 'speed-state');
  } finally { panel.dispose(); }
});

test('changing models never reuses another model’s Speed options or selection', async () => {
  const server = fixture(), panel = await panelHarness(server);
  try {
    await panel.nodes().find(node => node.type === 'select').props.onChange({ target: { value: 'priority' } }); await panel.flush();
    server.setModel('subscription-kimi-coding', 'kimi-model'); await panel.rerender();
    const defaultSelect = panel.nodes().find(node => node.type === 'select');
    assert.equal(defaultSelect.props.value, 'default');
    assert.equal(defaultSelect.props.children.length, 1, 'Kimi does not inherit Codex tiers');
    assert.equal(defaultSelect.props.disabled, true);
    server.setModel('subscription-openai-codex', 'tiered-model'); await panel.rerender();
    const select = panel.nodes().find(node => node.type === 'select');
    assert.equal(select.props.value, 'priority');
    server.setModel('unrelated-api-provider', 'other-model'); await panel.rerender();
    assert.equal(panel.tree, null);
  } finally { panel.dispose(); }
});
