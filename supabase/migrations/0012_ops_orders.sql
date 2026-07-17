-- ───────────────────────────────────────────────────────────────────────────
-- Phase 12: RFMS order lines — the grain behind the Ops Reports section.
--
-- One row per order LINE (RFMS Invoice_Num + LineNum), not per order. That is
-- the grain RFMS exports and the grain both reports need:
--   • Install Pipeline rolls lines up to the CG (order) to show status mix.
--   • Orders Pipeline counts lines per day/week/month for capacity planning.
--
-- A CG's lines can carry DIFFERENT install dates (phased jobs — carpet Tuesday,
-- laminate Thursday), so install_date lives on the line and never on a header
-- table. Rolling it up to the order would destroy the schedule.
--
-- Same tenancy rules as 0005/0010: tenant = public.clients(id); members read via
-- public.is_member_of(client_id); writes go through the service role, so there
-- are intentionally no client insert/update/delete policies.
-- ───────────────────────────────────────────────────────────────────────────

-- RFMS line status, in material-readiness order (the enum order IS the pipeline:
-- nothing ordered -> PO generated -> on order -> reserved -> cut -> delivered).
-- Declaring it in this order lets ORDER BY line_status sort by readiness for free.
do $$ begin
  create type rfms_line_status as enum (
    'None', 'GenPO', 'OnOrder', 'Resvd', 'Cut', 'Del'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.ops_order_lines (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,

  -- ── Natural key ──
  invoice_num     text not null,           -- the CG, e.g. 'CG600062'
  line_num        int  not null,

  line_status     rfms_line_status not null default 'None',

  -- ── Customer / job ──
  cust_name       text,
  ship_city       text,
  ship_state      text,
  salesperson     text,
  job_type        text,                    -- RETAIL | CANCELED ORDER | HOLD ORDER | …
  ad_source       text,

  -- ── Dates. RFMS exports YYYYMMDD strings; we store real dates. ──
  order_date      date,
  install_date    date,                    -- per LINE: phased jobs differ within a CG
  est_del_date    date,
  measure_date    date,

  -- ── Product ──
  style_item      text,
  color_desc      text,
  line_group      text,
  supplier        text,
  po_number       text,
  uom             text,

  -- ── Money / volume ──
  qty             numeric(14, 2),
  unit_price      numeric(14, 2),
  line_total      numeric(14, 2),
  total_cost      numeric(14, 2),

  -- Everything else from the export, so a new report never needs a re-import.
  raw             jsonb,
  imported_at     timestamptz not null default now(),

  -- An RFMS export is a full snapshot: re-importing must update in place, not
  -- duplicate. A line is identified by its number within its CG for a client.
  unique (client_id, invoice_num, line_num)
);

-- Both reports scan one client over a date window; install_date drives the
-- Install Pipeline, order_date drives the Orders Pipeline.
create index if not exists idx_ool_client_install on public.ops_order_lines (client_id, install_date);
create index if not exists idx_ool_client_order   on public.ops_order_lines (client_id, order_date);
create index if not exists idx_ool_client_cg      on public.ops_order_lines (client_id, invoice_num);
create index if not exists idx_ool_status         on public.ops_order_lines (client_id, line_status);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.ops_order_lines enable row level security;

drop policy if exists ool_select on public.ops_order_lines;
create policy ool_select on public.ops_order_lines
  for select using ( public.is_member_of(client_id) );
