import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKimiTools } from '../kimi-tools.js';

// small/spec — docs/research/kimi-database-integration.md and pinned Datasource 3.5.1.
// All grants, transports and attachment bytes are synthetic; no external HTTP or local credential access.
const access = 'SYNTHETIC-KIMI-ACCESS';
const oauth = token => ({ source: 'OAuth', auth: { headers: { Authorization: `Bearer ${token ?? access}` } } });
const desc = { name: 'world_bank_open_data' };
const query = { data_source_name: desc.name, api_name: 'synthetic_query', params: { year: 2025 } };
const exec = () => ({ signal: new AbortController().signal });
const reply = text => ({ is_success: true, result: { assistant: [{ type: 'text', text }] } });
function fixture(options = {}) {
  const state = { authReads: 0, requests: [], saved: [] };
  const store = {
    async saveFile({ data, name }) {
      state.saved.push({ data, name });
      return { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, name, bytes: data.byteLength };
    },
    fileHostPath: ref => `/synthetic-attachments/${ref.name}`,
  };
  state.tools = createKimiTools({ enabled: true, version: '9.8.7', oauthHost: () => 'https://auth.kimi.com',
    attachments: () => store, ...options,
    async getAuth(signal) { state.authReads++; return options.getAuth ? options.getAuth(signal) : oauth(); },
    async fetchTool(url, request) {
      state.requests.push({ url, ...request });
      return options.fetchTool ? options.fetchTool(url, request) : Response.json(reply('Synthetic rows'));
    },
  });
  return state;
}

test('default-disabled tools stop before credentials, storage or transport', async () => {
  const tools = createKimiTools({ getAuth: () => assert.fail('credential read'),
    fetchTool: () => assert.fail('network'), attachments: () => assert.fail('storage') });
  assert.deepEqual(tools.map(tool => tool.name), ['kimi_get_data_source_desc', 'kimi_call_data_source_tool']);
  for (const tool of tools) {
    const result = await tool.execute({}, exec());
    assert.deepEqual(result, { error: 'KIMI_DATASOURCE_DISABLED' });
    assert.deepEqual(JSON.parse(tool.output.render({}, result)[0].text), result);
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test('two independent RPC methods use fresh OAuth headers and retain complete replies', async () => {
  let grant = oauth('SYNTHETIC-KIMI-FIRST');
  const raw = '{"is_success":true,"result":{"assistant":[],"user":[{"type":"text","text":"synthetic_query"}]},"exact":9007199254740993}';
  const state = fixture({ getAuth: () => grant, fetchTool: (_url, request) =>
    JSON.parse(request.body).method === 'get_data_source_desc' ? new Response(raw) : Response.json(reply('Synthetic rows')) });
  const description = await state.tools[0].execute(desc, exec());
  grant = oauth('SYNTHETIC-KIMI-ROTATED');
  const result = await state.tools[1].execute(query, exec());
  assert.equal(description.text, 'synthetic_query');
  assert.equal(result.text, 'Synthetic rows');
  assert.equal(state.authReads, 2);
  assert.equal(state.saved[0].data.toString(), raw); // Preserve integers beyond JS precision as original JSON bytes.
  for (const [i, request] of state.requests.entries()) {
    assert.equal(request.url, 'https://api.kimi.com/coding/v1/tools');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.headers.Authorization, `Bearer SYNTHETIC-KIMI-${i ? 'ROTATED' : 'FIRST'}`);
    assert.equal(request.headers['User-Agent'], 'dk-dsh-subscriptions/9.8.7');
    assert.equal(request.headers['X-Msh-Platform'], 'dk-dsh-subscriptions');
    assert.equal(request.headers['X-Msh-Version'], '9.8.7');
    assert.match(request.headers['X-Msh-Tool-Call-Id'], /^[a-f\d-]{36}$/);
    assert.deepEqual(JSON.parse(request.body), { method: i ? 'call_data_source_tool' : 'get_data_source_desc', params: i ? query : desc });
  }
  assert.notEqual(description.toolCallId, result.toolCallId);
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, false);
  assert.equal(result.response.bytes, state.saved[1].data.byteLength);
  assert.match(result.response.path, /^\/synthetic-attachments\/kimi-[a-f\d-]+\.json$/);
  grant = undefined; // Logout is observed on the next call; no cached access token or API-key fallback.
  assert.deepEqual(await state.tools[1].execute(query, exec()), { error: 'KIMI_OAUTH_REQUIRED' });
  assert.equal(state.requests.length, 2);
});

test('description accepts the JSON-string Markdown observed in the live response', async () => {
  // small/spec — 2026-11-08 authorized World Bank desc: HTTP 200 JSON string, not query result envelope.
  const text = `# world_bank_open_data\n\n## Available APIs\n\n### synthetic_api\n${access}`;
  const raw = JSON.stringify(text);
  const state = fixture({ fetchTool: () => new Response(raw) });
  const result = await state.tools[0].execute(desc, exec());
  assert.equal(result.text, text.replaceAll(access, '[REDACTED]'));
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, false);
  assert.equal(state.requests.length, 1);
  assert.equal(state.saved[0].data.toString(), raw.replaceAll(access, '[REDACTED]'));
  // Do not infer an unobserved query wire format from the description response.
  assert.deepEqual(await state.tools[1].execute(query, exec()), { error: 'KIMI_INVALID_RESPONSE' });
});

test('invalid input, missing storage and unsupported region fail before reading credentials', async () => {
  const cycle = {}; cycle.self = cycle;
  const state = fixture();
  for (const args of [null, [], {}, { ...desc, model: 'another-vendor' }, { name: 'unknown' }, { name: 'materials_project' }]) {
    assert.ok((await state.tools[0].execute(args, exec())).error);
  }
  for (const args of [{ ...query, api_name: 1 }, { ...query, api_name: ' ' }, { ...query, api_name: 'line\nbreak' },
    { ...query, api_name: 'x'.repeat(257) }, { ...query, params: [] }, { ...query, params: cycle },
    { ...query, params: { year: Infinity } }, { ...query, params: { value: 'x'.repeat(65536) } }]) {
    assert.ok((await state.tools[1].execute(args, exec())).error);
  }
  assert.equal(state.authReads, 0);
  assert.equal(state.requests.length, 0);
  const dynamicApi = fixture();
  assert.equal((await dynamicApi.tools[1].execute({ ...query, api_name: 'synthetic.query/v1' }, exec())).text, 'Synthetic rows');
  for (const [options, error] of [[{ attachments: () => undefined }, 'KIMI_OUTPUT_UNAVAILABLE'],
    [{ oauthHost: () => 'https://auth.kimi.ai' }, 'KIMI_REGION_UNSUPPORTED'],
    [{ version: 'kimi-code-cli\nspoof' }, 'KIMI_CLIENT_IDENTITY_INVALID']]) {
    const blocked = fixture(options);
    assert.deepEqual(await blocked.tools[0].execute(desc, exec()), { error });
    assert.equal(blocked.authReads, 0);
    assert.equal(blocked.requests.length, 0);
  }
});

test('OAuth-only and fixed-origin boundaries never forward fallback keys or credentials elsewhere', async () => {
  for (const [resolved, error] of [[{ source: 'APIKey', auth: { apiKey: access } }, 'KIMI_OAUTH_REQUIRED'],
    [{ source: 'OAuth', auth: { apiKey: access } }, 'KIMI_OAUTH_REQUIRED'],
    [{ ...oauth(), auth: { ...oauth().auth, baseUrl: 'https://untrusted.invalid' } }, 'KIMI_REGION_UNSUPPORTED']]) {
    const state = fixture({ getAuth: () => resolved });
    assert.deepEqual(await state.tools[0].execute(desc, exec()), { error });
    assert.equal(state.authReads, 1);
    assert.equal(state.requests.length, 0);
  }
  const state = fixture({ getAuth: () => { throw new Error(`Refresh failed: ${access}`); } });
  assert.deepEqual(await state.tools[0].execute(desc, exec()), { error: 'KIMI_REQUEST_FAILED' });
});

test('HTTP failures, business failures and invalid responses do not retry or reveal upstream errors', async () => {
  for (const [status, error] of [[401, 'KIMI_AUTH_DENIED'], [403, 'KIMI_ACCESS_DENIED'], [429, 'KIMI_RATE_LIMITED'],
    [302, 'KIMI_UPSTREAM_ERROR'], [502, 'KIMI_UPSTREAM_ERROR']]) {
    const state = fixture({ fetchTool: () => new Response(`Bearer ${access}`, { status }) });
    assert.deepEqual(await state.tools[1].execute(query, exec()), { error });
    assert.equal(state.authReads, 1);
    assert.equal(state.requests.length, 1);
    assert.equal(state.saved.length, 0);
  }
  const invalidUtf8 = Buffer.from(JSON.stringify(reply('SYNTHETIC')));
  invalidUtf8[invalidUtf8.indexOf('SYNTHETIC')] = 0xff;
  for (const [body, error] of [[invalidUtf8, 'KIMI_INVALID_RESPONSE'], ['not JSON', 'KIMI_INVALID_RESPONSE'], ['[]', 'KIMI_INVALID_RESPONSE'],
    ['{"result":null}', 'KIMI_INVALID_RESPONSE'],
    [JSON.stringify({ is_success: false, error: { assistant: [{ type: 'text', text: access }] } }), 'KIMI_TOOL_FAILED']]) {
    const state = fixture({ fetchTool: () => new Response(body) });
    assert.deepEqual(await state.tools[0].execute(desc, exec()), { error });
    assert.equal(state.requests.length, 1);
    assert.equal(state.saved.length, 0);
  }
});

test('large text, files and untrusted paths stay complete in a redacted JSON attachment', async () => {
  const value = { ...reply(`${'数'.repeat(17000)} ${access}`),
    files: [{ name: '../../do-not-write.csv', content: 'YSxiCg==', encoding: 'base64' }] };
  const state = fixture({ fetchTool: () => Response.json(value) });
  const result = await state.tools[1].execute(query, exec());
  assert.equal(result.text.length, 16000);
  assert.equal(result.truncated, true);
  const stored = JSON.parse(state.saved[0].data.toString());
  assert.deepEqual(stored.files, value.files);
  assert.equal(stored.result.assistant[0].text, value.result.assistant[0].text.replaceAll(access, '[REDACTED]'));
  assert.ok(!JSON.stringify(result).includes(access));
  assert.ok(!state.saved[0].data.toString().includes(access));
  assert.match(state.saved[0].name, /^kimi-[a-f\d-]+\.json$/);
  assert.ok(!result.response.path.includes('do-not-write'));
});

test('caller cancellation, plugin disposal and timeout are propagated without dispatch or retries', async () => {
  for (const reason of [new DOMException('Synthetic cancellation', 'AbortError'), new DOMException('Synthetic timeout', 'TimeoutError')]) {
    const controller = new AbortController(); controller.abort(reason);
    const state = fixture();
    assert.deepEqual(await state.tools[0].execute(desc, { signal: controller.signal }),
      { error: reason.name === 'TimeoutError' ? 'KIMI_TIMEOUT' : 'KIMI_ABORTED' });
    assert.equal(state.authReads, 0);
  }
  const lifetime = new AbortController();
  const disposed = fixture({ signal: lifetime.signal, getAuth: () => { lifetime.abort(); return oauth(); } });
  assert.deepEqual(await disposed.tools[0].execute(desc, exec()), { error: 'KIMI_ABORTED' });
  assert.equal(disposed.requests.length, 0);
  const caller = new AbortController();
  const active = fixture({ fetchTool: (_url, request) => { caller.abort(); request.signal.throwIfAborted(); } });
  assert.deepEqual(await active.tools[0].execute(desc, { signal: caller.signal }), { error: 'KIMI_ABORTED' });
  assert.equal(active.requests.length, 1);
  assert.equal(active.saved.length, 0);
});

test('oversized replies stop reading and failed storage never triggers a paid retry', async () => {
  let closed = false;
  const oversized = fixture({ fetchTool: () => ({ ok: true, body: (async function* () {
    try { yield new Uint8Array(17 * 1024 * 1024); yield new Uint8Array(17 * 1024 * 1024); }
    finally { closed = true; }
  })() }) });
  assert.deepEqual(await oversized.tools[0].execute(desc, exec()), { error: 'KIMI_RESULT_TOO_LARGE' });
  assert.ok(closed);
  assert.equal(oversized.saved.length, 0);
  const storage = fixture({ attachments: () => ({ saveFile: () => { throw new Error(access); } }) });
  assert.deepEqual(await storage.tools[0].execute(desc, exec()), { error: 'KIMI_REQUEST_FAILED' });
  assert.equal(storage.requests.length, 1);
});
