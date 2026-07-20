-- ───────────────────────────────────────────────────────────────────────────
-- Phase 15: drop the pre-roles marketing policies that 0014 left behind.
--
-- 0014 ADDED <table>_role_select (can_read_marketing) but never dropped the
-- original <abbrev>_select policies (is_member_of) from 0005/0007. Postgres ORs
-- PERMISSIVE policies, so the looser one kept winning and an 'ops' user could
-- still read marketing rows — the new policy was decorative.
--
-- Lesson for future role work: replacing a policy means DROPping the old name,
-- not just creating a stricter one alongside it.
-- ───────────────────────────────────────────────────────────────────────────

drop policy if exists mconn_select on public.marketing_connections;
drop policy if exists mmd_select   on public.marketing_metrics_daily;
drop policy if exists mrev_select  on public.marketing_revenue_daily;

-- marketing_sync_log was missed by 0014's table list entirely; it carries
-- client_id and describes marketing activity, so it takes the same gate.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'marketing_sync_log'
       and column_name = 'client_id'
  ) then
    drop policy if exists msync_select on public.marketing_sync_log;
    drop policy if exists marketing_sync_log_role_select on public.marketing_sync_log;
    create policy marketing_sync_log_role_select on public.marketing_sync_log
      for select using ( public.can_read_marketing(client_id) );
  end if;
end $$;
