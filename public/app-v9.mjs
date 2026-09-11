import {
  applyObservedPhaseRecords,
  findMatchingAlert,
  mergeSavedClassification,
  normalizeObservedPhaseRecords,
  reconcileLiveAlertState,
  updateObservedPhaseRecords,
} from './alert-reconciliation-v2.mjs';

(() => {
  'use strict';

  const LEGACY_SOURCE_URL = 'https://kyiv.digital/storage/air-alert/stats.html';
  const LEGACY_PROXY_URL = '/api/legacy-history';
  const CLASSIFIED_PROXY_URL = '/api/air-alerts';
  const CACHE_KEY = 'kyiv-alert-impact-cache-v9';
  const PREVIOUS_CACHE_KEYS = ['kyiv-alert-impact-cache-v8', 'kyiv-alert-impact-cache-v7', 'kyiv-alert-impact-cache-v6'];
  const OBSERVED_PHASES_KEY = 'kyiv-alert-impact-observed-phases-v2';
  const PREVIOUS_OBSERVED_PHASE_KEYS = ['kyiv-alert-impact-observed-phases-v1'];
  const KYIV_TZ = 'Europe/Kyiv';
  const WORK_START = 9 * 60;
  const WORK_END = 18 * 60;
  const MINUTE = 60 * 1000;
  const DAY = 1440 * MINUTE;
  const BASELINE_RANGE_KEY = 'kyiv-alert-impact-baseline-range-v1';
  const DEFAULT_BASELINE_RANGE = { startMs: Date.UTC(2026, 7, 1), endMs: Date.UTC(2026, 7, 26) };

  const FIXED_UA_HOLIDAYS = new Map([
    ['01-01', "New Year's Day"],
    ['03-08', "International Women's Day"],
    ['05-01', 'Labour Day'],
    ['05-08', 'Remembrance and Victory Day'],
    ['06-28', 'Constitution Day'],
    ['07-15', 'Ukrainian Statehood Day'],
    ['08-24', 'Independence Day'],
    ['10-01', 'Defenders of Ukraine Day'],
    ['12-25', 'Christmas Day'],
  ]);

  const FALLBACK_BASELINE = {
    alertsPerDay: 2.42,
    totalMinutesPerDay: 114,
    workMinutesPerDay: 27,
    dayCount: 26,
    startMs: DEFAULT_BASELINE_RANGE.startMs,
    endMs: DEFAULT_BASELINE_RANGE.endMs,
    isEmbedded: true,
  };

  const state = {
    alerts: [],
    days: [],
    range: 10,
    selectedKey: null,
    sourceMode: 'loading',
    fetchedAt: null,
    providerName: '',
    providerUrl: 'https://alerts.in.ua/',
    classificationAvailable: false,
    classificationStale: false,
    classificationError: '',
    usedLegacyHistory: false,
    sourceWarnings: [],
    legacyAlertsCache: [],
    legacyFetchedAt: 0,
    liveStateKnown: false,
    liveActiveReported: false,
    baseline: FALLBACK_BASELINE,
    baselineRange: readBaselineRange(),
    baselineBounds: { minMs: DEFAULT_BASELINE_RANGE.startMs, maxMs: DEFAULT_BASELINE_RANGE.endMs },
    baselineDraftStartMs: null,
    baselineDraftEndMs: null,
    baselineCalendarMonthMs: Date.UTC(2026, 7, 1),
    baselineSelecting: 'start',
    baselineLastFocus: null,
  };

  const els = {};
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheElements();
    bindControls();
    loadData();
    window.setInterval(() => loadData({ silent: true }), 60 * 1000);
  }

  function cacheElements() {
    [
      'feedChip','feedLabel','updatedLabel','refreshButton','todayEyebrow','heroHeadline','heroSubline',
      'currentStatus','currentStatusText','threatSummary','yellowToday','redToday','unknownToday','kpiCount','kpiCountNote','kpiTotal','kpiWork','kpiLongest',
      'kpiLongestNote','baselineCount','baselineTotal','baselineWork','baselineInsight','baselineRangeLabel',
      'baselinePeriodMeta','baselineRangeTrigger','baselineModal','baselineClose','baselineCancel','baselineApply',
      'baselineDraftStart','baselineDraftEnd','baselineDraftDays','calendarPrev','calendarNext','calendarMonthLabel',
      'calendarGrid','timelineGrid','timelineScroll','mobileTimeline','workToggle','detailTitle','detailSummary',
      'detailPills','detailList','tooltip','toast','dataSourcePrimary','dataSourceSecondary','dataSourceLink'
    ].forEach(id => els[id] = document.getElementById(id));
  }

  function bindControls() {
    document.querySelectorAll('[data-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.range = Number(btn.dataset.range);
        document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('is-active', b === btn));
        renderTimelines();
      });
    });

    els.workToggle.addEventListener('change', () => document.body.classList.toggle('hide-work', !els.workToggle.checked));
    els.refreshButton.addEventListener('click', () => loadData({ force: true }));
    els.baselineRangeTrigger.addEventListener('click', openBaselineModal);
    document.querySelectorAll('[data-baseline-close]').forEach(control => control.addEventListener('click', closeBaselineModal));
    els.baselineApply.addEventListener('click', commitBaselineRange);
    els.calendarPrev.addEventListener('click', () => shiftBaselineCalendar(-1));
    els.calendarNext.addEventListener('click', () => shiftBaselineCalendar(1));

    els.calendarGrid.addEventListener('click', event => {
      const button = event.target.closest('[data-calendar-date]');
      if (!button || button.disabled) return;
      selectBaselineDate(Number(button.dataset.calendarDate));
    });

    document.querySelectorAll('[data-baseline-preset]').forEach(button => {
      button.addEventListener('click', () => applyBaselinePreset(button.dataset.baselinePreset));
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !els.baselineModal.hidden) closeBaselineModal();
    });
    window.addEventListener('resize', hideTooltip);
  }

  function openBaselineModal() {
    state.baselineLastFocus = document.activeElement;
    state.baselineDraftStartMs = state.baselineRange.startMs;
    state.baselineDraftEndMs = state.baselineRange.endMs;
    state.baselineCalendarMonthMs = monthStart(state.baselineRange.startMs);
    state.baselineSelecting = 'start';
    renderBaselinePicker();
    els.baselineModal.hidden = false;
    els.baselineRangeTrigger.setAttribute('aria-expanded', 'true');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => els.baselineClose.focus({ preventScroll: true }));
  }

  function closeBaselineModal() {
    if (els.baselineModal.hidden) return;
    els.baselineModal.hidden = true;
    els.baselineRangeTrigger.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('modal-open');
    state.baselineLastFocus?.focus?.({ preventScroll: true });
  }

  function applyBaselinePreset(preset) {
    const maxMs = state.baselineBounds.maxMs;
    let startMs;
    let endMs;
    if (preset === 'pre-spike') {
      ({ startMs, endMs } = DEFAULT_BASELINE_RANGE);
    } else if (preset === 'previous-7') {
      endMs = maxMs;
      startMs = endMs - 6 * DAY;
    } else {
      endMs = maxMs;
      startMs = endMs - 29 * DAY;
    }
    setBaselineDraftRange(startMs, endMs);
  }

  function setBaselineDraftRange(startMs, endMs) {
    const { minMs, maxMs } = state.baselineBounds;
    state.baselineDraftStartMs = Math.max(minMs, Math.min(startMs, maxMs));
    state.baselineDraftEndMs = Math.max(state.baselineDraftStartMs, Math.min(endMs, maxMs));
    state.baselineCalendarMonthMs = monthStart(state.baselineDraftStartMs);
    state.baselineSelecting = 'start';
    renderBaselinePicker();
  }

  function selectBaselineDate(dayMs) {
    if (dayMs < state.baselineBounds.minMs || dayMs > state.baselineBounds.maxMs) return;
    if (state.baselineSelecting === 'start') {
      state.baselineDraftStartMs = dayMs;
      state.baselineDraftEndMs = null;
      state.baselineSelecting = 'end';
    } else {
      if (dayMs < state.baselineDraftStartMs) {
        state.baselineDraftEndMs = state.baselineDraftStartMs;
        state.baselineDraftStartMs = dayMs;
      } else {
        state.baselineDraftEndMs = dayMs;
      }
      state.baselineSelecting = 'start';
    }
    renderBaselinePicker();
  }

  function shiftBaselineCalendar(delta) {
    const d = new Date(state.baselineCalendarMonthMs);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1);
    const minMonth = monthStart(state.baselineBounds.minMs);
    const maxMonth = monthStart(state.baselineBounds.maxMs);
    state.baselineCalendarMonthMs = Math.max(minMonth, Math.min(next, maxMonth));
    renderBaselinePicker();
  }

  function renderBaselinePicker() {
    const startMs = state.baselineDraftStartMs;
    const endMs = state.baselineDraftEndMs;
    els.baselineDraftStart.textContent = startMs == null ? 'Select date' : formatDateFull(startMs);
    els.baselineDraftEnd.textContent = endMs == null ? 'Select date' : formatDateFull(endMs);
    els.baselineDraftDays.textContent = endMs == null
      ? 'Now choose the end date'
      : `${Math.round((endMs - startMs) / DAY) + 1} complete ${endMs === startMs ? 'day' : 'days'}`;
    els.baselineApply.disabled = endMs == null;
    els.baselineApply.setAttribute('aria-disabled', String(endMs == null));

    document.querySelectorAll('[data-baseline-preset]').forEach(button => {
      const preset = button.dataset.baselinePreset;
      let a;
      let b;
      if (preset === 'pre-spike') ({ startMs: a, endMs: b } = DEFAULT_BASELINE_RANGE);
      else if (preset === 'previous-7') { b = state.baselineBounds.maxMs; a = b - 6 * DAY; }
      else { b = state.baselineBounds.maxMs; a = b - 29 * DAY; }
      a = Math.max(state.baselineBounds.minMs, a);
      button.classList.toggle('is-active', startMs === a && endMs === b);
    });

    const monthMs = state.baselineCalendarMonthMs;
    els.calendarMonthLabel.textContent = formatMonthYear(monthMs);
    els.calendarPrev.disabled = monthMs <= monthStart(state.baselineBounds.minMs);
    els.calendarNext.disabled = monthMs >= monthStart(state.baselineBounds.maxMs);
    els.calendarGrid.innerHTML = '';

    const monthDate = new Date(monthMs);
    const mondayOffset = (monthDate.getUTCDay() + 6) % 7;
    const gridStart = monthMs - mondayOffset * DAY;
    for (let i = 0; i < 42; i += 1) {
      const dayMs = gridStart + i * DAY;
      const d = new Date(dayMs);
      const disabled = dayMs < state.baselineBounds.minMs || dayMs > state.baselineBounds.maxMs;
      const outside = d.getUTCMonth() !== monthDate.getUTCMonth();
      const selectedStart = dayMs === startMs;
      const selectedEnd = dayMs === endMs;
      const inRange = endMs != null && dayMs > startMs && dayMs < endMs;
      const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      const holiday = ukrainianHoliday(dayMs);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calendar-day';
      if (outside) button.classList.add('is-outside');
      if (inRange) button.classList.add('is-in-range');
      if (selectedStart) button.classList.add('is-start');
      if (selectedEnd) button.classList.add('is-end');
      if (weekend || holiday) button.classList.add('is-special');
      button.disabled = disabled;
      button.dataset.calendarDate = String(dayMs);
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-selected', String(selectedStart || selectedEnd));
      button.setAttribute('aria-label', `${formatDateFull(dayMs)}${holiday ? `, ${holiday}` : ''}`);
      button.innerHTML = `<span>${d.getUTCDate()}</span>${holiday ? '<i aria-hidden="true"></i>' : ''}`;
      els.calendarGrid.appendChild(button);
    }
  }

  function commitBaselineRange() {
    const startMs = state.baselineDraftStartMs;
    const endMs = state.baselineDraftEndMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      showToast('Choose both baseline dates');
      return;
    }
    if (startMs > endMs) {
      showToast('The baseline start must be before the end');
      return;
    }
    if (endMs > state.baselineBounds.maxMs) {
      showToast('Use complete calendar days only');
      return;
    }
    const dayCount = Math.round((endMs - startMs) / DAY) + 1;
    if (dayCount > 366) {
      showToast('Choose a baseline period of 366 days or less');
      return;
    }
    if (state.sourceMode === 'unavailable' && !isDefaultBaselineRange(startMs, endMs)) {
      showToast('Live data is needed for that baseline period');
      return;
    }
    state.baselineRange = { startMs, endMs };
    try { localStorage.setItem(BASELINE_RANGE_KEY, JSON.stringify(state.baselineRange)); } catch { /* storage may be unavailable */ }
    state.baseline = resolveBaseline();
    renderBaseline();
    closeBaselineModal();
    showToast(`Baseline updated · ${formatRangeLabel(startMs, endMs)}`);
  }

  async function loadData({ silent = false, force = false } = {}) {
    if (!silent) els.refreshButton.classList.add('is-loading');
    setFeedState('loading', 'Refreshing');

    const demoMode = new URLSearchParams(window.location.search).get('demo') === 'classified';
    const savedDataset = readCache({ allowExpired: true });
    let alerts = [];
    let mode = 'live-unclassified';
    let classifiedEnvelope = null;
    let historyEnvelope = null;
    let legacyAlerts = [];
    let fetchedAt = Date.now();
    let liveStateKnown = false;
    let liveActiveReported = false;
    let liveActiveAlert = null;
    let liveObservedAtMs = null;
    let usingCachedFallback = false;
    let classificationError = '';

    if (demoMode) {
      alerts = buildClassifiedDemo();
      classifiedEnvelope = {
        provider: 'Demo classification feed',
        providerUrl: 'https://alerts.in.ua/',
        classificationAvailable: true,
        warnings: ['Synthetic demo data'],
      };
      mode = 'demo';
    } else {
      const shouldRefreshLegacy = force || !state.legacyAlertsCache.length || Date.now() - state.legacyFetchedAt >= 5 * 60 * 1000;
      const [legacyResult, classifiedResult] = await Promise.allSettled([
        shouldRefreshLegacy ? fetchLegacySource(force) : Promise.resolve(null),
        fetchClassifiedSource(force),
      ]);

      if (legacyResult.status === 'fulfilled' && legacyResult.value) {
        historyEnvelope = legacyResult.value;
        legacyAlerts = normalizeLegacyEnvelope(historyEnvelope);
        state.legacyAlertsCache = legacyAlerts;
        state.legacyFetchedAt = Date.now();
      } else {
        legacyAlerts = state.legacyAlertsCache;
      }
      if (classifiedResult.status === 'fulfilled') {
        classifiedEnvelope = classifiedResult.value;
        const hasActiveField = Object.prototype.hasOwnProperty.call(classifiedEnvelope || {}, 'active');
        const hasExplicitLiveState = typeof classifiedEnvelope?.liveStatusKnown === 'boolean';
        liveStateKnown = hasExplicitLiveState
          ? classifiedEnvelope.liveStatusKnown
          : hasActiveField;
        liveActiveReported = liveStateKnown && Boolean(classifiedEnvelope?.active);
        liveActiveAlert = liveActiveReported
          ? normalizeClassifiedAlert(classifiedEnvelope.active, classifiedEnvelope)
          : null;
        liveStateKnown &&= !liveActiveReported || Boolean(liveActiveAlert);
        const collectorObservedAtMs = toKyivWallMs(classifiedEnvelope?.collector?.lastSuccessAt);
        liveObservedAtMs = Number.isFinite(collectorObservedAtMs)
          ? Math.min(collectorObservedAtMs, getKyivNow())
          : getKyivNow();
      } else {
        classificationError = normalizeText(classifiedResult.reason?.message || 'Threat classifier unavailable');
      }

      const transitionedToInactive = state.liveStateKnown
        && state.liveActiveReported
        && liveStateKnown
        && !liveActiveReported;
      if (transitionedToInactive && !force) {
        try {
          historyEnvelope = await fetchLegacySource(true);
          legacyAlerts = normalizeLegacyEnvelope(historyEnvelope);
          state.legacyAlertsCache = legacyAlerts;
          state.legacyFetchedAt = Date.now();
        } catch { /* the live state still closes the alert immediately */ }
      }

      let classifiedAlerts = classifiedEnvelope ? normalizeClassifiedEnvelope(classifiedEnvelope) : [];
      if (!liveStateKnown) classifiedAlerts = classifiedAlerts.filter(alert => !alert.ongoing);
      const serverRecords = normalizeServerPhaseRecords(classifiedEnvelope?.phaseRecords);
      const phaseObservationMs = liveStateKnown && Number.isFinite(liveObservedAtMs)
        ? liveObservedAtMs
        : getKyivNow();
      let observedRecords = updateObservedPhaseRecords(
        normalizeObservedPhaseRecords([...readObservedPhaseRecords(), ...serverRecords]),
        classifiedAlerts,
        { liveStateKnown, liveActiveAlert, nowMs: phaseObservationMs },
      );
      writeObservedPhaseRecords(observedRecords);

      if (legacyAlerts.length || classifiedAlerts.length || liveActiveAlert) {
        alerts = mergeAlertSources(legacyAlerts, classifiedAlerts);
        alerts = mergeSavedClassification(alerts, savedDataset?.alerts || []);
        alerts = applyObservedPhaseRecords(alerts, observedRecords);
        alerts = reconcileLiveAlertState(alerts, {
          liveStateKnown,
          liveActiveAlert,
          liveObservedAtMs,
          nowMs: getKyivNow(),
        });
        mode = classifiedEnvelope?.classificationAvailable || classifiedAlerts.some(hasClientClassification)
          ? 'live-classified'
          : 'live-unclassified';
      }
    }

    if (!alerts.length) {
      const cached = readCache();
      if (cached?.alerts?.length) {
        alerts = cached.alerts;
        if (!demoMode && liveStateKnown) {
          alerts = reconcileLiveAlertState(alerts, {
            liveStateKnown,
            liveActiveAlert,
            liveObservedAtMs,
            nowMs: getKyivNow(),
          });
        }
        fetchedAt = cached.fetchedAt || fetchedAt;
        classifiedEnvelope = cached.source || null;
        mode = 'cached';
        usingCachedFallback = true;
      } else {
        mode = 'unavailable';
      }
    }

    if (alerts.length && !demoMode && !usingCachedFallback) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          alerts,
          fetchedAt,
          source: {
            provider: classifiedEnvelope?.provider || historyEnvelope?.provider || 'Kyiv Digital',
            providerUrl: classifiedEnvelope?.providerUrl || historyEnvelope?.providerUrl || LEGACY_SOURCE_URL,
            classificationAvailable: Boolean(classifiedEnvelope?.classificationAvailable),
            warnings: [
              ...(historyEnvelope?.warning ? [historyEnvelope.warning] : []),
              ...(classifiedEnvelope?.warnings || []),
            ],
          },
        }));
      } catch { /* storage may be unavailable */ }
    }

    state.alerts = alerts.map(normalizeSerializedAlert).filter(a => Number.isFinite(a.startMs) && Number.isFinite(a.endMs));
    state.fetchedAt = fetchedAt;
    state.sourceMode = mode;
    state.providerName = classifiedEnvelope?.provider || (mode === 'live-unclassified' ? 'Kyiv Digital' : '');
    state.providerUrl = classifiedEnvelope?.providerUrl
      || (['live-unclassified', 'unavailable'].includes(mode) ? LEGACY_SOURCE_URL : 'https://alerts.in.ua/');
    state.classificationAvailable = Boolean(classifiedEnvelope?.classificationAvailable) || state.alerts.some(hasClientClassification);
    state.classificationStale = Boolean(classifiedEnvelope?.collector?.stale);
    state.classificationError = classificationError;
    state.usedLegacyHistory = legacyAlerts.length > 0;
    state.liveStateKnown = liveStateKnown;
    state.liveActiveReported = liveActiveReported;
    state.sourceWarnings = [
      ...(historyEnvelope?.warning ? [historyEnvelope.warning] : []),
      ...(classifiedEnvelope?.warnings || []),
      ...(classificationError ? [classificationError] : []),
    ];
    state.days = buildDailyModel(state.alerts);
    setBaselineBounds();
    state.baseline = resolveBaseline();
    state.selectedKey = chooseSelectedKey();

    renderAll();
    renderSourceAttribution();
    const label = mode === 'live-classified' ? `Live · tracked${state.classificationStale ? ' ⚠' : ''}`
      : mode === 'live-unclassified' ? `Live · basic${classificationError ? ' ⚠' : ''}`
        : mode === 'cached' ? 'Cached data'
          : mode === 'demo' ? 'Demo data'
            : 'Data unavailable';
    setFeedState(mode, label);
    els.updatedLabel.textContent = `Refreshed ${formatClock(getKyivNow())}`;
    els.refreshButton.classList.remove('is-loading');
    if (!silent) {
      showToast(mode === 'live-classified' ? 'Threat classification refreshed'
        : mode === 'live-unclassified' ? 'Alert history refreshed; classification unavailable'
          : mode === 'cached' ? 'Using the last saved dataset'
            : mode === 'demo' ? 'Showing classified demo data'
              : 'Live feeds unavailable — no saved data yet');
    }
  }

  async function fetchLegacySource(force = false) {
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      throw new Error('Local preview uses embedded or demo data');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 22000);
    try {
      const response = await fetch(`${LEGACY_PROXY_URL}${force ? '?force=1' : ''}`, {
        cache: force ? 'no-store' : 'default',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Legacy history HTTP ${response.status}`);
      const payload = await response.json().catch(() => null);
      if (!payload?.ok || !Array.isArray(payload.intervals)) {
        throw new Error(payload?.error || 'Invalid legacy history response');
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchClassifiedSource(force = false) {
    if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      throw new Error('Local preview needs ?demo=classified or Netlify Functions');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${CLASSIFIED_PROXY_URL}${force ? '?force=1' : ''}`, {
        cache: force ? 'no-store' : 'default',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `Classification HTTP ${response.status}`);
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeLegacyEnvelope(envelope) {
    const now = getKyivNow();
    return (Array.isArray(envelope?.intervals) ? envelope.intervals : []).map((interval, index) => {
      const startMs = Number(interval?.[0]);
      const storedEndMs = interval?.[1] == null ? null : Number(interval[1]);
      const ongoing = storedEndMs == null;
      const endMs = ongoing ? now : storedEndMs;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return normalizeSerializedAlert({
        id: `kyiv-digital-${startMs || index}`,
        startMs,
        endMs,
        ongoing,
        level: 'unknown',
        threats: [],
        phases: [],
        source: envelope.provider || 'Kyiv Digital',
        sourceMessage: '',
      });
    }).filter(Boolean);
  }

  function normalizeClassifiedEnvelope(envelope) {
    const list = Array.isArray(envelope?.alerts) ? envelope.alerts : [];
    return list.map(raw => normalizeClassifiedAlert(raw, envelope)).filter(Boolean);
  }

  function normalizeClassifiedAlert(raw, envelope) {
    const now = getKyivNow();
    const startMs = toKyivWallMs(raw?.start);
    const endMs = raw?.ongoing || !raw?.end ? now : toKyivWallMs(raw.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    const threats = normalizeClientThreats(raw?.threats);
    const level = normalizeClientLevel(raw?.level, threats);
    const phases = normalizeClientPhases(raw?.phases, startMs, endMs, level, threats);
    return {
      id: String(raw?.id || `${startMs}|${raw?.ongoing ? 'open' : endMs}`),
      startMs,
      endMs,
      ongoing: Boolean(raw?.ongoing),
      level,
      threats,
      phases,
      sourceMessage: normalizeText(raw?.sourceMessage),
      source: envelope?.provider || 'Configured alert API',
    };
  }

  function normalizeClientThreats(value) {
    return (Array.isArray(value) ? value : []).map(item => {
      const type = normalizeText(typeof item === 'string' ? item : item?.type || 'unknown').toLowerCase();
      return {
        type,
        level: normalizeClientLevel(typeof item === 'string' ? item : item?.level || type),
        startedAtMs: typeof item === 'object' && item?.startedAt ? toKyivWallMs(item.startedAt) : null,
        sourceMessage: normalizeText(typeof item === 'object' ? item?.sourceMessage : ''),
      };
    });
  }

  function normalizeClientPhases(value, alertStartMs, alertEndMs, fallbackLevel, fallbackThreats) {
    const phases = (Array.isArray(value) ? value : []).map(item => {
      const startMs = item?.start ? toKyivWallMs(item.start) : alertStartMs;
      const endMs = item?.end ? toKyivWallMs(item.end) : alertEndMs;
      const threats = normalizeClientThreats(item?.threats);
      return {
        startMs: Math.max(alertStartMs, startMs),
        endMs: Math.min(alertEndMs, endMs),
        level: normalizeClientLevel(item?.level, threats),
        threats,
        sourceMessage: normalizeText(item?.sourceMessage),
      };
    }).filter(p => Number.isFinite(p.startMs) && Number.isFinite(p.endMs) && p.endMs > p.startMs)
      .sort((a, b) => a.startMs - b.startMs);

    if (phases.length) return phases;
    if (fallbackLevel !== 'unknown') {
      return [{ startMs: alertStartMs, endMs: alertEndMs, level: fallbackLevel, threats: fallbackThreats, sourceMessage: '' }];
    }
    return [];
  }

  function normalizeClientLevel(value, threats = []) {
    const text = normalizeText(value).toLowerCase();
    if (text.includes('yellow') || text.includes('жовт')) return 'yellow';
    if (text.includes('red') || text.includes('черв')) return 'red';
    if (threats.some(t => t.level === 'red')) return 'red';
    if (threats.some(t => t.level === 'yellow')) return 'yellow';
    if (/(ballistic|cruise|missile|rocket|mig31|strategic|guided|бомб|ракет)/.test(text)) return 'red';
    if (/(drone|uav|shahed|бпла|дрон)/.test(text)) return 'yellow';
    return 'unknown';
  }

  function toKyivWallMs(value) {
    if (!value) return NaN;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return NaN;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: KYIV_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const p = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second || 0));
  }

  function mergeAlertSources(legacyAlerts, classifiedAlerts) {
    const merged = legacyAlerts.map(alert => normalizeSerializedAlert({ ...alert, source: 'Kyiv Digital' }));
    classifiedAlerts.forEach(classified => {
      const match = findMatchingAlert(merged, classified);
      if (match) {
        const legacyWasOngoing = match.ongoing;
        match.id = classified.id || match.id;
        match.level = classified.level !== 'unknown' ? classified.level : match.level;
        match.threats = classified.threats?.length ? classified.threats : match.threats;
        match.phases = classified.phases?.length ? classified.phases : match.phases;
        match.sourceMessage = classified.sourceMessage || match.sourceMessage;
        match.source = classified.source || match.source;
        if (classified.ongoing) {
          match.endMs = classified.endMs;
          match.ongoing = true;
        } else if (legacyWasOngoing) {
          match.endMs = classified.endMs;
          match.ongoing = false;
        }
      } else {
        merged.push(normalizeSerializedAlert(classified));
      }
    });

    const sorted = merged.sort((a, b) => a.startMs - b.startMs);
    const deduped = [];
    sorted.forEach(alert => {
      const previous = deduped.at(-1);
      if (previous && Math.abs(previous.startMs - alert.startMs) <= 90 * 1000) {
        const richer = hasClientClassification(alert) ? alert : previous;
        const other = richer === alert ? previous : alert;
        deduped[deduped.length - 1] = {
          ...other,
          ...richer,
          startMs: Math.min(previous.startMs, alert.startMs),
          endMs: Math.max(previous.endMs, alert.endMs),
          ongoing: previous.ongoing && alert.ongoing,
        };
      } else {
        deduped.push(alert);
      }
    });
    return deduped;
  }

  function readObservedPhaseRecords() {
    for (const key of [OBSERVED_PHASES_KEY, ...PREVIOUS_OBSERVED_PHASE_KEYS]) {
      try {
        const saved = localStorage.getItem(key);
        if (!saved) continue;
        const records = normalizeObservedPhaseRecords(JSON.parse(saved));
        if (records.length) return records;
      } catch { /* try the previous storage format */ }
    }
    return [];
  }

  function normalizeServerPhaseRecords(value) {
    const records = (Array.isArray(value) ? value : []).map(record => ({
      startMs: toKyivWallMs(record?.start),
      updatedAtMs: toKyivWallMs(record?.updatedAt || record?.start),
      provisionalEnd: Boolean(record?.provisionalEnd),
      phases: (Array.isArray(record?.phases) ? record.phases : []).map(phase => ({
        startMs: toKyivWallMs(phase?.start),
        endMs: phase?.end == null ? null : toKyivWallMs(phase.end),
        level: normalizeClientLevel(phase?.level, normalizeClientThreats(phase?.threats)),
        threats: normalizeClientThreats(phase?.threats),
        sourceMessage: normalizeText(phase?.sourceMessage),
      })),
    }));
    return normalizeObservedPhaseRecords(records);
  }

  function writeObservedPhaseRecords(records) {
    try { localStorage.setItem(OBSERVED_PHASES_KEY, JSON.stringify(records)); } catch { /* storage may be unavailable */ }
  }

  function buildClassifiedDemo() {
    const today = dayStart(getKyivNow());
    const patterns = [
      [[75, 42, 'yellow'], [330, 58, 'red'], [755, 84, 'yellow']],
      [[25, 31, 'yellow'], [280, 94, 'yellow'], [610, 42, 'red'], [1210, 53, 'yellow']],
      [[160, 66, 'red'], [540, 121, 'yellow'], [1040, 38, 'red']],
      [[50, 44, 'yellow'], [430, 55, 'yellow'], [970, 106, 'red']],
      [[210, 87, 'yellow'], [690, 32, 'red']],
      [[15, 25, 'yellow'], [390, 75, 'red'], [870, 43, 'yellow'], [1130, 66, 'red']],
      [[80, 48, 'yellow'], [515, 39, 'yellow'], [930, 82, 'red']],
      [[35, 63, 'red'], [470, 95, 'yellow']],
      [[300, 54, 'yellow'], [620, 42, 'red'], [1125, 31, 'yellow']],
      [[70, 36, 'yellow'], [300, 64, 'red']],
    ];
    const result = [];
    patterns.forEach((items, dayIndex) => {
      const d0 = today - (patterns.length - 1 - dayIndex) * DAY;
      items.forEach(([minute, duration, level], index) => {
        const startMs = d0 + minute * MINUTE;
        const ongoing = dayIndex === patterns.length - 1 && index === items.length - 1 && startMs < getKyivNow();
        const endMs = ongoing ? getKyivNow() : startMs + duration * MINUTE;
        const mixedDemo = dayIndex === patterns.length - 1 && index === items.length - 1;
        const threats = mixedDemo
          ? [
              { type: 'drones', level: 'yellow', startedAtMs: startMs, sourceMessage: '' },
              { type: 'ballistic_missiles', level: 'red', startedAtMs: startMs + 20 * MINUTE, sourceMessage: '' },
            ]
          : [{ type: level === 'yellow' ? 'drones' : 'missile_threat', level, startedAtMs: startMs, sourceMessage: '' }];
        const phases = mixedDemo
          ? [
              { startMs, endMs: Math.min(endMs, startMs + 20 * MINUTE), level: 'yellow', threats: [threats[0]], sourceMessage: '' },
              { startMs: Math.min(endMs, startMs + 20 * MINUTE), endMs, level: 'red', threats: [threats[1]], sourceMessage: '' },
            ].filter(phase => phase.endMs > phase.startMs)
          : [{ startMs, endMs, level, threats, sourceMessage: '' }];
        result.push({
          id: `demo-${dayIndex}-${index}`,
          startMs, endMs, ongoing, level: mixedDemo ? 'red' : level,
          threats,
          phases,
          source: 'Demo classification feed',
          sourceMessage: '',
        });
      });
    });
    return result;
  }

  function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

  function normalizeSerializedAlert(a) {
    const startMs = Number(a?.startMs);
    const endMs = Number(a?.endMs);
    const threats = normalizeStoredThreats(a?.threats);
    const level = normalizeClientLevel(a?.level, threats);
    const phases = (Array.isArray(a?.phases) ? a.phases : []).map(phase => ({
      startMs: Number(phase?.startMs),
      endMs: Number(phase?.endMs),
      level: normalizeClientLevel(phase?.level, normalizeStoredThreats(phase?.threats)),
      threats: normalizeStoredThreats(phase?.threats),
      sourceMessage: normalizeText(phase?.sourceMessage),
    })).filter(phase => Number.isFinite(phase.startMs) && Number.isFinite(phase.endMs) && phase.endMs > phase.startMs);
    return {
      id: String(a?.id || `${startMs}|${a?.ongoing ? 'open' : endMs}`),
      startMs,
      endMs,
      ongoing: Boolean(a?.ongoing),
      level,
      threats,
      phases,
      source: normalizeText(a?.source) || 'Unknown source',
      sourceMessage: normalizeText(a?.sourceMessage),
    };
  }

  function normalizeStoredThreats(value) {
    return (Array.isArray(value) ? value : []).map(item => ({
      type: normalizeText(typeof item === 'string' ? item : item?.type || 'unknown').toLowerCase(),
      level: normalizeClientLevel(typeof item === 'string' ? item : item?.level || item?.type),
      startedAtMs: Number.isFinite(Number(item?.startedAtMs)) ? Number(item.startedAtMs) : null,
      sourceMessage: normalizeText(typeof item === 'object' ? item?.sourceMessage : ''),
    }));
  }

  function hasClientClassification(alert) {
    return alert?.level === 'yellow' || alert?.level === 'red'
      || alert?.phases?.some(phase => phase.level === 'yellow' || phase.level === 'red');
  }

  function getKyivNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: KYIV_TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
    }).formatToParts(new Date());
    const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month)-1, Number(p.day), Number(p.hour), Number(p.minute));
  }

  function readCache({ allowExpired = false } = {}) {
    for (const key of [CACHE_KEY, ...PREVIOUS_CACHE_KEYS]) {
      try {
        const data = JSON.parse(localStorage.getItem(key));
        const freshEnough = Date.now() - Number(data?.fetchedAt || 0) <= 48 * 60 * 60 * 1000;
        if (data?.alerts?.length && (allowExpired || freshEnough)) return data;
      } catch { /* try the next compatible cache key */ }
    }
    return null;
  }

  function readBaselineRange() {
    try {
      const saved = JSON.parse(localStorage.getItem(BASELINE_RANGE_KEY));
      const startMs = Number(saved?.startMs);
      const endMs = Number(saved?.endMs);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= endMs) return { startMs, endMs };
    } catch { /* use default */ }
    return { ...DEFAULT_BASELINE_RANGE };
  }

  function setBaselineBounds() {
    const firstAlertDay = state.alerts.length ? dayStart(Math.min(...state.alerts.map(a => a.startMs))) : DEFAULT_BASELINE_RANGE.startMs;
    const earliestSelectableDay = ['unavailable', 'demo'].includes(state.sourceMode)
      ? DEFAULT_BASELINE_RANGE.startMs
      : firstAlertDay;
    const latestCompleteDay = dayStart(getKyivNow()) - DAY;
    state.baselineBounds = { minMs: earliestSelectableDay, maxMs: latestCompleteDay };

    const current = state.baselineRange;
    const valid = current.startMs >= earliestSelectableDay && current.endMs <= latestCompleteDay && current.startMs <= current.endMs;
    if (!valid) {
      const defaultFits = DEFAULT_BASELINE_RANGE.startMs >= earliestSelectableDay && DEFAULT_BASELINE_RANGE.endMs <= latestCompleteDay;
      state.baselineRange = defaultFits
        ? { ...DEFAULT_BASELINE_RANGE }
        : { startMs: Math.max(earliestSelectableDay, latestCompleteDay - 29 * DAY), endMs: latestCompleteDay };
    }
  }

  function monthStart(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }

  function resolveBaseline() {
    const { startMs, endMs } = state.baselineRange;
    if (['unavailable', 'demo'].includes(state.sourceMode) && isDefaultBaselineRange(startMs, endMs)) return { ...FALLBACK_BASELINE };
    if (state.sourceMode === 'unavailable') return { ...FALLBACK_BASELINE };
    return calculateBaseline(state.alerts, startMs, endMs);
  }

  function calculateBaseline(alerts, startMs, endMs) {
    const endExclusive = endMs + DAY;
    const dayCount = Math.round((endMs - startMs) / DAY) + 1;
    const started = alerts.filter(a => a.startMs >= startMs && a.startMs < endExclusive).length;
    let totalMinutes = 0;
    let workMinutes = 0;

    alerts.forEach(alert => {
      const overlapStart = Math.max(alert.startMs, startMs);
      const overlapEnd = Math.min(alert.endMs, endExclusive);
      if (overlapEnd <= overlapStart) return;
      totalMinutes += Math.round((overlapEnd - overlapStart) / MINUTE);

      for (let dayMs = dayStart(overlapStart); dayMs < overlapEnd; dayMs += DAY) {
        const windowStart = dayMs + WORK_START * MINUTE;
        const windowEnd = dayMs + WORK_END * MINUTE;
        workMinutes += Math.max(0, Math.round((Math.min(overlapEnd, windowEnd) - Math.max(overlapStart, windowStart)) / MINUTE));
      }
    });

    return {
      alertsPerDay: started / dayCount,
      totalMinutesPerDay: totalMinutes / dayCount,
      workMinutesPerDay: workMinutes / dayCount,
      dayCount,
      startMs,
      endMs,
      isEmbedded: false,
    };
  }

  function isDefaultBaselineRange(startMs, endMs) {
    return startMs === DEFAULT_BASELINE_RANGE.startMs && endMs === DEFAULT_BASELINE_RANGE.endMs;
  }

  function buildDailyModel(alerts) {
    const map = new Map();
    const ensure = dayMs => {
      const key = dateKey(dayMs);
      if (!map.has(key)) {
        map.set(key, {
          key,
          dayMs,
          segments: [],
          starts: [],
          totalMinutes: 0,
          workMinutes: 0,
          yellowMinutes: 0,
          redMinutes: 0,
          unknownMinutes: 0,
          longestMinutes: 0,
          ongoing: false,
        });
      }
      return map.get(key);
    };

    alerts.forEach((alert, alertIndex) => {
      if (!Number.isFinite(alert.startMs) || !Number.isFinite(alert.endMs) || alert.endMs <= alert.startMs) return;
      const startDay = dayStart(alert.startMs);
      ensure(startDay).starts.push(alert);
      let cursor = alert.startMs;
      let part = 0;

      while (cursor < alert.endMs) {
        const d0 = dayStart(cursor);
        const d1 = d0 + DAY;
        const segEnd = Math.min(alert.endMs, d1);
        const startMinute = Math.round((cursor - d0) / MINUTE);
        const endMinute = Math.round((segEnd - d0) / MINUTE);
        const duration = Math.max(1, endMinute - startMinute);
        const work = overlapMinutes(startMinute, endMinute, WORK_START, WORK_END);
        const phaseSlices = buildSegmentPhases(alert, cursor, segEnd);
        const levelMinutes = { yellow: 0, red: 0, unknown: 0 };
        phaseSlices.forEach(phase => {
          levelMinutes[phase.level] += phase.durationMinutes;
        });
        const dominantLevel = Object.entries(levelMinutes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
        const day = ensure(d0);
        const segment = {
          id: `${alert.id || alertIndex}-${part}`,
          alertIndex,
          part,
          startMs: cursor,
          endMs: segEnd,
          originalStartMs: alert.startMs,
          originalEndMs: alert.endMs,
          startMinute,
          endMinute,
          durationMinutes: duration,
          workMinutes: work,
          yellowMinutes: levelMinutes.yellow,
          redMinutes: levelMinutes.red,
          unknownMinutes: levelMinutes.unknown,
          dominantLevel,
          phases: phaseSlices,
          threats: alert.threats || [],
          sourceMessage: alert.sourceMessage || '',
          source: alert.source || '',
          ongoing: alert.ongoing && segEnd === alert.endMs,
          continuation: cursor !== alert.startMs,
        };
        day.segments.push(segment);
        day.totalMinutes += duration;
        day.workMinutes += work;
        day.yellowMinutes += levelMinutes.yellow;
        day.redMinutes += levelMinutes.red;
        day.unknownMinutes += levelMinutes.unknown;
        day.longestMinutes = Math.max(day.longestMinutes, duration);
        day.ongoing ||= segment.ongoing;
        cursor = segEnd;
        part += 1;
      }
    });

    const nowDay = dayStart(getKyivNow());
    const minimumTimelineStart = nowDay - 30 * DAY;
    const firstAlertDay = map.size ? Math.min(...[...map.values()].map(d => d.dayMs)) : nowDay;
    const first = Math.min(firstAlertDay, minimumTimelineStart);
    for (let d = first; d <= nowDay; d += DAY) ensure(d);
    return [...map.values()].sort((a,b) => a.dayMs - b.dayMs);
  }

  function buildSegmentPhases(alert, segmentStartMs, segmentEndMs) {
    const input = (Array.isArray(alert.phases) && alert.phases.length)
      ? alert.phases
      : [{
          startMs: alert.startMs,
          endMs: alert.endMs,
          level: alert.level || 'unknown',
          threats: alert.threats || [],
          sourceMessage: alert.sourceMessage || '',
        }];
    const clipped = input.map(phase => ({
      startMs: Math.max(segmentStartMs, Number(phase.startMs)),
      endMs: Math.min(segmentEndMs, Number(phase.endMs)),
      level: normalizeClientLevel(phase.level, phase.threats || []),
      threats: phase.threats || [],
      sourceMessage: phase.sourceMessage || '',
    })).filter(phase => Number.isFinite(phase.startMs) && Number.isFinite(phase.endMs) && phase.endMs > phase.startMs)
      .sort((a, b) => a.startMs - b.startMs);

    const result = [];
    let cursor = segmentStartMs;
    clipped.forEach(phase => {
      const startMs = Math.max(cursor, phase.startMs);
      if (startMs > cursor) result.push(makePhaseSlice(cursor, startMs, 'unknown', [], ''));
      const endMs = Math.max(startMs, phase.endMs);
      if (endMs > startMs) result.push(makePhaseSlice(startMs, endMs, phase.level, phase.threats, phase.sourceMessage));
      cursor = Math.max(cursor, endMs);
    });
    if (cursor < segmentEndMs) result.push(makePhaseSlice(cursor, segmentEndMs, 'unknown', [], ''));
    if (!result.length) result.push(makePhaseSlice(segmentStartMs, segmentEndMs, 'unknown', [], ''));
    return result;
  }

  function makePhaseSlice(startMs, endMs, level, threats, sourceMessage) {
    return {
      startMs,
      endMs,
      durationMinutes: Math.max(1, Math.round((endMs - startMs) / MINUTE)),
      level: ['yellow', 'red'].includes(level) ? level : 'unknown',
      threats: threats || [],
      sourceMessage: sourceMessage || '',
    };
  }

  function overlapMinutes(a0,a1,b0,b1) { return Math.max(0, Math.min(a1,b1) - Math.max(a0,b0)); }
  function dayStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function dateKey(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`; }
  function pad(n) { return String(n).padStart(2,'0'); }
  function inputDate(ms) { return dateKey(ms); }
  function parseInputDate(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  }

  function calendarMeta(ms) {
    const d = new Date(ms);
    const weekday = d.getUTCDay();
    const holiday = ukrainianHoliday(ms);
    return { weekend: weekday === 0 || weekday === 6, holiday };
  }

  function ukrainianHoliday(ms) {
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    const key = `${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    if (FIXED_UA_HOLIDAYS.has(key)) return FIXED_UA_HOLIDAYS.get(key);
    const easter = orthodoxEaster(year);
    if (dayStart(ms) === easter) return 'Easter';
    if (dayStart(ms) === easter + 49 * DAY) return 'Trinity Sunday';
    return null;
  }

  function orthodoxEaster(year) {
    const a = year % 4;
    const b = year % 7;
    const c = year % 19;
    const d = (19 * c + 15) % 30;
    const e = (2 * a + 4 * b - d + 34) % 7;
    const julianMonth = Math.floor((d + e + 114) / 31);
    const julianDay = ((d + e + 114) % 31) + 1;
    return Date.UTC(year, julianMonth - 1, julianDay) + 13 * DAY;
  }

  function formatDateFull(ms) {
    return new Intl.DateTimeFormat('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(ms));
  }

  function formatMonthYear(ms) {
    return new Intl.DateTimeFormat('en-GB', { month:'long', year:'numeric', timeZone:'UTC' }).format(new Date(ms));
  }

  function formatRangeLabel(startMs, endMs) {
    const start = new Date(startMs);
    const end = new Date(endMs);
    const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
    const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
    const startDay = start.getUTCDate();
    const endDay = end.getUTCDate();
    const startMonth = new Intl.DateTimeFormat('en-GB',{month:'short',timeZone:'UTC'}).format(start);
    const endMonth = new Intl.DateTimeFormat('en-GB',{month:'short',timeZone:'UTC'}).format(end);
    if (sameMonth) return `${startDay}–${endDay} ${endMonth} ${end.getUTCFullYear()}`;
    if (sameYear) return `${startDay} ${startMonth}–${endDay} ${endMonth} ${end.getUTCFullYear()}`;
    return `${startDay} ${startMonth} ${start.getUTCFullYear()}–${endDay} ${endMonth} ${end.getUTCFullYear()}`;
  }

  function chooseSelectedKey() {
    const today = dateKey(getKyivNow());
    return state.days.some(d => d.key === today) ? today : state.days.at(-1)?.key;
  }

  function renderAll() {
    renderHero();
    renderBaseline();
    renderTimelines();
    renderDetail();
  }

  function renderHero() {
    const now = getKyivNow();
    const today = state.days.find(d => d.key === dateKey(now)) || emptyDay(now);
    const active = state.alerts.filter(a => a.ongoing).sort((a, b) => b.startMs - a.startMs)[0] || null;
    const dayLabel = formatDateLong(now).toUpperCase();
    els.todayEyebrow.textContent = `TODAY · ${dayLabel} · KYIV CITY`;

    if (state.sourceMode === 'unavailable' && !state.alerts.length) {
      els.heroHeadline.textContent = 'Live alert data is temporarily unavailable.';
      els.heroSubline.textContent = 'The dashboard cannot confirm Kyiv’s current status. Use an official warning channel.';
      els.kpiCount.textContent = '—';
      els.kpiCountNote.textContent = 'Waiting for data';
      els.kpiTotal.textContent = '—';
      els.kpiWork.textContent = '—';
      els.kpiLongest.textContent = '—';
      els.kpiLongestNote.textContent = 'Waiting for data';
      els.threatSummary.hidden = true;
      els.currentStatus.dataset.alert = 'false';
      els.currentStatus.dataset.level = 'none';
      els.currentStatusText.textContent = 'CURRENT STATUS UNAVAILABLE';
      return;
    }

    els.heroHeadline.innerHTML = today.totalMinutes
      ? `Kyiv has spent <em>${formatDuration(today.totalMinutes)}</em> under air-raid alerts today.`
      : `No air-raid alert time has been recorded in Kyiv today.`;
    els.heroSubline.innerHTML = today.workMinutes
      ? `<strong>${formatDuration(today.workMinutes)}</strong> occurred inside the 09:00–18:00 window.`
      : `No alert time has overlapped the 09:00–18:00 window so far.`;

    els.kpiCount.textContent = today.starts.length;
    els.kpiCountNote.textContent = today.starts.length === 1 ? 'Alert started today' : 'Alerts started today';
    els.kpiTotal.textContent = formatDuration(today.totalMinutes);
    els.kpiWork.textContent = formatDuration(today.workMinutes);
    els.kpiLongest.textContent = formatDuration(today.longestMinutes);
    els.kpiLongestNote.textContent = today.longestMinutes ? 'Longest daily segment' : 'No alerts recorded';

    els.threatSummary.hidden = !today.totalMinutes;
    els.yellowToday.textContent = formatDuration(today.yellowMinutes);
    els.redToday.textContent = formatDuration(today.redMinutes);
    els.unknownToday.textContent = formatDuration(today.unknownMinutes);

    const activeLevel = active ? alertCurrentLevel(active) : 'none';
    els.currentStatus.dataset.alert = active ? 'true' : 'false';
    els.currentStatus.dataset.level = activeLevel;
    if (!active) {
      els.currentStatusText.textContent = state.sourceMode === 'cached'
        ? 'CACHED DATA · NO ACTIVE ALERT AT LAST REFRESH'
        : 'NO ACTIVE AIR-RAID ALERT';
    } else {
      const measuredUntil = state.sourceMode === 'cached' ? active.endMs : now;
      const elapsed = Math.max(0, Math.round((measuredUntil - active.startMs) / MINUTE));
      const label = activeLevel === 'yellow' ? 'YELLOW · DRONE WARNING ACTIVE'
        : activeLevel === 'red' ? 'RED · HIGH-LEVEL THREAT ACTIVE'
          : 'AIR-RAID ALERT ACTIVE · LEVEL UNAVAILABLE';
      els.currentStatusText.textContent = `${state.sourceMode === 'cached' ? 'CACHED DATA · ' : ''}${label} · ${formatDuration(elapsed)}`;
    }
  }

  function renderSourceAttribution() {
    const provider = state.providerName || (state.sourceMode === 'unavailable' ? 'Kyiv Digital' : 'Configured alert API');
    if (state.sourceMode === 'live-classified') {
      els.dataSourcePrimary.textContent = `Server-tracked classification: ${provider}`;
      els.dataSourceSecondary.textContent = state.classificationStale
        ? 'Saved yellow/red history is available · current classification is temporarily stale'
        : state.usedLegacyHistory
          ? 'Threat phases are collected 24/7 · alert intervals supplemented by Kyiv Digital'
          : 'Threat phases and alert intervals are collected continuously on the server';
    } else if (state.sourceMode === 'live-unclassified') {
      els.dataSourcePrimary.textContent = 'Data source: Kyiv Digital';
      els.dataSourceSecondary.textContent = state.classificationError
        ? 'Alert intervals are live · the yellow/red classifier is offline'
        : 'Alert intervals are live · threat classification is currently unavailable';
    } else if (state.sourceMode === 'cached') {
      els.dataSourcePrimary.textContent = `Cached data: ${provider}`;
      els.dataSourceSecondary.textContent = 'Showing the last successful dataset saved in this browser';
    } else if (state.sourceMode === 'demo') {
      els.dataSourcePrimary.textContent = 'Demo mode: synthetic classified data';
      els.dataSourceSecondary.textContent = 'For interface preview only · not operational warning data';
    } else {
      els.dataSourcePrimary.textContent = 'Live data unavailable';
      els.dataSourceSecondary.textContent = 'Current status cannot be confirmed · use an official warning channel';
    }
    els.dataSourceLink.href = state.providerUrl || 'https://alerts.in.ua/';
  }

  function alertCurrentLevel(alert) {
    const phases = Array.isArray(alert?.phases) ? alert.phases : [];
    const last = phases.filter(p => p.endMs >= getKyivNow() - MINUTE).at(-1) || phases.at(-1);
    return normalizeClientLevel(last?.level || alert?.level, last?.threats || alert?.threats || []);
  }

  function renderBaseline() {
    const b = state.baseline;
    const { startMs, endMs } = state.baselineRange;
    els.baselineRangeLabel.textContent = formatRangeLabel(startMs, endMs);
    els.baselinePeriodMeta.textContent = `${b.dayCount} calendar ${b.dayCount === 1 ? 'day' : 'days'} · zero-alert days included${b.isEmbedded ? ' · embedded benchmark' : ''}`;
    els.baselineCount.textContent = b.alertsPerDay.toFixed(2);
    els.baselineTotal.textContent = formatDuration(Math.round(b.totalMinutesPerDay));
    els.baselineWork.textContent = formatDuration(Math.round(b.workMinutesPerDay));

    const complete = [...state.days].reverse().find(d => d.dayMs < dayStart(getKyivNow()) && d.starts.length);
    if (!complete) {
      els.baselineInsight.textContent = 'No completed alert day is available for comparison yet.';
      return;
    }
    if (!b.totalMinutesPerDay) {
      els.baselineInsight.textContent = 'The selected baseline period contains no recorded alert time.';
      return;
    }
    const ratio = complete.totalMinutes / b.totalMinutesPerDay;
    const direction = ratio >= 1 ? 'above' : 'below';
    els.baselineInsight.textContent = `${formatDateShort(complete.dayMs)} was ${ratio.toFixed(1)}× the selected average — ${direction} the chosen “usual” period.`;
  }

  function renderTimelines() {
    const shown = state.days.slice(-state.range);
    els.timelineGrid.innerHTML = '';
    els.mobileTimeline.innerHTML = '';

    // Desktop reads chronologically from left to right.
    shown.forEach(day => els.timelineGrid.appendChild(createDesktopDay(day)));
    // Mobile is newest-first, so today is the first card users see.
    [...shown].reverse().forEach(day => els.mobileTimeline.appendChild(createMobileDay(day)));

    requestAnimationFrame(() => { els.timelineScroll.scrollLeft = els.timelineScroll.scrollWidth; });
  }

  function createDesktopDay(day) {
    const col = document.createElement('article');
    const meta = calendarMeta(day.dayMs);
    col.className = 'day-column';
    if (day.key === state.selectedKey) col.classList.add('is-selected');
    if (day.key === dateKey(getKyivNow())) col.classList.add('today-column');
    if (meta.weekend) col.classList.add('is-weekend');
    if (meta.holiday) col.classList.add('is-holiday');
    col.dataset.dayKey = day.key;
    col.innerHTML = `
      <header class="day-column-header">
        <span class="day-date">${formatDayMonth(day.dayMs)}</span>
        <span class="day-weekday-row">
          <span class="day-weekday">${formatWeekday(day.dayMs)}</span>
          ${meta.holiday ? `<span class="holiday-marker" title="${meta.holiday}" aria-label="${meta.holiday}">HOLIDAY</span>` : ''}
        </span>
        <div class="day-summary"><strong>${day.starts.length} ${day.starts.length === 1 ? 'alert' : 'alerts'}</strong><span>09–18 · ${formatCompact(day.workMinutes)}</span></div>
      </header>
      <div class="day-timeline"><span class="work-band"></span></div>`;
    const track = col.querySelector('.day-timeline');
    day.segments.forEach((seg, i) => track.appendChild(createAlertBlock(seg, i + 1, day)));
    col.addEventListener('click', event => {
      if (event.target.closest('.alert-block')) return;
      selectDay(day.key);
    });
    return col;
  }

  function createAlertBlock(seg, index, day) {
    const button = document.createElement('button');
    const top = seg.startMinute / 1440 * 100;
    const height = Math.max(seg.durationMinutes / 1440 * 100, .45);
    button.type = 'button';
    button.className = `alert-block level-${seg.dominantLevel}${seg.ongoing ? ' is-ongoing' : ''}`;
    button.style.top = `${top}%`;
    button.style.height = `${height}%`;
    button.setAttribute('aria-label', tooltipPlain(seg, index));
    appendPhaseSpans(button, seg, 'vertical');

    if (seg.durationMinutes >= 45) {
      const label = document.createElement('span');
      label.className = 'alert-label';
      label.textContent = formatCompact(seg.durationMinutes);
      button.appendChild(label);
    }
    if (seg.ongoing) {
      const pulse = document.createElement('span');
      pulse.className = 'ongoing-marker';
      pulse.setAttribute('aria-hidden', 'true');
      button.appendChild(pulse);
    }

    button.addEventListener('mouseenter', event => showTooltip(event, seg, index));
    button.addEventListener('mousemove', positionTooltip);
    button.addEventListener('mouseleave', hideTooltip);
    button.addEventListener('focus', event => showTooltip(event, seg, index));
    button.addEventListener('blur', hideTooltip);
    button.addEventListener('click', event => { event.stopPropagation(); selectDay(day.key); });
    return button;
  }

  function appendPhaseSpans(container, seg, orientation) {
    const totalMs = Math.max(MINUTE, seg.endMs - seg.startMs);
    (seg.phases?.length ? seg.phases : [{ startMs: seg.startMs, endMs: seg.endMs, level: 'unknown' }]).forEach(phase => {
      const startPct = Math.max(0, (phase.startMs - seg.startMs) / totalMs * 100);
      const sizePct = Math.max(.5, (phase.endMs - phase.startMs) / totalMs * 100);
      const span = document.createElement('span');
      span.className = `threat-phase level-${phase.level || 'unknown'}`;
      if (orientation === 'vertical') {
        span.style.top = `${startPct}%`;
        span.style.height = `${Math.min(100 - startPct, sizePct)}%`;
      } else {
        span.style.left = `${startPct}%`;
        span.style.width = `${Math.min(100 - startPct, sizePct)}%`;
      }
      container.appendChild(span);
    });
  }

  function createMobileDay(day) {
    const card = document.createElement('article');
    const meta = calendarMeta(day.dayMs);
    const specialWeekday = meta.weekend || meta.holiday;
    card.className = `mobile-day-card${day.key === state.selectedKey ? ' is-selected' : ''}${meta.weekend ? ' is-weekend' : ''}${meta.holiday ? ' is-holiday' : ''}`;
    card.dataset.dayKey = day.key;
    const levelSummary = compactThreatSummary(day);
    card.innerHTML = `
      <div class="mobile-day-head">
        <div class="mobile-day-title">
          <strong>${formatDayMonth(day.dayMs)} · <span class="mobile-weekday${specialWeekday ? ' is-special' : ''}">${formatWeekday(day.dayMs)}</span></strong>
          ${meta.holiday ? `<span class="mobile-holiday">${meta.holiday}</span>` : ''}
          <span class="mobile-total">${day.totalMinutes ? formatDuration(day.totalMinutes) + ' total' : 'No alert time'}</span>
          ${levelSummary ? `<span class="mobile-threat-summary">${levelSummary}</span>` : ''}
        </div>
        <div class="mobile-day-stats"><strong>${day.starts.length} ${day.starts.length === 1 ? 'alert' : 'alerts'}</strong><span>09–18 · ${formatCompact(day.workMinutes)}</span></div>
      </div>
      <div class="mobile-track-wrap">
        <div class="mobile-track"><span class="mobile-work-band"></span></div>
        <div class="mobile-axis"><span>00:00</span><span>09:00</span><span>18:00</span><span>24:00</span></div>
      </div>`;
    const track = card.querySelector('.mobile-track');
    day.segments.forEach(seg => {
      const block = document.createElement('span');
      block.className = `mobile-alert-shape level-${seg.dominantLevel}${seg.ongoing ? ' is-ongoing' : ''}`;
      block.style.left = `${seg.startMinute / 1440 * 100}%`;
      block.style.width = `${Math.max(seg.durationMinutes / 1440 * 100, .7)}%`;
      block.setAttribute('aria-hidden', 'true');
      appendPhaseSpans(block, seg, 'horizontal');
      if (seg.ongoing) {
        const pulse = document.createElement('span');
        pulse.className = 'ongoing-marker';
        block.appendChild(pulse);
      }
      track.appendChild(block);
    });
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${formatDayMonth(day.dayMs)} ${formatWeekday(day.dayMs)}. ${day.starts.length} alerts. ${formatDuration(day.totalMinutes)} total. ${classificationPlain(day)}.`);
    card.addEventListener('click', () => selectDay(day.key));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectDay(day.key);
      }
    });
    return card;
  }

  function compactThreatSummary(day) {
    const parts = [];
    if (day.yellowMinutes) parts.push(`<i class="level-dot level-yellow"></i>Y ${formatCompact(day.yellowMinutes)}`);
    if (day.redMinutes) parts.push(`<i class="level-dot level-red"></i>R ${formatCompact(day.redMinutes)}`);
    if (day.unknownMinutes) parts.push(`<i class="level-dot level-unknown"></i>U ${formatCompact(day.unknownMinutes)}`);
    return parts.join('<span class="threat-separator">·</span>');
  }

  function classificationPlain(day) {
    const parts = [];
    if (day.yellowMinutes) parts.push(`${formatDuration(day.yellowMinutes)} yellow`);
    if (day.redMinutes) parts.push(`${formatDuration(day.redMinutes)} red`);
    if (day.unknownMinutes) parts.push(`${formatDuration(day.unknownMinutes)} unclassified`);
    return parts.join(', ') || 'No classified alert time';
  }

  function selectDay(key) {
    state.selectedKey = key;
    document.querySelectorAll('[data-day-key]').forEach(el => el.classList.toggle('is-selected', el.dataset.dayKey === key));
    document.querySelectorAll('.mobile-day-card').forEach(el => {
      el.classList.toggle('is-selected', el.dataset.dayKey === key);
    });
    renderDetail();
    document.querySelector('.detail-section')?.scrollIntoView({ behavior:'smooth', block:'start' });
  }

  function renderDetail() {
    const day = state.days.find(d => d.key === state.selectedKey);
    if (!day) return;
    const meta = calendarMeta(day.dayMs);
    els.detailTitle.textContent = `${formatDayMonth(day.dayMs)} · ${formatWeekday(day.dayMs)}`;
    els.detailSummary.textContent = day.segments.length
      ? `${day.starts.length} ${day.starts.length === 1 ? 'alert started' : 'alerts started'} on this date. Colours show the available threat classification.`
      : 'No air-raid alert time was recorded for this date.';
    els.detailPills.innerHTML = `
      ${meta.holiday ? `<span class="detail-pill is-holiday">${meta.holiday}</span>` : ''}
      ${meta.weekend ? `<span class="detail-pill is-holiday">Weekend</span>` : ''}
      <span class="detail-pill">${formatDuration(day.totalMinutes)} total</span>
      <span class="detail-pill is-accent">${formatDuration(day.workMinutes)} in 09:00–18:00</span>
      ${day.yellowMinutes ? `<span class="detail-pill is-yellow">${formatDuration(day.yellowMinutes)} yellow</span>` : ''}
      ${day.redMinutes ? `<span class="detail-pill is-red">${formatDuration(day.redMinutes)} red</span>` : ''}
      ${day.unknownMinutes ? `<span class="detail-pill is-unknown">${formatDuration(day.unknownMinutes)} unclassified</span>` : ''}`;

    if (!day.segments.length) {
      els.detailList.innerHTML = '<div class="empty-state">No alert intervals to display.</div>';
      return;
    }
    const max = Math.max(...day.segments.map(s => s.durationMinutes));
    els.detailList.innerHTML = '';
    day.segments.forEach((seg, i) => {
      const row = document.createElement('div');
      row.className = 'detail-row';
      row.innerHTML = `
        <span class="detail-index">#${String(i+1).padStart(2,'0')}</span>
        <span class="detail-time">${formatClock(seg.startMs)}–${seg.ongoing ? 'now' : formatClock(seg.endMs)}</span>
        <span class="detail-threat level-${seg.dominantLevel}"><i aria-hidden="true"></i>${escapeHtml(segmentThreatTitle(seg))}</span>
        <span class="detail-track" aria-hidden="true"></span>
        <strong class="detail-duration">${formatDuration(seg.durationMinutes)}</strong>
        <span class="detail-overlap">${seg.workMinutes ? formatDuration(seg.workMinutes) + ' in 09–18' : 'No 09–18 overlap'}</span>`;
      const detailTrack = row.querySelector('.detail-track');
      const width = seg.durationMinutes / max * 100;
      const fill = document.createElement('span');
      fill.className = 'detail-track-fill';
      fill.style.width = `${width}%`;
      appendPhaseSpans(fill, seg, 'horizontal');
      detailTrack.appendChild(fill);
      els.detailList.appendChild(row);
    });
  }

  function segmentThreatTitle(seg) {
    const levels = new Set((seg.phases || []).filter(p => p.durationMinutes > 0).map(p => p.level));
    levels.delete('unknown');
    if (levels.size > 1) return 'Mixed threat levels';
    const level = levels.values().next().value || seg.dominantLevel;
    if (level === 'yellow') return `Yellow · ${threatName(seg, 'Drone warning')}`;
    if (level === 'red') return `Red · ${threatName(seg, 'High-level threat')}`;
    return 'Classification unavailable';
  }

  function threatName(seg, fallback) {
    const types = [...new Set([
      ...(seg.threats || []).map(t => t.type),
      ...(seg.phases || []).flatMap(p => (p.threats || []).map(t => t.type)),
    ].filter(Boolean).map(humanThreatType).filter(Boolean))];
    return types.length ? types.slice(0, 2).join(' / ') : fallback;
  }

  function humanThreatType(type) {
    const value = normalizeText(type).toLowerCase().replace(/[_-]+/g, ' ');
    const labels = {
      drones: 'Drone warning', drone: 'Drone warning', uav: 'Drone warning', shahed: 'Drone warning',
      'ballistic missiles': 'Ballistic missile', 'ballistic missile': 'Ballistic missile',
      'cruise missiles': 'Cruise missile', 'cruise missile': 'Cruise missile',
      'missile threat': 'Missile threat', missiles: 'Missile threat', missile: 'Missile threat',
      'mig31k departure': 'MiG-31K threat', 'strategic aircraft activity': 'Strategic aviation',
      'guided aerial bombs': 'Guided aerial bombs',
    };
    return labels[value] || (value && value !== 'unknown' ? value.replace(/\b\w/g, letter => letter.toUpperCase()) : '');
  }

  function showTooltip(event, seg, index) {
    const phaseText = classificationBreakdown(seg);
    const sourceMessage = seg.sourceMessage ? `<br><em>${escapeHtml(seg.sourceMessage)}</em>` : '';
    els.tooltip.innerHTML = `
      <strong>Alert #${String(index).padStart(2,'0')} · ${formatDuration(seg.durationMinutes)}</strong>
      <span class="tooltip-level level-${seg.dominantLevel}">${escapeHtml(segmentThreatTitle(seg))}</span>
      <span>${formatClock(seg.startMs)}–${seg.ongoing ? 'ongoing' : formatClock(seg.endMs)}${seg.continuation ? ' · continued after midnight' : ''}<br>${escapeHtml(phaseText)}<br>${seg.workMinutes ? formatDuration(seg.workMinutes) + ' inside 09:00–18:00' : 'No overlap with 09:00–18:00'}${sourceMessage}</span>`;
    els.tooltip.hidden = false;
    positionTooltip(event);
  }

  function classificationBreakdown(seg) {
    const totals = { yellow: 0, red: 0, unknown: 0 };
    (seg.phases || []).forEach(phase => totals[phase.level] += phase.durationMinutes);
    const parts = [];
    if (totals.yellow) parts.push(`Yellow ${formatDuration(totals.yellow)}`);
    if (totals.red) parts.push(`Red ${formatDuration(totals.red)}`);
    if (totals.unknown) parts.push(`Unclassified ${formatDuration(totals.unknown)}`);
    return parts.join(' · ') || 'Classification unavailable';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  }

  function positionTooltip(event) {
    if (els.tooltip.hidden) return;
    const x = Math.min(window.innerWidth - 260, Math.max(12, event.clientX + 16));
    const y = Math.min(window.innerHeight - 120, Math.max(12, event.clientY + 16));
    els.tooltip.style.left = `${x}px`;
    els.tooltip.style.top = `${y}px`;
  }
  function hideTooltip() { els.tooltip.hidden = true; }

  function tooltipPlain(seg,index) {
    return `Alert ${index}, ${formatDuration(seg.durationMinutes)}, ${segmentThreatTitle(seg)}, ${formatClock(seg.startMs)} to ${seg.ongoing ? 'ongoing' : formatClock(seg.endMs)}, ${formatDuration(seg.workMinutes)} within 09:00 to 18:00`;
  }

  function setFeedState(mode,label) {
    els.feedChip.dataset.state = mode;
    els.feedLabel.textContent = label;
  }

  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 2800);
  }

  function emptyDay(ms) { return { key:dateKey(ms), dayMs:dayStart(ms), segments:[], starts:[], totalMinutes:0, workMinutes:0, yellowMinutes:0, redMinutes:0, unknownMinutes:0, longestMinutes:0, ongoing:false }; }
  function formatDuration(mins) {
    const n = Math.max(0, Math.round(mins || 0));
    const h = Math.floor(n/60), m = n%60;
    if (!h) return `${m} min`;
    if (!m) return `${h} h`;
    return `${h} h ${m} min`;
  }
  function formatCompact(mins) {
    const n = Math.max(0, Math.round(mins || 0));
    return `${Math.floor(n/60)}h${String(n%60).padStart(2,'0')}`;
  }
  function formatClock(ms) { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function formatDayMonth(ms) { return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}).format(new Date(ms)); }
  function formatWeekday(ms) { return new Intl.DateTimeFormat('en-GB',{weekday:'short',timeZone:'UTC'}).format(new Date(ms)); }
  function formatDateShort(ms) { return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}).format(new Date(ms)); }
  function formatDateLong(ms) { return new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'2-digit',month:'short',timeZone:'UTC'}).format(new Date(ms)); }
})();
