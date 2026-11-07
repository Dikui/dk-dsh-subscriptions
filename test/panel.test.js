import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialStatus, panelHarness } from './panel-harness.js';

// www.kimi.com is the observed verification origin; path/code are synthetic.
const url = 'https://www.kimi.com/code/oauth?user_code=TEST-CODE';
const notice = { message: 'Open this page and enter the code.', url, code: 'TEST-CODE' };
function makePopup(replace = () => {}) {
  const meta = [];
  const document = { title: '', body: { textContent: '' }, head: { append: value => meta.push(value) }, createElement: () => ({}) };
  return { closed: false, opener: {}, document, meta, location: { href: 'about:blank', replace }, close() { this.closed = true; } };
}
function flowServer(provider = 'kimi-coding') {
  let attempt = null;
  const events = [];
  return {
    events,
    setNotices(notices = [notice]) { attempt = { ...attempt, notices }; },
    fail() { attempt = { ...attempt, state: 'failed', error: 'REQUEST_FAILED' }; },
    restore() { attempt = { id: 'existing-attempt', state: 'running', notices: [notice], prompt: null }; },
    fetch: async (path, options = {}) => {
      assert.equal(path, '/api/subscriptions-lite');
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        events.push(body.action);
        if (body.action === 'login') {
          attempt = { id: 'new-attempt', state: 'running', notices: [], prompt: null };
          return Response.json(attempt);
        }
        if (body.action === 'cancel') { attempt = { ...attempt, state: 'cancelled' }; return Response.json({ ok: true }); }
      }
      return Response.json(initialStatus(attempt, provider));
    },
  };
}

// small/regression — user requested separate title-only subpages; status/HTTP are synthetic and billing stays available in collapsed details.
test('model connections and data tools occupy separate bilingual subpages', async () => {
  for (const language of ['en', 'zh']) {
    for (const enabled of [undefined, false, true]) {
      const state = initialStatus(); let requests = 0;
      if (enabled !== undefined) state.vendorTools = { kimiDatasource: { enabled } };
      const panel = await panelHarness({ language, fetch: async (path, options) => {
        assert.equal(path, '/api/subscriptions-lite'); assert.equal(options.method, 'GET'); requests++;
        return Response.json(state); // Navigation must never issue a Datasource or inference request.
      } });
      try {
        const labels = language === 'en' ? ['Model connections', 'Data tools'] : ['模型接入', '数据工具'];
        const toolTitle = language === 'en' ? 'Kimi data tools' : 'Kimi 数据工具';
        for (const label of [labels[0], labels[1], labels[0], labels[1]]) {
          await panel.click(label, null);
          const navigation = panel.nodes().find(node => node.type === 'nav');
          const buttons = panel.nodes(navigation).filter(node => node.type === 'button');
          assert.equal(buttons.length, 2);
          assert.equal(buttons.filter(node => node.props['aria-current'] === 'page').length, 1);
          assert.equal(panel.text(buttons.find(node => node.props['aria-current'] === 'page')), label);
          assert.ok(buttons.every(node => node.props.type === 'button')); // Native keyboard activation, no custom tab key handling.
          const page = panel.nodes().find(node => node.props.id === buttons[0].props['aria-controls']);
          assert.equal(page.props['aria-label'], label);
          const cards = panel.nodes(page).filter(node => node.type === 'article').map(node => node.props['aria-label']);
          assert.deepEqual(cards, label === labels[0] ? ['OpenAI · ChatGPT', 'Kimi Code', 'Grok'] : [toolTitle]);
          for (const card of panel.nodes(page).filter(node => node.type === 'article')) {
            const details = panel.nodes(card).filter(node => node.type === 'details');
            const folded = new Set(details.flatMap(node => panel.nodes(node)));
            assert.ok(details.every(node => !node.props.open));
            assert.ok(panel.nodes(card).filter(node => node.type === 'p' && !folded.has(node))
              .every(node => node.props.role === 'status'), 'default view contains statuses, not description paragraphs');
          }
        }
        const card = panel.within(toolTitle)[0], text = panel.text(card);
        assert.match(text, /ExtraUsage/);
        assert.match(text, enabled === undefined ? /Status unknown|状态未知/ : enabled ? /Enabled|已启用/ : /Disabled|已关闭/);
        assert.doesNotMatch(text, /GDP|kimi_get_data_source_desc|kimi_call_data_source_tool|config\.kimiDatasource/);
        assert.equal(panel.nodes(card).some(node => node.type === 'blockquote'), false);
        const details = panel.nodes(card).find(node => node.type === 'details');
        assert.ok(details); assert.ok(!details.props.open);
        assert.equal(panel.text(panel.nodes(details).find(node => node.type === 'summary')), language === 'en' ? 'Billing' : '费用说明');
        assert.match(panel.text(details), /ExtraUsage/);
        assert.equal(panel.nodes(card).some(node => node.type === 'select'), false);
        assert.equal(requests, 1, 'switching subpages does not reload the account or call paid tools');
      } finally { panel.dispose(); }
    }
  }
});

// small/spec — tool access shares Kimi OAuth; the connection shortcut only navigates, never starts OAuth.
test('Kimi tool credential guidance follows the shared OAuth status', async () => {
  for (const configured of [false, true]) {
    const state = initialStatus();
    state.vendorTools = { kimiDatasource: { enabled: true } };
    const kimi = state.providers.find(provider => provider.id === 'kimi-coding');
    kimi.configured = configured; kimi.credentialKind = configured ? 'grant' : null;
    const panel = await panelHarness({ fetch: async (_path, options) => {
      assert.equal(options.method, 'GET'); return Response.json(state);
    } });
    try {
      let focused = 0;
      panel.button('Model connections', null).props.ref.current = { focus() { focused++; } }; // Native focus target, not another authorization service.
      await panel.click('Data tools', null);
      const card = panel.within('Kimi data tools')[0];
      const status = panel.nodes(card).find(node => node.type === 'p' && node.props.role === 'status');
      assert.equal(panel.text(status), configured ? 'Connected' : 'Not connected');
      assert.equal(panel.nodes(card).some(node => node.type === 'button'), !configured);
      if (!configured) {
        await panel.click('Go to connections', 'Kimi data tools');
        assert.ok(panel.within('Kimi Code'));
        assert.equal(focused, 1);
      }
    } finally { panel.dispose(); }
  }
});

// small/regression — internal navigation must not unmount the owner of a pending OAuth flow.
test('switching subpages preserves a running authorization', async () => {
  const server = flowServer(), destinations = [];
  const panel = await panelHarness({ fetch: server.fetch, open: () => makePopup(value => destinations.push(value)) });
  try {
    await panel.click('Connect');
    await panel.click('Data tools', null);
    server.setNotices(); await panel.poll();
    assert.deepEqual(destinations, [url]);
    assert.equal(server.events.filter(event => event === 'login').length, 1);
    assert.equal(server.events.includes('cancel'), false);
    await panel.click('Model connections', null);
    assert.ok(panel.within('Kimi Code').some(node => node.type === 'a' && node.props.href === url));
    await panel.click('Cancel authorization');
    assert.equal(server.events.filter(event => event === 'cancel').length, 1);
  } finally { panel.dispose(); }
});

// small/spec — the two-subpage settings request must preserve the model chosen before navigation.
test('switching subpages preserves the selected model', async () => {
  const state = initialStatus();
  state.providers[1].models.push({ id: 'kimi-second', name: 'Second synthetic model' });
  const panel = await panelHarness({ fetch: async () => Response.json(state) });
  try {
    panel.within('Kimi Code').find(node => node.type === 'select').props.onChange({ target: { value: 'kimi-second' } });
    await panel.flush();
    await panel.click('Data tools', null);
    await panel.click('Model connections', null);
    assert.equal(panel.within('Kimi Code').find(node => node.type === 'select').props.value, 'kimi-second');
  } finally { panel.dispose(); }
});

test('Connect reserves a tab before the async request, then opens the trusted Kimi device URL', async () => {
  const server = flowServer();
  const destinations = [];
  let closed = false;
  const popup = makePopup(value => destinations.push(value));
  popup.close = () => { closed = true; popup.closed = true; };
  const panel = await panelHarness({ fetch: server.fetch, open: (value) => { server.events.push('open'); assert.equal(value, 'about:blank'); return popup; } });
  try {
    await panel.click('Connect');
    assert.deepEqual(server.events.slice(0, 2), ['open', 'login']);
    assert.equal(popup.opener, null);
    assert.equal(popup.meta[0].name, 'referrer'); assert.equal(popup.meta[0].content, 'no-referrer');
    assert.match(popup.document.body.textContent, /Preparing authorization/);
    assert.match(panel.text(), /[Pp]reparing.*authorization/);
    server.setNotices(); await panel.poll();
    assert.deepEqual(destinations, [url]);
    assert.ok(panel.within('Kimi Code').some(node => node.type === 'a' && node.props.href === url));
    await panel.poll(); assert.deepEqual(destinations, [url], 'do not launch a tab on every poll');
    await panel.click('Cancel authorization');
    assert.equal(closed, false, 'do not close a tab after navigating it to the provider');
  } finally { panel.dispose(); }
});

// small/spec — feature/grok-subscription; official accounts origin, SYNTHETIC device path/code.
test('Grok device notices open only the allowlisted accounts origin and preserve copy fallback', async () => {
  const server = flowServer('xai'), destinations = [], copied = [];
  const deviceUrl = 'https://accounts.x.ai/synthetic-device?user_code=TEST-CODE';
  const panel = await panelHarness({ fetch: server.fetch, open: () => makePopup(value => destinations.push(value)),
    clipboard: { writeText: async value => copied.push(value) } });
  try {
    await panel.click('Connect', 'Grok');
    server.setNotices([{ ...notice, url: deviceUrl }]); await panel.poll();
    assert.deepEqual(destinations, [deviceUrl]);
    await panel.click('Copy authorization link', 'Grok');
    await panel.click('Copy code', 'Grok');
    assert.deepEqual(copied, [deviceUrl, 'TEST-CODE']);
    for (const rejected of ['https://accounts.x.ai.evil.example/device', 'http://accounts.x.ai/device',
      'https://accounts.x.ai:444/device', 'https://auth.x.ai/device', 'https://www.kimi.com/code/oauth']) {
      server.setNotices([{ ...notice, url: rejected }]); await panel.poll();
      assert.equal(panel.within('Grok').some(node => node.type === 'a' && node.props.href === rejected), false);
      assert.equal(panel.within('Grok').some(node => node.type === 'input' && node.props.value === rejected), false);
    }
    assert.deepEqual(destinations, [deviceUrl]);
  } finally { panel.dispose(); }
});

test('Blocked popups retain an explicit copyable link and device code', async () => {
  const server = flowServer(), copied = [];
  const panel = await panelHarness({ fetch: server.fetch, open: () => null, clipboard: { writeText: async value => copied.push(value) } });
  try {
    await panel.click('Connect'); server.setNotices(); await panel.poll();
    assert.match(panel.text(), /[Pp]opup.*blocked/);
    await panel.click('Copy authorization link');
    await panel.click('Copy code');
    assert.deepEqual(copied, [url, 'TEST-CODE']);
    assert.ok(panel.within('Kimi Code').some(node => node.type === 'input' && node.props.readOnly && node.props.value === url));
  } finally { panel.dispose(); }
});

test('A device-start failure closes only the waiting tab and explains the missing link', async () => {
  const server = flowServer(); let closed = 0;
  const popup = makePopup(); popup.close = () => { closed++; popup.closed = true; };
  const panel = await panelHarness({ fetch: server.fetch, open: () => popup });
  try {
    await panel.click('Connect'); server.fail(); await panel.poll();
    assert.equal(closed, 1);
    assert.match(panel.text(), /No authorization link was received/);
    assert.equal(panel.within('Kimi Code').some(node => node.type === 'a'), false);
  } finally { panel.dispose(); }
});

test('OpenAI region rejection explains the backend network setting in both languages', async () => {
  for (const language of ['en', 'zh']) {
    const state = initialStatus();
    state.providers[0].attempt = { id: 'failed-openai', state: 'failed', notices: [], prompt: null, error: 'OAUTH_REGION_UNSUPPORTED' };
    const panel = await panelHarness({ language, fetch: async () => Response.json(state) });
    try {
      assert.match(panel.text(), /HTTPS_PROXY/);
      assert.match(panel.text(), language === 'en' ? /country or region/ : /国家或地区/);
      assert.doesNotMatch(panel.text(), /The request did not complete|请求未完成/);
    } finally { panel.dispose(); }
  }
});

test('Untrusted authorization URLs never navigate or enter the copy fallback', async () => {
  const server = flowServer(); let navigated = false, closed = false;
  const popup = makePopup(() => { navigated = true; }); popup.close = () => { closed = true; popup.closed = true; };
  const panel = await panelHarness({ fetch: server.fetch, open: () => popup });
  try {
    await panel.click('Connect');
    server.setNotices([{ ...notice, url: 'https://auth.kimi.com.evil.example/phish' }]); await panel.poll();
    assert.equal(navigated, false); assert.equal(closed, true);
    assert.match(panel.text(), /not on a verified HTTPS host/);
    assert.equal(panel.within('Kimi Code').some(node => node.type === 'a'), false);
    assert.equal(panel.within('Kimi Code').some(node => node.type === 'input' && node.props.value?.includes('evil.example')), false);
  } finally { panel.dispose(); }
});

test('Unavailable clipboard leaves selectable URL and code with manual instructions', async () => {
  const server = flowServer(); server.restore();
  const panel = await panelHarness({ fetch: server.fetch });
  try {
    await panel.click('Copy authorization link');
    assert.match(panel.text(), /Select and copy the text above manually/);
    assert.ok(panel.within('Kimi Code').some(node => node.type === 'input' && node.props.readOnly && node.props.value === url));
  } finally { panel.dispose(); }
});

test('Disposing after navigation does not close the external provider page', async () => {
  const server = flowServer(); let closed = 0;
  const popup = makePopup(); popup.close = () => { closed++; popup.closed = true; };
  const panel = await panelHarness({ fetch: server.fetch, open: () => popup });
  await panel.click('Connect'); server.setNotices(); await panel.poll();
  panel.dispose(); await panel.flush();
  assert.equal(closed, 0);
  assert.ok(server.events.includes('cancel'), 'cancel only the flow initiated in this panel');
});

test('A waiting tab navigated by the user is neither redirected nor closed', async () => {
  for (const crossOrigin of [false, true]) {
    const server = flowServer(); let navigated = 0, closed = 0;
    const popup = makePopup(() => { navigated++; }); popup.close = () => { closed++; };
    const panel = await panelHarness({ fetch: server.fetch, open: () => popup });
    try {
      await panel.click('Connect');
      if (crossOrigin) Object.defineProperty(popup, 'document', { get() { throw new Error('Cross-origin'); } });
      else popup.document = { title: 'A user-selected document' };
      server.setNotices(); await panel.poll(); await panel.click('Cancel authorization');
      assert.equal(navigated, 0); assert.equal(closed, 0);
    } finally { panel.dispose(); }
  }
});

test('Closing a restored panel does not cancel an attempt it did not initiate', async () => {
  const server = flowServer(); server.restore();
  const panel = await panelHarness({ fetch: server.fetch });
  panel.dispose(); await panel.flush();
  assert.equal(server.events.includes('cancel'), false);
});

test('The actual select component submits the selected option.id, including the first and empty ID', async () => {
  const prompt = { id: 'prompt-one', kind: 'select', message: 'Choose an authorization method', options: [
    { id: 'browser', label: 'Browser' }, { id: 'copy_code', label: 'Copy code' }, { id: '', label: 'Empty ID is still an ID' },
  ] };
  for (const index of [0, 1, 2]) {
    const submitted = [];
    const panel = await panelHarness({ prompt, answer: async value => { submitted.push(value); return true; } });
    try {
      panel.nodes().find(node => node.type === 'select').props.onChange({ target: { value: String(index) } }); await panel.flush();
      await panel.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await panel.flush();
      assert.deepEqual(submitted, [prompt.options[index].id]);
      assert.equal(panel.nodes().find(node => node.type === 'select').props.value, '');
    } finally { panel.dispose(); }
  }
});

test('Reopening the panel resumes a pending device flow without launching a tab or hiding the link', async () => {
  const server = flowServer(); server.restore();
  let opens = 0;
  const panel = await panelHarness({ fetch: server.fetch, open: () => { opens++; return null; } });
  try {
    assert.ok(panel.within('Kimi Code').some(node => node.type === 'a' && node.props.href === url));
    assert.ok(panel.button('Cancel authorization'));
    assert.equal(opens, 0);
  } finally { panel.dispose(); }
});

// small/spec — account model-list request: metadata refresh must not invoke inference.
test('account model refresh replaces any registered vendor’s names without a model test', async () => {
  // The Kimi account capability here is synthetic, not a production endpoint claim.
  for (const [id, title] of [['openai-codex', 'OpenAI · ChatGPT'], ['kimi-coding', 'Kimi Code']]) {
    const state = initialStatus(), calls = [], account = state.providers.find(provider => provider.id === id);
    account.configured = true; account.credentialKind = 'grant';
    account.models = [{ id: 'server-only', name: 'Server Model' }];
    account.modelCatalog = { source: 'account', state: 'ready', error: null, updatedAt: 1 };
    const panel = await panelHarness({ fetch: async (_url, options = {}) => {
      if (options.method === 'POST') {
        calls.push(JSON.parse(options.body));
        account.models = [{ id: 'server-new', name: 'New Server Model' }];
        return Response.json({ ok: true });
      }
      return Response.json(state);
    } });
    try {
      const card = () => panel.within(title);
      assert.equal(card().find(node => node.type === 'select').props.value, 'server-only');
      await panel.click('Refresh account models · no inference quota', title);
      assert.equal(card().find(node => node.type === 'select').props.value, 'server-new');
      assert.deepEqual(card().filter(node => node.type === 'option').map(node => node.props.value), ['server-new']);
      assert.deepEqual(calls, [{ provider: id, action: 'models' }]);
    } finally { panel.dispose(); }
  }
});

// small/spec — feature/grok-subscription; no request may precede the billing confirmation.
test('Grok warns about extra charges in both languages and tests only after confirmation', async () => {
  for (const language of ['en', 'zh']) {
    const state = initialStatus(), posts = [], confirmations = [];
    const grok = state.providers.find(provider => provider.id === 'xai');
    grok.configured = true; grok.credentialKind = 'grant';
    let allowed = false;
    const panel = await panelHarness({ language, confirm: message => { confirmations.push(message); return allowed; },
      fetch: async (_url, options = {}) => {
        if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return Response.json({ ok: true, text: '2' }); }
        return Response.json(state);
      } });
    try {
      const label = language === 'en' ? 'Test selected model · uses quota' : '测试所选模型 · 消耗额度';
      const warning = language === 'en' ? /extra charges/ : /额外收费/;
      const billing = panel.within('Grok').find(node => node.type === 'details');
      assert.ok(billing && !billing.props.open);
      assert.match(panel.text(billing), warning);
      assert.equal(panel.within('Grok').some(node => node.type === 'button' && /Refresh account models|刷新账号模型/.test(node.props.children.join(''))), false);
      await panel.click(label, 'Grok');
      assert.match(confirmations[0], warning);
      assert.match(confirmations[0], /grok-test/);
      assert.deepEqual(posts, []);
      allowed = true; await panel.click(label, 'Grok');
      assert.deepEqual(posts, [{ provider: 'xai', action: 'test', model: 'grok-test' }]);
    } finally { panel.dispose(); }
  }
});

test('failed account discovery shows no static names and disables inference testing', async () => {
  for (const language of ['en', 'zh']) {
    const state = initialStatus(), account = state.providers[0];
    account.configured = true; account.credentialKind = 'grant';
    account.modelCatalog = { source: 'account', state: 'error', error: 'MODEL_CATALOG_DENIED', updatedAt: null };
    const panel = await panelHarness({ language, fetch: async () => Response.json(state) });
    try {
      const card = panel.within('OpenAI · ChatGPT');
      assert.equal(card.find(node => node.type === 'select').props.disabled, true);
      assert.ok(card.some(node => node.props.role === 'alert'));
      assert.match(panel.text(), /401\/403/);
      assert.equal(panel.button(language === 'en' ? 'Test selected model · uses quota' : '测试所选模型 · 消耗额度', 'OpenAI · ChatGPT').props.disabled, true);
      assert.ok(!panel.text().includes('GPT-5.3 Codex Spark'));
    } finally { panel.dispose(); }
  }
});
