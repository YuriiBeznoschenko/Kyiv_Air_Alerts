# Kyiv Air-Raid Impact — v9

Responsive dashboard for Kyiv City air-raid alerts. The v9 release records yellow/red threat phases continuously on the server instead of relying on an open browser tab.

## What v9 fixes

- A scheduled Netlify Function polls the classification provider every minute on published production deploys.
- Yellow/red transitions are stored in a site-wide, strongly consistent Netlify Blobs store and survive browser closure, device changes, and deployments.
- Provider timestamps are used for escalations when available; otherwise the transition is bounded by the one-minute collection interval.
- All-clear closes the observed phase immediately, while the exact completed-alert end from Kyiv Digital remains authoritative in the dashboard.
- Concurrent collectors use ETag-guarded writes and retry against the latest stored state instead of overwriting it.
- Deploy previews use isolated Blob stores, while production and its scheduled collector share site-wide history across releases.
- `alerts.in.ua` is preferred when its dedicated token is present because it supplies `alert_level`, threat type, and threat start timestamps.
- A generic token is automatically tried against the alternate supported provider when `ALERTS_PROVIDER` points at the wrong service.
- Completed history is never painted entirely yellow or red from a final-level value without actual phase evidence.
- Browser storage remains only as a migration and temporary fallback layer; the server record is the shared source of truth.

## Previous v8 fixes

- A successful live-status response is authoritative for the current banner. A lagging open row in Kyiv Digital can no longer keep the alert marked active after an all-clear.
- The current-status endpoint no longer permits a five-minute stale response; its shared cache is revalidated every 45 seconds.
- An active-to-inactive transition triggers an immediate uncached history refresh so the exact end time arrives as soon as Kyiv Digital publishes it.
- Yellow/red phase observations use the alert start time instead of a provider-specific alert ID, so they survive the ID change that commonly happens when an active alert becomes historical.
- Observed phases are closed on all-clear and reattached to the completed Kyiv Digital interval.
- Richer classification already saved in the browser is merged into new live data before the cache is updated, so an unclassified history refresh cannot erase it.
- Compatible v6/v7 caches and the earlier phase-history format are migrated automatically.

## What v7 fixes

- The repository now contains normal source files instead of requiring a new ZIP for every edit.
- Netlify publishes only `public/`; old archives in the repository are not exposed by the site.
- `/api/legacy-history` fetches and parses Kyiv Digital on the server and returns compact JSON.
- Netlify durable caching keeps the normalized history for five minutes and may serve stale data while refreshing for up to 24 hours.
- The browser no longer downloads and parses the full Kyiv Digital HTML page every five minutes.
- The manually maintained `FALLBACK_INTERVALS` array is gone.
- The browser keeps the last successful dataset for 48 hours and can migrate the compatible v6 cache.
- If no live or saved data exists, the dashboard says that status is unavailable instead of incorrectly reporting zero alerts.
- `/api/air-alerts` now uses shared Netlify caching instead of a cache-busting timestamp on every request.

## Project structure

```text
public/
  index.html
  app-v9.mjs
  alert-reconciliation-v2.mjs
  styles-v7.css
  _headers
  _redirects
netlify/functions/
  legacy-history.mjs
  air-alerts.mjs
  collect-alert-phases.mjs
  lib/
tests/
  legacy-history.test.mjs
  phase-collector.test.mjs
  reconciliation.test.mjs
package.json
package-lock.json
netlify.toml
.env.example
```

No frontend framework or build command is required. Netlify installs the declared Functions dependency during deployment.

## Data flow

```text
Browser
  ├─ /api/legacy-history → Netlify Function → Kyiv Digital HTML → compact interval JSON
  └─ /api/air-alerts     → persistent phase state → configured classification provider

Scheduled collector (every minute)
  └─ classification provider → ETag-safe update → Netlify Blobs
```

The browser merges both feeds:

- Kyiv Digital supplies the complete start/end history;
- the configured provider supplies yellow/red threat classification when available;
- history without confirmed classification remains blue-grey;
- all durations and 09:00–18:00 overlaps are calculated from timestamps;
- the interface reads shared classification every minute and history every five minutes.

## One-time Netlify setup

### 1. Connect the repository

In Netlify, open the current project and choose:

**Project configuration → Build & deploy → Continuous deployment → Link repository**

Select `YuriiBeznoschenko/Kyiv_Air_Alerts` and the `main` branch. `netlify.toml` already sets:

```text
Publish directory: public
Functions directory: netlify/functions
Build command: none
```

After that, every merge or push to `main` creates a new production deploy automatically. ZIP/Drop deployment is no longer needed.

### 2. Configure classification

The basic Kyiv Digital history works without a secret. Yellow/red classification requires a newly issued provider token.

In Netlify open:

**Project configuration → Environment variables → Add a variable**

For yellow/red classification, use a token issued by `alerts.in.ua`:

```text
ALERTS_IN_UA_TOKEN = <new alerts.in.ua token>
ALERTS_PROVIDER = auto
```

Recommended variable scope: **Functions**. Trigger a production deploy after adding or changing environment variables.

Never put a real token in GitHub, a ZIP, `index.html`, client-side JavaScript, `netlify.toml`, `.env.example`, an issue, or chat.

The older generic variable remains supported and is auto-detected across both providers:

```text
ALERTS_API_TOKEN = <provider token>
```

Optional Ukraine Alert API fallback:

```text
UKRAINE_ALARM_API_TOKEN = <Ukraine Alert API token>
KYIV_REGION_ID = 31
```

The site-wide phase store is provisioned automatically by Netlify Blobs. The `collect-alert-phases` function is scheduled from `netlify.toml` and runs only on the published production deploy.

## Verification

Run syntax checks and parser tests:

```text
npm run check
npm test
```

After deployment, verify:

- `/api/legacy-history` returns `"ok":true` and an `intervals` array;
- `/api/air-alerts` returns `"ok":true` after the token is configured;
- `/api/air-alerts` includes `phaseRecords`, `liveStatusKnown`, and collector health;
- the homepage shows `Live · basic` without classification or `Live · tracked` with server history.

## Preview mode

For a design preview without live credentials, append `?demo=classified`. Demo mode is clearly labelled and must not be used as an operational warning source.

## Timeline rules

- Time zone: `Europe/Kyiv`.
- Geography: Kyiv City, not Kyiv Oblast.
- Daily alert count means alerts that started on that date.
- Intervals crossing midnight are split between calendar days for duration totals.
- `09:00–18:00` means exact overlap with that window.
- Desktop order: oldest to newest, left to right.
- Mobile order: newest to oldest, top to bottom.
- Yellow: drone warning.
- Red: high-level threat.
- Blue-grey: classification unavailable.
