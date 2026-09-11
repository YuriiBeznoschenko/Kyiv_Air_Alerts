const CACHE_TTL_MS = 45_000;
const DEFAULT_TIMEOUT_MS = 9_000;
const KYIV_NAMES = new Set(['м київ', 'місто київ', 'kyiv', 'kyiv city', 'city of kyiv']);

let memoryCache = { expiresAt: 0, payload: null };

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  if (!force && memoryCache.payload && Date.now() < memoryCache.expiresAt) {
    return json({ ...memoryCache.payload, cache: 'memory' }, 200, true);
  }

  const token = process.env.ALERTS_API_TOKEN
    || process.env.ALERTS_IN_UA_TOKEN
    || process.env.UKRAINE_ALARM_API_TOKEN;

  if (!token) {
    return json({
      ok: false,
      configured: false,
      error: 'Missing ALERTS_API_TOKEN environment variable',
      generatedAt: new Date().toISOString(),
    }, 503);
  }

  const requestedProvider = String(process.env.ALERTS_PROVIDER || 'ukraine-alarm-v3').toLowerCase();
  const candidates = requestedProvider === 'auto'
    ? ['alerts-in-ua', 'ukraine-alarm-v3']
    : [requestedProvider];
  const failures = [];

  for (const provider of candidates) {
    try {
      const payload = provider === 'alerts-in-ua'
        ? await fetchAlertsInUa(token)
        : provider === 'ukraine-alarm-v3'
          ? await fetchUkraineAlarmV3(token)
          : null;

      if (!payload) throw new Error(`Unsupported provider: ${provider}`);
      const response = {
        ok: true,
        configured: true,
        generatedAt: new Date().toISOString(),
        cache: 'origin',
        ...payload,
      };
      memoryCache = { expiresAt: Date.now() + CACHE_TTL_MS, payload: response };
      return json(response, 200, !force);
    } catch (error) {
      failures.push(`${provider}: ${safeError(error)}`);
    }
  }

  return json({
    ok: false,
    configured: true,
    error: 'All configured alert providers failed',
    details: failures,
    generatedAt: new Date().toISOString(),
  }, 502);
}

export const config = { path: '/api/air-alerts' };

async function fetchAlertsInUa(token) {
  const base = trimSlash(process.env.ALERTS_IN_UA_BASE || 'https://api.alerts.in.ua/v1');
  const regionUid = String(process.env.ALERTS_IN_UA_REGION_UID || '31');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  const [historyPayload, activePayload] = await Promise.all([
    fetchJson(`${base}/regions/${encodeURIComponent(regionUid)}/alerts/month_ago.json`, headers),
    fetchJson(`${base}/alerts/active.json`, headers),
  ]);

  const historyItems = arrayFrom(historyPayload, ['alerts', 'data', 'items'])
    .filter(item => isKyivItem(item, regionUid))
    .map(normalizeAlert)
    .filter(Boolean);
  const activeItems = arrayFrom(activePayload, ['alerts', 'data', 'items'])
    .filter(item => isKyivItem(item, regionUid))
    .map(normalizeAlert)
    .filter(Boolean)
    .filter(item => item.ongoing);

  const active = activeItems.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0] || null;
  const alerts = dedupeAlerts([...historyItems, ...activeItems]);
  if (!alerts.length && !active) throw new Error('No Kyiv alert records returned');

  return {
    provider: 'alerts.in.ua',
    providerUrl: 'https://alerts.in.ua/',
    region: { id: regionUid, name: 'Kyiv City' },
    classificationAvailable: alerts.some(hasClassification) || Boolean(active && hasClassification(active)),
    alerts,
    active,
    warnings: [],
  };
}

async function fetchUkraineAlarmV3(token) {
  const base = trimSlash(process.env.UKRAINE_ALARM_API_BASE || 'https://api.ukrainealarm.com');
  const headers = { Authorization: token, Accept: 'application/json' };
  const warnings = [];
  let regionId = process.env.KYIV_REGION_ID || '';

  if (!regionId) {
    try {
      const regionsPayload = await fetchJson(`${base}/api/v3/regions`, headers);
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
    fetchJson(`${base}/api/v3/alerts/regionHistory?regionId=${encodeURIComponent(regionId)}`, headers),
    fetchJson(`${base}/api/v3/alerts/${encodeURIComponent(regionId)}`, headers),
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

function normalizeAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (normalizeAlertType(raw) !== 'air_raid') return null;

  const start = firstDate(raw, ['started_at', 'startDate', 'start_date', 'start', 'created_at', 'lastUpdate', 'last_update']);
  const end = firstDate(raw, ['finished_at', 'endDate', 'end_date', 'end', 'ended_at']);
  if (!start) return null;

  const threats = extractThreats(raw);
  const level = normalizeLevel(raw.alert_level || raw.alertLevel || raw.level || raw.color, threats);
  const ongoing = Boolean(raw.isContinue ?? raw.is_continue ?? raw.ongoing ?? !end);
  const phases = normalizePhases(raw.phases || raw.levelHistory || raw.level_history || [], start, end, level, threats);

  return {
    id: String(raw.id ?? raw.alertId ?? raw.alert_id ?? `${start}|${end || 'open'}`),
    start,
    end: ongoing ? null : end,
    ongoing,
    alertType: 'air_raid',
    level,
    threats,
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

function normalizePhases(value, alertStart, alertEnd, fallbackLevel, threats) {
  const list = Array.isArray(value) ? value : [];
  const phases = list.map(item => ({
    start: firstDate(item, ['started_at', 'startedAt', 'startDate', 'start']) || alertStart,
    end: firstDate(item, ['finished_at', 'finishedAt', 'endDate', 'end']) || null,
    level: normalizeLevel(item?.level || item?.alert_level || item?.alertLevel, normalizeThreats(item?.threats || [])),
    threats: normalizeThreats(item?.threats || []),
    sourceMessage: String(item?.source_message || item?.sourceMessage || item?.message || '').trim(),
  })).filter(item => item.start);

  if (phases.length) return phases;

  const threatEvents = threats
    .filter(item => item.startedAt)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (threatEvents.length) {
    return threatEvents.map((item, index) => ({
      start: item.startedAt,
      end: threatEvents[index + 1]?.startedAt || alertEnd || null,
      level: item.level || fallbackLevel,
      threats: [item],
      sourceMessage: item.sourceMessage,
    }));
  }

  return fallbackLevel && fallbackLevel !== 'unknown'
    ? [{ start: alertStart, end: alertEnd || null, level: fallbackLevel, threats, sourceMessage: '' }]
    : [];
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

async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
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
