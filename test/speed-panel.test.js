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
    assert.ok(select); assert.equal(select.props.value, 'default'); assert.equal(select.props.children.length, 1);
    assert.equal(panel.nodes().some(node => node.type === 'button'), false);
  } finally { pending.resolve(); panel.dispose(); }
});

test('changing models never reuses another model’s Speed options or selection', async () => {
  const server = fixture(), panel = await panelHarness(server);
  try {
    await panel.nodes().find(node => node.type === 'select').props.onChange({ target: { value: 'priority' } }); await panel.flush();
    server.setModel('subscription-kimi-coding', 'kimi-model'); await panel.rerender();
    let select = panel.nodes().find(node => node.type === 'select');
    assert.equal(select.props.disabled, true); assert.equal(select.props.value, 'default');
    assert.equal(select.props.children.length, 1);
    server.setModel('subscription-openai-codex', 'tiered-model'); await panel.rerender();
    select = panel.nodes().find(node => node.type === 'select');
    assert.equal(select.props.value, 'priority');
    server.setModel('unrelated-api-provider', 'other-model'); await panel.rerender();
    assert.equal(panel.tree, null);
  } finally { panel.dispose(); }
});
