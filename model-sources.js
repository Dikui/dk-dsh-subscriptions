import { createHash } from 'node:crypto';
import { fail } from './core.js';
import { codexSpeed } from './speed.js';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const positive = value => Number.isSafeInteger(value) && value > 0;

function codexModels(value, baseline) {
  if (!Array.isArray(value?.models) || value.models.length > 1000 || !baseline.length) fail('MODEL_CATALOG_INVALID');
  const selected = new Map();
  for (const row of value.models) {
    if (row?.visibility !== 'list' || row.supported_in_api === false) continue;
    const id = row.slug;
    if (selected.has(id)) continue;
    const known = baseline.find(model => model.id === id);
    const base = known ?? baseline.find(model => !/spark/i.test(model.id)) ?? baseline[0];
    const efforts = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map(item => item?.effort) : [];
    const thinkingLevelMap = Object.fromEntries(levels.map(level => [level, null]));
    for (const effort of efforts) {
      const level = effort === 'none' ? 'off' : effort;
      if (levels.includes(level)) thinkingLevelMap[level] = effort;
    }
    const input = Array.isArray(row.input_modalities) ? row.input_modalities.filter(type => ['text', 'image'].includes(type)) : [];
    selected.set(id, { priority: Number.isFinite(row.priority) ? row.priority : 0, model: {
      ...base, id, name: typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.slice(0, 200) : id,
      input: input.length ? [...new Set(input)] : ['text'], reasoning: efforts.length > 0, thinkingLevelMap,
      speed: codexSpeed(row),
      supportsReasoningEffortUpdates: row.supports_reasoning_effort_updates === true,
      defaultReasoningEffort: typeof row.default_reasoning_level === 'string' ? row.default_reasoning_level : undefined,
      contextWindow: positive(row.context_window) ? row.context_window : positive(row.max_context_window) ? row.max_context_window : base.contextWindow,
      ...(positive(row.max_context_window) ? { maxContextWindow: row.max_context_window } : {}),
      cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } });
  }
  return [...selected.values()].sort((a, b) => a.priority - b.priority).map(item => item.model);
}

function openAICodexModels({ baseModels, clientVersion, readCredential, getAuth, fetchCatalog }) {
  return {
    async readIdentity(signal) {
      const credential = await readCredential(signal);
      return credential?.type === 'oauth' && credential.access && typeof credential.accountId === 'string' ? credential.accountId : undefined;
    },
    async loadModels({ identity, signal }) {
      let credential;
      for (let attempt = 0; attempt < 2; attempt++) {
        const resolved = await getAuth(signal); // Official refresh also persists rotated tokens.
        if (resolved?.source !== 'OAuth') fail('MODEL_CATALOG_DENIED');
        credential = await readCredential(signal);
        if (credential?.type === 'oauth' && credential.accountId === identity && credential.access === resolved.auth?.apiKey) break;
        credential = undefined;
      }
      if (!credential) fail('MODEL_CATALOG_CHANGED');
      const response = await fetchCatalog(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': credential.accountId,
          accept: 'application/json', originator: 'pi' },
      });
      if (!response.ok) fail([401, 403].includes(response.status) ? 'MODEL_CATALOG_DENIED' : response.status === 429 ? 'MODEL_CATALOG_RATE_LIMIT' : 'MODEL_CATALOG_FAILED');
      let payload;
      try { payload = await response.json(); } catch { fail('MODEL_CATALOG_INVALID'); }
      // Account-scoped consent fingerprint, never a raw identifier or token.
      const speedAccount = createHash('sha256').update(`dk-subscriptions:speed:${identity}`).digest('hex');
      return codexModels(payload, baseModels).map(model => ({ ...model, speedAccount }));
    },
  };
}

// Only verified account-discovery sources belong here; SDK-local lists are not substitutes.
export const accountModelSources = new Map([['openai-codex', openAICodexModels]]);
