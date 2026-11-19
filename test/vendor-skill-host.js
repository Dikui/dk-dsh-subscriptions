import { pathToFileURL } from 'node:url';

// Offline host fixture: real Cordis ownership, skill discovery and step admission;
// in-memory agent/session identities stand in for a running conversation loop.
export async function vendorSkillHost(hostRequire, { legacy = false, withAgents = true } = {}) {
  const load = name => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${name}`)).href);
  const [{ Context }, { ToolsService }, { SkillRegistry, renderSkillContent }] = await Promise.all([
    load('cordis'), load('dsh-tools'), load('dsh-skill'),
  ]);
  const ctx = new Context(), agents = new Map();
  if (withAgents) ctx.provide('agents', agents);
  ctx.provide('systemPrompt', { tools() {} });
  if (legacy) ctx.provide('tools', { register() { throw new Error('Legacy register ignores conditions'); } });
  else await ctx.plugin(ToolsService);
  await ctx.plugin(SkillRegistry);
  const sessionAgent = id => {
    const agent = { session: { id } };
    agents.set(id, agent);
    return agent;
  };
  const step = agent => ctx.tools.resolve({ agent, signal: new AbortController().signal });
  const nextTools = async agent => {
    const selection = await step(agent);
    try { return selection.view(agent); } finally { selection.dispose(); }
  };
  const modelLoad = (agent, skill, result = { isError: false, value: skill }) => {
    ctx.emit('tools/result', { agent, name: 'skill', arguments: { name: skill.name } }, result);
  };
  const slashLoad = (session, skill, source = { kind: 'skill-invocation', form: 'instructions', name: skill.name }) => {
    ctx.emit('session/event', session, { type: 'user/message', data: { source, content: [{ type: 'text', text: renderSkillContent(skill) }] } });
  };
  return { ctx, sessionAgent, step, nextTools, modelLoad, slashLoad, close: () => ctx.fiber.dispose() };
}
