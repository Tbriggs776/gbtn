-- ───────────────────────────────────────────────────────────────────────────
-- Phase 16: close the storage side of the financials gate.
--
-- 0014 restricted the documents TABLE (Financials category needs
-- can_read_financials) but left storage.objects on 0002's membership-only
-- policies. Both document uploads and raw financial workbooks live in the same
-- 'client-files' bucket under a {client_id}/ prefix, so an ops user could
-- skip the table entirely:
--
--     supabase.storage.from('client-files').list('<client_id>')
--     supabase.storage.from('client-files').createSignedUrl(path)
--
-- …and read (or .remove()) every financial package. The category filter was
-- decorative for anyone who opened a browser console.
--
-- Fix: an object is "financial" if a documents row marks it Financials, or a
-- financial_uploads row points at it. Reading/deleting one requires the
-- financials capability for the owning client.
-- ───────────────────────────────────────────────────────────────────────────

-- SECURITY DEFINER: the lookup must see rows the CALLER cannot. Under the
-- caller's own RLS an ops user sees no financial rows, the EXISTS returns
-- false, and the object would read as "not financial" — inverting the gate.
create or replace function public.is_financial_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.documents d
     where d.storage_path = object_name and d.category = 'Financials'
  ) or exists (
    select 1 from public.financial_uploads f
     where f.source_path = object_name
  );
$$;

-- Owning client = first path segment ({client_id}/…), same convention as 0002.
create or replace function public.storage_object_client(object_name text)
returns uuid
language sql
immutable
as $$
  select nullif((storage.foldername(object_name))[1], '')::uuid;
$$;

drop policy if exists client_files_select on storage.objects;
create policy client_files_select on storage.objects
  for select using (
    bucket_id = 'client-files'
    and public.is_member_of(public.storage_object_client(name))
    and (
      not public.is_financial_object(name)
      or public.can_read_financials(public.storage_object_client(name))
    )
  );

-- Deleting a financial package needs the same standing as reading it —
-- otherwise ops could destroy files it isn't allowed to open.
drop policy if exists client_files_delete on storage.objects;
create policy client_files_delete on storage.objects
  for delete using (
    bucket_id = 'client-files'
    and public.is_member_of(public.storage_object_client(name))
    and (
      not public.is_financial_object(name)
      or public.can_read_financials(public.storage_object_client(name))
    )
  );
