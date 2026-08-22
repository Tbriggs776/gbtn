-- ───────────────────────────────────────────────────────────────────────────
-- Phase 21: GBTN "employee" role + staff/client login split.
--
-- Adds a third platform role, 'employee': GBTN staff who work the CRM but are
-- NOT full platform admins — no client provisioning, no user management, and no
-- access to client financials/portal data. "Staff" = admin ∪ employee.
--
-- The CRM (crm_* tables) opens up from admin-only to staff. Everything else
-- (financials, documents, ops, marketing) stays gated on is_admin(), so an
-- employee can never see a client's books.
-- ───────────────────────────────────────────────────────────────────────────

-- 1) Allow the new role value.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('admin', 'employee', 'client'));

-- 2) Staff helper (admin OR employee), SECURITY DEFINER like is_admin().
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'employee')
  );
$$;

-- 3) Re-point the CRM RLS policies from is_admin() to is_staff().
do $$
declare t text;
begin
  foreach t in array array[
    'crm_companies','crm_contacts','crm_stages','crm_deals','crm_activities',
    'crm_tasks','crm_campaigns','crm_campaign_steps','crm_enrollments','crm_messages'
  ] loop
    execute format('drop policy if exists %I on public.%I;', t || '_admin_all', t);
    execute format('drop policy if exists %I on public.%I;', t || '_staff_all', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_staff()) with check (public.is_staff());',
      t || '_staff_all', t);
  end loop;
end $$;
