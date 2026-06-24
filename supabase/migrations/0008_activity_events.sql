-- Lightweight portal usage tracking: one row per page view. Users insert their
-- own events (RLS); admins read all for the analytics section.

create table if not exists public.activity_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  client_id  uuid references public.clients (id) on delete set null,
  path       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_time on public.activity_events (created_at desc);
create index if not exists idx_activity_user on public.activity_events (user_id);

alter table public.activity_events enable row level security;

drop policy if exists activity_insert_self on public.activity_events;
create policy activity_insert_self on public.activity_events
  for insert with check ( user_id = auth.uid() );

drop policy if exists activity_admin_select on public.activity_events;
create policy activity_admin_select on public.activity_events
  for select using ( public.is_admin() );
