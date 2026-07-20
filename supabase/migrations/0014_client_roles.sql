-- ───────────────────────────────────────────────────────────────────────────
-- Phase 14: per-client roles (Admin / Finance / Ops / Marketing).
--
-- memberships.role has existed since 0001 as an unused text column defaulting
-- to 'member'. It becomes the real per-client role here — PER CLIENT, so one
-- person can be finance at one company and ops at another.
--
-- Two axes, unchanged in spirit:
--   profiles.role = 'admin'  -> GBTN platform admin (Tyler). Sees everything,
--                               every client. is_admin() still short-circuits.
--   memberships.role         -> what this user may do INSIDE that one client.
--
-- Capability matrix (mirrored exactly in lib/permissions.ts — change both):
--   admin      financials, marketing, ops, documents, manage_users
--   finance    financials, marketing, ops, documents
--   ops                                 ops, documents
--   marketing              marketing,    ops, documents
--
-- RLS here is defense in depth. Most dashboards read through the service role
-- (which bypasses RLS by design), so the server-side guards in lib/auth.ts are
-- the primary gate; these policies stop anything querying as the end user.
-- ───────────────────────────────────────────────────────────────────────────

do $$ begin
  create type client_role as enum ('admin', 'finance', 'ops', 'marketing');
exception when duplicate_object then null; end $$;

-- Backfill before the type change: every pre-roles row ('member', or anything
-- unrecognised) becomes 'finance' — full access minus user management, so no
-- existing user loses visibility the moment this ships.
update public.memberships
   set role = 'finance'
 where role is null or role not in ('admin', 'finance', 'ops', 'marketing');

alter table public.memberships
  alter column role drop default;

alter table public.memberships
  alter column role type client_role using role::client_role;

alter table public.memberships
  alter column role set default 'finance'::client_role,
  alter column role set not null;

-- ── Role helpers (SECURITY DEFINER: they read memberships, which is itself
--    under RLS, so they must not recurse) ─────────────────────────────────────

-- The caller's role in one client, or null if they aren't a member.
create or replace function public.client_role_of(cid uuid)
returns client_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.memberships
   where user_id = auth.uid() and client_id = cid;
$$;

-- Manages users for this client (platform admins manage every client).
create or replace function public.is_client_admin(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or public.client_role_of(cid) = 'admin';
$$;

-- Financials tab + Financials-category documents.
create or replace function public.can_read_financials(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or public.client_role_of(cid) in ('admin', 'finance');
$$;

-- Marketing, Google Ads, and the marketing-connection settings.
create or replace function public.can_read_marketing(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or public.client_role_of(cid) in ('admin', 'finance', 'marketing');
$$;

-- Ops Reports / Operational Levers / Pricing — every role that has the client.
create or replace function public.can_read_ops(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_member_of(cid);
$$;

-- ── Financial data: admin + finance only ────────────────────────────────────

drop policy if exists fin_uploads_all on public.financial_uploads;
create policy fin_uploads_all on public.financial_uploads
  for all using ( public.can_read_financials(client_id) )
  with check ( public.can_read_financials(client_id) );

drop policy if exists fin_items_all on public.financial_line_items;
create policy fin_items_all on public.financial_line_items
  for all using ( public.can_read_financials(client_id) )
  with check ( public.can_read_financials(client_id) );

drop policy if exists cat_map_all on public.category_mappings;
create policy cat_map_all on public.category_mappings
  for all using ( public.can_read_financials(client_id) )
  with check ( public.can_read_financials(client_id) );

-- ── Marketing data: admin + finance + marketing ─────────────────────────────
--
-- Every marketing table already carries a membership-only SELECT policy from
-- 0005/0007/0010/0011 under its OWN name. Postgres ORs permissive policies, so
-- adding a stricter one alongside changes nothing — the old name MUST be
-- dropped or the new guard is decorative. (This is exactly what shipped first
-- and had to be corrected in 0015.)
--
-- Second-guessing the `if exists` guard too: tables from unapplied migrations
-- are skipped SILENTLY, so 0010/0011's tables would land later with only their
-- own membership policy and never get a role guard. Those two migrations now
-- create their policies against can_read_marketing directly, and this block
-- re-asserts whatever exists at apply time.

do $$
declare
  t text;
  legacy text;
  pairs text[][] := array[
    ['marketing_connections',          'mconn_select'],
    ['marketing_metrics_daily',        'mmd_select'],
    ['marketing_revenue_daily',        'mrev_select'],
    ['marketing_sync_log',             'msync_select'],
    ['google_ads_search_terms_daily',  'gast_select'],
    ['google_ads_keywords_daily',      'gakw_select'],
    ['google_ads_ads_daily',           'gaad_select'],
    ['google_ads_segments_daily',      'gaseg_select'],
    ['marketing_channel_map',          'mcmap_select']
  ];
  i int;
begin
  for i in 1 .. array_length(pairs, 1) loop
    t := pairs[i][1];
    legacy := pairs[i][2];
    if exists (select 1 from information_schema.tables
                where table_schema = 'public' and table_name = t) then
      -- Drop the pre-roles membership policy, then install the role gate.
      execute format('drop policy if exists %I on public.%I', legacy, t);
      execute format('drop policy if exists %I on public.%I', t || '_role_select', t);
      execute format(
        'create policy %I on public.%I for select using ( public.can_read_marketing(client_id) )',
        t || '_role_select', t
      );
    end if;
  end loop;
end $$;

-- ── Documents: members read; Financials category needs the financials cap ────

drop policy if exists documents_all on public.documents;

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select using (
    public.is_member_of(client_id)
    and (category <> 'Financials' or public.can_read_financials(client_id))
  );

-- Writes stay with the roles that can see the whole picture; a financial
-- document must not be creatable by someone who then cannot see it.
drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents
  for all using (
    public.is_member_of(client_id)
    and (category <> 'Financials' or public.can_read_financials(client_id))
  )
  with check (
    public.is_member_of(client_id)
    and (category <> 'Financials' or public.can_read_financials(client_id))
  );

-- ── Ops order lines: any member of the client ───────────────────────────────

drop policy if exists ool_select on public.ops_order_lines;
create policy ool_select on public.ops_order_lines
  for select using ( public.can_read_ops(client_id) );

-- ── Memberships: client admins manage their own client's users ──────────────
-- Platform admins keep full write via is_admin() inside is_client_admin().

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select using (
    user_id = auth.uid()
    or public.is_admin()
    or public.is_client_admin(client_id)
  );

drop policy if exists memberships_admin_write on public.memberships;
create policy memberships_admin_write on public.memberships
  for all using ( public.is_client_admin(client_id) )
  with check ( public.is_client_admin(client_id) );

-- A client admin needs to read the profiles of people in their companies to
-- render the user list; platform admins keep reading everyone.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (
    id = auth.uid()
    or public.is_admin()
    or exists (
      select 1
        from public.memberships m_target
        join public.memberships m_self
          on m_self.client_id = m_target.client_id
       where m_target.user_id = profiles.id
         and m_self.user_id = auth.uid()
         and m_self.role = 'admin'
    )
  );

comment on column public.memberships.role is
  'Per-client role: admin | finance | ops | marketing. Matrix mirrored in lib/permissions.ts.';
