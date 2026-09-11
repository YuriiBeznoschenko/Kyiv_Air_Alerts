import {
  normalizeObservedPhaseRecords,
  updateObservedPhaseRecords,
} from '../../../public/alert-reconciliation-v2.mjs';

const LIVE_FRESHNESS_MS = 150_000;

export function normalizeCollectorState(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    providerKey: String(raw.providerKey || ''),
    snapshot: raw.snapshot && typeof raw.snapshot === 'object' ? clone(raw.snapshot) : null,
    records: normalizeObservedPhaseRecords(raw.records),
    lastAttemptAtMs: finiteNumber(raw.lastAttemptAtMs),
    lastSuccessAtMs: finiteNumber(raw.lastSuccessAtMs),
    consecutiveFailures: Math.max(0, Number(raw.consecutiveFailures) || 0),
    lastError: String(raw.lastError || ''),
  };
}

export function advanceCollectorState(previousValue, snapshot, options = {}) {
  const previous = normalizeCollectorState(previousValue);
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  if (Number.isFinite(previous.lastSuccessAtMs) && nowMs < previous.lastSuccessAtMs) return previous;

  const activeAlert = toObservedAlert(snapshot?.active, nowMs);
  const records = updateObservedPhaseRecords(
    previous.records,
    activeAlert ? [activeAlert] : [],
    {
      liveStateKnown: true,
      liveActiveAlert: activeAlert,
      nowMs,
    },
  );

  return {
    version: 1,
    providerKey: String(options.providerKey || previous.providerKey || ''),
    snapshot: clone(snapshot),
    records,
    lastAttemptAtMs: nowMs,
    lastSuccessAtMs: nowMs,
    consecutiveFailures: 0,
    lastError: '',
  };
}

export function recordCollectorFailure(previousValue, error, options = {}) {
  const previous = normalizeCollectorState(previousValue);
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  if (Number.isFinite(previous.lastAttemptAtMs) && nowMs < previous.lastAttemptAtMs) return previous;
  return {
    ...previous,
    lastAttemptAtMs: nowMs,
    consecutiveFailures: previous.consecutiveFailures + 1,
    lastError: safeError(error),
  };
}

export function buildCollectorPayload(value, options = {}) {
  const state = normalizeCollectorState(value);
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const snapshot = state.snapshot || {};
  const liveStatusKnown = Number.isFinite(state.lastSuccessAtMs)
    && nowMs - state.lastSuccessAtMs <= LIVE_FRESHNESS_MS;
  const alerts = (Array.isArray(snapshot.alerts) ? snapshot.alerts : [])
    .filter(alert => liveStatusKnown || !alert?.ongoing)
    .map(clone);
  const phaseRecords = phaseRecordsToApi(state.records);
  const classificationAvailable = Boolean(snapshot.classificationAvailable)
    || state.records.some(record => record.phases.some(phase => ['yellow', 'red'].includes(phase.level)));
  const warnings = [
    ...(Array.isArray(snapshot.warnings) ? snapshot.warnings : []),
    ...(state.consecutiveFailures && state.lastError ? [`Collector: ${state.lastError}`] : []),
  ];

  return {
    ok: Boolean(state.snapshot || phaseRecords.length),
    configured: true,
    generatedAt: new Date(nowMs).toISOString(),
    cache: 'persistent',
    provider: snapshot.provider || providerLabel(state.providerKey),
    providerKey: state.providerKey || null,
    providerUrl: snapshot.providerUrl || providerUrl(state.providerKey),
    region: snapshot.region || { id: '31', name: 'Kyiv City' },
    classificationAvailable,
    liveStatusKnown,
    alerts,
    active: liveStatusKnown && snapshot.active ? clone(snapshot.active) : null,
    phaseRecords,
    warnings,
    collector: {
      lastAttemptAt: isoOrNull(state.lastAttemptAtMs),
      lastSuccessAt: isoOrNull(state.lastSuccessAtMs),
      stale: !liveStatusKnown,
      consecutiveFailures: state.consecutiveFailures,
    },
  };
}

export function phaseRecordsToApi(value) {
  return normalizeObservedPhaseRecords(value).map(record => ({
    start: new Date(record.startMs).toISOString(),
    updatedAt: new Date(record.updatedAtMs).toISOString(),
    provisionalEnd: Boolean(record.provisionalEnd),
    phases: record.phases.map(phase => ({
      start: new Date(phase.startMs).toISOString(),
      end: phase.endMs == null ? null : new Date(phase.endMs).toISOString(),
      level: phase.level,
      threats: clone(phase.threats || []),
      sourceMessage: String(phase.sourceMessage || ''),
    })),
  }));
}

function toObservedAlert(alert, nowMs) {
  if (!alert || typeof alert !== 'object') return null;
  const startMs = Date.parse(alert.start);
  if (!Number.isFinite(startMs) || startMs >= nowMs + 60_000) return null;
  return {
    id: String(alert.id || startMs),
    startMs,
    endMs: nowMs,
    ongoing: true,
    level: normalizeLevel(alert.level),
    threats: (Array.isArray(alert.threats) ? alert.threats : []).map(threat => ({
      type: String(threat?.type || 'unknown'),
      level: normalizeLevel(threat?.level),
      startedAtMs: threat?.startedAt ? Date.parse(threat.startedAt) : null,
      sourceMessage: String(threat?.sourceMessage || ''),
    })),
    phases: [],
    sourceMessage: String(alert.sourceMessage || ''),
    source: String(alert.source || ''),
  };
}

function normalizeLevel(value) {
  const level = String(value || '').toLowerCase();
  return level === 'red' || level === 'yellow' ? level : 'unknown';
}

function providerLabel(key) {
  return key === 'alerts-in-ua' ? 'alerts.in.ua'
    : key === 'ukraine-alarm-v3' ? 'Ukraine Alert API v3'
      : 'Configured alert API';
}

function providerUrl(key) {
  return key === 'alerts-in-ua' ? 'https://alerts.in.ua/'
    : key === 'ukraine-alarm-v3' ? 'https://www.ukrainealarm.com/'
      : 'https://alerts.in.ua/';
}

function isoOrNull(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function safeError(error) {
  return String(error?.message || error || 'Unknown provider error')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}
