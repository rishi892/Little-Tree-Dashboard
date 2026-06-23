-- Little Tree Dashboard - Supabase schema.
-- Run this once in the Supabase project (SQL Editor → New query → Run).
--
-- The backend stores all its small JSON blobs (QuickBooks OAuth tokens, weekly
-- snapshots, overrides, bot change-history, reviews, etc.) in this single
-- key-value table, keyed by the original filename. The server uses the
-- service_role key, which bypasses Row Level Security, so RLS being on is fine.

-- 1) Blob store: QuickBooks tokens, snapshots, overrides, bot metric history.
create table if not exists kv_store (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);
alter table kv_store enable row level security;

-- 2) Login users. Passwords are salted-scrypt hashed (scrypt$salt$hash) and
--    verified server-side via POST /api/login - never shipped to the browser.
create table if not exists app_users (
  id              bigint generated always as identity primary key,
  email           text unique not null,
  password_hash   text not null,
  name            text not null,
  title           text default '',
  photo           text default '',
  ar_role         text default 'none',     -- full | gelato-only | little-tree-only | none
  cashflow_access boolean default false,
  rep             text default '',
  active          boolean default true,
  created_at      timestamptz default now()
);
alter table app_users enable row level security;

-- 3) Login audit (every attempt, success or fail).
create table if not exists login_events (
  id        bigint generated always as identity primary key,
  email     text,
  dashboard text,
  success   boolean,
  at        timestamptz default now()
);
alter table login_events enable row level security;

-- 4) Bot conversation log - every question + intent + answer, so the assistant
--    has a real history to analyse / learn from.
create table if not exists bot_conversations (
  id           bigint generated always as identity primary key,
  user_name    text default '',
  question     text,
  intent       text,
  answer_title text,
  confidence   real,
  at           timestamptz default now()
);
alter table bot_conversations enable row level security;

-- (No policies = no anon/public access. Only the service_role key, used
--  server-side from Vercel, can read/write. Never expose the service key to the
--  browser. After creating app_users, seed it with hashed passwords - the
--  backend exposes hashPassword() in src/auth.ts.)
