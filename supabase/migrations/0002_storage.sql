-- ───────────────────────────────────────────────────────────────────────────
-- Private storage bucket for client documents + per-tenant RLS.
-- Object path convention:  {client_id}/{uuid}-{original_filename}
-- The first path segment is the client_id, which the policies check against
-- membership. Downloads are served via short-lived signed URLs from the server.
-- ───────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('client-files', 'client-files', false)
on conflict (id) do nothing;

-- Read
drop policy if exists client_files_select on storage.objects;
create policy client_files_select on storage.objects
  for select using (
    bucket_id = 'client-files'
    and public.is_member_of( ((storage.foldername(name))[1])::uuid )
  );

-- Upload
drop policy if exists client_files_insert on storage.objects;
create policy client_files_insert on storage.objects
  for insert with check (
    bucket_id = 'client-files'
    and public.is_member_of( ((storage.foldername(name))[1])::uuid )
  );

-- Update (e.g. re-upload / metadata)
drop policy if exists client_files_update on storage.objects;
create policy client_files_update on storage.objects
  for update using (
    bucket_id = 'client-files'
    and public.is_member_of( ((storage.foldername(name))[1])::uuid )
  );

-- Delete
drop policy if exists client_files_delete on storage.objects;
create policy client_files_delete on storage.objects
  for delete using (
    bucket_id = 'client-files'
    and public.is_member_of( ((storage.foldername(name))[1])::uuid )
  );
