-- app_config: small server-only key/value store for operational secrets that
-- aren't Vercel env vars. First use: 'cron_secret', the bearer token the
-- Supabase pg_cron scheduler sends to the /api/cron/* routes (see lib/cron-auth.ts).
--
-- RLS is enabled with NO policies, so it is unreadable to anon and authenticated
-- roles entirely; only the service role (which bypasses RLS) and SECURITY DEFINER
-- functions can read it. The secret value itself is inserted out-of-band (not in
-- this migration) so it never lands in version control.

create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;
-- Intentionally no policies: deny all access except the service role.

comment on table public.app_config is
  'Server-only key/value config (e.g. cron_secret). RLS-locked: service role / SECURITY DEFINER only.';
