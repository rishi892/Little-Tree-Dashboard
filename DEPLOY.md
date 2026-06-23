# Deploy to Vercel + Supabase

This app is **GitHub + Vercel + Supabase**:

- **Vercel** hosts the **frontend** (static Vite build) **and** the **backend**
  (the whole Express app runs as one serverless function at `api/index.js`;
  every `/api/*` and `/auth/*` request is rewritten to it - see `vercel.json`).
- **Supabase** (Postgres) is the **database**: the backend stores its JSON blobs
  (QuickBooks tokens, snapshots, overrides, bot history, reviews) in a `kv_store`
  table instead of local files, because a serverless filesystem is read-only.
- **Secrets** live in **Vercel Environment Variables** (not in the repo).

---

## 1. Supabase (Rishi's account)

1. Create a project at https://supabase.com (note the region).
2. **SQL Editor → New query →** paste `supabase/schema.sql` → **Run**.
3. **Project Settings → API**, copy two values:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret key → `SUPABASE_SERVICE_KEY`  ⚠️ server-only, never in the browser.

## 2. Vercel (import the repo)

1. https://vercel.com → **Add New → Project → Import** `rishi892/Little-Tree-Dashboard`.
2. Vercel auto-detects `vercel.json` (build/install commands, the function, rewrites). Leave defaults.
3. Add the Environment Variables below, then **Deploy**.

## 3. Vercel Environment Variables

| Variable | Value |
|---|---|
| `SUPABASE_URL` | from Supabase step 1 |
| `SUPABASE_SERVICE_KEY` | service_role key from Supabase |
| `QBO_CLIENT_ID` | from Intuit Developer app |
| `QBO_CLIENT_SECRET` | from Intuit Developer app |
| `QBO_ENVIRONMENT` | `production` |
| `QBO_REDIRECT_URI` | `https://<your-vercel-domain>/auth/callback` |
| `CLIENT_URL` | `https://<your-vercel-domain>` |
| `UPFLOW_API_KEY` | from Upflow |
| `UPFLOW_API_SECRET` | from Upflow |
| `UPFLOW_API_BASE_URL` | from Upflow |

(`PORT` is not needed on Vercel. `VERCEL` is set automatically.)

## 4. QuickBooks redirect URI

Once you know the Vercel domain (e.g. `little-tree-dashboard.vercel.app`):

1. Set `QBO_REDIRECT_URI` = `https://<domain>/auth/callback` and `CLIENT_URL` =
   `https://<domain>` in Vercel env, **redeploy**.
2. In https://developer.intuit.com → your app → **Keys & OAuth → Redirect URIs**,
   add the exact same `https://<domain>/auth/callback`.
3. Connect: open `https://<domain>/auth/connect`.

A Vercel domain is **stable**, so unlike the dev tunnel you only register the
redirect URI once.

---

## Notes / caveats

- **Function timeout.** `vercel.json` sets `maxDuration: 60` (needs the **Pro**
  plan). The heavy dashboard endpoints do live QuickBooks + Google-Sheet pulls
  that can take 10-30s cold; on the **Hobby** plan (10s hard limit) those will
  time out until warmed by Supabase-cached results. Pro is recommended.
- **Review screenshots** (AR review uploads) are not persisted on serverless
  (read-only disk) - the review text is saved, the image is skipped. Move to
  Supabase Storage later if needed.
- **Local dev is unchanged.** With no `SUPABASE_URL` set, the backend reads/writes
  the same local JSON files as before (`npm run dev`).
