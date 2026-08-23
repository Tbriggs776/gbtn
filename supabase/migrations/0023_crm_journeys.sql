-- CRM branching journeys: wait_event + yes/no next positions.
-- Apply via normal migration flow; do not run against production from this PR.

alter table public.crm_campaign_steps
  add column if not exists kind text not null default 'send',
  add column if not exists wait_event text,
  add column if not exists wait_hours int,
  add column if not exists next_yes int,
  add column if not exists next_no int;

alter table public.crm_campaign_steps drop constraint if exists crm_campaign_steps_kind_check;
alter table public.crm_campaign_steps
  add constraint crm_campaign_steps_kind_check
  check (kind in ('send', 'wait_event', 'exit'));

alter table public.crm_campaign_steps drop constraint if exists crm_campaign_steps_wait_event_check;
alter table public.crm_campaign_steps
  add constraint crm_campaign_steps_wait_event_check
  check (wait_event is null or wait_event in ('opened', 'clicked', 'replied', 'stage_changed'));

alter table public.crm_enrollments
  add column if not exists context jsonb not null default '{}';
