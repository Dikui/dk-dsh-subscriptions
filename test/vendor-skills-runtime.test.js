import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { registerVendorSkills } from '../vendor-skills.js';
import { vendorSkillHost } from './vendor-skill-host.js';

const require = createRequire(import.meta.url);
let adapterEntry;
try {
  const selected = require.resolve(process.env.DSH_TEST_UNDICI ?? 'undici');
  adapterEntry = createRequire(selected).resolve('@deepseek-ai/dsh-llm-pi-ai');
} catch (error) { if (process.env.DSH_TEST_UNDICI) throw error; }

// small/spec — successful skill load admits exactly that route on the next step of its owner.
// Only session/agent identities and the vendor boundary are synthetic; no credentials, network or profile.
test('vendor skill admission follows live skill events, not prose, history or same-name overrides', {
  skip: !adapterEntry ? 'Set DSH_TEST_UNDICI to the desktop runtime.' : false,
}, async t => {
  const host = await vendorSkillHost(createRequire(adapterEntry));
  t.after(host.close);
  const never = () => assert.fail('Loading a skill must not touch the vendor or attachments');
  await registerVendorSkills(host.ctx, { kimiDatasource: true, grokXSearch: true, version: 'test',
    adapterUrl: pathToFileURL(adapterEntry),
    getAuth: never, fetchTool: never, attachments: never });
  const agent = host.sessionAgent('owner'), other = host.sessionAgent('other');
  const kimi = await host.ctx.skills.get('kimi-datasource'), grok = await host.ctx.skills.get('grok-x-search');
  const kimiTools = ['kimi_call_data_source_tool', 'kimi_get_data_source_desc'];
  const names = async caller => [...(await host.nextTools(caller)).keys()].sort();

  for (const [label, act] of [
    ['failed model load', () => host.modelLoad(agent, kimi, { isError: true })],
    ['same-name provider', () => host.modelLoad(agent, { ...kimi, provider: 'project' })],
    ['replaced content', () => host.modelLoad(agent, { ...grok, content: 'Different instructions.' })],
    ['ordinary prose', () => host.slashLoad(agent.session, kimi, { kind: 'user' })],
    ['same-name slash override', () => host.slashLoad(agent.session, { ...grok, provider: 'project' })],
    ['other session object with same ID', () => host.slashLoad({ ...agent.session }, kimi)],
  ]) {
    act();
    assert.deepEqual(await names(agent), [], label);
  }

  const current = await host.step(agent);
  host.modelLoad(agent, kimi);
  assert.deepEqual([...current.view(agent).keys()], [], 'same tool batch remains frozen');
  current.dispose();
  assert.deepEqual(await names(agent), kimiTools);
  assert.deepEqual(await names(other), []);
  const fork = host.sessionAgent('fork');
  fork.session.requestHeader = () => ({ tools: kimiTools.map(name => ({ name })) });
  assert.deepEqual(await names(fork), [], 'a copied request header is not a load');

  const beforeSlash = await host.step(other);
  host.slashLoad(other.session, grok);
  assert.deepEqual([...beforeSlash.view(other).keys()], []);
  beforeSlash.dispose();
  assert.deepEqual(await names(other), ['grok_x_search']);
  assert.deepEqual(await names(agent), kimiTools);
  host.slashLoad(agent.session, grok);
  assert.deepEqual(await names(agent), ['grok_x_search', ...kimiTools]);
  host.ctx.emit('agent/disposed', { agent });
  assert.deepEqual(await names(agent), []);
  assert.deepEqual(await names(host.sessionAgent('owner')), [], 'reopened session needs a new load');
});
