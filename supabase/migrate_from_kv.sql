-- One-time migration: copy data out of the old kv_store JSON blobs into the
-- proper relational tables. Idempotent (ON CONFLICT / NOT EXISTS guards) so it
-- can be re-run safely. After verifying, kv_store is dropped separately.

-- 1) QuickBooks tokens (critical - keeps QB connected across the cutover).
insert into qb_tokens (realm_id, access_token, refresh_token, expires_at, updated_at)
select value->>'realmId', value->>'accessToken', value->>'refreshToken', (value->>'expiresAt')::bigint, now()
from kv_store
where key = '.tokens.json' and value->>'realmId' is not null
on conflict (realm_id) do update
  set access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = now();

-- 2) Cashflow overrides (single row). Old data stored ccUtilisationByWeek as an
--    all-zero array (= no manual overrides) -> store {} unless it's a real map.
insert into cashflow_overrides (id, mode, cc_utilisation_by_week)
select 1,
       coalesce(value->>'mode', 'manual'),
       case when jsonb_typeof(value->'ccUtilisationByWeek') = 'object'
            then value->'ccUtilisationByWeek' else '{}'::jsonb end
from kv_store
where key = '.cashflow-overrides.json'
on conflict (id) do update
  set mode = excluded.mode, cc_utilisation_by_week = excluded.cc_utilisation_by_week;

-- 3) Category overrides (account -> {paidBy, lineItem}).
insert into category_overrides (account, paid_by, line_item)
select e.key, e.value->>'paidBy', e.value->>'lineItem'
from kv_store, jsonb_each(kv_store.value) e
where kv_store.key = '.category-overrides.json'
on conflict (account) do nothing;

-- 4) Commission overrides (invoice -> {type, rep}).
insert into commission_overrides (invoice_number, type, rep)
select e.key, e.value->>'type', coalesce(e.value->>'rep', '')
from kv_store, jsonb_each(kv_store.value->'overrides') e
where kv_store.key = '.commission-overrides.json'
on conflict (invoice_number) do nothing;

-- 5) Brand emails (brand -> email string).
insert into brand_emails (brand, email)
select e.key, e.value #>> '{}'
from kv_store, jsonb_each(kv_store.value) e
where kv_store.key = '.brand-emails.json'
  and coalesce(e.value #>> '{}', '') <> ''
on conflict (brand) do nothing;

-- 6) Weekly snapshots (monday -> snapshot object).
insert into weekly_snapshots (monday, captured_at, opening_cash, total_inflow_wk1,
       total_outflow_wk1, net_change_wk1, closing_cash_wk1, ar_projection_13w_total,
       sales_forecast_wk1, sales_forecast_13w_total, inflows, outflows)
select s.key,
       coalesce((s.value->>'capturedAt')::timestamptz, now()),
       (s.value->>'openingCash')::numeric,
       (s.value->>'totalInflowWk1')::numeric,
       (s.value->>'totalOutflowWk1')::numeric,
       (s.value->>'netChangeWk1')::numeric,
       (s.value->>'closingCashWk1')::numeric,
       (s.value->>'arProjection13wTotal')::numeric,
       (s.value->>'salesForecastWk1')::numeric,
       (s.value->>'salesForecast13wTotal')::numeric,
       coalesce(s.value->'inflows', '[]'::jsonb),
       coalesce(s.value->'outflows', '[]'::jsonb)
from kv_store, jsonb_each(kv_store.value->'snapshots') s
where kv_store.key = '.weekly-snapshots.json'
on conflict (monday) do nothing;

-- 7) Bot metric history (array of {at, m}).
insert into bot_metric_history (at, bank_cash, opening_cash, cc_debt, net_cash,
       gelato_net, gelato_received, lt_ar_projected, inflow_13w, outflow_13w,
       closing_wk13, min_closing, runway_negative_week, qb_down)
select (e->>'at')::timestamptz,
       (e->'m'->>'bankCash')::numeric,
       (e->'m'->>'openingCash')::numeric,
       (e->'m'->>'ccDebt')::numeric,
       (e->'m'->>'netCash')::numeric,
       (e->'m'->>'gelatoNet')::numeric,
       (e->'m'->>'gelatoReceived')::numeric,
       (e->'m'->>'ltArProjected')::numeric,
       (e->'m'->>'inflow13w')::numeric,
       (e->'m'->>'outflow13w')::numeric,
       (e->'m'->>'closingWk13')::numeric,
       (e->'m'->>'minClosing')::numeric,
       case when e->'m'->>'runwayNegativeWeek' is null then null
            else (e->'m'->>'runwayNegativeWeek')::int end,
       coalesce((e->'m'->>'qbDown')::boolean, false)
from kv_store, jsonb_array_elements(kv_store.value) e
where kv_store.key = '.assistant-history.json'
  and not exists (select 1 from bot_metric_history);

-- 8) Invoice scrape cache (single blob row).
insert into scrape_cache (source, data, updated_at)
select 'invoices', value, now()
from kv_store
where key = '.invoice-scrape-cache.json'
on conflict (source) do update
  set data = excluded.data, updated_at = now();
