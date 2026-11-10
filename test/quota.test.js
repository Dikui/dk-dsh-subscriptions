import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountQuota } from '../models.js';
import { accountQuotaSources } from '../quota-sources.js';

// small/spec — public quota sources/cache, synthetic official HTTP and in-memory OAuth only.
function fixture(id = 'openai-codex', payload = { rate_limit: { primary_window: {
  used_percent: 25, limit_window_seconds: 18000, reset_at: 1800000000,
} } }, options = {}) {
  let credential = { type: 'oauth', access: 'ACCESS-SECRET', refresh: 'REFRESH-SECRET', accountId: 'ACCOUNT-SECRET', expires: 3600000 };
  const calls = [];
  const quota = createAccountQuota(accountQuotaSources.get(id)({
    readCredential: async () => credential,
    getAuth: async () => ({ source: 'OAuth', auth: { apiKey: credential?.access } }),
    fetchCatalog: async (url, request) => { calls.push({ url, request }); return Response.json(payload); },
    ...options,
  }));
  return { quota, calls, setCredential: value => { credential = value; }, getCredential: () => credential };
}

test('OpenAI quota reports official percentages, window durations and Unix resets without exposing identity', async () => {
  const f = fixture('openai-codex', { plan_type: 'plus', rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1800000000 },
    secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1800100000 },
  }, account_id: 'UNTRUSTED-SECRET', credits: { balance: 'UNTRUSTED-SECRET' } });
  await f.quota.ensure();
  assert.deepEqual(f.quota.status().windows, [
    { id: 'primary', usedPercent: 25, windowSeconds: 18000, resetsAt: 1800000000000 },
    { id: 'secondary', usedPercent: 100, windowSeconds: 604800, resetsAt: 1800100000000 },
  ]);
  assert.equal(f.quota.status().state, 'ready');
  assert.equal(f.quota.status().stale, false);
  assert.equal(f.calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(f.calls[0].request.method, 'GET');
  assert.equal(f.calls[0].request.redirect, 'error');
  assert.equal(f.calls[0].request.headers.authorization, 'Bearer ACCESS-SECRET');
  assert.equal(f.calls[0].request.headers['chatgpt-account-id'], 'ACCOUNT-SECRET');
  assert.equal(f.calls[0].request.headers['x-openai-codex-luna-reserve'], undefined);
  assert.doesNotMatch(JSON.stringify(f.quota.status()), /SECRET|plus|credits|account_id/);
});

test('Kimi supports current ratios and legacy amount windows without inventing token units', async () => {
  const reset = '2027-01-15T08:00:00Z';
  const modern = fixture('kimi-coding', { usages: {
    limit_5h: { used_ratio: '0.25', reset_time: reset },
    limit_7d: { used_ratio: 1, reset_time: reset },
    limit_month_total: { used_ratio: 0, reset_time: reset },
    limit_month_code: { used_ratio: 0.5, reset_time: reset },
  }, boosterWallet: { balance: 'SECRET' } });
  await modern.quota.ensure();
  assert.deepEqual(modern.quota.status().windows.map(({ id, usedPercent, windowSeconds }) => ({ id, usedPercent, windowSeconds })), [
    { id: 'limit_5h', usedPercent: 25, windowSeconds: 18000 },
    { id: 'limit_7d', usedPercent: 100, windowSeconds: 604800 },
    { id: 'limit_month_total', usedPercent: 0, windowSeconds: null },
    { id: 'limit_month_code', usedPercent: 50, windowSeconds: null },
  ]);
  assert.equal(modern.quota.status().state, 'ready');
  assert.equal(modern.quota.status().windows[0].resetsAt, 1800000000000);
  assert.equal(modern.calls[0].url, 'https://api.kimi.com/coding/v1/usages');
  const legacy = fixture('kimi-coding', { usage: { limit: '100', remaining: '75', reset_at: reset }, limits: [
    { detail: { limit: 20, used: 10, resetTime: reset }, window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' } },
    { limit: 10, remaining: 2, resetTime: reset, window: { duration: 1, timeUnit: 'DAY' } },
  ] });
  await legacy.quota.ensure();
  assert.deepEqual(legacy.quota.status().windows, [
    { id: 'usage', usedPercent: 25, windowSeconds: null, resetsAt: 1800000000000 },
    { id: 'limit-0', usedPercent: 50, windowSeconds: 18000, resetsAt: 1800000000000 },
    { id: 'limit-1', usedPercent: 80, windowSeconds: 86400, resetsAt: 1800000000000 },
  ]);
  assert.doesNotMatch(JSON.stringify(modern.quota.status()), /SECRET|balance|token/);
});

test('quota never turns missing or invalid values into zero, unlimited, or a reset estimate', async () => {
  for (const value of [null, '', ' ', false, true, -1, 101, '25']) {
    const f = fixture('openai-codex', { rate_limit: { primary_window: { used_percent: value, reset_after_seconds: 50 } } });
    await f.quota.ensure();
    assert.equal(f.quota.status().state, 'partial');
    assert.deepEqual(f.quota.status().windows, [{ id: 'primary', usedPercent: null, windowSeconds: null, resetsAt: null }]);
  }
  for (const value of [null, '', ' ', false, true, -1, 1.1, 'Infinity']) {
    const f = fixture('kimi-coding', { usages: { limit_5h: { used_ratio: value } } });
    await f.quota.ensure();
    assert.equal(f.quota.status().windows[0].usedPercent, null);
    assert.equal(f.quota.status().state, 'partial');
  }
  for (const [id, payload] of [['openai-codex', {}], ['openai-codex', { rate_limit: { primary_window: null } }],
    ['kimi-coding', {}], ['kimi-coding', { usage: null, limits: [] }]]) {
    await assert.rejects(fixture(id, payload).quota.ensure(), { code: 'QUOTA_INVALID' });
  }
  const extra = fixture('openai-codex', { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1800000000 } },
    additional_rate_limits: [{ limit_name: 'UNTRUSTED-SECRET' }] });
  await extra.quota.ensure();
  assert.equal(extra.quota.status().state, 'partial');
  assert.doesNotMatch(JSON.stringify(extra.quota.status()), /UNTRUSTED/);
  assert.equal(accountQuotaSources.has('xai'), false, 'no documented OAuth subscription quota endpoint');
});

test('quota OAuth boundary rejects paid or changed credentials and redacts bounded HTTP failures', async () => {
  for (const id of ['openai-codex', 'kimi-coding']) {
    for (const credential of [undefined, { type: 'api_key', apiKey: 'PAID-SECRET' }]) {
      const f = fixture(id, {}, { getAuth: () => assert.fail('no OAuth grant'), fetchCatalog: () => assert.fail('must not query') });
      f.setCredential(credential);
      await assert.rejects(f.quota.ensure(), { code: 'MISSING_CREDENTIAL' });
    }
    for (const auth of [{ source: 'api_key', auth: { apiKey: 'PAID-SECRET' } }, { source: 'OAuth', auth: { apiKey: 'WRONG-SECRET' } }]) {
      const f = fixture(id, {}, { getAuth: async () => auth, fetchCatalog: () => assert.fail('must not query') });
      await assert.rejects(f.quota.ensure(), { code: auth.source === 'OAuth' ? 'QUOTA_CHANGED' : 'QUOTA_DENIED' });
      assert.doesNotMatch(JSON.stringify(f.quota.status()), /SECRET/);
    }
    for (const [response, code] of [
      [() => new Response('TOKEN-SECRET', { status: 401 }), 'QUOTA_DENIED'],
      [() => new Response('TOKEN-SECRET', { status: 403 }), 'QUOTA_DENIED'],
      [() => new Response('TOKEN-SECRET', { status: 429 }), 'QUOTA_RATE_LIMIT'],
      [() => new Response('TOKEN-SECRET', { status: 500 }), 'QUOTA_FAILED'],
      [() => new Response('invalid json SECRET'), 'QUOTA_INVALID'],
      [() => new Response('{}', { headers: { 'content-length': '1048577' } }), 'QUOTA_INVALID'],
      [() => new Response(' '.repeat(1048577)), 'QUOTA_INVALID'],
    ]) {
      const f = fixture(id, {}, { fetchCatalog: async () => response() });
      await assert.rejects(f.quota.ensure(), { code });
      assert.equal(f.quota.status().state, 'error');
      assert.deepEqual(f.quota.status().windows, []);
      assert.doesNotMatch(JSON.stringify(f.quota.status()), /SECRET/);
    }
  }
});

test('quota coalesces refresh, caches failures, ages on demand and invalidates account changes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let payload = { usages: { limit_5h: { used_ratio: 0.2, reset_time: '2027-01-15T08:00:00Z' } } };
  let queries = 0, denied = false;
  const f = fixture('kimi-coding', {}, { fetchCatalog: async () => {
    queries++; return denied ? new Response('SECRET', { status: 403 }) : Response.json(payload);
  } });
  await Promise.all([f.quota.ensure(), f.quota.ensure()]);
  await f.quota.ensure();
  assert.equal(queries, 1);
  t.mock.timers.tick(60001);
  assert.equal(f.quota.status().stale, true);
  await f.quota.ensure();
  assert.equal(queries, 2);
  assert.equal(f.quota.status().stale, false);
  denied = true;
  await assert.rejects(f.quota.ensure({ force: true }), { code: 'QUOTA_DENIED' });
  await assert.rejects(f.quota.ensure(), { code: 'QUOTA_DENIED' });
  assert.equal(queries, 3);
  assert.deepEqual(f.quota.status().windows, []);
  denied = false;
  payload = { usages: { limit_5h: { used_ratio: 0.8, reset_time: '2027-01-15T08:00:00Z' } } };
  f.setCredential({ ...f.getCredential(), access: 'OTHER-SECRET' });
  await f.quota.ensure();
  assert.equal(queries, 4);
  assert.equal(f.quota.status().windows[0].usedPercent, 80);
  f.quota.clear();
  assert.equal(f.quota.status().state, 'unloaded');
  assert.deepEqual(f.quota.status().windows, []);
});

test('quota clear and credential replacement fence late HTTP and identity readers', async () => {
  for (const clear of [false, true]) {
    const pending = Promise.withResolvers(), started = Promise.withResolvers();
    let requests = 0;
    const f = fixture('openai-codex', {}, { fetchCatalog: async () => {
      if (++requests === 1) { started.resolve(); return pending.promise; }
      return Response.json({ rate_limit: { primary_window: { used_percent: 70 } } });
    } });
    const old = f.quota.ensure().then(() => 'ready', error => error.code);
    await started.promise;
    f.setCredential({ ...f.getCredential(), access: 'NEW-SECRET', accountId: 'NEW-ACCOUNT' });
    if (clear) f.quota.clear();
    await f.quota.ensure();
    pending.resolve(Response.json({ rate_limit: { primary_window: { used_percent: 5 } } }));
    assert.equal(await old, 'QUOTA_CHANGED');
    assert.equal(f.quota.status().windows[0].usedPercent, 70);
  }
  const pending = Promise.withResolvers(); let reads = 0;
  const f = fixture('openai-codex', { rate_limit: { primary_window: { used_percent: 70 } } }, {
    readCredential: async () => ++reads === 1 ? pending.promise : ({ type: 'oauth', access: 'NEW-SECRET', accountId: 'NEW-ACCOUNT' }),
    getAuth: async () => ({ source: 'OAuth', auth: { apiKey: 'NEW-SECRET' } }),
  });
  const old = f.quota.ensure().then(() => 'ready', error => error.code);
  f.quota.clear(); await f.quota.ensure();
  pending.resolve(undefined);
  assert.equal(await old, 'QUOTA_CHANGED');
  assert.equal(f.quota.status().windows[0].usedPercent, 70);
});

test('quota shares OAuth rotation and bounds auth and HTTP while caller cancellation stays local', async t => {
  const originalTimeout = AbortSignal.timeout, deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => ms === 10000 ? deadline.signal : originalTimeout(ms));
  const authStarted = Promise.withResolvers(), release = Promise.withResolvers();
  let authCalls = 0;
  const f = fixture('kimi-coding', { usages: { limit_5h: { used_ratio: 0 } } }, { getAuth: async () => {
    authCalls++; f.setCredential({ ...f.getCredential(), access: 'ROTATED-SECRET' }); authStarted.resolve();
    await release.promise;
    return { source: 'OAuth', auth: { headers: { Authorization: 'Bearer ROTATED-SECRET' } } };
  } });
  const controller = new AbortController();
  const leaving = f.quota.ensure({ signal: controller.signal });
  await authStarted.promise;
  const staying = f.quota.ensure();
  controller.abort(); await assert.rejects(leaving, { name: 'AbortError' });
  release.resolve(); await staying;
  assert.equal(authCalls, 1);
  assert.equal(f.calls[0].request.headers.authorization, 'Bearer ROTATED-SECRET');
  const started = Promise.withResolvers();
  const hung = fixture('kimi-coding', {}, { getAuth: async () => { started.resolve(); return new Promise(() => {}); } });
  const outcome = hung.quota.ensure().then(() => 'ready', error => error.code);
  await started.promise; deadline.abort();
  assert.equal(await outcome, 'QUOTA_FAILED');
  assert.equal(hung.quota.status().state, 'error');
});
