-- Book waitlist. Distinct from contact_submissions (consultation inquiries).
-- Inserts via the service-role client (public form, no auth); reads are admin-only.

create table if not exists public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  first_name  text,
  email       text not null,
  source      text not null default 'book',
  notified    boolean not null default false,
  user_agent  text,
  created_at  timestamptz not null default now(),
  constraint waitlist_email_key unique (email)
);

create index if not exists idx_waitlist_created on public.waitlist (created_at desc);

alter table public.waitlist enable row level security;

-- Admins can read/manage. Inserts come through the service-role client, which
-- bypasses RLS, so there is intentionally no public insert policy.
drop policy if exists waitlist_admin_all on public.waitlist;
create policy waitlist_admin_all on public.waitlist
  for all using ( public.is_admin() ) with check ( public.is_admin() );
