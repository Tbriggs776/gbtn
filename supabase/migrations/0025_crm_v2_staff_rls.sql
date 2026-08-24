-- Re-point the CRM v2 tables (segments, templates, cases) from is_admin() to
-- is_staff(), matching the employee-role model (0021_employee_role): employees
-- work the whole CRM, and the app actions gate these with assertStaff(). The
-- original 0022/0024 migrations shipped with is_admin() policies; this makes
-- them consistent so an employee isn't blocked by RLS on features the UI offers.
do $$
declare t text;
begin
  foreach t in array array['crm_segments','crm_templates','crm_cases'] loop
    execute format('drop policy if exists %I on public.%I;', t || '_admin_all', t);
    execute format('drop policy if exists %I on public.%I;', t || '_staff_all', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_staff()) with check (public.is_staff());',
      t || '_staff_all', t);
  end loop;
end $$;
