-- ───────────────────────────────────────────────────────────────────────────
-- Platform AI integration: a single GBTN-owned Anthropic key (stored in Vault,
-- never in the table or the browser) that powers the AI CFO briefing for every
-- client, plus a cache of generated summaries so we don't re-bill on every load.
--
-- Same security model as the marketing connection secrets (0006): the secret
-- lives in Vault; SECURITY DEFINER helpers are the only way to write/read it,
-- and they're revoked from anon/authenticated so a browser can never invoke
-- them. This is platform-scoped (no client_id) — one key serves all clients.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.platform_integrations (
  provider    text primary key,          -- e.g. 'anthropic'
  secret_ref  uuid,                       -- vault.secrets id; opaque, never exposed
  hint        text,                       -- last 4 chars, for the admin UI
  model       text,                       -- optional model override
  updated_at  timestamptz not null default now()
);

-- No policies: with RLS on and nothing granted, only the service role (which
-- bypasses RLS) can touch this table. Admin server actions use the service-role
-- client; the browser never reads secret_ref.
alter table public.platform_integrations enable row level security;

create or replace function public.store_platform_secret(
  p_provider text,
  p_secret text,
  p_hint text
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_ref uuid;
begin
  insert into public.platform_integrations (provider)
    values (p_provider)
    on conflict (provider) do nothing;

  select secret_ref into v_ref from public.platform_integrations where provider = p_provider;

  if v_ref is not null then
    perform vault.update_secret(v_ref, p_secret);
  else
    v_ref := vault.create_secret(p_secret, 'platform:' || p_provider, 'GBTN platform integration secret');
    update public.platform_integrations set secret_ref = v_ref where provider = p_provider;
  end if;

  update public.platform_integrations set hint = p_hint, updated_at = now() where provider = p_provider;
end $$;

create or replace function public.read_platform_secret(p_provider text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_ref uuid;
  v_secret text;
begin
  select secret_ref into v_ref from public.platform_integrations where provider = p_provider;
  if v_ref is null then
    return null;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_ref;
  return v_secret;
end $$;

revoke all on function public.store_platform_secret(text, text, text) from public, anon, authenticated;
revoke all on function public.read_platform_secret(text) from public, anon, authenticated;
grant execute on function public.store_platform_secret(text, text, text) to service_role;
grant execute on function public.read_platform_secret(text) to service_role;

-- ── Generated summaries cache ────────────────────────────────────────────────
-- One row per generation; the latest by generated_at is what the tab shows.
create table if not exists public.ai_summaries (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  kind          text not null,            -- e.g. 'cfo_briefing'
  content       text not null,
  model         text,
  generated_by  uuid references auth.users (id) on delete set null,
  generated_at  timestamptz not null default now()
);
create index if not exists idx_ai_summaries_client on public.ai_summaries (client_id, kind, generated_at desc);

alter table public.ai_summaries enable row level security;

-- Read gated on the financials capability (the briefing is financial detail).
-- Writes go through the service role only (the admin-triggered generate action).
drop policy if exists ai_sum_select on public.ai_summaries;
create policy ai_sum_select on public.ai_summaries
  for select using ( public.can_read_financials(client_id) );
