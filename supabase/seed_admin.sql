-- ───────────────────────────────────────────────────────────────────────────
-- Make Tyler an admin. Run ONCE, AFTER you've signed in (or been invited) so an
-- auth user + profile row exists for your email.
--
-- Replace the email below if needed, then run in the Supabase SQL editor.
-- ───────────────────────────────────────────────────────────────────────────

update public.profiles
set role = 'admin'
where id = (
  select id from auth.users
  where email = 'tyler.briggs@outlook.com'
  limit 1
);

-- Verify:
-- select p.role, u.email
-- from public.profiles p join auth.users u on u.id = p.id
-- where u.email = 'tyler.briggs@outlook.com';
