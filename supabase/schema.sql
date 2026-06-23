-- Little Tree Dashboard - Supabase schema (proper relational tables).
-- Run in the Supabase project: SQL Editor -> New query -> paste -> Run.
--
-- Every piece of dashboard state has its OWN table with real columns (no JSON
-- blob store). The backend connects with the service_role key, which bypasses
-- Row Level Security, so leaving RLS on with no policies = server-only access.
-- NEVER expose the service_role key to the browser.

-- ---------------------------------------------------------------------------
-- AUTH / AUDIT
-- ---------------------------------------------------------------------------

-- Login users. Passwords are salted-scrypt hashed (scrypt$salt$hash) and
-- verified server-side via POST /api/login - never shipped to the browser.
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

-- Login audit (every attempt, success or fail).
create table if not exists login_events (
  id        bigint generated always as identity primary key,
  email     text,
  dashboard text,
  success   boolean,
  at        timestamptz default now()
);
alter table login_events enable row level security;

-- ---------------------------------------------------------------------------
-- QUICKBOOKS OAUTH
-- ---------------------------------------------------------------------------

-- App-level OAuth config (single row, id=1): client id/secret, redirect uri,
-- environment. Stored here so the WHOLE QB connection lives in the DB and never
-- depends on a fragile env var. Code falls back to env vars per-field if empty.
create table if not exists qb_config (
  id            integer primary key default 1,
  client_id     text not null,
  client_secret text not null,
  redirect_uri  text not null,
  environment   text not null default 'production',  -- production | sandbox
  updated_at    timestamptz default now()
);
alter table qb_config enable row level security;

-- Per-connection tokens: access + refresh in real columns so the connection
-- survives restarts/redeploys and never silently drops.
create table if not exists qb_tokens (
  realm_id      text primary key,
  access_token  text not null,
  refresh_token text not null,
  expires_at    bigint not null,           -- epoch ms
  updated_at    timestamptz default now()
);
alter table qb_tokens enable row level security;

-- ---------------------------------------------------------------------------
-- REVIEWS / AUDIT TRAIL (AR dashboard) - who raised it, who resolved it, who
-- audited it. Status flow: Under process -> Resolved (by X) -> Audited (by Y).
-- ---------------------------------------------------------------------------
create table if not exists reviews (
  id          text primary key,
  at          timestamptz default now(),
  kind        text default 'review',       -- review | audit
  verdict     text default '',             -- audits: correct | issue
  user_email  text default '',
  role        text default '',
  page        text default '',
  section     text default '',
  tab         text default '',
  subtab      text default '',
  comment     text default '',
  screenshot  text default '',             -- '' or /api/review-uploads/<file>
  status      text default 'Under process',-- Under process | Resolved | Audited
  resolved_by text default '',
  resolved_at text default '',
  note        text default '',
  audited_by  text default '',
  audited_at  text default '',
  audit_note  text default ''
);
alter table reviews enable row level security;

-- ---------------------------------------------------------------------------
-- BOT - conversation log, metric history (for "what changed"), and the
-- learning/training surface.
-- ---------------------------------------------------------------------------
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

create table if not exists bot_metric_history (
  id                   bigint generated always as identity primary key,
  at                   timestamptz default now(),
  bank_cash            numeric,
  opening_cash         numeric,            -- total cash on hand (bank + Due From PureX)
  cc_debt              numeric,
  net_cash             numeric,
  gelato_net           numeric,            -- still to collect
  gelato_received      numeric,
  lt_ar_projected      numeric,
  inflow_13w           numeric,
  outflow_13w          numeric,
  closing_wk13         numeric,
  min_closing          numeric,
  runway_negative_week integer,
  qb_down              boolean default false
);
create index if not exists bot_metric_history_at_idx on bot_metric_history (at);
alter table bot_metric_history enable row level security;

-- ---------------------------------------------------------------------------
-- CASHFLOW STATE
-- ---------------------------------------------------------------------------

-- Weekly forecast snapshots (one row per Monday) - historical artifacts.
create table if not exists weekly_snapshots (
  monday                  text primary key,
  captured_at             timestamptz default now(),
  opening_cash            numeric,
  total_inflow_wk1        numeric,
  total_outflow_wk1       numeric,
  net_change_wk1          numeric,
  closing_cash_wk1        numeric,
  ar_projection_13w_total numeric,
  sales_forecast_wk1      numeric,
  sales_forecast_13w_total numeric,
  inflows                 jsonb default '[]'::jsonb,
  outflows                jsonb default '[]'::jsonb
);
alter table weekly_snapshots enable row level security;

-- Manual cashflow overrides (single row, id=1): mode + per-week CC utilisation.
create table if not exists cashflow_overrides (
  id                      integer primary key default 1,
  mode                    text default 'manual',   -- manual | auto
  cc_utilisation_by_week  jsonb default '{}'::jsonb
);
alter table cashflow_overrides enable row level security;

-- QB account -> (Paid-By entity, mapped line-item) overrides.
create table if not exists category_overrides (
  account   text primary key,
  paid_by   text,                          -- PureX | Moysh | Combined | Other
  line_item text
);
alter table category_overrides enable row level security;

-- Per-invoice commission overrides (type and/or rep).
create table if not exists commission_overrides (
  invoice_number text primary key,
  type           text,                     -- NEW | OLD | WHITELABEL
  rep            text default ''
);
alter table commission_overrides enable row level security;

-- Brand -> AR contact email registry.
create table if not exists brand_emails (
  brand text primary key,
  email text not null
);
alter table brand_emails enable row level security;

-- Collections-agency handoffs (old invoices sent to an agency).
create table if not exists agency_handoffs (
  inv_no       text primary key,
  vendor       text default '',
  amount       numeric default 0,
  days_overdue integer,
  agency       text default '',
  note         text default '',
  handed_by    text default '',
  handed_at    timestamptz default now()
);
alter table agency_handoffs enable row level security;

-- ---------------------------------------------------------------------------
-- SCRAPE CACHE - parsed PureX invoice payloads (one blob row per source).
-- ---------------------------------------------------------------------------
create table if not exists scrape_cache (
  source     text primary key,
  data       jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table scrape_cache enable row level security;

-- (No policies = no anon/public access. Only the service_role key, used
--  server-side from Vercel, can read/write. After creating app_users, seed it
--  with hashed passwords - the backend exposes hashPassword() in src/auth.ts.)
