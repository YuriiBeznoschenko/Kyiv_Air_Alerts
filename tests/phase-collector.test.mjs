import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProviderCandidates,
  fetchConfiguredProvider,
  isDeployScopedRequest,
  normalizeAlert,
} from '../netlify/functions/air-alerts.mjs';
import { createBlobStoreAdapter } from '../netlify/functions/lib/blob-phase-store.mjs';
import {
  advanceCollectorState,
  buildCollectorPayload,
  normalizeCollectorState,
} from '../netlify/functions/lib/phase-collector-v1.mjs';

const MINUTE = 60 * 1000;
const START = Date.parse('2026-09-11T08:00:00.000Z');

function snapshot(active, alerts = []) {
  return {
    provider: 'alerts.in.ua',
    providerUrl: 'https://alerts.in.ua/',
    region: { id: '31', name: 'Kyiv City' },
    classificationAvailable: Boolean(active?.level && active.level !== 'unknown'),
    alerts,
    active,
    warnings: [],
  };
}

function activeAlert(level, threats) {
  return {
    id: `provider-${level}`,
    start: new Date(START).toISOString(),
    end: null,
    ongoing: true,
    level,
    threats,
    phases: [],
    sourceMessage: '',
  };
}

test('server state retains exact yellow/red transitions through all-clear and restart', () => {
  const yellow = activeAlert('yellow', [{
    type: 'drones',
    level: 'yellow',
    startedAt: new Date(START).toISOString(),
    sourceMessage: 'Drone warning',
  }]);
  let state = advanceCollectorState(null, snapshot(yellow, [yellow]), {
    nowMs: START + 3 * MINUTE,
    providerKey: 'alerts-in-ua',
  });

  const red = activeAlert('red', [
    ...yellow.threats,
    {
      type: 'ballistic_missiles',
      level: 'red',
      startedAt: new Date(START + 7 * MINUTE).toISOString(),
      sourceMessage: 'Ballistic threat',
    },
  ]);
  state = advanceCollectorState(state, snapshot(red, [red]), {
    nowMs: START + 9 * MINUTE,
    providerKey: 'alerts-in-ua',
  });

  const completed = { ...red, end: new Date(START + 14 * MINUTE).toISOString(), ongoing: false, level: 'unknown', threats: [] };
  state = advanceCollectorState(JSON.parse(JSON.stringify(state)), snapshot(null, [completed]), {
    nowMs: START + 14 * MINUTE,
    providerKey: 'alerts-in-ua',
  });

  assert.deepEqual(state.records[0].phases.map(phase => [phase.level, phase.startMs, phase.endMs]), [
    ['yellow', START, START + 7 * MINUTE],
    ['red', START + 7 * MINUTE, START + 14 * MINUTE],
  ]);
  assert.equal(state.records[0].provisionalEnd, true);

  const payload = buildCollectorPayload(state, { nowMs: START + 14 * MINUTE });
  assert.equal(payload.liveStatusKnown, true);
  assert.equal(payload.classificationAvailable, true);
  assert.equal(payload.active, null);
  assert.deepEqual(payload.phaseRecords[0].phases.map(phase => phase.level), ['yellow', 'red']);
});

test('an older concurrent observation cannot regress persisted state', () => {
  const active = activeAlert('yellow', [{
    type: 'drones', level: 'yellow', startedAt: new Date(START).toISOString(), sourceMessage: '',
  }]);
  const latest = advanceCollectorState(null, snapshot(active, [active]), {
    nowMs: START + 10 * MINUTE,
    providerKey: 'alerts-in-ua',
  });
  const result = advanceCollectorState(latest, snapshot(null, []), {
    nowMs: START + 9 * MINUTE,
    providerKey: 'alerts-in-ua',
  });

  assert.equal(result.lastSuccessAtMs, START + 10 * MINUTE);
  assert.equal(result.snapshot.active.id, active.id);
});

test('a quick restart creates a new record and closes the previous incident', () => {
  const first = activeAlert('yellow', [{
    type: 'drones', level: 'yellow', startedAt: new Date(START).toISOString(), sourceMessage: '',
  }]);
  let state = advanceCollectorState(null, snapshot(first, [first]), {
    nowMs: START + MINUTE,
    providerKey: 'alerts-in-ua',
  });
  state = advanceCollectorState(state, snapshot(null, []), {
    nowMs: START + 2 * MINUTE,
    providerKey: 'alerts-in-ua',
  });
  const restartedAt = START + 4 * MINUTE;
  const second = {
    ...activeAlert('red', [{
      type: 'missile', level: 'red', startedAt: new Date(restartedAt).toISOString(), sourceMessage: '',
    }]),
    id: 'provider-restarted',
    start: new Date(restartedAt).toISOString(),
  };
  state = advanceCollectorState(state, snapshot(second, [second]), {
    nowMs: START + 5 * MINUTE,
    providerKey: 'alerts-in-ua',
  });

  assert.equal(state.records.length, 2);
  assert.equal(state.records[0].phases.at(-1).endMs, START + 2 * MINUTE);
  assert.equal(state.records[1].startMs, restartedAt);
});

test('a red-to-yellow downgrade starts at the server observation time', () => {
  const yellowThreat = {
    type: 'drones', level: 'yellow', startedAt: new Date(START).toISOString(), sourceMessage: '',
  };
  const redThreat = {
    type: 'ballistic_missiles', level: 'red', startedAt: new Date(START + 4 * MINUTE).toISOString(), sourceMessage: '',
  };
  const red = activeAlert('red', [yellowThreat, redThreat]);
  let state = advanceCollectorState(null, snapshot(red, [red]), {
    nowMs: START + 6 * MINUTE,
    providerKey: 'alerts-in-ua',
  });
  const yellow = activeAlert('yellow', [yellowThreat]);
  state = advanceCollectorState(state, snapshot(yellow, [yellow]), {
    nowMs: START + 11 * MINUTE,
    providerKey: 'alerts-in-ua',
  });

  assert.deepEqual(state.records[0].phases.map(phase => [phase.level, phase.startMs, phase.endMs]), [
    ['yellow', START, START + 4 * MINUTE],
    ['red', START + 4 * MINUTE, START + 11 * MINUTE],
    ['yellow', START + 11 * MINUTE, null],
  ]);
});

test('blob adapter retries a conditional-write conflict against the newest value', async () => {
  let data = { count: 1 };
  let etag = 'v1';
  let writes = 0;
  const blob = {
    async getWithMetadata() { return { data, etag, metadata: {} }; },
    async setJSON(_key, next, options) {
      writes += 1;
      if (writes === 1) {
        data = { count: 4 };
        etag = 'v2';
        return { modified: false };
      }
      assert.equal(options.onlyIfMatch, 'v2');
      data = next;
      etag = 'v3';
      return { modified: true, etag };
    },
  };

  const store = createBlobStoreAdapter(blob);
  const result = await store.update(current => ({ count: current.count + 1 }));
  assert.deepEqual(result, { count: 5 });
  assert.equal(writes, 2);
});

test('a generic token falls back from a mismatched configured provider to alerts.in.ua', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    if (String(url).includes('api.ukrainealarm.com')) {
      return new Response('{"message":"unauthorized"}', { status: 401 });
    }
    return Response.json({ alerts: [{
      id: 42,
      location_title: 'м. Київ',
      location_uid: '31',
      alert_type: 'air_raid',
      started_at: new Date(START).toISOString(),
      finished_at: null,
      alert_level: 'yellow',
      threats: [{
        threat_type: 'drones',
        level: 'yellow',
        started_at: new Date(START).toISOString(),
      }],
    }] });
  };

  const result = await fetchConfiguredProvider({
    env: {
      ALERTS_API_TOKEN: 'generic-token',
      ALERTS_PROVIDER: 'ukraine-alarm-v3',
      KYIV_REGION_ID: '31',
    },
    fetchImpl,
  });

  assert.equal(result.providerKey, 'alerts-in-ua');
  assert.equal(result.payload.active.level, 'yellow');
  assert.ok(result.failures[0].startsWith('ukraine-alarm-v3: HTTP 401'));
  assert.ok(calls.some(call => call.authorization === 'Bearer generic-token'));
});

test('an all-clear active response is a successful authoritative snapshot', async () => {
  const result = await fetchConfiguredProvider({
    env: { ALERTS_IN_UA_TOKEN: 'alerts-token', ALERTS_PROVIDER: 'alerts-in-ua' },
    fetchImpl: async () => Response.json({ alerts: [] }),
  });

  assert.equal(result.payload.active, null);
  assert.deepEqual(result.payload.alerts, []);
  assert.equal(result.payload.classificationAvailable, true);
});

test('completed provider history is not painted one colour without phase evidence', () => {
  const alert = normalizeAlert({
    id: 9,
    location_title: 'м. Київ',
    location_uid: '31',
    alert_type: 'air_raid',
    started_at: new Date(START).toISOString(),
    finished_at: new Date(START + 30 * MINUTE).toISOString(),
    alert_level: 'red',
  });

  assert.equal(alert.level, 'unknown');
  assert.deepEqual(alert.phases, []);
});

test('first observation mid-alert does not invent a colour for earlier time', () => {
  const active = activeAlert('red', []);
  const observedAt = START + 12 * MINUTE;
  const state = advanceCollectorState(null, snapshot(active, [active]), {
    nowMs: observedAt,
    providerKey: 'alerts-in-ua',
  });

  assert.deepEqual(state.records[0].phases.map(phase => [phase.level, phase.startMs, phase.endMs]), [
    ['unknown', START, observedAt],
    ['red', observedAt, null],
  ]);
});

test('provider candidates prefer the classification token without exposing tokens', () => {
  const candidates = buildProviderCandidates({
    ALERTS_IN_UA_TOKEN: 'a',
    UKRAINE_ALARM_API_TOKEN: 'b',
    ALERTS_PROVIDER: 'auto',
  }, 'ukraine-alarm-v3');
  assert.deepEqual(candidates.map(item => item.provider), ['alerts-in-ua', 'ukraine-alarm-v3']);
  assert.deepEqual(normalizeCollectorState({ providerKey: 'alerts-in-ua' }).providerKey, 'alerts-in-ua');
});

test('deploy previews are isolated while the production hostname is site-wide', () => {
  const env = { SITE_NAME: 'kyiv-colored-alerts' };
  assert.equal(isDeployScopedRequest(
    new Request('https://deploy-preview-3--kyiv-colored-alerts.netlify.app/api/air-alerts'),
    env,
  ), true);
  assert.equal(isDeployScopedRequest(
    new Request('https://feature-x--kyiv-colored-alerts.netlify.app/api/air-alerts'),
    env,
  ), true);
  assert.equal(isDeployScopedRequest(
    new Request('https://kyiv-colored-alerts.netlify.app/api/air-alerts'),
    env,
  ), false);
  assert.equal(isDeployScopedRequest(
    new Request('https://alerts.example.com/api/air-alerts'),
    env,
  ), false);
});
