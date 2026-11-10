import { fail } from './core.js';
import { remoteSource } from './model-sources.js';

const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const seconds = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const unixTime = value => seconds(value) && value <= 8640000000000 ? value * 1000 : null;

function codexQuota(payload) {
  const windows = [];
  // ponytail: primary/secondary limits only; normalize named feature limits when their display is needed.
  let partial = Array.isArray(payload?.additional_rate_limits) && payload.additional_rate_limits.length > 0;
  for (const [key, id] of [['primary_window', 'primary'], ['secondary_window', 'secondary']]) {
    const row = payload?.rate_limit?.[key];
    if (row == null) continue;
    const window = { id, usedPercent: percent(row.used_percent), windowSeconds: seconds(row.limit_window_seconds), resetsAt: unixTime(row.reset_at) };
    if (Object.values(window).includes(null)) partial = true;
    windows.push(window);
  }
  if (!windows.length) fail('QUOTA_INVALID');
  return { windows, partial };
}

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : null;
}
function kimiQuota(payload) {
  const windows = [];
  let partial = false;
  if (payload?.usages && typeof payload.usages === 'object' && !Array.isArray(payload.usages)) {
    const durations = { limit_5h: 18000, limit_7d: 604800, limit_month_total: null, limit_month_code: null };
    for (const [id, duration] of Object.entries(durations)) {
      const row = payload.usages[id];
      if (row == null) continue;
      const ratio = numeric(row.used_ratio);
      windows.push({ id, usedPercent: ratio === null ? null : percent(ratio * 100), windowSeconds: duration, resetsAt: isoTime(row.reset_time) });
    }
    if (Object.keys(payload.usages).some(id => !Object.hasOwn(durations, id))) partial = true;
  } else {
    const append = (id, row, windowSeconds = null) => {
      const limit = numeric(row?.limit), used = numeric(row?.used), remaining = numeric(row?.remaining);
      const amount = used ?? (limit !== null && remaining !== null ? limit - remaining : null);
      windows.push({ id, usedPercent: limit > 0 && amount !== null ? percent(amount / limit * 100) : null, windowSeconds,
        resetsAt: isoTime(row?.reset_at ?? row?.resetAt ?? row?.reset_time ?? row?.resetTime) });
    };
    if (payload?.usage != null) append('usage', payload.usage);
    if (payload?.limits != null && (!Array.isArray(payload.limits) || payload.limits.length > 100)) fail('QUOTA_INVALID');
    for (const [index, row] of (payload?.limits ?? []).entries()) {
      const unit = { MINUTE: 60, HOUR: 3600, DAY: 86400 }[String(row?.window?.timeUnit).replace(/^TIME_UNIT_/, '')];
      const duration = numeric(row?.window?.duration);
      const windowSeconds = unit && duration > 0 ? seconds(duration * unit) : null;
      if (windowSeconds === null) partial = true;
      append(`limit-${index}`, row?.detail && typeof row.detail === 'object' && !Array.isArray(row.detail) ? row.detail : row, windowSeconds);
    }
  }
  if (!windows.length) fail('QUOTA_INVALID');
  return { windows, partial: partial || windows.some(window => window.usedPercent === null || window.resetsAt === null) };
}

export const accountQuotaSources = new Map([
  ['openai-codex', remoteSource({ endpoint: () => 'https://chatgpt.com/backend-api/wham/usage', errorPrefix: 'QUOTA',
    headers: credential => {
      if (typeof credential.accountId !== 'string' || !credential.accountId) fail('QUOTA_DENIED');
      return { 'chatgpt-account-id': credential.accountId, originator: 'pi' };
    }, normalize: codexQuota })],
  ['kimi-coding', remoteSource({ endpoint: () => 'https://api.kimi.com/coding/v1/usages', errorPrefix: 'QUOTA', normalize: kimiQuota })],
]);
