const DEFAULT_TIMEOUT_MS = 7_000;
const KYIV_NAMES = new Set(['м київ', 'місто київ', 'kyiv', 'kyiv city', 'city of kyiv']);

export function buildProviderCandidates(env = {}, preferredProvider = '') {
  const genericToken = String(env.ALERTS_API_TOKEN || '').trim();
  const explicitAlertsToken = String(env.ALERTS_IN_UA_TOKEN || '').trim();
  const tokens = {
    'alerts-in-ua': explicitAlertsToken || genericToken,
    'ukraine-alarm-v3': String(env.UKRAINE_ALARM_API_TOKEN || genericToken).trim(),
  };
  const requested = String(env.ALERTS_PROVIDER || 'auto').trim().toLowerCase();
  const requestedOrder = requested === 'auto'
    ? ['alerts-in-ua', 'ukraine-alarm-v3']
    : [requested];
  const order = [
    ...(explicitAlertsToken ? ['alerts-in-ua'] : []),
    preferredProvider,
    ...requestedOrder,
    'alerts-in-ua',
    'ukraine-alarm-v3',
  ];
  const seen = new Set();
  return order.flatMap(provider => {
    if (!tokens[provider] || seen.has(provider)) return [];
    seen.add(provider);
    return [{ provider, token: tokens[provider] }];
  });
}

export async function fetchConfiguredProvider(options = {}) {
  const env = options.env || {};
  const fetchImpl = options.fetchImpl || fetch;
  const candidates = buildProviderCandidates(env, options.preferredProvider);
  if (!candidates.length) throw new Error('No supported alert-provider token is configured');
  const failures = [];

  for (const candidate of candidates) {
    try {
      const payload = candidate.provider === 'alerts-in-ua'
        ? await fetchAlertsInUa(candidate.token, env, fetchImpl)
        : await fetchUkraineAlarmV3(candidate.token, env, fetchImpl);
      return { payload, providerKey: candidate.provider, failures };
    } catch (error) {
      failures.push(`${candidate.provider}: ${safeError(error)}`);
    }
  }

  const error = new Error(`All configured alert providers failed · ${failures.join(' · ')}`);
  error.failures = failures;
  throw error;
}

async function fetchAlertsInUa(token, env, fetchImpl) {
  const base = trimSlash(env.ALERTS_IN_UA_BASE || 'https://api.alerts.in.ua/v1');
  const regionUid = String(env.ALERTS_IN_UA_REGION_UID || '31');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // Kyiv Digital remains the source of completed intervals. The collector only
  // needs the live snapshot here, which avoids consuming the provider's
  // rate-limited history endpoint once per minute.
  const activePayload = await fetchJson(`${base}/alerts/active.json`, headers, fetchImpl);
  const activeItems = arrayFrom(activePayload, ['alerts', 'data', 'items'])
    .filter(item => isKyivItem(item, regionUid))
    .map(normalizeAlert)
    .filter(Boolean)
    .filter(item => item.ongoing);

  const active = activeItems.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0] || null;
  const alerts = dedupeAlerts(activeItems);

  return {
    provider: 'alerts.in.ua',
    providerUrl: 'https://alerts.in.ua/',
    region: { id: regionUid, name: 'Kyiv City' },
    classificationAvailable: true,
    alerts,
    active,
    warnings: [],
  };
}

async function fetchUkraineAlarmV3(token, env, fetchImpl) {
  const base = trimSlash(env.UKRAINE_ALARM_API_BASE || 'https://api.ukrainealarm.com');
  const headers = { Authorization: token, Accept: 'application/json' };
  const warnings = [];
  let regionId = env.KYIV_REGION_ID || '';

  if (!regionId) {
    try {
      const regionsPayload = await fetchJson(`${base}/api/v3/regions`, headers, fetchImpl);
      regionId = findKyivRegionId(regionsPayload) || '';
    } catch (error) {
      warnings.push(`Region directory unavailable: ${safeError(error)}`);
    }
  }
  if (!regionId) {
    regionId = '31';
    warnings.push('Kyiv region ID could not be resolved; fallback ID 31 was used. Set KYIV_REGION_ID if required.');
  }

  const [historyPayload, statusPayload] = await Promise.all([
    fetchJson(`${base}/api/v3/alerts/regionHistory?regionId=${encodeURIComponent(regionId)}`, headers, fetchImpl),
    fetchJson(`${base}/api/v3/alerts/${encodeURIComponent(regionId)}`, headers, fetchImpl),
  ]);

  const historyGroup = findHistoryGroup(historyPayload, regionId);
  const rawHistory = arrayFrom(historyGroup || historyPayload, ['alarms', 'alerts', 'data', 'items']);
  const history = rawHistory.map(normalizeAlert).filter(Boolean);

  const statusGroup = findStatusGroup(statusPayload, regionId);
  const activeRaw = arrayFrom(statusGroup || statusPayload, ['activeAlerts', 'active_alerts', 'alerts', 'data', 'items'])
    .filter(item => normalizeAlertType(item) === 'air_raid');
  const activeMeta = activeRaw.map(normalizeCurrentMetadata).filter(Boolean)[0] || null;

  const active = resolveActiveAlert(history, activeMeta);

  const alerts = dedupeAlerts([...history, ...(active ? [active] : [])]);
  if (!alerts.length && !active) throw new Error('No Kyiv alert records returned');

  return {
    provider: 'Ukraine Alert API v3',
    providerUrl: 'https://www.ukrainealarm.com/',
    region: { id: String(regionId), name: statusGroup?.regionName || historyGroup?.regionName || 'Kyiv City' },
    classificationAvailable: alerts.some(hasClassification) || Boolean(active && hasClassification(active)),
    alerts,
    active,
    warnings,
  };
}

export function normalizeAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (normalizeAlertType(raw) !== 'air_raid') return null;

  const start = firstDate(raw, ['started_at', 'startDate', 'start_date', 'start', 'created_at', 'lastUpdate', 'last_update']);
  const end = firstDate(raw, ['finished_at', 'endDate', 'end_date', 'end', 'ended_at']);
  if (!start) return null;

  const threats = extractThreats(raw);
  const observedLevel = normalizeLevel(raw.alert_level || raw.alertLevel || raw.level || raw.color, threats);
  const ongoing = Boolean(raw.isContinue ?? raw.is_continue ?? raw.ongoing ?? !end);
  const phases = normalizePhases(raw.phases || raw.levelHistory || raw.level_history || [], start, end);
  const level = ongoing ? observedLevel : normalizeLevel(phases.at(-1)?.level);

  return {
    id: String(raw.id ?? raw.alertId ?? raw.alert_id ?? `${start}|${end || 'open'}`),
    start,
    end: ongoing ? null : end,
    ongoing,
    alertType: 'air_raid',
    level,
    threats: ongoing ? threats : [],
    phases,
    sourceMessage: String(raw.notes || raw.source_message || raw.sourceMessage || '').trim(),
  };
}

function normalizeCurrentMetadata(raw) {
  if (!raw || typeof raw !== 'object' || normalizeAlertType(raw) !== 'air_raid') return null;
  const threats = extractThreats(raw);
  const level = normalizeLevel(raw.alert_level || raw.alertLevel || raw.level || raw.color, threats);
  const threatStart = threats.map(item => item.startedAt).filter(Boolean).sort()[0] || null;
  const start = firstDate(raw, ['started_at', 'startDate', 'start_date', 'start', 'created_at'])
    || threatStart
    || firstDate(raw, ['lastUpdate', 'last_update']);
  return {
    id: String(raw.id ?? raw.alertId ?? raw.alert_id ?? start ?? 'active'),
    start,
    end: null,
    ongoing: true,
    alertType: 'air_raid',
    level,
    threats,
    phases: normalizePhases(raw.phases || raw.levelHistory || raw.level_history || [], start, null, level, threats),
    sourceMessage: String(raw.notes || raw.source_message || raw.sourceMessage || threats.map(item => item.sourceMessage).filter(Boolean).join(' · ') || '').trim(),
  };
}


function extractThreats(raw) {
  const direct = raw?.threats || raw?.activeThreats || raw?.active_threats || raw?.activeAlertLevels || raw?.active_alert_levels || [];
  return normalizeThreats(direct);
}

function normalizeThreats(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map(item => {
    if (typeof item === 'string') return { type: item, level: normalizeLevel(item), startedAt: null, sourceMessage: '' };
    const reason = String(item?.reason || item?.source_message || item?.sourceMessage || item?.message || '').trim();
    const type = String(item?.threat_type || item?.threatType || item?.type || item?.name || reason || 'unknown').toLowerCase();
    const level = normalizeLevel(item?.level || item?.alert_level || item?.alertLevel || type || reason);
    return {
      type,
      level,
      startedAt: firstDate(item, ['started_at', 'startedAt', 'startDate', 'start', 'createdAt', 'created_at']),
      sourceMessage: reason,
    };
  });
}

function normalizePhases(value, alertStart, alertEnd) {
  const list = Array.isArray(value) ? value : [];
  const phases = list.map(item => ({
    start: firstDate(item, ['started_at', 'startedAt', 'startDate', 'start']) || alertStart,
    end: firstDate(item, ['finished_at', 'finishedAt', 'endDate', 'end']) || null,
    level: normalizeLevel(item?.level || item?.alert_level || item?.alertLevel, normalizeThreats(item?.threats || [])),
    threats: normalizeThreats(item?.threats || []),
    sourceMessage: String(item?.source_message || item?.sourceMessage || item?.message || '').trim(),
  })).filter(item => item.start);
  return phases;
}

function normalizeAlertType(raw) {
  const value = String(raw?.alert_type || raw?.alertType || raw?.type || 'air_raid').toLowerCase();
  if (['air', 'air_raid', 'airraid', 'air raid'].includes(value)) return 'air_raid';
  return value;
}

function normalizeLevel(value, threats = []) {
  const text = String(value || '').toLowerCase();
  if (text.includes('yellow') || text.includes('жовт')) return 'yellow';
  if (text.includes('red') || text.includes('черв')) return 'red';
  if (threats.some(item => item.level === 'red')) return 'red';
  if (threats.some(item => item.level === 'yellow')) return 'yellow';
  if (/(ballistic|cruise|missile|rocket|mig31|strategic|guided|бомб|ракет)/.test(text)) return 'red';
  if (/(drone|uav|shahed|бпла|дрон)/.test(text)) return 'yellow';
  return 'unknown';
}

function mergeMetadata(alert, metadata) {
  return {
    ...alert,
    level: metadata.level !== 'unknown' ? metadata.level : alert.level,
    threats: metadata.threats?.length ? metadata.threats : alert.threats,
    phases: metadata.phases?.length ? metadata.phases : alert.phases,
    sourceMessage: metadata.sourceMessage || alert.sourceMessage,
  };
}

export function resolveActiveAlert(history, activeMetadata) {
  // The live status endpoint is authoritative. History can lag after an
  // all-clear, so an open history row must never resurrect an inactive alert.
  if (!activeMetadata) return null;

  const openHistory = (Array.isArray(history) ? history : [])
    .filter(item => item?.ongoing)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const matchingHistory = activeMetadata.start
    ? openHistory.find(item => Math.abs(Date.parse(item.start) - Date.parse(activeMetadata.start)) <= 5 * 60 * 1000)
    : openHistory[0];

  if (matchingHistory) {
    return { ...mergeMetadata(matchingHistory, activeMetadata), end: null, ongoing: true };
  }
  return activeMetadata.start ? { ...activeMetadata, end: null, ongoing: true } : null;
}

function hasClassification(alert) {
  return alert?.level === 'yellow' || alert?.level === 'red' || Boolean(alert?.threats?.length) || Boolean(alert?.phases?.length);
}

function findKyivRegionId(payload) {
  const stack = [];
  if (Array.isArray(payload)) stack.push(...payload);
  else if (payload && typeof payload === 'object') stack.push(payload);

  let fallback = null;
  while (stack.length) {
    const item = stack.shift();
    if (!item || typeof item !== 'object') continue;
    const name = normalizeName(item.regionName || item.region_name || item.name || item.title || '');
    const id = item.regionId || item.region_id || item.id || item.uid;
    if (id != null && KYIV_NAMES.has(name)) return String(id);
    if (id != null && !fallback && name.includes('київ') && !name.includes('област')) fallback = String(id);
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return fallback;
}

function findHistoryGroup(payload, regionId) {
  const groups = Array.isArray(payload) ? payload : arrayFrom(payload, ['data', 'items', 'history']);
  return groups.find(item => String(item?.regionId ?? item?.region_id ?? '') === String(regionId))
    || groups.find(item => normalizeName(item?.regionName || item?.region_name || '').includes('київ'))
    || groups[0]
    || null;
}

function findStatusGroup(payload, regionId) {
  const groups = Array.isArray(payload) ? payload : arrayFrom(payload, ['data', 'items', 'regions']);
  return groups.find(item => String(item?.regionId ?? item?.region_id ?? '') === String(regionId))
    || groups.find(item => KYIV_NAMES.has(normalizeName(item?.regionName || item?.region_name || item?.name || '')))
    || groups[0]
    || null;
}

function isKyivItem(item, regionUid) {
  const uid = item?.location_uid ?? item?.locationUid ?? item?.regionId ?? item?.region_id;
  if (uid != null && String(uid) === String(regionUid)) return true;
  const name = normalizeName(item?.location_title || item?.locationTitle || item?.regionName || item?.region_name || '');
  return KYIV_NAMES.has(name) || (name.includes('київ') && !name.includes('област'));
}

function arrayFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function firstDate(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function dedupeAlerts(items) {
  const sorted = items.filter(Boolean).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const result = [];
  for (const item of sorted) {
    const duplicate = result.find(existing => Math.abs(Date.parse(existing.start) - Date.parse(item.start)) <= 120_000);
    if (duplicate) {
      Object.assign(duplicate, mergeMetadata(duplicate, item));
      if (!duplicate.end && item.end) duplicate.end = item.end;
      duplicate.ongoing = duplicate.ongoing || item.ongoing;
    } else {
      result.push({ ...item });
    }
  }
  return result;
}

async function fetchJson(url, headers, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? ` · ${text.slice(0, 120)}` : ''}`);
    try { return JSON.parse(text); }
    catch { throw new Error('Provider returned invalid JSON'); }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.ʼ'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimSlash(value) { return String(value).replace(/\/+$/, ''); }
function safeError(error) { return String(error?.message || error || 'Unknown error').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240); }
function corsHeaders() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function json(body, status = 200, cacheable = false) {
  const headers = {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheable
      ? 'public, max-age=5, must-revalidate'
      : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (cacheable) {
    headers['Netlify-CDN-Cache-Control'] = 'public, durable, s-maxage=45, must-revalidate';
  }
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}
