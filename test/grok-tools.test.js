import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrokSearchTool } from '../grok-tools.js';

// small/spec — official xAI Responses/X Search docs. All credentials, HTTP and files are synthetic.
const token = 'SYNTHETIC-XAI-ACCESS';
const oauth = access => ({ source: 'OAuth', auth: { headers: { Authorization: `Bearer ${access ?? token}` } } });
const exec = () => ({ signal: new AbortController().signal });
const query = { query: 'Find one public X post.' };
const reply = text => ({ status: 'completed', output: [
  { type: 'custom_tool_call', name: 'x_keyword_search' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text,
    annotations: [{ type: 'url_citation', url: 'https://x.com/xai/status/123' }] }] },
], citations: ['https://x.com/xai/status/123'], usage: { input_tokens: 3, output_tokens: 8, total_tokens: 11,
  server_side_tool_usage_details: { x_search_calls: 1, x_posts_fetched: 1, x_users_fetched: 0 } } });
function fixture(options = {}) {
  const state = { requests: [], saved: [], authReads: 0 };
  state.tool = createGrokSearchTool({ enabled: true,
    attachments: () => ({ async saveFile(value) { state.saved.push(value); return { attachmentId: 'SYNTHETIC', name: value.name, bytes: value.data.length }; } }),
    ...options,
    async getAuth(signal) { state.authReads++; return options.getAuth ? options.getAuth(signal) : oauth(); },
    async fetchTool(url, request) { state.requests.push({ url, ...request }); return options.fetchTool ? options.fetchTool(url, request) : Response.json(reply('Synthetic answer')); },
  });
  return state;
}

test('disabled X Search never reads credentials, attachments or network', async () => {
  const tool = createGrokSearchTool({ getAuth: () => assert.fail(), fetchTool: () => assert.fail(), attachments: () => assert.fail() });
  assert.equal(tool.name, 'grok_x_search');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(await tool.execute({}, exec()), { error: 'GROK_X_SEARCH_DISABLED' });
});

test('search uses fresh OAuth, fixed Responses origin and bounded X-only options', async () => {
  let grant = oauth();
  const state = fixture({ getAuth: () => grant });
  const result = await state.tool.execute({ ...query, allowed_x_handles: ['xai'], from_date: '2026-01-01', to_date: '2026-02-01', max_turns: 1 }, exec());
  assert.equal(result.text, 'Synthetic answer');
  assert.deepEqual(result.citations, ['https://x.com/xai/status/123']);
  assert.deepEqual(result.usage, reply('').usage);
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, false);
  assert.equal(result.status, 'completed');
  assert.equal(result.searched, true);
  assert.equal(state.saved.length, 1);
  assert.equal(JSON.parse(state.saved[0].data).output[0].name, 'x_keyword_search');
  assert.deepEqual(JSON.parse(state.tool.output.render(query, result)[0].text), result);
  const request = state.requests[0];
  assert.equal(request.url, 'https://api.x.ai/v1/responses');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.body), { model: 'grok-4.7', input: [{ role: 'user', content: query.query }],
    tools: [{ type: 'x_search', enable_image_understanding: false, enable_video_understanding: false,
      allowed_x_handles: ['xai'], from_date: '2026-01-01', to_date: '2026-02-01' }],
    tool_choice: 'required', max_turns: 1, max_output_tokens: 1024, store: false, stream: false });
  grant = oauth('SYNTHETIC-ROTATED');
  await state.tool.execute({ ...query, model: 'grok-4.3', excluded_x_handles: ['xai'] }, exec());
  assert.equal(state.requests[1].headers.Authorization, 'Bearer SYNTHETIC-ROTATED');
  assert.equal(JSON.parse(state.requests[1].body).model, 'grok-4.3');
  grant = undefined;
  assert.deepEqual(await state.tool.execute(query, exec()), { error: 'GROK_OAUTH_REQUIRED' });
  assert.equal(state.requests.length, 2);
});

test('input and storage are validated before credentials or billable transport', async () => {
  const state = fixture();
  for (const args of [null, [], {}, { query: ' ' }, { query: 'x'.repeat(8001) }, { ...query, url: 'https://untrusted.invalid' },
    { ...query, model: 'another-provider' }, { ...query, model: 5 }, { ...query, model: null }, { ...query, max_turns: null }, { ...query, max_turns: 0 }, { ...query, max_turns: 6 }, { ...query, max_turns: 1.5 },
    { ...query, allowed_x_handles: ['@xai'] }, { ...query, allowed_x_handles: [] }, { ...query, allowed_x_handles: Array(21).fill('xai') },
    { ...query, allowed_x_handles: ['xai'], excluded_x_handles: ['other'] }, { ...query, from_date: '2026-02-30' },
    { ...query, from_date: '2026-02-01', to_date: '2026-02-01' }, { ...query, from_date: '2026-02-02', to_date: '2026-02-01' }]) {
    assert.deepEqual(await state.tool.execute(args, exec()), { error: 'GROK_INVALID_ARGUMENTS' });
  }
  assert.equal(state.authReads, 0);
  const unavailable = fixture({ attachments: () => undefined });
  assert.deepEqual(await unavailable.tool.execute(query, exec()), { error: 'GROK_OUTPUT_UNAVAILABLE' });
  assert.equal(unavailable.authReads, 0);
});

test('OAuth-only fixed-origin boundary rejects fallback keys and foreign base URLs', async () => {
  for (const [grant, error] of [[{ source: 'APIKey', auth: { apiKey: token } }, 'GROK_OAUTH_REQUIRED'],
    [{ source: 'OAuth', auth: { apiKey: 'short' } }, 'GROK_OAUTH_REQUIRED'],
    [{ ...oauth(), auth: { ...oauth().auth, baseUrl: 'https://api.x.ai.evil.invalid/v1' } }, 'GROK_ORIGIN_UNSUPPORTED']]) {
    const state = fixture({ getAuth: () => grant });
    assert.deepEqual(await state.tool.execute(query, exec()), { error });
    assert.equal(state.requests.length, 0);
  }
  const failed = fixture({ getAuth: () => { throw new Error(token); } });
  assert.deepEqual(await failed.tool.execute(query, exec()), { error: 'GROK_REQUEST_FAILED' });
});

test('upstream failure, invalid JSON/UTF-8 and failed search are sanitized without retry', async () => {
  for (const [status, error] of [[401, 'GROK_AUTH_DENIED'], [403, 'GROK_ACCESS_DENIED'], [429, 'GROK_RATE_LIMITED'], [302, 'GROK_UPSTREAM_ERROR'], [500, 'GROK_UPSTREAM_ERROR']]) {
    const state = fixture({ fetchTool: () => new Response(token, { status }) });
    assert.deepEqual(await state.tool.execute(query, exec()), { error });
    assert.equal(state.requests.length, 1);
    assert.equal(state.saved.length, 0);
  }
  for (const [body, error] of [['not JSON', 'GROK_INVALID_RESPONSE'], ['[]', 'GROK_INVALID_RESPONSE'],
    [Buffer.from([0xff]), 'GROK_INVALID_RESPONSE'], [JSON.stringify({ status: 'failed', output: [], error: { message: token } }), 'GROK_SEARCH_FAILED']]) {
    const state = fixture({ fetchTool: () => new Response(body) });
    assert.deepEqual(await state.tool.execute(query, exec()), { error });
    assert.equal(state.requests.length, 1);
    assert.equal(state.saved.length, 0);
  }
});

test('large partial answers retain complete redacted JSON and bounded safe citations/usage', async () => {
  const value = { ...reply('数'.repeat(17000) + token), status: 'incomplete', citations: [
    'javascript:alert(1)', 'https://user:password@x.com/', ...Array.from({ length: 25 }, (_, i) => `https://x.com/xai/status/${i}`),
  ] };
  value.usage.extra = token;
  const raw = JSON.stringify(value).replace('"total_tokens":11', '"total_tokens":9007199254740993');
  const state = fixture({ fetchTool: () => new Response(raw) });
  const result = await state.tool.execute(query, exec());
  assert.equal(result.text.length, 16000);
  assert.equal(result.truncated, true);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.citations.length, 20);
  assert.ok(result.citations.every(url => /^https:\/\/x.com\//.test(url)));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal(state.saved[0].data.toString(), raw.replaceAll(token, '[REDACTED]'));
});

test('missing search evidence and incomplete details are never reported as verified complete search', async () => {
  const state = fixture({ fetchTool: () => Response.json({ status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }) });
  const result = await state.tool.execute(query, exec());
  assert.equal(result.searched, false);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.citations, []);
  assert.equal(state.saved.length, 1);
});

test('caller abort, plugin disposal, response limit and storage failure never trigger retries', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const controller = new AbortController(); controller.abort(new DOMException('Synthetic', name));
    const state = fixture();
    assert.deepEqual(await state.tool.execute(query, { signal: controller.signal }), { error: name === 'TimeoutError' ? 'GROK_TIMEOUT' : 'GROK_ABORTED' });
    assert.equal(state.authReads, 0);
  }
  const lifetime = new AbortController();
  const disposed = fixture({ signal: lifetime.signal, getAuth: () => { lifetime.abort(); return oauth(); } });
  assert.deepEqual(await disposed.tool.execute(query, exec()), { error: 'GROK_ABORTED' });
  assert.equal(disposed.requests.length, 0);
  let closed = false;
  const oversized = fixture({ fetchTool: () => ({ ok: true, body: (async function* () {
    try { yield Buffer.alloc(9 * 1024 * 1024); } finally { closed = true; }
  })() }) });
  assert.deepEqual(await oversized.tool.execute(query, exec()), { error: 'GROK_RESULT_TOO_LARGE' });
  assert.ok(closed);
  assert.equal(oversized.saved.length, 0);
  const storage = fixture({ attachments: () => ({ saveFile: () => { throw new Error(token); } }) });
  assert.deepEqual(await storage.tool.execute(query, exec()), { error: 'GROK_REQUEST_FAILED' });
  assert.equal(storage.requests.length, 1);
});
