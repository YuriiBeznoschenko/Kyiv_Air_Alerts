const SOURCE_URL = 'https://kyiv.digital/storage/air-alert/stats.html';
const MEMORY_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const CDN_TTL_SECONDS = 5 * 60;
const CDN_STALE_SECONDS = 24 * 60 * 60;

let memoryCache = { expiresAt: 0, payload: null };

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const force = new URL(request.url).searchParams.get('force') === '1';
  if (!force && memoryCache.payload && Date.now() < memoryCache.expiresAt) {
    return json({ ...memoryCache.payload, cache: 'memory' }, 200, true);
  }

  try {
    const html = await fetchSource();
    const parsed = parseKyivDigitalHistory(html);
    if (!parsed.intervals.length) throw new Error('No Kyiv alert intervals were parsed');

    const payload = {
      ok: true,
      provider: 'Kyiv Digital',
      providerUrl: SOURCE_URL,
      generatedAt: new Date().toISOString(),
      cache: 'origin',
      ...parsed,
    };

    memoryCache = {
      expiresAt: Date.now() + MEMORY_TTL_MS,
      payload,
    };
    return json(payload, 200, !force);
  } catch (error) {
    if (memoryCache.payload) {
      return json({
        ...memoryCache.payload,
        cache: 'memory-stale',
        warning: safeError(error),
      }, 200, !force);
    }

    return json({
      ok: false,
      error: 'Kyiv Digital history is temporarily unavailable',
      details: safeError(error),
      generatedAt: new Date().toISOString(),
    }, 502);
  }
}

export const config = { path: '/api/legacy-history' };

async function fetchSource() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(SOURCE_URL, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Kyiv-Air-Raid-Impact/7.0 (+https://kyiv-air-alerts.netlify.app/)',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Kyiv Digital HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function parseKyivDigitalHistory(html) {
  const events = [];
  const rows = String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu);

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)]
      .map(match => htmlToText(match[1]));
    if (cells.length < 2) continue;

    const ms = parseKyivWallTime(cells[0]);
    if (!Number.isFinite(ms)) continue;

    const message = cells[1];
    const type = /Повітряна\s+тривога/u.test(message)
      ? 'start'
      : /Відбій\s+тривоги/u.test(message)
        ? 'end'
        : null;
    if (type) events.push({ ms, type });
  }

  const uniqueEvents = [...new Map(
    events.map(event => [`${event.ms}|${event.type}`, event]),
  ).values()].sort((a, b) => a.ms - b.ms);

  const intervals = [];
  let open = null;
  for (const event of uniqueEvents) {
    if (event.type === 'start') {
      open = event;
    } else if (open && event.ms >= open.ms) {
      if (event.ms > open.ms) intervals.push([open.ms, event.ms]);
      open = null;
    }
  }
  if (open) intervals.push([open.ms, null]);

  return {
    intervals,
    eventCount: uniqueEvents.length,
    alertCount: intervals.length,
    firstEventAt: uniqueEvents.length ? new Date(uniqueEvents[0].ms).toISOString() : null,
    lastEventAt: uniqueEvents.length ? new Date(uniqueEvents.at(-1).ms).toISOString() : null,
    active: Boolean(open),
  };
}

function parseKyivWallTime(value) {
  const match = String(value || '').match(/(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{2})/);
  if (!match) return NaN;
  return Date.UTC(
    2000 + Number(match[5]),
    Number(match[4]) - 1,
    Number(match[3]),
    Number(match[1]),
    Number(match[2]),
  );
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status = 200, cacheable = false) {
  const headers = {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheable ? 'public, max-age=30, must-revalidate' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (cacheable) {
    headers['Netlify-CDN-Cache-Control'] = `public, durable, s-maxage=${CDN_TTL_SECONDS}, stale-while-revalidate=${CDN_STALE_SECONDS}`;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function safeError(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 240);
}
