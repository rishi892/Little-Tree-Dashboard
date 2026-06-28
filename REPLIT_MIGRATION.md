# Replit Migration (Reserved VM) - Checklist

Goal: run the dashboard on Replit **Reserved VM** (always-on) so the auto-refresh
and QB-token keep-alive run even when nobody has the dashboard open. Vercel stays
live as backup until Replit is green.

**No data migration needed.** All data (QB tokens, cache, edits, bot history) lives
in **Supabase**, shared by both hosts. Replit just needs the same Supabase secrets.
The Replit built-in Postgres (`helium/heliumdb`) is NOT used by this app - ignore it.

---

## 1. Code/config (DONE from VS Code)
- `.replit` -> `deploymentTarget = "gce"` (Reserved VM, always-on). Was `cloudrun`
  (Autoscale = sleeps when idle = why it felt imperfect).
- Always-on auto-refresh is already in the code (only runs when `process.env.VERCEL`
  is NOT set): `prewarmSheetCaches` every 90s, `prewarmQbCaches` every 30 min, plus
  startup token preflight. On Reserved VM these run automatically.
- Server already binds `0.0.0.0` on `config.port` (PORT ?? 4747).

## 2. Replit UI - create the deployment (~10 min, YOU)
1. Open the Repl -> **Deployments** -> **Create / Reserved VM**.
   - Pick the smallest tier (0.25 vCPU / 1 GB is enough; can scale up later).
   - Build command: `npm run install:all && npm run build:all`
   - Run command:   `npm start`
2. Connect to GitHub repo `main` branch, enable **auto-deploy on push** (so each
   `git push` redeploys). If no auto-deploy toggle, use the **Redeploy** button.

## 3. Replit Secrets - env vars (YOU)
Copy these from the **Vercel** project (Settings -> Environment Variables) into
Replit **Secrets**:

Copy as-is:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`   (set `SUPABASE_SERVICE_ROLE_KEY` too if Vercel has it)
- `QBO_CLIENT_ID`
- `QBO_CLIENT_SECRET`
- `QBO_ENVIRONMENT`        (= `production`)
- `UPFLOW_API_BASE_URL`
- `UPFLOW_API_KEY`
- `UPFLOW_API_SECRET`
- `CRON_SECRET`            (optional - only guards the manual /api/cron/prewarm)

Change for the new Replit domain (`https://<your-app>.replit.app` or custom domain):
- `QBO_REDIRECT_URI` = `https://<your-replit-domain>/auth/callback`
- `CLIENT_URL`       = `https://<your-replit-domain>`
- `ALLOWED_ORIGINS`  = `https://<your-replit-domain>` (include it if you restrict CORS)

Do NOT set:
- `PORT`   (let it default to 4747; `.replit` maps 4747 -> external 80)
- `VERCEL` (must be ABSENT - its absence is what enables always-on mode)

## 4. QuickBooks app (YOU)
In the Intuit developer dashboard (developer.intuit.com -> your app -> Keys & OAuth):
- Add the new Redirect URI: `https://<your-replit-domain>/auth/callback`
- Keep the Vercel one too during transition (both can coexist).

## 5. Deploy + test (TOGETHER)
After deploy, check on the Replit URL:
- [ ] `/cashflow` loads, QuickBooks shows **connected** (token loaded from Supabase)
- [ ] Cash on hand = **$179,003** (available) on dashboard KPI + 13-week opening + bot
- [ ] 13-Week plan loads fast (warm caches)
- [ ] Bot answers an English question (e.g. "how much cash do we have")
- [ ] Wait/observe: caches refresh on their own (server logs show prewarm cycles)

## 6. Cutover (when Replit is green)
- Point the custom domain at Replit.
- Leave Vercel live a few days as backup, then pause/remove it.

---

### Why Replit Reserved VM (recap)
- Always-on: in-process warmers + token keep-alive actually run (Vercel serverless
  can't run background work; Hobby cron is daily only).
- No cold starts, no 60s function limit, no 504 on heavy recompute.
- Single Node process = app's native design (one process serves both dashboards).
- Covered by the existing $40/user Replit Teams plan (deployment credits).
