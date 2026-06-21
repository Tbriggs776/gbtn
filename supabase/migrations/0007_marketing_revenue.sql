-- Imported revenue attributed to marketing channels, by date. This is the
-- "revenue" side (from an Excel import). Spend/clicks/leads come later from the
-- channel APIs (marketing_metrics_daily); joined on channel+date they yield
-- ROAS, cost per booking, booking rate, etc.

create table if not exists public.marketing_revenue_daily (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  metric_date date not null,
  channel     text not null,
  revenue     numeric(14, 2) not null default 0,
  jobs        integer not null default 0,
  source      text not null default 'import',
  created_at  timestamptz not null default now(),
  unique (client_id, metric_date, channel)
);

create index if not exists idx_mrev_client_date
  on public.marketing_revenue_daily (client_id, metric_date);
create index if not exists idx_mrev_client_channel
  on public.marketing_revenue_daily (client_id, channel);

alter table public.marketing_revenue_daily enable row level security;

drop policy if exists mrev_select on public.marketing_revenue_daily;
create policy mrev_select on public.marketing_revenue_daily
  for select using ( public.is_member_of(client_id) );
