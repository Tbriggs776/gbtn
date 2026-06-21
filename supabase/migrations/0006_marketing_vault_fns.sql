-- Service-role-only helpers to store/read marketing connection secrets in
-- Supabase Vault. The portal's write path calls store_connection_secret via the
-- service-role client; the sync jobs call read_connection_secret. Both are
-- SECURITY DEFINER and revoked from anon/authenticated so the browser can never
-- invoke them — secrets never leave the server.

create or replace function public.store_connection_secret(
  p_connection_id uuid,
  p_kind text,
  p_secret text
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_ref uuid;
begin
  if p_kind not in ('api_key', 'access_token', 'refresh_token') then
    raise exception 'invalid secret kind: %', p_kind;
  end if;

  insert into public.marketing_connection_secrets (connection_id)
    values (p_connection_id)
    on conflict (connection_id) do nothing;

  execute format(
    'select %I from public.marketing_connection_secrets where connection_id = $1',
    p_kind || '_ref'
  ) into v_ref using p_connection_id;

  if v_ref is not null then
    perform vault.update_secret(v_ref, p_secret);
  else
    v_ref := vault.create_secret(
      p_secret,
      'mconn:' || p_connection_id::text || ':' || p_kind,
      'GBTN marketing connection secret'
    );
    execute format(
      'update public.marketing_connection_secrets set %I = $1, updated_at = now() where connection_id = $2',
      p_kind || '_ref'
    ) using v_ref, p_connection_id;
  end if;
end $$;

create or replace function public.read_connection_secret(
  p_connection_id uuid,
  p_kind text
) returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_ref uuid;
  v_secret text;
begin
  execute format(
    'select %I from public.marketing_connection_secrets where connection_id = $1',
    p_kind || '_ref'
  ) into v_ref using p_connection_id;
  if v_ref is null then
    return null;
  end if;
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where id = v_ref;
  return v_secret;
end $$;

revoke all on function public.store_connection_secret(uuid, text, text) from public, anon, authenticated;
revoke all on function public.read_connection_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.store_connection_secret(uuid, text, text) to service_role;
grant execute on function public.read_connection_secret(uuid, text) to service_role;
