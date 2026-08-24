-- ───────────────────────────────────────────────────────────────────────────
-- CRM Conversations: a unified inbox over crm_messages. One row per
-- (contact, channel) carrying inbox state (unread / status / assignee / last
-- activity). Maintained by a trigger on crm_messages insert, so every SMS/email
-- in or out keeps the thread current. Staff-gated.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_conversations (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references public.crm_contacts (id) on delete cascade,
  channel         text not null check (channel in ('email','sms')),
  status          text not null default 'open' check (status in ('open','snoozed','closed')),
  assignee        uuid references auth.users (id) on delete set null,
  unread          boolean not null default false,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  snooze_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (contact_id, channel)
);
create index if not exists idx_crm_conv_inbox on public.crm_conversations (status, last_message_at desc);
create index if not exists idx_crm_conv_unread on public.crm_conversations (unread) where unread;
create index if not exists idx_crm_conv_assignee on public.crm_conversations (assignee);

drop trigger if exists trg_crm_conv_touch on public.crm_conversations;
create trigger trg_crm_conv_touch before update on public.crm_conversations
  for each row execute function public.crm_touch_updated_at();

-- Keep the conversation current from every logged message.
create or replace function public.crm_sync_conversation()
returns trigger language plpgsql as $$
begin
  if new.contact_id is null then return new; end if;
  insert into public.crm_conversations
      (contact_id, channel, last_message_at, last_inbound_at, unread, status)
    values (
      new.contact_id, new.channel, new.created_at,
      case when new.direction = 'inbound' then new.created_at end,
      new.direction = 'inbound',
      'open')
  on conflict (contact_id, channel) do update set
    last_message_at = greatest(public.crm_conversations.last_message_at, excluded.last_message_at),
    last_inbound_at = case when new.direction = 'inbound'
                        then greatest(public.crm_conversations.last_inbound_at, new.created_at)
                        else public.crm_conversations.last_inbound_at end,
    -- Inbound marks unread + reopens a closed thread; outbound leaves both.
    unread = case when new.direction = 'inbound' then true else public.crm_conversations.unread end,
    status = case when new.direction = 'inbound' and public.crm_conversations.status = 'closed'
                  then 'open' else public.crm_conversations.status end,
    updated_at = now();
  return new;
end $$;

drop trigger if exists trg_crm_msg_conversation on public.crm_messages;
create trigger trg_crm_msg_conversation after insert on public.crm_messages
  for each row execute function public.crm_sync_conversation();

alter table public.crm_conversations enable row level security;
drop policy if exists crm_conversations_staff_all on public.crm_conversations;
create policy crm_conversations_staff_all on public.crm_conversations
  for all using (public.is_staff()) with check (public.is_staff());

-- Backfill from existing messages (historical threads start read).
insert into public.crm_conversations (contact_id, channel, last_message_at, last_inbound_at, unread, status)
select m.contact_id, m.channel,
       max(m.created_at),
       max(m.created_at) filter (where m.direction = 'inbound'),
       false, 'open'
from public.crm_messages m
where m.contact_id is not null
group by m.contact_id, m.channel
on conflict (contact_id, channel) do nothing;
