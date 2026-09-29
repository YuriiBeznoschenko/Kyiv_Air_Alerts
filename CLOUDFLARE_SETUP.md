# Cloudflare setup

Cloudflare must deploy this project as a Worker script with static assets. The entry point is `public/_worker.js`; `wrangler.jsonc` at the repository root points to it.

## 1. Make Workers Builds deploy the Worker script

In **Workers & Pages → kyiv-air-alerts → Settings → Build**, check:

- **Root directory** is the repository root (blank or `/`), where `wrangler.jsonc` lives.
- **Deploy command** is `npx wrangler deploy`.

Save the settings and trigger/retry a deployment from the production branch. In the deployment logs, confirm Wrangler deploys a Worker script as well as assets. If the Bindings page says the Worker has only static assets, stop here: the build is still ignoring the root Wrangler config.

## 2. Create and bind D1

1. Create a D1 database in **Storage & databases → D1 SQL Database**.
2. Once the Worker script is deployed, open **Workers & Pages → kyiv-air-alerts → Settings → Bindings → Add binding → D1 database**.
3. Name the binding `DB` and select the database.
4. In the database's **Console**, run `migrations/0001_create_phase_state.sql`.

## 3. Add the provider token

In **Workers & Pages → kyiv-air-alerts → Settings → Variables and Secrets**, add a **Secret** named `ALERTS_IN_UA_TOKEN`, paste the alerts.in.ua API token, and save. Redeploy after adding it.

## 4. Verify

Open `/api/air-alerts` and `/api/legacy-history` on the deployed site. The first route should return alert data and persistent phase history; the second should return Kyiv Digital history.

The scheduled collector runs once per minute on Cloudflare. Netlify is no longer part of the live API path.
