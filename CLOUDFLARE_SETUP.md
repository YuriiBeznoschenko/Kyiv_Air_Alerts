# Cloudflare setup

The Cloudflare Pages project now runs the two API routes through `public/_worker.js`; all other requests fall through to the site's static assets.

## 1. Create and bind D1

1. In Cloudflare, open **Storage & databases → D1 SQL Database** and create a database.
2. Open the Pages project **kyiv-air-alerts → Settings → Functions → D1 database bindings**.
3. Add a binding named `DB` and select the database.
4. Open that database's SQL console and run the contents of `migrations/0001_create_phase_state.sql`.

The binding name must be exactly `DB`.

## 2. Add the provider token

In the Pages project, open **Settings → Variables and Secrets**, add a **Secret** named `ALERTS_IN_UA_TOKEN`, paste the alerts.in.ua API token, and save. Redeploy after adding it.

## 3. Verify

After the deployment succeeds, open `/api/air-alerts` and `/api/legacy-history` on the site. The first route should return alert data with a persistent phase history; the second should return Kyiv Digital history.

The live collector runs when `/api/air-alerts` is requested, at most once per 45 seconds. It does not need a Netlify scheduled function.
