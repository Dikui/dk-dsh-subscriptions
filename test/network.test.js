import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoProxy } from '../network.js';

// small/spec — automatic macOS proxy request; synthetic scutil and transport only.
const systemProxy = `
<dictionary> {
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7897
  ExceptionsList : <array> {
    0 : *.local
  }
}
`;
const options = { env: {}, platform: 'darwin', readSystem: async () => ({ stdout: systemProxy }) };

// This dispatcher namespace replaces undici; network-runtime.test.js uses the real library.
function transport() {
  const calls = [];
  let configuration;
  class Dispatcher {
    constructor(route = 'direct') { this.route = route; }
    dispatch(options, handler) {
      calls.push({ route: this.route, origin: options.origin });
      handler.onResponseStart(null, 204, {}, 'No Content');
      return true;
    }
    compose(interceptor) { return { dispatch: interceptor(this.dispatch.bind(this)) }; }
  }
  class EnvHttpProxyAgent extends Dispatcher {
    constructor(config) { super('proxy'); configuration = config; }
    async close() { calls.push('closed'); }
  }
  const previous = new Dispatcher();
  let current = previous;
  const undici = { Dispatcher, EnvHttpProxyAgent,
    getGlobalDispatcher: () => current, setGlobalDispatcher: next => { current = next; } };
  const fetch = (input, init) => new Promise(resolve => {
    const url = new URL(input instanceof Request ? input.url : input);
    (init?.dispatcher ?? current).dispatch({ origin: url.origin }, {
      onResponseStart: (_controller, status) => resolve(new Response(null, { status })),
    });
  });
  return { undici, calls, previous, fetch, config: () => configuration };
}

test('automatic proxy does not override explicit environment routing', async () => {
  for (const env of [{ HTTPS_PROXY: 'http://manual:80' }, { http_proxy: 'http://manual:80' }, { ALL_PROXY: 'socks5://manual:80' }]) {
    const proxy = await createAutoProxy(() => assert.fail('must not replace explicit routing'), {
      ...options, env, readSystem: () => assert.fail('must not query system settings'),
    });
    assert.equal(proxy.enabled, false);
    assert.equal(proxy.run(() => 'unchanged'), 'unchanged');
    await proxy.dispose();
  }
});

test('automatic proxy leaves unsupported or absent system settings alone', async () => {
  for (const override of [
    { platform: 'linux', readSystem: () => assert.fail('not macOS') },
    { readSystem: async () => { throw new Error('scutil unavailable'); } },
    { readSystem: async () => ({ stdout: systemProxy.replace('HTTPSEnable : 1', 'HTTPSEnable : 0') }) },
    { readSystem: async () => ({ stdout: systemProxy.replace('HTTPSPort : 7897', 'HTTPSPort : 99999') }) },
    { readSystem: async () => ({ stdout: systemProxy.replace('HTTPSProxy : 127.0.0.1', 'HTTPSProxy : user@remote') }) },
    { readSystem: async () => ({ stdout: '<dictionary> {\n  ProxyAutoConfigEnable : 1\n}' }) },
    { readSystem: async () => ({ stdout: systemProxy.replace('HTTPSEnable : 1', 'ProxyAutoConfigEnable : 1\n  HTTPSEnable : 1') }) },
    { readSystem: async () => ({ stdout: '<dictionary> {\n  __SCOPED__ : <dictionary> {\n    HTTPSEnable : 1\n    HTTPSProxy : 127.0.0.1\n    HTTPSPort : 7897\n  }\n}' }) },
  ]) {
    const proxy = await createAutoProxy(() => assert.fail('must not create a proxy'), { ...options, ...override });
    assert.equal(proxy.enabled, false);
    assert.equal(proxy.run(() => 'direct'), 'direct');
    await proxy.dispose();
  }
});

test('automatic proxy routes only scoped HTTPS requests and restores the dispatcher', async () => {
  const original = globalThis.fetch, fixture = transport();
  const env = { no_proxy: '  ', NO_PROXY: 'private.example' };
  globalThis.fetch = fixture.fetch;
  let proxy;
  try {
    proxy = await createAutoProxy(() => fixture.undici, { ...options, env });
    const config = fixture.config();
    assert.equal(config.httpsProxy, 'http://127.0.0.1:7897/');
    assert.equal(config.httpProxy, '');
    assert.match(config.noProxy, /private\.example/);
    assert.match(config.noProxy, /\*\.local/);
    assert.equal(proxy.enabled, true);
    assert.equal(globalThis.fetch, fixture.fetch);
    await Promise.all([
      proxy.run(async () => { await Promise.resolve(); await fetch('https://auth.openai.com/oauth/token'); }),
      fetch('https://unrelated.example'),
    ]);
    await proxy.run(() => fetch('http://remote.example'));
    await proxy.run(() => fetch('https://127.0.0.2'));
    await proxy.run(() => fetch('https://[::1]'));
    await proxy.run(() => fetch(new Request('https://api.kimi.com'), { dispatcher: new fixture.undici.Dispatcher('explicit') }));
    assert.deepEqual(fixture.calls.filter(call => call.route === 'proxy'), [{ route: 'proxy', origin: 'https://auth.openai.com' }]);
    assert.equal(fixture.calls.filter(call => call.route === 'direct').length, 4);
    assert.equal(fixture.calls.at(-1).route, 'explicit');
    assert.deepEqual(env, { no_proxy: '  ', NO_PROXY: 'private.example' });
    await proxy.dispose();
    assert.equal(fixture.undici.getGlobalDispatcher(), fixture.previous);
    assert.equal(globalThis.fetch, fixture.fetch);
    assert.equal(fixture.calls.at(-1), 'closed');
    proxy = null;
  } finally { await proxy?.dispose(); globalThis.fetch = original; }
});

test('automatic proxy follows lazy stream iteration without replacing a later dispatcher', async () => {
  const original = globalThis.fetch, fixture = transport();
  globalThis.fetch = fixture.fetch;
  let proxy;
  try {
    proxy = await createAutoProxy(() => fixture.undici, options);
    async function* source() {
      try { await fetch('https://chatgpt.com'); yield 'chunk'; }
      finally { await fetch('https://chatgpt.com'); }
    }
    const iterator = proxy.wrap(source());
    assert.deepEqual(await iterator.next(), { value: 'chunk', done: false });
    await iterator.return();
    assert.deepEqual(fixture.calls.map(call => call.route), ['proxy', 'proxy']);
    const later = new fixture.undici.Dispatcher();
    fixture.undici.setGlobalDispatcher(later);
    await proxy.dispose();
    assert.equal(fixture.undici.getGlobalDispatcher(), later);
    proxy = null;
  } finally { await proxy?.dispose(); globalThis.fetch = original; }
});
