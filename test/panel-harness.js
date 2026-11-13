import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped Panel's event handlers and effects without a second
// React installation. This is a deterministic hook harness, not a browser or
// an assertion about browser popup policy / native shell behavior.
export async function panelHarness({ fetch, open = () => null, clipboard, confirm = () => true, language = 'en', localeSnapshot, prompt, answer, speed, quota }) {
  let declaration, Panel, Prompt, Speed, SidebarQuota, cursor = 0, pendingRender = false, effects = [], tree;
  const cells = [], cleanups = [], timers = new Map(), dictionaries = new Map();
  let timerId = 0;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity).filter(child => child !== false && child != null) } }; },
    useState(initial) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [cells[index].value, next => {
        cells[index].value = typeof next === 'function' ? next(cells[index].value) : next;
        pendingRender = true;
      }];
    },
    useRef(value) { const index = cursor++; return cells[index] ??= { current: value }; },
    useId() { return `test-${cursor++}`; },
    useSyncExternalStore(subscribe, snapshot) { cursor++; return snapshot(); },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = cells[index];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        effects.push(() => { previous?.cleanup?.(); cells[index] = { deps, cleanup: callback() }; });
      }
    },
  };
  const sandbox = {
    URL, AbortController, fetch, navigator: { clipboard }, __capturePrompt(component) { Prompt = component; }, __captureSpeed(component) { Speed = component; },
    __captureQuota(component) { SidebarQuota = component; },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: { __ModuleLoader__: { load(value) { declaration = value; } }, open, confirm },
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const marker = '        function Panel({ close, embedded = close === undefined }) {';
  assert.equal(source.split(marker).length, 2);
  // Capture the real nested component only inside this VM; shipped code has no test exports.
  vm.runInNewContext(source.replace(marker, '        __capturePrompt(Prompt);\n        __captureSpeed(Speed);\n        __captureQuota(SidebarQuota);\n' + marker), sandbox);
  const plugin = declaration.factory(name => { assert.equal(name, 'react'); return React; });
  plugin.apply({
    effect(fn) { cleanups.push(fn()); },
    locale: {
      register(ns, locale, values) { dictionaries.set(locale, values); return () => dictionaries.delete(locale); },
      bind() { return key => dictionaries.get(language)?.[key] ?? key; },
      subscribe() { return () => {}; }, getSnapshot() { return localeSnapshot ?? { active: language, revision: 1 }; },
    },
    slots: { inject(name, callback) { callback(); }, register(options, component) { if (options.name === 'sidebar.footer.action') SidebarQuota = component; else if (options.name === 'settings.models.footer') Panel = component; } },
  });
  function render() {
    cursor = 0; pendingRender = false;
    tree = quota ? SidebarQuota() : speed ? Speed(speed) : prompt ? Prompt({ prompt, disabled: false, answer }) : Panel({ close() {} });
    const callbacks = effects; effects = []; callbacks.forEach(callback => callback());
  }
  async function flush() {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (pendingRender) render();
    }
  }
  function nodes(node = tree) {
    if (node == null || typeof node !== 'object') return [];
    return [node, ...(node.props?.children ?? []).flatMap(child => nodes(child))];
  }
  function text(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    return (node?.props?.children ?? []).map(text).join('');
  }
  function within(label) {
    const card = nodes().find(node => node.type === 'article' && node.props['aria-label'] === label);
    assert.ok(card, `missing provider card: ${label}`);
    return nodes(card);
  }
  function button(label, provider = 'Kimi Code') {
    const found = (provider ? within(provider) : nodes()).find(node => node.type === 'button' && text(node) === label);
    assert.ok(found, `missing button: ${label}`); return found;
  }
  render(); await flush();
  return {
    get tree() { return tree; }, text: (node = tree) => text(node), nodes, within, button, flush,
    async rerender() { render(); await flush(); },
    async click(label, provider) { const node = button(label, provider); assert.ok(!node.props.disabled); const work = node.props.onClick(); await flush(); return work; },
    async poll() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); await flush(); },
    dispose() { for (const cell of cells) cell?.cleanup?.(); cleanups.forEach(fn => fn?.()); timers.clear(); },
  };
}

export function initialStatus(attempt = null, provider = 'kimi-coding') {
  return { providers: [
    { id: 'openai-codex', name: 'OpenAI · ChatGPT', route: 'subscription-openai-codex', available: true, configured: false, credentialKind: null, models: [], modelCatalog: { source: 'account', state: 'unloaded', error: null, updatedAt: null }, attempt: null },
    { id: 'kimi-coding', name: 'Kimi Code', route: 'subscription-kimi-coding', available: true, configured: false, credentialKind: null, models: [], modelCatalog: { source: 'account', state: 'unloaded', error: null, updatedAt: null }, attempt: provider === 'kimi-coding' ? attempt : null },
    { id: 'xai', name: 'Grok', route: 'subscription-xai', available: true, configured: false, credentialKind: null, models: [], modelCatalog: { source: 'account', state: 'unloaded', error: null, updatedAt: null }, attempt: provider === 'xai' ? attempt : null },
  ] };
}
