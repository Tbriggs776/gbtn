-- ───────────────────────────────────────────────────────────────────────────
-- Floor Daddy Ops Board — idempotent mirror of the live table.
--
-- public.ops_board_items already exists in production (cards included). This
-- file exists so a fresh rebuild and a re-run land on the same shape. It does
-- not seed rows, drop or rename columns, add CRM foreign keys, or touch the
-- e-sign tables.
--
-- Re-running is the recovery path (no migration ledger). No begin/commit.
-- Apply with:
--   node scripts/migrate.mjs supabase/migrations/0033_ops_board_items.sql
-- only when you choose to. Do not run it as part of a deploy.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.ops_board_items (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  status       text not null default 'inbox',
  owner        text,
  next_action  text,
  due_on       date,
  source       text,
  notes        text,
  sort_order   integer not null default 0,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Inline checks on create table are skipped when the table already exists,
-- so re-state them by name. Drop + add is the idempotent form used elsewhere;
-- the definitions match production.
alter table public.ops_board_items drop constraint if exists ops_board_items_status_check;
alter table public.ops_board_items
  add constraint ops_board_items_status_check
  check (status = any (array['inbox'::text, 'tyler'::text, 'karen'::text, 'waiting'::text, 'done'::text]));

alter table public.ops_board_items drop constraint if exists ops_board_items_owner_check;
alter table public.ops_board_items
  add constraint ops_board_items_owner_check
  check (owner is null or owner = any (array['tyler'::text, 'karen'::text]));

create index if not exists ops_board_items_status_idx on public.ops_board_items (status);
create index if not exists ops_board_items_owner_idx on public.ops_board_items (owner);
create index if not exists ops_board_items_due_on_idx on public.ops_board_items (due_on);
create index if not exists ops_board_items_sort_order_idx on public.ops_board_items (sort_order);

alter table public.ops_board_items enable row level security;

drop policy if exists ops_board_items_staff_all on public.ops_board_items;
create policy ops_board_items_staff_all
  on public.ops_board_items
  for all
  using (public.is_staff())
  with check (public.is_staff());

-- Bumps updated_at. Sets completed_at the first time a row enters Done, and
-- clears it when the row leaves Done. The app does not write completed_at.
create or replace function public.set_ops_board_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if new.status = 'done' and old.status is distinct from 'done' and new.completed_at is null then
    new.completed_at = now();
  end if;
  if new.status is distinct from 'done' then
    new.completed_at = null;
  end if;
  return new;
end;
$$;

drop trigger if exists ops_board_items_updated_at on public.ops_board_items;
create trigger ops_board_items_updated_at
  before update on public.ops_board_items
  for each row execute function public.set_ops_board_items_updated_at();
