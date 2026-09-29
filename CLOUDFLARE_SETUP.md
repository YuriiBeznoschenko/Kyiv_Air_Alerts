# Cloudflare setup

Cloudflare now serves the static site and runs both API routes through the Worker in `public/_worker.js`. The Worker config also schedules alert collection once per minute.

## 1. Create and bind D1

1. In Cloudflare, open **Storage & databases → D1 SQL Database** and create a database.
2. Open **Workers & Pages → kyiv-air-alerts → Settings → Bindings** and add a D1 database binding named `DB`.
3. Select the database, save, and open its SQL console.
4. Run the contents of `migrations/0001_create_phase_state.sql`.

The binding name must be exactly `DB`.

## 2. Add the provider token

In **Workers & Pages → kyiv-air-alerts → Settings → Variables and Secrets**, add a **Secret** named `ALERTS_IN_UA_TOKEN`, paste the alerts.in.ua API token, and save. Redeploy after adding it.

## 3. Verify

After deployment succeeds, open `/api/air-alerts` and `/api/legacy-history` on the site. The first route should return alert data and persistent phase history; the second should return Kyiv Digital history.

The scheduled collector runs once per minute on Cloudflare. Netlify is no longer part of the live API path.
