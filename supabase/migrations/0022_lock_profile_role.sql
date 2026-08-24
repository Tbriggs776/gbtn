-- ───────────────────────────────────────────────────────────────────────────
-- Phase 22: SECURITY FIX — stop users from self-promoting via profiles.role.
--
-- profiles carries the platform role (admin | employee | client). The
-- profiles_update_self policy (0001) allows a user to UPDATE their own row
-- (WITH CHECK id = auth.uid()), and RLS WITH CHECK cannot restrict WHICH
-- columns change. With table UPDATE granted to `authenticated`, any signed-in
-- user could run  update profiles set role='admin' where id = auth.uid()  from
-- the browser and seize full platform-admin access (every client's financials,
-- the CRM, all admin actions). This trigger closes that hole.
--
-- Legitimate role changes go through the admin server actions, which use the
-- service-role client (current_user = 'service_role') and are allowed. A signed
-- in user editing their own full_name is unaffected (role unchanged).
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and current_user <> 'service_role'
     and not public.is_admin() then
    raise exception 'Only GBTN admins can change a profile role.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_guard_role on public.profiles;
create trigger trg_profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();
