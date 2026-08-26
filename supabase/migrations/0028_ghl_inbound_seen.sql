-- A lead is anyone who reached IN — by text, call, chat, email, OR a form/ad
-- that GHL logged as an inbound contact. The message export only carries the
-- text/call/chat/email transcript; form and ad leads show up ONLY in the
-- conversation search index (an inbound lastMessageDirection, an unread inbound,
-- with no message we can pull). inbound_seen captures that signal from the
-- search record so those threads count as leads instead of being filed as
-- "outbound only" and dropped from every number.
--
-- Set in sync pass 1 (from the search record) and deliberately NOT touched by
-- the transcript recompute (pass 3), which can't see it. Existing rows default
-- to false and are corrected on the next full sync.

alter table public.ghl_conversations
  add column if not exists inbound_seen boolean not null default false;
