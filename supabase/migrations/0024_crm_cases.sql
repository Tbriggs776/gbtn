-- CRM customer-care cases (post-sale, Dynamics-style).
-- Apply via normal migration flow; do not run against production from this PR.

create table if not exists public.crm_cases (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.crm_contacts (id) on delete cascade,
  company_id  uuid references public.crm_companies (id) on delete set null,
  deal_id     uuid references public.crm_deals (id) on delete set null,
  title       text not null,
  status      text not null default 'open' check (status in ('open','pending','closed')),
  priority    text not null default 'normal' check (priority in ('low','normal','high')),
  assignee    uuid references auth.users (id) on delete set null,
  opened_at   timestamptz not null default now(),
  due_at      timestamptz,
  closed_at   timestamptz,
  notes       text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_crm_cases_contact on public.crm_cases (contact_id);
create index if not exists idx_crm_cases_deal on public.crm_cases (deal_id);
create index if not exists idx_crm_cases_company on public.crm_cases (company_id);
create index if not exists idx_crm_cases_status on public.crm_cases (status);
create index if not exists idx_crm_cases_due on public.crm_cases (due_at) where status <> 'closed';

drop trigger if exists trg_crm_cases_touch on public.crm_cases;
create trigger trg_crm_cases_touch before update on public.crm_cases
  for each row execute function public.crm_touch_updated_at();

alter table public.crm_cases enable row level security;
drop policy if exists crm_cases_admin_all on public.crm_cases;
create policy crm_cases_admin_all on public.crm_cases
  for all using (public.is_admin()) with check (public.is_admin());
