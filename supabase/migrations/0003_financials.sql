-- ───────────────────────────────────────────────────────────────────────────
-- Phase 3: financial statement uploads, normalized line items, and per-client
-- category mappings (so re-uploads auto-map). All under RLS via is_member_of().
-- ───────────────────────────────────────────────────────────────────────────

-- An uploaded statement: one P&L or Balance Sheet for one period.
create table if not exists public.financial_uploads (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients (id) on delete cascade,
  uploaded_by    uuid references auth.users (id) on delete set null,
  statement_type text not null check (statement_type in ('pl', 'bs')),
  period_label   text not null,
  period_start   date,
  period_end     date,
  source_path    text,          -- storage object in client-files (audit copy)
  file_name      text,
  status         text not null default 'draft' check (status in ('draft', 'confirmed')),
  created_at     timestamptz not null default now()
);

-- Normalized line items after the user confirms the category mapping.
create table if not exists public.financial_line_items (
  id             uuid primary key default gen_random_uuid(),
  upload_id      uuid not null references public.financial_uploads (id) on delete cascade,
  client_id      uuid not null references public.clients (id) on delete cascade,
  statement_type text not null check (statement_type in ('pl', 'bs')),
  raw_label      text not null,
  category       text not null,
  amount         numeric(18, 2) not null default 0,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now()
);

-- Learned mappings: next time the same line label shows up for this client, we
-- pre-select the category the user chose before.
create table if not exists public.category_mappings (
  client_id      uuid not null references public.clients (id) on delete cascade,
  statement_type text not null check (statement_type in ('pl', 'bs')),
  raw_label_norm text not null,   -- lowercased/trimmed label
  category       text not null,
  updated_at     timestamptz not null default now(),
  primary key (client_id, statement_type, raw_label_norm)
);

create index if not exists idx_fin_uploads_client on public.financial_uploads (client_id);
create index if not exists idx_fin_items_client on public.financial_line_items (client_id);
create index if not exists idx_fin_items_upload on public.financial_line_items (upload_id);
create index if not exists idx_cat_map_client on public.category_mappings (client_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.financial_uploads    enable row level security;
alter table public.financial_line_items enable row level security;
alter table public.category_mappings    enable row level security;

drop policy if exists fin_uploads_all on public.financial_uploads;
create policy fin_uploads_all on public.financial_uploads
  for all using ( public.is_member_of(client_id) )
  with check ( public.is_member_of(client_id) );

drop policy if exists fin_items_all on public.financial_line_items;
create policy fin_items_all on public.financial_line_items
  for all using ( public.is_member_of(client_id) )
  with check ( public.is_member_of(client_id) );

drop policy if exists cat_map_all on public.category_mappings;
create policy cat_map_all on public.category_mappings
  for all using ( public.is_member_of(client_id) )
  with check ( public.is_member_of(client_id) );
