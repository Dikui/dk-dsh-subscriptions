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
function flowServer() {
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
      return Response.json(initialStatus(attempt));
    },
  };
}

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
