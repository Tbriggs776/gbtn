-- ───────────────────────────────────────────────────────────────────────────
-- GBTN Client Portal — initial schema, helpers, and RLS.
-- Run in the Supabase SQL editor (or `supabase db push`). Idempotent-ish:
-- safe to re-run during development.
-- ───────────────────────────────────────────────────────────────────────────

-- Extensions
create extension if not exists "pgcrypto";

-- ── Tables ──────────────────────────────────────────────────────────────────

-- Tenant / organization. One per customer of GBTN.
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

-- One row per auth user. role = 'admin' (Tyler) or 'client'.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  role        text not null default 'client' check (role in ('admin', 'client')),
  created_at  timestamptz not null default now()
);

-- Maps a user to the client(s) they can access.
create table if not exists public.memberships (
  user_id     uuid not null references auth.users (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  role        text not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (user_id, client_id)
);

-- Shared documents, backed by a private storage object.
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  uploaded_by   uuid references auth.users (id) on delete set null,
  storage_path  text not null,
  file_name     text not null,
  byte_size     bigint not null default 0,
  content_type  text,
  category      text not null default 'Other'
                  check (category in ('Financials','Tax','Contracts','Reports','Other')),
  created_at    timestamptz not null default now()
);

-- Indexes for RLS-filtered columns.
create index if not exists idx_memberships_client on public.memberships (client_id);
create index if not exists idx_memberships_user on public.memberships (user_id);
create index if not exists idx_documents_client on public.documents (client_id);

-- ── Helper functions (SECURITY DEFINER to avoid RLS recursion) ───────────────

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_member_of(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1 from public.memberships
      where user_id = auth.uid() and client_id = cid
    );
$$;

-- ── Enable RLS ───────────────────────────────────────────────────────────────

alter table public.clients      enable row level security;
alter table public.profiles     enable row level security;
alter table public.memberships  enable row level security;
alter table public.documents    enable row level security;

-- ── Policies ─────────────────────────────────────────────────────────────────

-- clients: members (and admins) can read their client; only admins write.
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select using ( public.is_member_of(id) );

drop policy if exists clients_admin_write on public.clients;
create policy clients_admin_write on public.clients
  for all using ( public.is_admin() ) with check ( public.is_admin() );

-- profiles: a user can read/update their own; admins can read all.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using ( id = auth.uid() or public.is_admin() );

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using ( id = auth.uid() ) with check ( id = auth.uid() );

-- memberships: a user can see their own rows; admins manage all.
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select using ( user_id = auth.uid() or public.is_admin() );

drop policy if exists memberships_admin_write on public.memberships;
create policy memberships_admin_write on public.memberships
  for all using ( public.is_admin() ) with check ( public.is_admin() );

-- documents: any member of the owning client (incl. admin) has full access.
drop policy if exists documents_all on public.documents;
create policy documents_all on public.documents
  for all using ( public.is_member_of(client_id) )
  with check ( public.is_member_of(client_id) );

-- ── New auth users get a profile automatically ──────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    'client'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
