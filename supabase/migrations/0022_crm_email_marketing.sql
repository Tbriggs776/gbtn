-- CRM email marketing: saved segments, reusable templates, message status index.
-- Apply via normal migration flow; do not run against production from this PR.

create table if not exists public.crm_segments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  filter      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create table if not exists public.crm_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  channel     text not null check (channel in ('email','sms')),
  subject     text,
  body        text not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists idx_crm_msg_campaign_status
  on public.crm_messages (campaign_id, status);

alter table public.crm_segments  enable row level security;
alter table public.crm_templates enable row level security;

do $$
declare t text;
begin
  foreach t in array array['crm_segments','crm_templates'] loop
    execute format('drop policy if exists %I on public.%I;', t || '_admin_all', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_admin()) with check (public.is_admin());',
      t || '_admin_all', t);
  end loop;
end $$;
