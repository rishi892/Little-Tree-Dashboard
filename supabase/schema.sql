-- Little Tree Dashboard - Supabase schema.
-- Run this once in the Supabase project (SQL Editor → New query → Run).
--
-- The backend stores all its small JSON blobs (QuickBooks OAuth tokens, weekly
-- snapshots, overrides, bot change-history, reviews, etc.) in this single
-- key-value table, keyed by the original filename. The server uses the
-- service_role key, which bypasses Row Level Security, so RLS being on is fine.

create table if not exists kv_store (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

alter table kv_store enable row level security;

-- (No policies = no anon/public access. Only the service_role key, used
--  server-side from Vercel, can read/write. Never expose the service key to the
--  browser.)
