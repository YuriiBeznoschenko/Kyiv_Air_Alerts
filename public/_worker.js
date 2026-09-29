import { buildProviderCandidates, fetchConfiguredProvider } from './_worker/provider.mjs';
import {
  advanceCollectorState,
  buildCollectorPayload,
  normalizeCollectorState,
  recordCollectorFailure,
} from './_worker/phase-collector.mjs';
import { createD1PhaseStateStore } from './_worker/d1-phase-store.mjs';
import legacyHistory from './_worker/legacy-history.mjs';

const CACHE_TTL_MS = 45_000;
const COLLECTION_INTERVAL_MS = 45_000;
let memoryCache = { expiresAt: 0, payload: null };

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/air-alerts') return handleAirAlerts(request, env);
    if (path === '/api/legacy-history') return legacyHistory(request);
    return env.ASSETS.fetch(request);
  },
};

async function handleAirAlerts(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);

  const force = new URL(request.url).searchParams.get('force') === '1';
  if (!force && memoryCache.payload && Date.now() < memoryCache.expiresAt) {
    return json({ ...memoryCache.payload, cache: 'memory' }, 200, true);
  }

  if (!buildProviderCandidates(env).length) {
    return json({
      ok: false,
      configured: false,
      error: 'Missing alert-provider token environment variable',
      generatedAt: new Date().toISOString(),
    }, 503);
  }
  if (!env.DB) {
    return json({
      ok: false,
      configured: true,
      error: 'Cloudflare D1 binding DB is missing',
      generatedAt: new Date().toISOString(),
    }, 503);
  }

  const store = createD1PhaseStateStore(env.DB);
  const nowMs = Date.now();
  let stored;
  try {
    stored = await store.read();
  } catch (error) {
    return json({
      ok: false, configured: true,
      error: 'Persistent phase history is unavailable',
      details: [safeError(error)],
      generatedAt: new Date(nowMs).toISOString(),
    }, 503);
  }

  const state = normalizeCollectorState(stored.data);
  const shouldCollect = force || !Number.isFinite(state.lastAttemptAtMs)
    || nowMs - state.lastAttemptAtMs >= COLLECTION_INTERVAL_MS;
  let result;
  try {
    result = shouldCollect
      ? await collectAndPersist({ store, env })
      : { success: true, state };
  } catch (error) {
    return json({
      ok: false, configured: true,
      error: 'Persistent phase collection failed',
      details: [safeError(error)],
      generatedAt: new Date(nowMs).toISOString(),
    }, 503);
  }

  const responseNowMs = Date.now();
  const response = buildCollectorPayload(result.state, { nowMs: responseNowMs });
  if (!response.ok) {
    return json({
      ...response,
      error: 'All configured alert providers failed',
      details: result.failures || (result.error ? [safeError(result.error)] : []),
    }, 502);
  }
  memoryCache = { expiresAt: responseNowMs + CACHE_TTL_MS, payload: response };
  return json(response, 200, !force);
}

async function collectAndPersist({ store, env, nowMs }) {
  const current = normalizeCollectorState((await store.read()).data);
  try {
    const result = await fetchConfiguredProvider({
      env,
      fetchImpl: fetch,
      preferredProvider: current.providerKey,
    });
    const snapshot = {
      ...result.payload,
      warnings: [
        ...(result.payload.warnings || []),
        ...result.failures.map(failure => `Provider fallback: ${failure}`),
      ],
    };
    const observedAtMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const state = await store.update(previous => advanceCollectorState(previous, snapshot, {
      nowMs: observedAtMs,
      providerKey: result.providerKey,
    }));
    return { success: true, state, failures: result.failures };
  } catch (error) {
    const failedAtMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const state = await store.update(previous => recordCollectorFailure(previous, error, { nowMs: failedAtMs }));
    return { success: false, state, error, failures: error.failures || [] };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function safeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/Bearer\\s+\\S+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}

function json(body, status = 200, cacheable = false) {
  const headers = {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheable ? 'public, max-age=5, must-revalidate' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(JSON.stringify(body), { status, headers });
}
