-- ───────────────────────────────────────────────────────────────────────────
-- Phase 20: GBTN agency-sales CRM.
--
-- A platform-internal CRM for GBTN's OWN sales pipeline (prospects → clients),
-- not a per-client feature. Everything here is gated to platform admins
-- (profiles.role = 'admin'); there is intentionally no client_id on these
-- tables. Reads/writes go through the authenticated admin (RLS: is_admin()),
-- while inbound webhooks (Twilio SMS/voice, Resend events) write via the
-- service-role client, which bypasses RLS.
--
-- Objects:
--   crm_companies        organizations
--   crm_contacts         people (+ enterprise auditing: last_contacted/attempt)
--   crm_stages           pipeline stages (ordered, weighted)
--   crm_deals            opportunities on the pipeline
--   crm_activities       unified per-contact timeline
--   crm_tasks            assignable follow-ups w/ reminders
--   crm_messages         every email/SMS logged with provider + status
--   crm_campaigns        Mailchimp-style blasts + drip sequences
--   crm_campaign_steps   ordered steps of a drip
--   crm_enrollments      a contact's progress through a campaign
-- ───────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Generic updated_at touch ─────────────────────────────────────────────────
create or replace function public.crm_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── Companies ────────────────────────────────────────────────────────────────
create table if not exists public.crm_companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  domain      text,
  website     text,
  phone       text,
  industry    text,
  size        text,
  address     jsonb,
  notes       text,
  source      text,
  owner       uuid references auth.users (id) on delete set null,
  tags        text[] not null default '{}',
  custom      jsonb  not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_crm_companies_name on public.crm_companies (lower(name));
create unique index if not exists uq_crm_companies_domain
  on public.crm_companies (lower(domain)) where domain is not null and domain <> '';

drop trigger if exists trg_crm_companies_touch on public.crm_companies;
create trigger trg_crm_companies_touch before update on public.crm_companies
  for each row execute function public.crm_touch_updated_at();

-- ── Contacts ─────────────────────────────────────────────────────────────────
create table if not exists public.crm_contacts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references public.crm_companies (id) on delete set null,
  first_name       text,
  last_name        text,
  email            text,
  phone            text,
  title            text,
  lifecycle_stage  text not null default 'lead',   -- lead|prospect|qualified|opportunity|customer|churned|disqualified
  source           text,                           -- contact_form|qbo_app_store|ghl|callrail|referral|import|manual
  owner            uuid references auth.users (id) on delete set null,
  lead_score       int not null default 0,
  tags             text[] not null default '{}',
  custom           jsonb  not null default '{}',
  notes            text,
  -- compliance
  do_not_email     boolean not null default false,
  do_not_sms       boolean not null default false,
  unsubscribed_at  timestamptz,
  -- enterprise auditing (maintained by crm_touch_contact_from_activity)
  last_attempt_at  timestamptz,   -- last OUTBOUND outreach of any kind
  last_contacted_at timestamptz,  -- last two-way connection (inbound reply, meeting, connected call)
  last_inbound_at  timestamptz,   -- last inbound message/call from them
  next_follow_up_at timestamptz,  -- earliest open task due date (maintained from crm_tasks)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_crm_contacts_company on public.crm_contacts (company_id);
create index if not exists idx_crm_contacts_owner on public.crm_contacts (owner);
create index if not exists idx_crm_contacts_stage on public.crm_contacts (lifecycle_stage);
create index if not exists idx_crm_contacts_followup on public.crm_contacts (next_follow_up_at);
create index if not exists idx_crm_contacts_phone on public.crm_contacts (phone);
create unique index if not exists uq_crm_contacts_email
  on public.crm_contacts (lower(email)) where email is not null and email <> '';

drop trigger if exists trg_crm_contacts_touch on public.crm_contacts;
create trigger trg_crm_contacts_touch before update on public.crm_contacts
  for each row execute function public.crm_touch_updated_at();

-- ── Pipeline stages ──────────────────────────────────────────────────────────
create table if not exists public.crm_stages (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  position     int  not null default 0,
  probability  numeric not null default 0,   -- 0..1, for weighted forecast
  is_won       boolean not null default false,
  is_lost      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ── Deals ────────────────────────────────────────────────────────────────────
create table if not exists public.crm_deals (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  company_id     uuid references public.crm_companies (id) on delete set null,
  contact_id     uuid references public.crm_contacts (id)  on delete set null,
  stage_id       uuid references public.crm_stages (id)    on delete set null,
  value          numeric not null default 0,
  value_type     text not null default 'one_time',  -- one_time|monthly|annual
  currency       text not null default 'USD',
  status         text not null default 'open' check (status in ('open','won','lost')),
  owner          uuid references auth.users (id) on delete set null,
  expected_close date,
  closed_at      timestamptz,
  lost_reason    text,
  notes          text,
  custom         jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_crm_deals_stage on public.crm_deals (stage_id);
create index if not exists idx_crm_deals_contact on public.crm_deals (contact_id);
create index if not exists idx_crm_deals_company on public.crm_deals (company_id);
create index if not exists idx_crm_deals_status on public.crm_deals (status);

drop trigger if exists trg_crm_deals_touch on public.crm_deals;
create trigger trg_crm_deals_touch before update on public.crm_deals
  for each row execute function public.crm_touch_updated_at();

-- ── Activities (unified timeline) ────────────────────────────────────────────
create table if not exists public.crm_activities (
  id           bigint generated always as identity primary key,
  contact_id   uuid references public.crm_contacts (id)  on delete cascade,
  company_id   uuid references public.crm_companies (id) on delete cascade,
  deal_id      uuid references public.crm_deals (id)     on delete set null,
  type         text not null check (type in
                 ('note','task','email','sms','call','meeting',
                  'stage_change','form_submission','enrollment','system')),
  direction    text check (direction in ('inbound','outbound')),
  subject      text,
  body         text,
  meta         jsonb not null default '{}',
  occurred_at  timestamptz not null default now(),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_crm_act_contact on public.crm_activities (contact_id, occurred_at desc);
create index if not exists idx_crm_act_company on public.crm_activities (company_id, occurred_at desc);
create index if not exists idx_crm_act_deal on public.crm_activities (deal_id, occurred_at desc);
create index if not exists idx_crm_act_type on public.crm_activities (type, occurred_at desc);

-- Maintain contact auditing columns from timeline inserts. GREATEST ignores
-- NULLs, so the first event on a contact still sets the column.
create or replace function public.crm_touch_contact_from_activity()
returns trigger language plpgsql as $$
begin
  if new.contact_id is null then return new; end if;
  if new.type in ('email','sms','call','meeting') then
    if new.direction = 'outbound' then
      update public.crm_contacts
        set last_attempt_at = greatest(last_attempt_at, new.occurred_at),
            updated_at = now()
        where id = new.contact_id;
      -- A connected call or a held meeting is also a real touch.
      if new.type = 'meeting'
         or (new.type = 'call' and coalesce(new.meta->>'connected','') = 'true') then
        update public.crm_contacts
          set last_contacted_at = greatest(last_contacted_at, new.occurred_at)
          where id = new.contact_id;
      end if;
    elsif new.direction = 'inbound' then
      update public.crm_contacts
        set last_inbound_at   = greatest(last_inbound_at, new.occurred_at),
            last_contacted_at = greatest(last_contacted_at, new.occurred_at),
            updated_at = now()
        where id = new.contact_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_crm_act_touch_contact on public.crm_activities;
create trigger trg_crm_act_touch_contact after insert on public.crm_activities
  for each row execute function public.crm_touch_contact_from_activity();

-- ── Tasks ────────────────────────────────────────────────────────────────────
create table if not exists public.crm_tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  contact_id    uuid references public.crm_contacts (id)  on delete set null,
  company_id    uuid references public.crm_companies (id) on delete set null,
  deal_id       uuid references public.crm_deals (id)     on delete set null,
  assignee      uuid references auth.users (id) on delete set null,
  due_at        timestamptz,
  reminder_at   timestamptz,
  remind_channel text not null default 'none' check (remind_channel in ('none','email','sms')),
  reminded_at   timestamptz,
  status        text not null default 'open' check (status in ('open','done','cancelled')),
  priority      text not null default 'normal' check (priority in ('low','normal','high')),
  notes         text,
  completed_at  timestamptz,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_crm_tasks_contact on public.crm_tasks (contact_id);
create index if not exists idx_crm_tasks_due on public.crm_tasks (due_at) where status = 'open';
create index if not exists idx_crm_tasks_reminder on public.crm_tasks (reminder_at)
  where status = 'open' and reminder_at is not null and reminded_at is null;

drop trigger if exists trg_crm_tasks_touch on public.crm_tasks;
create trigger trg_crm_tasks_touch before update on public.crm_tasks
  for each row execute function public.crm_touch_updated_at();

-- Keep crm_contacts.next_follow_up_at = MIN(open task due_at) for that contact.
create or replace function public.crm_recalc_followup(p_contact uuid)
returns void language sql as $$
  update public.crm_contacts c
    set next_follow_up_at = (
      select min(t.due_at) from public.crm_tasks t
      where t.contact_id = p_contact and t.status = 'open' and t.due_at is not null
    )
    where c.id = p_contact;
$$;

create or replace function public.crm_task_followup_sync()
returns trigger language plpgsql as $$
begin
  if tg_op in ('INSERT','UPDATE') and new.contact_id is not null then
    perform public.crm_recalc_followup(new.contact_id);
  end if;
  if tg_op in ('UPDATE','DELETE') and old.contact_id is not null
     and old.contact_id is distinct from new.contact_id then
    perform public.crm_recalc_followup(old.contact_id);
  end if;
  return null;
end $$;

drop trigger if exists trg_crm_task_followup on public.crm_tasks;
create trigger trg_crm_task_followup after insert or update or delete on public.crm_tasks
  for each row execute function public.crm_task_followup_sync();

-- ── Campaigns (blast + drip) ─────────────────────────────────────────────────
create table if not exists public.crm_campaigns (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  channel      text not null check (channel in ('email','sms')),
  type         text not null default 'blast' check (type in ('blast','drip')),
  status       text not null default 'draft'
                 check (status in ('draft','scheduled','sending','active','paused','done','archived')),
  subject      text,
  from_name    text,
  body         text,                    -- template w/ {{first_name}} etc. (blast only)
  audience     jsonb not null default '{}',   -- segment filter definition
  scheduled_at timestamptz,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
drop trigger if exists trg_crm_campaigns_touch on public.crm_campaigns;
create trigger trg_crm_campaigns_touch before update on public.crm_campaigns
  for each row execute function public.crm_touch_updated_at();

create table if not exists public.crm_campaign_steps (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.crm_campaigns (id) on delete cascade,
  position      int  not null default 0,
  delay_minutes int  not null default 0,   -- after enrollment (or previous step)
  channel       text not null check (channel in ('email','sms')),
  subject       text,
  body          text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists idx_crm_steps_campaign on public.crm_campaign_steps (campaign_id, position);

create table if not exists public.crm_enrollments (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.crm_campaigns (id) on delete cascade,
  contact_id   uuid not null references public.crm_contacts (id)  on delete cascade,
  status       text not null default 'active'
                 check (status in ('active','completed','unsubscribed','failed','cancelled')),
  current_step int not null default 0,
  next_run_at  timestamptz,
  enrolled_at  timestamptz not null default now(),
  completed_at timestamptz,
  unique (campaign_id, contact_id)
);
create index if not exists idx_crm_enroll_due on public.crm_enrollments (next_run_at)
  where status = 'active';

-- ── Messages (email/SMS log) ─────────────────────────────────────────────────
create table if not exists public.crm_messages (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid references public.crm_contacts (id) on delete set null,
  campaign_id  uuid references public.crm_campaigns (id) on delete set null,
  channel      text not null check (channel in ('email','sms')),
  direction    text not null check (direction in ('inbound','outbound')),
  from_addr    text,
  to_addr      text,
  subject      text,
  body         text,
  status       text not null default 'queued',  -- queued|sent|delivered|failed|received|bounced|opened|clicked
  provider     text,                            -- resend|twilio
  provider_id  text,                            -- resend id / twilio sid
  error        text,
  meta         jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_crm_msg_contact on public.crm_messages (contact_id, created_at desc);
create index if not exists idx_crm_msg_provider on public.crm_messages (provider, provider_id);

drop trigger if exists trg_crm_msg_touch on public.crm_messages;
create trigger trg_crm_msg_touch before update on public.crm_messages
  for each row execute function public.crm_touch_updated_at();

-- ── RLS: platform admins only; service role bypasses for webhooks/cron ────────
alter table public.crm_companies      enable row level security;
alter table public.crm_contacts       enable row level security;
alter table public.crm_stages         enable row level security;
alter table public.crm_deals          enable row level security;
alter table public.crm_activities     enable row level security;
alter table public.crm_tasks          enable row level security;
alter table public.crm_campaigns      enable row level security;
alter table public.crm_campaign_steps enable row level security;
alter table public.crm_enrollments    enable row level security;
alter table public.crm_messages       enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'crm_companies','crm_contacts','crm_stages','crm_deals','crm_activities',
    'crm_tasks','crm_campaigns','crm_campaign_steps','crm_enrollments','crm_messages'
  ] loop
    execute format('drop policy if exists %I on public.%I;', t || '_admin_all', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_admin()) with check (public.is_admin());',
      t || '_admin_all', t);
  end loop;
end $$;

-- ── Seed default pipeline stages ─────────────────────────────────────────────
insert into public.crm_stages (name, position, probability, is_won, is_lost) values
  ('New',        0, 0.05, false, false),
  ('Contacted',  1, 0.15, false, false),
  ('Qualified',  2, 0.35, false, false),
  ('Proposal',   3, 0.60, false, false),
  ('Negotiation',4, 0.80, false, false),
  ('Won',        5, 1.00, true,  false),
  ('Lost',       6, 0.00, false, true)
on conflict (name) do nothing;

-- ── Backfill from existing website contact-form submissions ──────────────────
-- Companies first (distinct, non-empty), then contacts, then a form_submission
-- activity per submission. Idempotent via the unique email/domain indexes.
insert into public.crm_companies (name, source, custom)
select distinct on (lower(cs.company)) cs.company, 'contact_form', '{}'::jsonb
from public.contact_submissions cs
where cs.company is not null and cs.company <> ''
  and not exists (
    select 1 from public.crm_companies c where lower(c.name) = lower(cs.company)
  )
on conflict do nothing;

insert into public.crm_contacts (first_name, last_name, email, company_id, lifecycle_stage, source, notes, created_at)
select
  split_part(cs.name, ' ', 1),
  nullif(regexp_replace(cs.name, '^\S+\s*', ''), ''),
  lower(cs.email),
  co.id,
  'lead',
  'contact_form',
  cs.message,
  cs.created_at
from public.contact_submissions cs
left join public.crm_companies co on lower(co.name) = lower(cs.company)
where cs.email is not null and cs.email <> ''
on conflict (lower(email)) where email is not null and email <> '' do nothing;

insert into public.crm_activities (contact_id, type, direction, subject, body, occurred_at, meta)
select ct.id, 'form_submission', 'inbound',
       'Website contact form',
       cs.message,
       cs.created_at,
       jsonb_build_object('revenue_stage', cs.revenue_stage, 'source_id', cs.id)
from public.contact_submissions cs
join public.crm_contacts ct on ct.email = lower(cs.email)
where not exists (
  select 1 from public.crm_activities a
  where a.contact_id = ct.id and a.type = 'form_submission'
    and a.meta->>'source_id' = cs.id::text
);
