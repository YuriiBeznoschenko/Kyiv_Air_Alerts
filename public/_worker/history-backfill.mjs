import { normalizeCollectorState } from './phase-collector.mjs';
import { normalizeObservedPhaseRecords } from '../alert-reconciliation-v2.mjs';

const HISTORY_URL = 'https://api.alerts.in.ua/v1/regions/31/alerts/month_ago.json';
const REQUEST_TIMEOUT_MS = 20_000;
const SUCCESS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MATCH_TOLERANCE_MS = 2 * 60 * 1000;
const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const KNOWN_LEVELS = new Set(['yellow', 'red']);

export async function backfillHistoricalClassifications({ store, env, nowMs = Date.now(), fetchImpl = fetch }) {
  const token = String(env.ALERTS_IN_UA_TOKEN || env.ALERTS_API_TOKEN || '').trim();
  if (!token) return { status: 'skipped', reason: 'alerts.in.ua token is not configured' };

  let claimed = false;
  await store.update(current => {
    claimed = false;
    const state = normalizeCollectorState(current);
    const meta = state.historyBackfill;
    const cooldown = meta.lastError ? FAILURE_COOLDOWN_MS : SUCCESS_INTERVAL_MS;
    if (Number.isFinite(meta.lastAttemptAtMs) && nowMs - meta.lastAttemptAtMs < cooldown) return state;
    claimed = true;
    state.historyBackfill = {
      ...meta,
      lastAttemptAtMs: nowMs,
      lastError: '',
    };
    return state;
  });

  if (!claimed) return { status: 'not-due' };

  try {
    const response = await fetchHistory(token, fetchImpl);
    const rows = extractAlerts(response);
    const imported = rows
      .filter(isKyivCityAlert)
      .map(toHistoricalClassification)
      .filter(Boolean);

    let added = 0;
    let refreshed = 0;
    await store.update(current => {
      const state = normalizeCollectorState(current);
      const result = mergeHistoricalRecords(state.records, imported, nowMs);
      added = result.added;
      refreshed = result.refreshed;
      state.records = result.records;
      state.historyBackfill = {
        ...state.historyBackfill,
        lastSuccessAtMs: nowMs,
        lastAttemptAtMs: nowMs,
        lastError: '',
        sourceRows: rows.length,
        classifiedRows: imported.length,
        recordsAdded: added,
        recordsRefreshed: refreshed,
      };
      return state;
    });

    return { status: 'completed', sourceRows: rows.length, classifiedRows: imported.length, added, refreshed };
  } catch (error) {
    const message = safeError(error);
    await store.update(current => {
      const state = normalizeCollectorState(current);
      state.historyBackfill = {
        ...state.historyBackfill,
        lastAttemptAtMs: nowMs,
        lastError: message,
      };
      return state;
    });
    return { status: 'failed', error: message };
  }
}

async function fetchHistory(token, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(HISTORY_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`alerts.in.ua history HTTP ${response.status}${text ? ` · ${text.slice(0, 120)}` : ''}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('alerts.in.ua history returned invalid JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

function extractAlerts(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['alerts', 'data', 'items', 'history']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function isKyivCityAlert(row) {
  if (!row || typeof row !== 'object') return false;
  const uid = String(row.location_uid ?? row.locationUid ?? row.regionId ?? '');
  if (uid !== '31') return false;
  const type = String(row.alert_type ?? row.alertType ?? 'air_raid').toLowerCase();
  return ['air_raid', 'airraid', 'air raid', 'air'].includes(type);
}

function toHistoricalClassification(row) {
  const startMs = parseDate(row.started_at ?? row.startDate ?? row.start);
  const endMs = parseDate(row.finished_at ?? row.endDate ?? row.end ?? row.ended_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const explicitPhases = Array.isArray(row.phases)
    ? row.phases
    : Array.isArray(row.level_history)
      ? row.level_history
      : Array.isArray(row.levelHistory)
        ? row.levelHistory
        : [];
  const phases = explicitPhases
    .map(phase => normalizeHistoricalPhase(phase, startMs, endMs))
    .filter(Boolean);

  if (!phases.length) {
    const level = normalizeLevel(row.alert_level ?? row.alertLevel ?? row.level ?? row.color);
    if (!KNOWN_LEVELS.has(level)) return null;
    phases.push({
      startMs,
      endMs,
      level,
      threats: normalizeThreats(row.threats),
      sourceMessage: String(row.notes || row.source_message || row.sourceMessage || ''),
    });
  }

  return {
    startMs,
    endMs,
    phases,
    sourceMessage: String(row.notes || row.source_message || row.sourceMessage || ''),
  };
}

function normalizeHistoricalPhase(phase, alertStartMs, alertEndMs) {
  const startMs = Math.max(alertStartMs, parseDate(phase.started_at ?? phase.startDate ?? phase.start));
  const endMs = Math.min(alertEndMs, parseDate(phase.finished_at ?? phase.endDate ?? phase.end) || alertEndMs);
  const level = normalizeLevel(phase.level ?? phase.alert_level ?? phase.alertLevel ?? phase.color);
  if (!Number.isFinite(startMs) || endMs <= startMs || !KNOWN_LEVELS.has(level)) return null;
  return {
    startMs,
    endMs,
    level,
    threats: normalizeThreats(phase.threats),
    sourceMessage: String(phase.source_message || phase.sourceMessage || phase.message || ''),
  };
}

function mergeHistoricalRecords(existingInput, imported, nowMs) {
  const records = normalizeObservedPhaseRecords(existingInput);
  let added = 0;
  let refreshed = 0;

  for (const item of imported) {
    if (item.endMs < nowMs - RETENTION_MS) continue;
    const matching = records
      .filter(record => Math.abs(record.startMs - item.startMs) <= MATCH_TOLERANCE_MS)
      .sort((a, b) => Math.abs(a.startMs - item.startMs) - Math.abs(b.startMs - item.startMs))[0];

    const hasKnownClassification = matching?.phases.some(phase => KNOWN_LEVELS.has(normalizeLevel(phase.level)));
    if (hasKnownClassification) continue;

    const record = {
      startMs: item.startMs,
      phases: item.phases.map(phase => ({ ...phase, threats: [...phase.threats] })),
      updatedAtMs: nowMs,
      provisionalEnd: false,
    };
    if (matching) {
      Object.assign(matching, record);
      refreshed += 1;
    } else {
      records.push(record);
      added += 1;
    }
  }

  return {
    records: normalizeObservedPhaseRecords(records).sort((a, b) => a.startMs - b.startMs),
    added,
    refreshed,
  };
}

function normalizeThreats(value) {
  return (Array.isArray(value) ? value : []).map(item => ({
    type: String(item?.threat_type || item?.threatType || item?.type || 'unknown'),
    level: normalizeLevel(item?.level || item?.alert_level || item?.alertLevel),
    startedAtMs: parseDate(item?.started_at || item?.startedAt || item?.startDate || item?.start),
    sourceMessage: String(item?.source_message || item?.sourceMessage || item?.message || ''),
  }));
}

function normalizeLevel(value) {
  const level = String(value || '').toLowerCase();
  return KNOWN_LEVELS.has(level) ? level : 'unknown';
}

function parseDate(value) {
  if (!value) return NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : NaN;
}

function safeError(error) {
  return String(error?.message || error || 'Unknown history error')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}
