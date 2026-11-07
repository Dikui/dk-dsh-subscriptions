import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createAutoProxy } from '../network.js';

const require = createRequire(import.meta.url);
let undici;
try { undici = require(process.env.DSH_TEST_UNDICI ?? 'undici'); }
catch (error) { if (process.env.DSH_TEST_UNDICI) throw error; }

// small/regression — desktop Node 24 uses the legacy dispatcher handler API.
// DSH_TEST_UNDICI selects DSH's already-installed undici; no package installation.
// MockAgent replaces the network and refuses all unregistered requests.
test('automatic proxy supports the desktop native fetch dispatcher protocol', {
  skip: !undici && 'Set DSH_TEST_UNDICI to the bundled undici directory.',
}, async () => {
  class FixtureAgent extends undici.MockAgent {
    constructor() {
      super();
      this.disableNetConnect();
      this.get('https://auth.openai.com').intercept({ path: '/oauth/token', method: 'POST' })
        .reply(401, { error: 'invalid_grant' });
    }
  }
  const previous = globalThis.fetch;
  const proxy = await createAutoProxy(() => ({ ...undici, EnvHttpProxyAgent: FixtureAgent }), {
    env: {}, platform: 'darwin', readSystem: async () => ({
      stdout: '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n}',
    }),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Proxy dispatcher did not answer native fetch')), 1000);
  try {
    assert.equal(proxy.enabled, true);
    const response = await proxy.run(() => fetch('https://auth.openai.com/oauth/token', {
      method: 'POST', body: 'code=synthetic-invalid-code', signal: controller.signal,
    }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_grant' });
    assert.deepEqual(proxy.status(), { mode: 'system-https', reason: null, requests: 1, lastStatus: 401 });
  } finally {
    clearTimeout(timer);
    await proxy.dispose();
    assert.equal(globalThis.fetch, previous);
  }
});

// small/regression — a coexisting fetch guard may re-anchor nested requests
// onto the original fetch, bypassing later hooks.
// This synthetic guard model routes both destinations to offline MockAgents.
test('automatic proxy survives a fetch guard that skips later hooks', {
  skip: !undici && 'Set DSH_TEST_UNDICI to the bundled undici directory.',
}, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const anchor = globalThis.fetch;
  const previousDispatcher = undici.getGlobalDispatcher();
  const direct = new undici.MockAgent();
  direct.disableNetConnect();
  direct.get('https://auth.openai.com').intercept({ path: '/oauth/token', method: 'POST' })
    .reply(403, { error: { code: 'unsupported_country_region_territory' } });
  undici.setGlobalDispatcher(direct);
  class FixtureAgent extends undici.MockAgent {
    constructor() {
      super();
      this.disableNetConnect();
      this.get('https://auth.openai.com').intercept({ path: '/oauth/token', method: 'POST' })
        .reply(401, { error: 'invalid_grant' });
    }
  }
  const depth = new AsyncLocalStorage();
  const chain = downstream => (input, init) => depth.getStore() === 1
    ? anchor(input, init) : depth.run(1, () => downstream(input, init));
  let top = chain(anchor), proxy;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true, get: () => top, set: next => { top = chain(next); },
  });
  try {
    proxy = await createAutoProxy(() => ({ ...undici, EnvHttpProxyAgent: FixtureAgent }), {
      env: {}, platform: 'darwin', readSystem: async () => ({
        stdout: '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n}',
      }),
    });
    const response = await depth.run(1, () => proxy.run(() => fetch('https://auth.openai.com/oauth/token', {
      method: 'POST', body: 'code=synthetic-invalid-code', signal: AbortSignal.timeout(1000),
    })));
    assert.equal(response.status, 401);
    assert.deepEqual(proxy.status(), { mode: 'system-https', reason: null, requests: 1, lastStatus: 401 });
  } finally {
    await proxy?.dispose();
    Object.defineProperty(globalThis, 'fetch', descriptor);
    undici.setGlobalDispatcher(previousDispatcher);
    await direct.close();
  }
});
