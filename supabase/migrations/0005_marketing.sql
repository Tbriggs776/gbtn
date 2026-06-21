-- ───────────────────────────────────────────────────────────────────────────
-- Phase 5: Client marketing metrics (multi-tenant, RLS).
--
-- Model:
--   • The portal "Marketing" tab reads marketing_metrics_daily ONLY. It never
--     touches a live channel API.
--   • Clients self-serve their channel connections in a portal Settings section.
--     They can SEE connection status but NEVER read the secret values.
--   • Secrets live in a separate table (marketing_connection_secrets) with NO
--     client-readable policy. They are written via a trusted server action that
--     (a) verifies the caller is a member of the client, then (b) stores the
--     value in Supabase Vault using the service-role client. The table holds
--     only the Vault secret IDs, never raw tokens/keys.
--   • Sync functions (service role) write metrics; service role bypasses RLS,
--     so there are no client write policies on the data tables on purpose.
--
-- Aligns with existing schema: tenant = public.clients(id); user→client link =
-- public.memberships; helpers public.is_member_of(uuid) / public.is_admin().
-- ───────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;
-- Supabase Vault (usually already enabled). Stores encrypted secrets; we keep
-- only the returned secret IDs in marketing_connection_secrets.
create extension if not exists supabase_vault;

-- ── Enums ────────────────────────────────────────────────────────────────────
do $$ begin
  create type marketing_provider as enum (
    'ga4', 'meta_ads', 'google_ads', 'gbp', 'callrail'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type connection_status as enum (
    'pending', 'connected', 'needs_reauth', 'disconnected'
  );
exception when duplicate_object then null; end $$;

-- ── Connections (client-visible; NO secrets here) ────────────────────────────
create table if not exists public.marketing_connections (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients (id) on delete cascade,
  provider            marketing_provider not null,
  status              connection_status not null default 'pending',
  external_account_id text not null,   -- GA4 property / Meta act_id / Ads customer / GBP location / CallRail company
  display_name        text,            -- friendly label shown in the portal
  last_synced_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (client_id, provider, external_account_id)
);

-- ── Secrets (service-role ONLY; holds Vault secret IDs, never raw values) ─────
create table if not exists public.marketing_connection_secrets (
  connection_id     uuid primary key references public.marketing_connections (id) on delete cascade,
  api_key_ref       uuid,         -- vault.secrets id (CallRail etc.)
  access_token_ref  uuid,         -- vault.secrets id (OAuth)
  refresh_token_ref uuid,         -- vault.secrets id (OAuth)
  token_expires_at  timestamptz,
  scopes            text[],
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── Canonical daily metrics (the table the UI reads) ─────────────────────────
create table if not exists public.marketing_metrics_daily (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients (id) on delete cascade,
  connection_id     uuid not null references public.marketing_connections (id) on delete cascade,
  provider          marketing_provider not null,
  metric_date       date not null,

  campaign_id       text,
  campaign_name     text,

  impressions       bigint,
  clicks            bigint,
  spend             numeric(14, 2),
  conversions       numeric(14, 2),
  conversion_value  numeric(14, 2),
  leads             bigint,
  phone_calls       bigint,
  sessions          bigint,
  engaged_sessions  bigint,

  raw               jsonb,
  synced_at         timestamptz not null default now(),

  -- NULLS NOT DISTINCT (PG15+) so account-level rows (campaign_id IS NULL)
  -- dedupe correctly under ON CONFLICT upserts.
  unique nulls not distinct (connection_id, metric_date, campaign_id)
);

create index if not exists idx_mmd_client_date on public.marketing_metrics_daily (client_id, metric_date);
create index if not exists idx_mmd_conn_date   on public.marketing_metrics_daily (connection_id, metric_date);
create index if not exists idx_mconn_client    on public.marketing_connections (client_id);

-- ── Sync log (observability; client_id added so it can be scoped) ────────────
create table if not exists public.marketing_sync_log (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references public.clients (id) on delete cascade,
  connection_id  uuid references public.marketing_connections (id) on delete cascade,
  provider       marketing_provider,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text,           -- 'success' | 'error' | 'partial'
  rows_upserted  integer default 0,
  error          text
);
create index if not exists idx_msync_client on public.marketing_sync_log (client_id, started_at desc);

-- ── updated_at trigger ───────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_touch_mconnections on public.marketing_connections;
create trigger trg_touch_mconnections
  before update on public.marketing_connections
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_msecrets on public.marketing_connection_secrets;
create trigger trg_touch_msecrets
  before update on public.marketing_connection_secrets
  for each row execute function public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.marketing_connections        enable row level security;
alter table public.marketing_connection_secrets enable row level security;
alter table public.marketing_metrics_daily      enable row level security;
alter table public.marketing_sync_log           enable row level security;

-- Connections: members (and admins) can READ their own. All writes go through
-- server actions using the service-role client (which bypasses RLS), so there
-- are intentionally no client insert/update/delete policies.
drop policy if exists mconn_select on public.marketing_connections;
create policy mconn_select on public.marketing_connections
  for select using ( public.is_member_of(client_id) );

-- Metrics: members (and admins) can READ their own. Writes via service role.
drop policy if exists mmd_select on public.marketing_metrics_daily;
create policy mmd_select on public.marketing_metrics_daily
  for select using ( public.is_member_of(client_id) );

-- Sync log: members (and admins) can READ their own. Writes via service role.
drop policy if exists msync_select on public.marketing_sync_log;
create policy msync_select on public.marketing_sync_log
  for select using ( public.is_member_of(client_id) );

-- Secrets: RLS enabled with NO policy → default-deny for every browser session
-- (anon + authenticated). Only the service role (server actions, sync jobs) can
-- read or write. This is what keeps tokens/keys off the client.
-- (intentionally no policies on public.marketing_connection_secrets)
