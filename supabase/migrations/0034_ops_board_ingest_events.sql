-- ───────────────────────────────────────────────────────────────────────────
-- Floor Daddy Ops Board — mail ingest log.
--
-- One row per external key (message-id, or sha256 of from|subject|date).
-- The card, when there is one, lives on public.ops_board_items. This table
-- does not seed cards, rewrite existing ones, or add CRM foreign keys.
--
-- Writes are service-role only (cron ingest API and the staff action's event
-- row). Staff can SELECT so the board can show recent ingest. There is no
-- INSERT/UPDATE/DELETE policy — Postgres denies those for the cookie client.
--
-- Re-running is the recovery path (no migration ledger). No begin/commit.
-- Apply with:
--   node scripts/migrate.mjs supabase/migrations/0034_ops_board_ingest_events.sql
-- only when you choose to. Do not run it as part of a deploy.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.ops_board_ingest_events (
  id           uuid primary key default gen_random_uuid(),
  external_key text not null,
  direction    text not null default 'in',
  from_addr    text,
  subject      text,
  received_at  timestamptz,
  payload      jsonb not null default '{}'::jsonb,
  card_id      uuid,
  status       text not null default 'created',
  error        text,
  created_at   timestamptz not null default now()
);

-- Inline checks and the unique key are skipped when the table already exists,
-- so re-state them by name. Drop + add matches 0033.
alter table public.ops_board_ingest_events
  drop constraint if exists ops_board_ingest_events_external_key_key;
alter table public.ops_board_ingest_events
  add constraint ops_board_ingest_events_external_key_key unique (external_key);

alter table public.ops_board_ingest_events
  drop constraint if exists ops_board_ingest_events_direction_check;
alter table public.ops_board_ingest_events
  add constraint ops_board_ingest_events_direction_check
  check (direction = any (array['in'::text, 'out'::text]));

alter table public.ops_board_ingest_events
  drop constraint if exists ops_board_ingest_events_status_check;
alter table public.ops_board_ingest_events
  add constraint ops_board_ingest_events_status_check
  check (status = any (array['created'::text, 'skipped'::text, 'error'::text]));

-- ON DELETE SET NULL so a deleted card can be ingested again. See the dedup
-- comment in lib/ops-board/persist.ts.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ops_board_ingest_events_card_id_fkey'
      and conrelid = 'public.ops_board_ingest_events'::regclass
  ) then
    alter table public.ops_board_ingest_events
      add constraint ops_board_ingest_events_card_id_fkey
      foreign key (card_id) references public.ops_board_items (id) on delete set null;
  end if;
end $$;

create index if not exists ops_board_ingest_events_card_id_idx
  on public.ops_board_ingest_events (card_id);
create index if not exists ops_board_ingest_events_created_at_idx
  on public.ops_board_ingest_events (created_at desc);

alter table public.ops_board_ingest_events enable row level security;

drop policy if exists ops_board_ingest_events_staff_select on public.ops_board_ingest_events;
create policy ops_board_ingest_events_staff_select
  on public.ops_board_ingest_events
  for select
  using (public.is_staff());

-- Cookie-client reads for the recent-ingest strip. Inserts stay on the
-- service role, which bypasses RLS. Re-granting is a no-op when the default
-- privileges already applied.
grant select on table public.ops_board_ingest_events to authenticated;
grant select, insert, update, delete on table public.ops_board_ingest_events to service_role;
