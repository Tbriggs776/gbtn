-- ───────────────────────────────────────────────────────────────────────────
-- Contact form submissions. Captured server-side so no lead is ever lost, even
-- if the email notification fails. Inserts happen via the service-role client
-- (public form, no auth); reads are admin-only.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.contact_submissions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,
  company       text,
  revenue_stage text,
  message       text not null,
  notified      boolean not null default false,  -- did the email notification send?
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_contact_created on public.contact_submissions (created_at desc);

alter table public.contact_submissions enable row level security;

-- Admins can read/manage submissions. Inserts come through the service-role
-- client, which bypasses RLS, so there is intentionally no public insert policy.
drop policy if exists contact_admin_all on public.contact_submissions;
create policy contact_admin_all on public.contact_submissions
  for all using ( public.is_admin() ) with check ( public.is_admin() );
