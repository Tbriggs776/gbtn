-- Admin-editable pricing assumptions per client (Floor Daddy pricing tool).
create table if not exists public.pricing_assumptions (
  client_id   uuid primary key references public.clients (id) on delete cascade,
  commission  numeric(6, 4) not null default 0.12,
  warranty    numeric(6, 4) not null default 0.02,
  gm          numeric(6, 4) not null default 0.50,
  finance_fee numeric(6, 4) not null default 0.10,
  tiers       numeric(6, 4)[] not null default '{0.10,0.08,0.06,0.03,0.01}',
  updated_at  timestamptz not null default now()
);

alter table public.pricing_assumptions enable row level security;

drop policy if exists pricing_assumptions_select on public.pricing_assumptions;
create policy pricing_assumptions_select on public.pricing_assumptions
  for select using ( public.is_member_of(client_id) );

insert into public.pricing_assumptions (client_id)
values ('1c33f100-30eb-4337-b923-a48f84ba6e95')
on conflict (client_id) do nothing;
