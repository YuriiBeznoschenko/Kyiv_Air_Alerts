import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveActiveAlert } from '../netlify/functions/air-alerts.mjs';
import {
  applyObservedPhaseRecords,
  mergeSavedClassification,
  normalizeObservedPhaseRecords,
  reconcileLiveAlertState,
  updateObservedPhaseRecords,
} from '../public/alert-reconciliation-v1.mjs';

const MINUTE = 60 * 1000;
const START = Date.UTC(2026, 8, 11, 9, 10);

function alert(overrides = {}) {
  return {
    id: 'provider-active-id',
    startMs: START,
    endMs: START + 10 * MINUTE,
    ongoing: true,
    level: 'yellow',
    threats: [{ type: 'drones', level: 'yellow' }],
    phases: [],
    source: 'test',
    sourceMessage: '',
    ...overrides,
  };
}

test('a confirmed all-clear closes a stale open history interval immediately', () => {
  const result = reconcileLiveAlertState([alert()], {
    liveStateKnown: true,
    liveActiveAlert: null,
    nowMs: START + 37 * MINUTE,
  });

  assert.equal(result[0].ongoing, false);
  assert.equal(result[0].endMs, START + 37 * MINUTE);
});

test('an unavailable live feed does not override Kyiv Digital current state', () => {
  const result = reconcileLiveAlertState([alert()], {
    liveStateKnown: false,
    liveActiveAlert: null,
    nowMs: START + 37 * MINUTE,
  });

  assert.equal(result[0].ongoing, true);
});

test('Ukraine Alarm live status does not resurrect a stale open history row', () => {
  const history = [{ start: new Date(START).toISOString(), end: null, ongoing: true, level: 'yellow' }];

  assert.equal(resolveActiveAlert(history, null), null);
  assert.equal(resolveActiveAlert(history, {
    start: new Date(START).toISOString(),
    end: null,
    ongoing: true,
    level: 'red',
  })?.level, 'red');
});

test('yellow and red phases survive the all-clear and attach to the completed alert', () => {
  let records = updateObservedPhaseRecords([], [alert()], {
    liveStateKnown: true,
    liveActiveAlert: alert(),
    nowMs: START + 10 * MINUTE,
  });

  const redAlert = alert({
    id: 'provider-active-id-changed',
    endMs: START + 22 * MINUTE,
    level: 'red',
    threats: [{ type: 'ballistic_missiles', level: 'red' }],
  });
  records = updateObservedPhaseRecords(records, [redAlert], {
    liveStateKnown: true,
    liveActiveAlert: redAlert,
    nowMs: START + 22 * MINUTE,
  });

  records = updateObservedPhaseRecords(records, [], {
    liveStateKnown: true,
    liveActiveAlert: null,
    nowMs: START + 31 * MINUTE,
  });

  const completed = alert({
    id: 'kyiv-digital-history-id',
    endMs: START + 32 * MINUTE,
    ongoing: false,
    level: 'unknown',
    threats: [],
  });
  const [enriched] = applyObservedPhaseRecords([completed], records);

  assert.deepEqual(enriched.phases.map(phase => [phase.level, phase.startMs, phase.endMs]), [
    ['yellow', START, START + 22 * MINUTE],
    ['red', START + 22 * MINUTE, START + 32 * MINUTE],
  ]);
});

test('the provider-ID keyed v1 phase store migrates by alert start time', () => {
  const migrated = normalizeObservedPhaseRecords({
    'temporary-provider-id': [
      { startMs: START, endMs: START + 12 * MINUTE, level: 'yellow', threats: [], sourceMessage: '' },
      { startMs: START + 12 * MINUTE, endMs: null, level: 'red', threats: [], sourceMessage: '' },
    ],
  });

  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].startMs, START);
  assert.deepEqual(migrated[0].phases.map(phase => phase.level), ['yellow', 'red']);
});

test('a refresh cannot erase richer phase history from the browser cache', () => {
  const live = alert({
    id: 'kyiv-digital-history-id',
    endMs: START + 32 * MINUTE,
    ongoing: false,
    level: 'unknown',
    threats: [],
    phases: [],
  });
  const saved = alert({
    ongoing: false,
    endMs: START + 32 * MINUTE,
    phases: [
      { startMs: START, endMs: START + 22 * MINUTE, level: 'yellow', threats: [], sourceMessage: '' },
      { startMs: START + 22 * MINUTE, endMs: START + 32 * MINUTE, level: 'red', threats: [], sourceMessage: '' },
    ],
  });

  const [merged] = mergeSavedClassification([live], [saved]);

  assert.deepEqual(merged.phases.map(phase => phase.level), ['yellow', 'red']);
});
