-- ───────────────────────────────────────────────────────────────────────────
-- Phase 21: GoHighLevel conversation intelligence.
--
-- Floor Daddy runs every inbound lead through GoHighLevel — SMS, email, and
-- call logging all land in one GHL "conversation" per contact. Nobody reads
-- them in aggregate, so the questions that decide whether a lead becomes a
-- measure ("how fast did we answer?", "which threads died unanswered?", "which
-- rep lets leads go cold on Saturdays?") have never had an answer.
--
-- Three tables, deliberately at three different grains:
--
--   ghl_conversations   one row per THREAD. Carries the derived per-thread
--                       metrics (speed-to-lead, answered/unanswered, message
--                       mix) computed once at sync, so a report never has to
--                       rescan the message table to draw a chart.
--   ghl_messages        one row per MESSAGE. The transcript. Needed for the
--                       AI coaching pass and the thread drill-down, and it is
--                       the source the conversation-level metrics derive from.
--   ghl_coaching_notes  one row per generated AI coaching write-up, cached so
--                       re-reading the tab doesn't re-bill Anthropic.
--
-- Tenancy matches every other module: tenant = public.clients(id), and all
-- writes go through the service role (the sync job), so there are intentionally
-- no client write policies. Reads are gated on public.can_read_marketing (0014)
-- rather than bare membership — lead handling is marketing/sales performance,
-- and these tables carry both customer contact detail and per-rep scorecards.
-- That matches the requireCapability(clientId, 'marketing') guard on every page.
--
-- The GHL Private Integration Token follows the 0017 platform-secret pattern —
-- Vault holds the value, the table holds only an opaque ref, and the SECURITY
-- DEFINER accessors are revoked from anon/authenticated so a browser can never
-- reach a token. Unlike 0017 this one is PER CLIENT: each client authorises its
-- own GHL sub-account (location), and one client's token must never read
-- another's conversations.
-- ───────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;
create extension if not exists supabase_vault;

-- ── Enums ────────────────────────────────────────────────────────────────────

-- The channel a message arrived on. GHL's own message types are far more
-- granular (TYPE_SMS, TYPE_EMAIL, TYPE_CALL, TYPE_FACEBOOK, TYPE_GMB, …); we
-- fold them into the five that change how you'd coach a rep. See lib/ghl/map.ts
-- for the mapping — that file is the single source of the rule.
do $$ begin
  create type ghl_channel as enum ('sms', 'email', 'call', 'chat', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ghl_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;

-- ── Connection (one GHL location per client) ─────────────────────────────────

create table if not exists public.ghl_connections (
  client_id       uuid primary key references public.clients (id) on delete cascade,
  location_id     text not null,            -- GHL sub-account ("location") id
  display_name    text,
  secret_ref      uuid,                     -- vault.secrets id; opaque, never exposed
  hint            text,                     -- last 4 chars of the token, for the admin UI
  status          text not null default 'pending',  -- pending|connected|needs_reauth
  last_synced_at  timestamptz,
  last_sync_error text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Gated on can_read_marketing (0014), the same capability the Conversations
-- pages check — NOT the broader is_member_of. Every policy in this migration is
-- written against the capability helper from the start and each table gets
-- exactly ONE select policy: Postgres ORs permissive policies together, so a
-- membership-only policy sitting alongside a stricter one makes the stricter
-- one decorative. That's the mistake 0015 had to clean up.
--
-- The secret_ref column is never selected by application code; the token itself
-- lives in Vault and only read_ghl_token can decrypt it.
alter table public.ghl_connections enable row level security;

drop policy if exists ghl_conn_select on public.ghl_connections;
create policy ghl_conn_select on public.ghl_connections
  for select using ( public.can_read_marketing(client_id) );

create or replace function public.store_ghl_token(
  p_client_id uuid,
  p_location_id text,
  p_token text,
  p_hint text
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_ref uuid;
begin
  insert into public.ghl_connections (client_id, location_id)
    values (p_client_id, p_location_id)
    on conflict (client_id) do update set location_id = excluded.location_id;

  select secret_ref into v_ref from public.ghl_connections where client_id = p_client_id;

  if v_ref is not null then
    perform vault.update_secret(v_ref, p_token);
  else
    v_ref := vault.create_secret(
      p_token,
      'ghl:' || p_client_id::text,
      'GoHighLevel private integration token'
    );
    update public.ghl_connections set secret_ref = v_ref where client_id = p_client_id;
  end if;

  update public.ghl_connections
     set hint = p_hint, status = 'connected', last_sync_error = null, updated_at = now()
   where client_id = p_client_id;
end $$;

create or replace function public.read_ghl_token(p_client_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_ref uuid;
  v_secret text;
begin
  select secret_ref into v_ref from public.ghl_connections where client_id = p_client_id;
  if v_ref is null then
    return null;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_ref;
  return v_secret;
end $$;

revoke all on function public.store_ghl_token(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.read_ghl_token(uuid) from public, anon, authenticated;
grant execute on function public.store_ghl_token(uuid, text, text, text) to service_role;
grant execute on function public.read_ghl_token(uuid) to service_role;

-- ── Conversations (thread grain) ─────────────────────────────────────────────

create table if not exists public.ghl_conversations (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients (id) on delete cascade,

  ghl_id              text not null,        -- GHL conversation id
  contact_id          text,
  contact_name        text,
  contact_email       text,
  contact_phone       text,

  -- The rep. GHL gives us an opaque user id on the message; the sync resolves
  -- it to a name once per run so every report can group by a human being.
  assigned_user_id    text,
  assigned_user_name  text,

  channel             ghl_channel not null default 'other',  -- dominant channel of the thread
  date_added          timestamptz,
  last_message_at     timestamptz,

  message_count       int not null default 0,
  inbound_count       int not null default 0,
  outbound_count      int not null default 0,

  -- ── Derived at sync (see lib/ghl/derive.ts) ──
  -- first_inbound_at is when the lead first spoke. first_response_at is the
  -- first outbound message after it THAT A PERSON SENT. response_seconds is the
  -- gap — the speed-to-lead number the whole report hangs on.
  first_inbound_at    timestamptz,
  first_response_at   timestamptz,
  response_seconds    int,
  -- A thread where the lead spoke and no person ever replied. Stored rather
  -- than derived at read time because it is the most-filtered field here.
  unanswered          boolean not null default false,
  -- Outbound-only threads (blasts, drip campaigns). They have no speed-to-lead
  -- and would drag every average toward zero, so every metric excludes them.
  outbound_only       boolean not null default false,
  -- Unanswered, but the workflow auto-reply DID fire. These are the dangerous
  -- ones: GHL's inbox shows a reply, so they look handled, and nobody chases
  -- them. Separated from plain unanswered so the report can name them.
  auto_replied_only   boolean not null default false,

  raw                 jsonb,
  synced_at           timestamptz not null default now(),

  -- A GHL sync is a full re-read of the window, so re-running must update in
  -- place rather than duplicate.
  unique (client_id, ghl_id)
);

create index if not exists idx_ghl_conv_client_last on public.ghl_conversations (client_id, last_message_at desc);
create index if not exists idx_ghl_conv_client_rep  on public.ghl_conversations (client_id, assigned_user_name);
create index if not exists idx_ghl_conv_unanswered  on public.ghl_conversations (client_id, unanswered);
create index if not exists idx_ghl_conv_contact     on public.ghl_conversations (client_id, contact_id);

alter table public.ghl_conversations enable row level security;

drop policy if exists ghl_conv_select on public.ghl_conversations;
create policy ghl_conv_select on public.ghl_conversations
  for select using ( public.can_read_marketing(client_id) );

-- ── Messages (transcript grain) ──────────────────────────────────────────────

create table if not exists public.ghl_messages (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  conversation_id  uuid not null references public.ghl_conversations (id) on delete cascade,

  ghl_id           text not null,
  ghl_contact_id   text,
  direction        ghl_direction not null,
  channel          ghl_channel not null default 'other',
  message_type     text,                    -- GHL's raw type, kept for auditing
  body             text,
  -- Who sent it. Null on inbound (the contact) and on automated sends.
  user_id          text,
  status           text,                    -- delivered|failed|… as GHL reports it
  -- GHL's own origin field: workflow|campaign|bulk_actions|api|app.
  source           text,
  -- Derived from source at sync (lib/ghl/map.ts). An automated outbound is not
  -- a rep replying, and every response metric depends on telling them apart.
  automated        boolean not null default false,
  date_added       timestamptz,

  raw              jsonb,

  unique (client_id, ghl_id)
);

-- The coaching pass reads a whole thread in order; the drill-down does the same.
create index if not exists idx_ghl_msg_conv on public.ghl_messages (conversation_id, date_added);
create index if not exists idx_ghl_msg_client_date on public.ghl_messages (client_id, date_added);

alter table public.ghl_messages enable row level security;

drop policy if exists ghl_msg_select on public.ghl_messages;
create policy ghl_msg_select on public.ghl_messages
  for select using ( public.can_read_marketing(client_id) );

-- ── Coaching notes (AI output cache) ─────────────────────────────────────────
--
-- Not folded into public.ai_summaries (0017): that table's select policy is
-- gated on can_read_financials, because the CFO briefing is P&L detail. Lead
-- handling is not financial — it needs the marketing gate instead — and reusing
-- the table would have meant either widening that policy or bolting a second
-- one onto a table whose whole point is "financial summaries".
create table if not exists public.ghl_coaching_notes (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,

  -- 'team' = one write-up across the whole floor. 'rep' = one per salesperson,
  -- keyed by rep_key (the assigned_user_name we grouped on).
  scope         text not null check (scope in ('team', 'rep')),
  rep_key       text,

  content       text not null,
  model         text,
  -- The window the notes describe, so a stale note can never be read as if it
  -- covered the current period.
  period_start  date not null,
  period_end    date not null,

  generated_by  uuid references auth.users (id) on delete set null,
  generated_at  timestamptz not null default now()
);

create index if not exists idx_ghl_notes_lookup
  on public.ghl_coaching_notes (client_id, scope, rep_key, generated_at desc);

alter table public.ghl_coaching_notes enable row level security;

drop policy if exists ghl_notes_select on public.ghl_coaching_notes;
create policy ghl_notes_select on public.ghl_coaching_notes
  for select using ( public.can_read_marketing(client_id) );

comment on table public.ghl_conversations is
  'One row per GoHighLevel thread, with speed-to-lead and answered/unanswered derived at sync. See lib/ghl/derive.ts.';
comment on column public.ghl_conversations.response_seconds is
  'Seconds from the lead''s first inbound message to the first outbound reply. Null when never answered or outbound-only.';
comment on column public.ghl_conversations.outbound_only is
  'Thread the business started and the contact never answered (drip/blast). Excluded from every response metric.';
comment on column public.ghl_conversations.auto_replied_only is
  'Lead wrote in, the workflow auto-reply fired, no human ever followed. Looks answered in the GHL inbox; is not.';
comment on column public.ghl_messages.automated is
  'Sent by workflow/campaign/bulk action/API rather than a person. See lib/ghl/map.ts — isAutomated is the single source of the rule.';
