import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { initialStatus } from './panel-harness.js';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function credentialedTestUrl(host) {
  const url = new URL(`https://${host}`);
  url.username = 'u';
  url.password = 'p';
  return url.href;
}
function loadClient() {
  let declaration;
  const sandbox = { window: { __ModuleLoader__: { load(value) { declaration = value; } } }, URL, __test: {} };
  // Observe private pure helpers in the test VM only; the distributed factory
  // has no debug globals, no test exports and no extra runtime dependencies.
  const marker = "    return {\n      inject: ['slots', 'locale'],";
  assert.equal(source.split(marker).length, 2);
  vm.runInNewContext(source.replace(marker, "    Object.assign(__test, { trustedLink, validStatus, messages });\n" + marker), sandbox);
  const plugin = declaration.factory(name => { assert.equal(name, 'react'); return { createElement() {} }; });
  return { declaration, plugin, helpers: sandbox.__test };
}
test('client module registers only its settings slot and disposes translations', () => {
  const { declaration, plugin } = loadClient();
  assert.equal(declaration.id, 'dsh-dk-subscriptions');
  const dictionaries = new Map(), cleanup = [];
  let slot;
  plugin.apply({
    effect(fn) { cleanup.push(fn()); },
    locale: { register(ns, language, values) { assert.equal(ns, 'dsh-dk-subscriptions'); dictionaries.set(language, values); return () => dictionaries.delete(language); },
      bind() { return key => dictionaries.get('en')[key]; }, subscribe() {}, getSnapshot() {} },
    slots: { inject(name, fn) { assert.equal(name, 'settings.section'); fn(); }, register(options, component) { slot = options; assert.equal(typeof component, 'function'); } },
  });
  assert.equal(slot.id, 'subscriptions-lite'); assert.equal(slot.label(), 'dsh-dk-subscriptions');
  assert.equal(dictionaries.size, 2); cleanup.forEach(fn => fn()); assert.equal(dictionaries.size, 0);
});
test('authorization links enforce exact HTTPS vendor hosts', () => {
  const { helpers: h } = loadClient();
  assert.equal(h.trustedLink('https://auth.openai.com/codex/device', 'openai-codex'), 'https://auth.openai.com/codex/device');
  assert.equal(h.trustedLink('https://auth.kimi.com/verify?a=b', 'kimi-coding'), 'https://auth.kimi.com/verify?a=b');
  for (const url of ['http://auth.openai.com', 'https://auth.openai.com.evil.example', 'https://evil.example', credentialedTestUrl('auth.openai.com'), 'https://auth.openai.com:444', 'javascript:alert(1)']) assert.equal(h.trustedLink(url, 'openai-codex'), null);
  assert.equal(h.trustedLink('https://auth.x.ai', 'xai'), null);
});
test('Kimi verification host is distinct from its OAuth API host', () => {
  const { helpers: h } = loadClient();
  const url = 'https://www.kimi.com/code/oauth?user_code=TEST-CODE';
  assert.equal(h.trustedLink(url, 'kimi-coding'), url);
  for (const rejected of ['http://www.kimi.com/code/oauth', 'https://www.kimi.com.evil.example/code/oauth',
    'https://evil.kimi.com/code/oauth', credentialedTestUrl('www.kimi.com'), 'https://www.kimi.com:444/code/oauth']) {
    assert.equal(h.trustedLink(rejected, 'kimi-coding'), null);
  }
  assert.equal(h.trustedLink(url, 'openai-codex'), null);
});
test('locale dictionaries and packaged metadata are bilingual', () => {
  const { helpers: h } = loadClient();
  assert.deepEqual(Object.keys(h.messages.en).sort(), Object.keys(h.messages.zh).sort());
  for (const language of ['en', 'zh']) {
    const data = JSON.parse(readFileSync(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'));
    assert.equal(data.meta.title, 'dsh-dk-subscriptions'); assert.ok(data.meta.description);
  }
});
test('selection prompts use the installed authorization contract option.id, not option.value', () => {
  const { helpers: h } = loadClient();
  const attempt = { id: 'attempt', state: 'running', notices: [], prompt: { id: 'prompt', kind: 'select', message: 'Choose',
    options: [{ id: 'browser', label: 'Browser' }, { id: 'copy_code', label: 'Copy code' }] } };
  assert.ok(h.validStatus(initialStatus(attempt)));
  attempt.prompt.options = [{ value: 'browser', label: 'Wrong contract' }];
  assert.equal(h.validStatus(initialStatus(attempt)), false);
});

test('client validates malformed endpoint data', () => {
  const { helpers: h } = loadClient();
  for (const data of [null, {}, { providers: [] }, { providers: [{ id: '__proto__' }] }]) assert.ok(!h.validStatus(data));
});
