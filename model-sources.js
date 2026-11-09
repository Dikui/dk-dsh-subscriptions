import { createHash } from 'node:crypto';
import { fail } from './core.js';
import { codexSpeed } from './speed.js';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const positive = value => Number.isSafeInteger(value) && value > 0;
// pi-ai's level convention (getSupportedThinkingLevels): a missing level falls back to the
// default capability, null removes it, and xhigh/max exist only when explicitly mapped.
// Harness refuses a reasoning model that exposes no selectable effort and then drops the
// whole provider, so metadata without a usable declaration must keep the provider default.
const selectableEffort = map => levels.some(level => {
  const mapped = map?.[level];
  return mapped !== null && (level === 'xhigh' || level === 'max' ? mapped !== undefined : true);
});

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
    const reasoning = efforts.length > 0 && selectableEffort(thinkingLevelMap);
    const defaultEffort = efforts.includes(row.default_reasoning_level) ? canonicalEffort(row.default_reasoning_level) : undefined;
    selected.set(id, { priority: Number.isFinite(row.priority) ? row.priority : 0, model: {
      ...base, id, name: typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.slice(0, 200) : id,
      input: input.length ? [...new Set(input)] : ['text'], reasoning, thinkingLevelMap,
      speed: codexSpeed(row),
      supportsReasoningEffortUpdates: row.supports_reasoning_effort_updates === true,
      ...(reasoning && thinkingLevelMap[defaultEffort] != null ? { defaultReasoningEffort: defaultEffort } : {}),
      contextWindow: positive(row.context_window) ? row.context_window : positive(row.max_context_window) ? row.max_context_window : base.contextWindow,
      ...(positive(row.max_context_window) ? { maxContextWindow: row.max_context_window } : {}),
      cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } });
  }
  return [...selected.values()].sort((a, b) => a.priority - b.priority).map(item => item.model);
}

const emptyCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const effortMap = efforts => Object.fromEntries(levels.map(level => [level,
  efforts.includes(level === 'off' ? 'none' : level) ? (level === 'off' ? 'none' : level) : null]));
const canonicalEffort = effort => effort === 'none' ? 'off' : effort;
function dataRows(value) {
  if (!Array.isArray(value?.data) || value.data.length > 1000) fail('MODEL_CATALOG_INVALID');
  return value.data;
}
function template(baseModels, id) {
  const known = baseModels.find(model => model.id === id);
  const base = known ?? baseModels[0];
  if (!base) fail('MODEL_CATALOG_INVALID');
  // Unknown IDs inherit transport only, never a known model's vision, effort or cost claims.
  return { type: 'chat', api: base.api, baseUrl: base.baseUrl, provider: base.provider,
    // Missing output limits use a local generation policy, not another model's claimed capability.
    maxTokens: known?.maxTokens ?? 16384, contextWindow: known?.contextWindow ?? 32768,
    ...(base.compat ? { compat: { ...base.compat } } : {}),
    ...(base.inputLimits ? { inputLimits: structuredClone(base.inputLimits) } : {}), cost: known?.cost ?? emptyCost() };
}
function kimiModels(value, baseline) {
  if (value?.has_more === true) fail('MODEL_CATALOG_INVALID'); // Never publish an incomplete page as the full catalog.
  return dataRows(value).map(row => {
    const base = template(baseline, row?.id);
    const effort = row?.reasoning?.effort;
    const declared = row?.think_efforts?.support === true ? row.think_efforts.valid_efforts : effort?.valid;
    const onlyThinking = row?.reasoning?.type === 'only' || row?.supports_thinking_type === 'only';
    const efforts = Array.isArray(declared) ? declared.filter(item => (levels.includes(item) || item === 'none')
      && (!onlyThinking || !['none', 'off'].includes(item))) : [];
    const defaultEffort = canonicalEffort(row?.think_efforts?.default_effort ?? effort?.default);
    const thinkingLevelMap = effortMap(efforts);
    const reasoning = (row?.supports_reasoning === true || onlyThinking) && selectableEffort(thinkingLevelMap);
    return { ...base, id: row?.id, name: row?.display_name ?? row?.id,
      contextWindow: positive(row?.context_length) ? row.context_length : positive(row?.limit?.context) ? row.limit.context : base.contextWindow,
      input: row?.supports_image_in === true || row?.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'],
      reasoning, thinkingLevelMap,
      // A same-ID capability upgrade must reach the wire, even when its SDK template predates efforts.
      ...(Array.isArray(declared) ? { compat: { ...base.compat, supportsReasoningEffort: efforts.length > 0 } } : {}),
      ...(reasoning && thinkingLevelMap[defaultEffort] != null ? { defaultReasoningEffort: defaultEffort } : {}),
    };
  });
}
async function grokModels(value, baseline, { query }) {
  const rows = dataRows(value);
  const language = await query('https://api.x.ai/v1/language-models');
  if (!Array.isArray(language?.models) || language.models.length > 1000) fail('MODEL_CATALOG_INVALID');
  const textModels = new Map(language.models.filter(row => Array.isArray(row?.input_modalities)
    && row.input_modalities.includes('text') && Array.isArray(row.output_modalities)
    && row.output_modalities.length === 1 && row.output_modalities[0] === 'text').map(row => [row.id, row]));
  return rows.flatMap(row => {
    const text = textModels.get(row?.id);
    // xAI documents that multi-agent models cannot accept custom function tools.
    if (!text || /multi-agent/i.test(row?.id) || text.capabilities?.function_calling === false) return [];
    const base = template(baseline, row?.id);
    const known = baseline.find(model => model.id === row?.id);
    const capabilities = row?.capabilities ?? text.capabilities;
    const efforts = Array.isArray(capabilities?.reasoning_effort) ? capabilities.reasoning_effort : undefined;
    const thinkingLevelMap = efforts ? effortMap(efforts) : known?.thinkingLevelMap ?? effortMap([]);
    const reasoning = (efforts ? efforts.some(effort => effort !== 'none') : known?.reasoning === true)
      && selectableEffort(thinkingLevelMap);
    const defaultEffort = efforts?.includes(capabilities.default_reasoning_effort)
      ? canonicalEffort(capabilities.default_reasoning_effort) : undefined;
    return [{ ...base, id: row?.id, name: row?.id,
      contextWindow: positive(row?.context_length) ? row.context_length : base.contextWindow,
      input: text.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
      reasoning, thinkingLevelMap,
      ...(reasoning && thinkingLevelMap[defaultEffort] != null ? { defaultReasoningEffort: defaultEffort } : {}),
    }];
  });
}
function fingerprint(credential) {
  if (credential?.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access) return undefined;
  return createHash('sha256').update(JSON.stringify(['dk-subscriptions:catalog',
    credential.accountId, credential.subject, credential.refresh, credential.access])).digest('hex');
}

// Bound both declared and streamed bytes before parsing untrusted metadata.
async function catalogJson(response) {
  const limit = 1024 * 1024;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) { await response.body?.cancel(); fail('MODEL_CATALOG_INVALID'); }
  if (!response.body) fail('MODEL_CATALOG_INVALID');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('MODEL_CATALOG_INVALID'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('MODEL_CATALOG_INVALID'); }
  } finally { reader.releaseLock(); }
}

// One auth/HTTP boundary for all vendors. Raw identity reads stay local; the
// shared catalog flight owns official OAuth refresh as well as metadata HTTP.
function remoteSource({ endpoint, normalize, scope = 'account', headers = () => ({}) }) {
  return ({ baseModels, clientVersion, readCredential, getAuth, fetchCatalog }) => ({
    scope,
    async readIdentity(signal) { return fingerprint(await readCredential(signal)); },
    async resolveIdentity(signal) {
      if (!fingerprint(await readCredential(signal))) return undefined;
      const resolved = await getAuth(signal); // Official resolver safely persists rotation.
      if (resolved?.source !== 'OAuth') fail('MODEL_CATALOG_DENIED');
      const credential = await readCredential(signal);
      if (!fingerprint(credential)) return undefined;
      const bearer = resolved.auth?.apiKey ?? new Headers(resolved.auth?.headers).get('authorization')?.replace(/^Bearer\s+/i, '');
      if (credential.access !== bearer) fail('MODEL_CATALOG_CHANGED');
      return fingerprint(credential);
    },
    async loadModels({ identity, signal }) {
      const credential = await readCredential(signal);
      if (fingerprint(credential) !== identity) fail('MODEL_CATALOG_CHANGED');
      async function query(url) {
        const response = await fetchCatalog(url, { method: 'GET', redirect: 'error', signal,
          headers: { authorization: `Bearer ${credential.access}`, accept: 'application/json', ...headers(credential) } });
        if (!response.ok) {
          await response.body?.cancel();
          fail([401, 403].includes(response.status) ? 'MODEL_CATALOG_DENIED'
            : response.status === 429 ? 'MODEL_CATALOG_RATE_LIMIT' : 'MODEL_CATALOG_FAILED');
        }
        return catalogJson(response);
      }
      return normalize(await query(endpoint(clientVersion)), baseModels, { credential, query });
    },
  });
}
const openAICodexModels = remoteSource({
  endpoint: version => `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,
  headers: credential => {
    if (typeof credential.accountId !== 'string' || !credential.accountId) fail('MODEL_CATALOG_DENIED');
    return { 'chatgpt-account-id': credential.accountId, originator: 'pi' };
  },
  normalize: (payload, baseline, { credential }) => {
    const speedAccount = createHash('sha256').update(`dk-subscriptions:speed:${credential.accountId}`).digest('hex');
    return codexModels(payload, baseline).map(model => ({ ...model, speedAccount }));
  },
});
const kimiCodingModels = remoteSource({ endpoint: () => 'https://api.kimi.com/coding/v1/models', normalize: kimiModels });

// Verified remote catalogs only; SDK lists supply transport templates, never names.
const xaiModels = remoteSource({ endpoint: () => 'https://api.x.ai/v1/models', normalize: grokModels, scope: 'vendor' });
export const accountModelSources = new Map([['openai-codex', openAICodexModels], ['kimi-coding', kimiCodingModels], ['xai', xaiModels]]);
