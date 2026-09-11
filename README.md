# Kyiv Air-Raid Impact — v8

Responsive, no-framework dashboard for Kyiv City air-raid alerts. The v8 release keeps the v7 data pipeline and fixes live all-clear handling and threat-phase retention.

## What v8 fixes

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
  app-v8.mjs
  alert-reconciliation-v1.mjs
  styles-v7.css
  _headers
  _redirects
netlify/functions/
  legacy-history.mjs
  air-alerts.mjs
tests/
  legacy-history.test.mjs
netlify.toml
.env.example
```

No framework, npm dependency or build command is required.

## Data flow

```text
Browser
  ├─ /api/legacy-history → Netlify Function → Kyiv Digital HTML → compact interval JSON
  └─ /api/air-alerts     → Netlify Function → configured classification provider
```

The browser merges both feeds:

- Kyiv Digital supplies the complete start/end history;
- the configured provider supplies yellow/red threat classification when available;
- history without confirmed classification remains blue-grey;
- all durations and 09:00–18:00 overlaps are calculated from timestamps;
- the interface refreshes classification every minute and history every five minutes.

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

Add:

```text
ALERTS_API_TOKEN = <new token>
ALERTS_PROVIDER = ukraine-alarm-v3
KYIV_REGION_ID = 31
```

Recommended variable scope: **Functions**. Trigger a production deploy after adding or changing environment variables.

Never put a real token in GitHub, a ZIP, `index.html`, client-side JavaScript, `netlify.toml`, `.env.example`, an issue, or chat.

Provider options:

```text
ALERTS_PROVIDER = ukraine-alarm-v3
ALERTS_PROVIDER = alerts-in-ua
ALERTS_PROVIDER = auto
```

Use a token issued by the selected provider. With `auto`, the function tries alerts.in.ua first and Ukraine Alert API v3 second.

## Verification

Run syntax checks and parser tests:

```text
node --check public/app-v8.mjs
node --check public/alert-reconciliation-v1.mjs
node --check netlify/functions/legacy-history.mjs
node --check netlify/functions/air-alerts.mjs
node --test tests/*.test.mjs
```

After deployment, verify:

- `/api/legacy-history` returns `"ok":true` and an `intervals` array;
- `/api/air-alerts` returns `"ok":true` after the token is configured;
- the homepage shows `Live · basic` without classification or `Live · classified` with it.

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
