const MINUTE = 60 * 1000;
const MATCH_TOLERANCE_MS = 5 * MINUTE;
const EXACT_START_TOLERANCE_MS = 90 * 1000;
const RETENTION_MS = 45 * 24 * 60 * MINUTE;
const MAX_INITIAL_OBSERVATION_LAG_MS = 90 * 1000;

const KNOWN_LEVELS = new Set(['yellow', 'red']);

export function findMatchingAlert(items, target, toleranceMs = MATCH_TOLERANCE_MS) {
  if (!target || !Number.isFinite(Number(target.startMs))) return null;

  let best = null;
  let bestScore = 0;
  const targetStart = Number(target.startMs);
  const targetEnd = Number(target.endMs);

  for (const item of Array.isArray(items) ? items : []) {
    const itemStart = Number(item?.startMs);
    const itemEnd = Number(item?.endMs);
    if (!Number.isFinite(itemStart)) continue;

    const startDelta = Math.abs(itemStart - targetStart);
    const canCompareOverlap = Number.isFinite(itemEnd) && Number.isFinite(targetEnd);
    const overlap = canCompareOverlap
      ? Math.max(0, Math.min(itemEnd, targetEnd) - Math.max(itemStart, targetStart))
      : 0;
    const targetDuration = canCompareOverlap ? Math.max(MINUTE, targetEnd - targetStart) : MINUTE;
    const itemDuration = canCompareOverlap ? Math.max(MINUTE, itemEnd - itemStart) : MINUTE;
    const overlapRatio = overlap / Math.min(targetDuration, itemDuration);
    const score = startDelta <= toleranceMs
      ? 2 - startDelta / toleranceMs
      : overlapRatio;
    const closeStart = startDelta <= Math.min(toleranceMs, EXACT_START_TOLERANCE_MS);

    if (score > bestScore && (closeStart || overlapRatio >= 0.65)) {
      best = item;
      bestScore = score;
    }
  }

  return best;
}

export function normalizeObservedPhaseRecords(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value).map(item => Array.isArray(item) ? { phases: item } : item)
      : [];
  const records = [];

  for (const raw of source) {
    const rawPhases = Array.isArray(raw?.phases) ? raw.phases : [];
    const phases = rawPhases.map(normalizePhase).filter(Boolean).sort((a, b) => a.startMs - b.startMs);
    const startMs = finiteNumber(raw?.startMs) ?? phases[0]?.startMs ?? null;
    if (!Number.isFinite(startMs) || !phases.length) continue;

    const record = {
      startMs,
      phases,
      updatedAtMs: finiteNumber(raw?.updatedAtMs) ?? startMs,
      provisionalEnd: Boolean(raw?.provisionalEnd),
    };
    const duplicate = findPhaseRecord(records, record);
    if (!duplicate) {
      records.push(record);
    } else if (phaseRecordScore(record) >= phaseRecordScore(duplicate)) {
      Object.assign(duplicate, record);
    }
  }

  return records.sort((a, b) => a.startMs - b.startMs);
}

export function updateObservedPhaseRecords(recordsInput, classifiedAlerts, options = {}) {
  const records = normalizeObservedPhaseRecords(recordsInput);
  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const liveStateKnown = Boolean(options.liveStateKnown);
  const liveActiveAlert = options.liveActiveAlert || null;
  const alerts = Array.isArray(classifiedAlerts) ? classifiedAlerts : [];

  for (const alert of alerts) observeAlert(records, alert, nowMs);
  if (liveActiveAlert && !findMatchingAlert(alerts, liveActiveAlert)) {
    observeAlert(records, liveActiveAlert, nowMs);
  }

  if (liveStateKnown) {
    for (const record of records) {
      const matchesActive = liveActiveAlert && isSameStart(record.startMs, liveActiveAlert.startMs);
      if (!matchesActive && record.startMs <= nowMs) closeRecord(record, nowMs, true);
    }
  }

  return records
    .filter(record => record.startMs >= nowMs - RETENTION_MS)
    .sort((a, b) => a.startMs - b.startMs);
}

export function applyObservedPhaseRecords(alertsInput, recordsInput) {
  const records = normalizeObservedPhaseRecords(recordsInput);
  return (Array.isArray(alertsInput) ? alertsInput : []).map(alert => {
    const next = cloneAlert(alert);
    const record = findPhaseRecord(records, next);
    if (!record) return next;

    const phases = materializeRecordPhases(record, next);
    if (!phases.some(phase => KNOWN_LEVELS.has(phase.level))) return next;

    next.phases = phases;
    const last = phases.at(-1);
    if (next.ongoing && last) {
      next.level = last.level;
      next.threats = cloneThreats(last.threats);
      next.sourceMessage = last.sourceMessage || next.sourceMessage;
    }
    return next;
  });
}

export function mergeSavedClassification(alertsInput, savedAlertsInput) {
  const savedAlerts = (Array.isArray(savedAlertsInput) ? savedAlertsInput : []).map(cloneAlert);
  return (Array.isArray(alertsInput) ? alertsInput : []).map(alert => {
    const next = cloneAlert(alert);
    const saved = findMatchingAlert(savedAlerts, next);
    if (!saved || classificationScore(saved) <= classificationScore(next)) return next;

    const phases = clipPhases(saved.phases, next.startMs, next.endMs, next.ongoing);
    if (!phases.some(phase => KNOWN_LEVELS.has(phase.level))) return next;

    next.phases = phases;
    if (!KNOWN_LEVELS.has(next.level) && KNOWN_LEVELS.has(saved.level)) next.level = saved.level;
    if (!next.threats?.length && saved.threats?.length) next.threats = cloneThreats(saved.threats);
    if (!next.sourceMessage && saved.sourceMessage) next.sourceMessage = saved.sourceMessage;
    return next;
  });
}

export function reconcileLiveAlertState(alertsInput, options = {}) {
  const alerts = (Array.isArray(alertsInput) ? alertsInput : []).map(cloneAlert);
  if (!options.liveStateKnown) return alerts;

  const nowMs = finiteNumber(options.nowMs) ?? Date.now();
  const liveObservedAtMs = finiteNumber(options.liveObservedAtMs) ?? nowMs;
  const activeAlert = options.liveActiveAlert ? cloneAlert(options.liveActiveAlert) : null;
  const activeMatch = activeAlert ? findMatchingAlert(alerts, activeAlert) : null;

  for (const alert of alerts) {
    if (!alert.ongoing || alert === activeMatch) continue;
    // A cached live snapshot cannot prove the state of an alert that started
    // after that snapshot was observed.
    if (liveObservedAtMs < alert.startMs) continue;
    alert.ongoing = false;
    alert.endMs = safeEnd(alert.startMs, liveObservedAtMs);
  }

  if (activeAlert) {
    if (activeMatch) {
      activeMatch.ongoing = true;
      activeMatch.endMs = safeEnd(activeMatch.startMs, nowMs);
      if (KNOWN_LEVELS.has(activeAlert.level)) activeMatch.level = activeAlert.level;
      if (activeAlert.threats?.length) activeMatch.threats = cloneThreats(activeAlert.threats);
      if (!hasKnownPhases(activeMatch) && hasKnownPhases(activeAlert)) {
        activeMatch.phases = clipPhases(activeAlert.phases, activeMatch.startMs, activeMatch.endMs, true);
      }
      activeMatch.sourceMessage = activeAlert.sourceMessage || activeMatch.sourceMessage;
      activeMatch.source = activeAlert.source || activeMatch.source;
    } else {
      activeAlert.ongoing = true;
      activeAlert.endMs = safeEnd(activeAlert.startMs, nowMs);
      alerts.push(activeAlert);
    }
  }

  return alerts.sort((a, b) => a.startMs - b.startMs);
}

function observeAlert(records, alert, nowMs) {
  const startMs = finiteNumber(alert?.startMs);
  const endMs = finiteNumber(alert?.endMs);
  if (!Number.isFinite(startMs)) return;

  const level = normalizeLevel(alert?.level);
  const providerPhases = clipPhases(alert?.phases, startMs, endMs ?? nowMs, Boolean(alert?.ongoing));
  let record = findPhaseRecord(records, alert);

  const providerHasPhaseHistory = providerPhases.length > 1;
  if ((!alert?.ongoing || providerHasPhaseHistory) && providerPhases.some(phase => KNOWN_LEVELS.has(phase.level))) {
    if (alert?.ongoing && providerPhases.length) providerPhases.at(-1).endMs = null;
    const providerRecord = {
      startMs,
      phases: providerPhases,
      updatedAtMs: nowMs,
      provisionalEnd: false,
    };
    if (!record) {
      records.push(providerRecord);
      return;
    }
    if (phaseRecordScore(providerRecord) >= phaseRecordScore(record)) Object.assign(record, providerRecord);
  }

  // A final colour on an already completed provider row is not proof that the
  // whole alert had that colour. Only a live observation or explicit phases
  // may create colour history.
  if (!record && alert?.ongoing && KNOWN_LEVELS.has(level)) {
    const phases = initialObservedPhases(alert, startMs, nowMs, level);
    record = {
      startMs,
      phases,
      updatedAtMs: nowMs,
      provisionalEnd: false,
    };
    records.push(record);
  }
  if (!record) return;

  record.updatedAtMs = nowMs;
  const last = record.phases.at(-1);
  if (!last) return;

  if (alert?.ongoing) {
    const nextLevel = KNOWN_LEVELS.has(level) ? level : 'unknown';
    if (last.level !== nextLevel) {
      const transitionMs = inferTransitionMs(alert, last, nextLevel, nowMs);
      last.endMs = safeEnd(last.startMs, transitionMs);
      record.phases.push({
        startMs: last.endMs,
        endMs: null,
        level: nextLevel,
        threats: cloneThreats(alert?.threats),
        sourceMessage: String(alert?.sourceMessage || ''),
      });
    } else {
      last.endMs = null;
      last.threats = cloneThreats(alert?.threats);
      last.sourceMessage = String(alert?.sourceMessage || last.sourceMessage || '');
    }
    record.provisionalEnd = false;
  } else {
    closeRecord(record, endMs ?? nowMs, false);
  }
}

function initialObservedPhases(alert, alertStartMs, nowMs, fallbackLevel) {
  const events = cloneThreats(alert?.threats)
    .map(threat => ({ ...threat, startedAtMs: finiteNumber(threat?.startedAtMs) }))
    .filter(threat => KNOWN_LEVELS.has(normalizeLevel(threat.level))
      && Number.isFinite(threat.startedAtMs)
      && threat.startedAtMs >= alertStartMs
      && threat.startedAtMs <= nowMs)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  if (!events.length) {
    // When the collector first sees an alert long after it began and the
    // provider gives no phase timestamp, the earlier interval is unknowable.
    // Mark it unknown instead of falsely assigning the current colour to it.
    const observedStartMs = nowMs - alertStartMs <= MAX_INITIAL_OBSERVATION_LAG_MS
      ? alertStartMs
      : nowMs;
    const phases = observedStartMs > alertStartMs
      ? [{
          startMs: alertStartMs,
          endMs: observedStartMs,
          level: 'unknown',
          threats: [],
          sourceMessage: '',
        }]
      : [];
    phases.push({
      startMs: observedStartMs,
      endMs: null,
      level: fallbackLevel,
      threats: cloneThreats(alert?.threats),
      sourceMessage: String(alert?.sourceMessage || ''),
    });
    return phases;
  }

  const phases = [];
  const activeThreats = [];
  let currentLevel = 'unknown';
  let cursor = alertStartMs;
  let index = 0;

  while (index < events.length) {
    const eventMs = events[index].startedAtMs;
    while (index < events.length && events[index].startedAtMs === eventMs) {
      activeThreats.push(events[index]);
      index += 1;
    }
    const nextLevel = strongestLevel(activeThreats.map(threat => threat.level));
    if (nextLevel === currentLevel) continue;
    if (eventMs > cursor) {
      phases.push({
        startMs: cursor,
        endMs: eventMs,
        level: currentLevel,
        threats: currentLevel === 'unknown'
          ? []
          : cloneThreats(activeThreats.filter(threat => normalizeLevel(threat.level) === currentLevel)),
        sourceMessage: '',
      });
    }
    cursor = Math.max(cursor, eventMs);
    currentLevel = nextLevel;
  }

  if (currentLevel !== fallbackLevel) {
    if (nowMs > cursor) {
      phases.push({
        startMs: cursor,
        endMs: nowMs,
        level: currentLevel,
        threats: cloneThreats(activeThreats),
        sourceMessage: '',
      });
    }
    cursor = Math.max(cursor, nowMs);
    currentLevel = fallbackLevel;
  }

  phases.push({
    startMs: cursor,
    endMs: null,
    level: currentLevel,
    threats: cloneThreats(alert?.threats),
    sourceMessage: String(alert?.sourceMessage || ''),
  });
  return phases.filter(phase => phase.endMs == null || phase.endMs > phase.startMs);
}

function inferTransitionMs(alert, lastPhase, nextLevel, nowMs) {
  const lastLevel = normalizeLevel(lastPhase?.level);
  const isEscalation = levelRank(nextLevel) > levelRank(lastLevel);
  if (!isEscalation) return nowMs;

  const candidates = cloneThreats(alert?.threats)
    .filter(threat => normalizeLevel(threat?.level) === nextLevel)
    .map(threat => finiteNumber(threat?.startedAtMs))
    .filter(startedAtMs => Number.isFinite(startedAtMs)
      && startedAtMs >= lastPhase.startMs
      && startedAtMs <= nowMs)
    .sort((a, b) => a - b);
  return candidates[0] ?? nowMs;
}

function strongestLevel(levels) {
  return (Array.isArray(levels) ? levels : []).reduce((strongest, level) => (
    levelRank(level) > levelRank(strongest) ? normalizeLevel(level) : strongest
  ), 'unknown');
}

function levelRank(level) {
  const normalized = normalizeLevel(level);
  return normalized === 'red' ? 2 : normalized === 'yellow' ? 1 : 0;
}

function closeRecord(record, endMs, provisional) {
  const last = record?.phases?.at(-1);
  if (!last || last.endMs != null) return;
  last.endMs = safeEnd(last.startMs, endMs);
  record.updatedAtMs = endMs;
  record.provisionalEnd = provisional;
}

function materializeRecordPhases(record, alert) {
  const alertStart = Number(alert.startMs);
  const alertEnd = Number(alert.endMs);
  const phases = record.phases.map((phase, index) => {
    const isLast = index === record.phases.length - 1;
    let endMs = finiteNumber(phase.endMs);
    if (endMs == null) endMs = alertEnd;
    if (!alert.ongoing && isLast && record.provisionalEnd) endMs = alertEnd;
    return {
      ...phase,
      startMs: Math.max(alertStart, phase.startMs),
      endMs: Math.min(alertEnd, endMs),
      threats: cloneThreats(phase.threats),
    };
  }).filter(phase => phase.endMs > phase.startMs);
  return phases;
}

function clipPhases(value, alertStart, alertEnd, ongoing) {
  if (!Number.isFinite(Number(alertStart)) || !Number.isFinite(Number(alertEnd))) return [];
  return (Array.isArray(value) ? value : []).map((phase, index, all) => {
    const normalized = normalizePhase(phase);
    if (!normalized) return null;
    let endMs = normalized.endMs;
    if (endMs == null || (ongoing && index === all.length - 1)) endMs = Number(alertEnd);
    return {
      ...normalized,
      startMs: Math.max(Number(alertStart), normalized.startMs),
      endMs: Math.min(Number(alertEnd), endMs),
    };
  }).filter(phase => phase && phase.endMs > phase.startMs);
}

function normalizePhase(phase) {
  const startMs = finiteNumber(phase?.startMs);
  const rawEndMs = phase?.endMs == null ? null : finiteNumber(phase.endMs);
  if (!Number.isFinite(startMs) || (rawEndMs != null && rawEndMs <= startMs)) return null;
  return {
    startMs,
    endMs: rawEndMs,
    level: normalizeLevel(phase?.level),
    threats: cloneThreats(phase?.threats),
    sourceMessage: String(phase?.sourceMessage || ''),
  };
}

function findPhaseRecord(records, target) {
  const startMs = finiteNumber(target?.startMs);
  if (!Number.isFinite(startMs)) return null;
  return (Array.isArray(records) ? records : [])
    .filter(record => Math.abs(Number(record.startMs) - startMs) <= EXACT_START_TOLERANCE_MS)
    .sort((a, b) => Math.abs(a.startMs - startMs) - Math.abs(b.startMs - startMs))[0] || null;
}

function classificationScore(alert) {
  const phases = Array.isArray(alert?.phases) ? alert.phases : [];
  const knownPhases = phases.filter(phase => KNOWN_LEVELS.has(normalizeLevel(phase?.level)));
  const coverage = knownPhases.reduce((sum, phase) => {
    const start = finiteNumber(phase?.startMs);
    const end = finiteNumber(phase?.endMs);
    return sum + (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0);
  }, 0);
  return knownPhases.length * 10 ** 12 + coverage + (KNOWN_LEVELS.has(normalizeLevel(alert?.level)) ? 1 : 0);
}

function phaseRecordScore(record) {
  return classificationScore({ phases: record?.phases }) + (finiteNumber(record?.updatedAtMs) ?? 0) / 10 ** 6;
}

function hasKnownPhases(alert) {
  return Array.isArray(alert?.phases) && alert.phases.some(phase => KNOWN_LEVELS.has(normalizeLevel(phase?.level)));
}

function cloneAlert(alert) {
  return {
    ...alert,
    startMs: Number(alert?.startMs),
    endMs: Number(alert?.endMs),
    ongoing: Boolean(alert?.ongoing),
    level: normalizeLevel(alert?.level),
    threats: cloneThreats(alert?.threats),
    phases: (Array.isArray(alert?.phases) ? alert.phases : []).map(normalizePhase).filter(Boolean),
  };
}

function cloneThreats(value) {
  return (Array.isArray(value) ? value : []).map(item => ({ ...item }));
}

function normalizeLevel(value) {
  return KNOWN_LEVELS.has(value) ? value : 'unknown';
}

function isSameStart(a, b) {
  return Number.isFinite(Number(a))
    && Number.isFinite(Number(b))
    && Math.abs(Number(a) - Number(b)) <= EXACT_START_TOLERANCE_MS;
}

function safeEnd(startMs, candidateEndMs) {
  const start = Number(startMs);
  const end = Number(candidateEndMs);
  return Math.max(start + 1, Number.isFinite(end) ? end : start + 1);
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
