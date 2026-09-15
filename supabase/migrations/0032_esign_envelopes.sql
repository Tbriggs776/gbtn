-- ───────────────────────────────────────────────────────────────────────────
-- Phase 32: e-sign v2 — multi-signer envelopes, placed fields, any file type.
--
-- ADDITIVE. 0031's signature_request / signature_event tables are left in
-- place (0 rows; 0033 drops them), because v1 is deployed on main and this
-- file is applied to production BEFORE the v2 code ships. v1's create and
-- finalize functions are neutered in §8b so deployed v1 cannot start or
-- finish a signature during the migrate -> deploy window.
--
-- Everything 0031's header says still applies and is not repeated here:
--   * signers never touch these tables (token_hash lookup + service role only);
--   * one state change = one function that locks and re-checks;
--   * events are append-only for EVERY role; rows are never deleted;
--   * this project's default ACL grants anon/authenticated full DML on new
--     tables and EXECUTE on new functions, so this file revokes explicitly;
--   * guards and transition functions are SECURITY INVOKER on purpose.
--
-- v2-specific choices a reviewer should not "fix":
--   1. Tokens live in their own append-only table. A sequential recipient has
--      no token until activated, so no raw token is ever held server-side
--      waiting for a turn, and "resend to one recipient" is rotation, not a
--      mutation of an evidence column.
--   2. Field geometry is integer parts-per-million of the DISPLAYED page,
--      top-left origin, and lives inside document_snapshot (so it is hashed).
--      Integers because canonicalJson rejects non-safe-integers.
--   3. The envelope has a 'completing' state. "All recipients signed but the
--      sealed PDF is not written yet" is reachable (two parallel finishers, or
--      a timeout mid-seal), so it is a named state with an idempotent recovery
--      path rather than an impossible one.
--   4. Superseded siblings are RECORDED, so a void/decline/expiry can undo
--      them. 0031 step 13 was one-way.
--   5. v2 writes NO client-files convenience copy. The sealed PDF lives only in
--      the private esign bucket. §11 still hardens client_files_select.
--   6. Countersigners are platform admins only (esign_is_countersigner) until
--      lib/auth.ts is hardened.
--   7. v1 create/finalize are neutered here; v1 tables stay until 0033.
--   8. The pg_cron job esign-sweep-expired runs pure SQL; it needs no route and
--      no secret.
--   9. There is no completing -> in_progress rollback; a stuck seal is
--      abandoned by staff (esign_abandon_seal).
--
-- Lock order, binding for every function in §8:
--   envelope row -> all recipients of that envelope (id order) -> access-token
--   row -> document -> siblings (id order).
-- Signer paths resolve the token WITHOUT a lock, take the locks, then re-select
-- the token by id `and revoked_at is null for update`.
--
-- storage.objects policy DDL in §11 works as postgres only because
-- supautils.policy_grants lists storage.objects for postgres (as 0031).
--
-- Idempotent: re-running is the normal recovery path (no migration ledger).
-- No begin/commit: the file must be safe to re-run from the top.
-- ───────────────────────────────────────────────────────────────────────────


-- ── §1 esign_document_type additions ────────────────────────────────────────

alter table public.esign_document_type
  add column if not exists sealing_mode           text     not null default 'auto',
  add column if not exists max_recipients         smallint not null default 10,
  add column if not exists allow_typed_signature  boolean  not null default true,
  add column if not exists allow_outside_signers  boolean  not null default true,
  add column if not exists consent_text_outside   text,
  add column if not exists consent_text_staff     text;

comment on column public.esign_document_type.sealing_mode is
  'auto = PDFs and images get placed fields, everything else gets a signature certificate page; page = refuse anything that cannot carry placed fields; certificate = always use the certificate page.';
comment on column public.esign_document_type.consent_text_outside is
  'Consent shown to a typed-in outside signer. NULL falls back to consent_text.';
comment on column public.esign_document_type.consent_text_staff is
  'Consent shown to a GBTN staff countersigner. NULL falls back to consent_text.';

alter table public.esign_document_type drop constraint if exists esign_document_type_sealing_check;
alter table public.esign_document_type add constraint esign_document_type_sealing_check
  check (sealing_mode in ('auto','page','certificate'));

alter table public.esign_document_type drop constraint if exists esign_document_type_recipients_check;
alter table public.esign_document_type add constraint esign_document_type_recipients_check
  check (max_recipients between 1 and 10);

-- Widen the default for NEW rows. v2 sniffs the real bytes anyway; this list is
-- the staff-facing pre-check. Legacy OLE Office types are deliberately absent.
alter table public.esign_document_type
  alter column allowed_content_types set default array[
    'application/pdf','image/png','image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain','text/csv'];

-- Config data, not client data: widen the seeded msa row ONCE, only while it is
-- still exactly the 0031 seed value. Re-running is a no-op.
update public.esign_document_type
   set allowed_content_types = array[
         'application/pdf','image/png','image/jpeg',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'text/plain','text/csv']
 where document_type = 'msa'
   and allowed_content_types = array['application/pdf'];


-- ── §2 signature_envelope ───────────────────────────────────────────────────

create table if not exists public.signature_envelope (
  id                          uuid primary key,          -- app-supplied (frozen paths)
  client_id                   uuid not null references public.clients (id)   on delete restrict,
  document_id                 uuid not null references public.documents (id) on delete restrict,
  engagement_id               uuid references public.engagements (id) on delete set null,
  document_type               text not null references public.esign_document_type (document_type) on delete restrict,
  created_by                  uuid,                      -- staff user id; deliberately NO FK
  status                      text not null default 'in_progress',
  routing_mode                text not null,             -- parallel | sequential
  source_mode                 text not null,             -- pdf | image_pdf | certificate

  -- The original, exactly as uploaded (frozen at send).
  original_frozen_path        text not null,             -- esign: envelopes/{id}/original.bin
  original_sha256             text not null,
  original_content_type       text not null,             -- SNIFFED, not documents.content_type
  original_file_name          text not null,
  original_byte_size          bigint not null,

  -- The PDF that is actually signed. == original for source_mode 'pdf'.
  render_frozen_path          text not null,             -- esign: envelopes/{id}/render.pdf
  render_sha256               text not null,
  page_count                  int  not null,

  hash_version                smallint not null default 2,
  document_snapshot           jsonb not null,            -- includes pages[] and fields[]
  document_hash               text not null,
  envelope_hash               text,                      -- set at completion
  last_receipt_sha256         text,                      -- receipt-chain head

  doc_status_before_send      text not null,
  doc_type_before_send        text,
  doc_engagement_before_send  uuid,                      -- snapshot, not a reference
  supersede_siblings          boolean not null default false,

  sealed_pdf_path             text,                      -- esign bucket only
  sealed_pdf_sha256           text,
  seal_lease_id               uuid,                      -- exclusive seal lease (esign_claim_seal)
  seal_lease_until            timestamptz,
  seal_attempts               smallint not null default 0,
  seal_next_attempt_at        timestamptz,               -- backoff after a failed seal

  sent_at                     timestamptz not null default now(),
  expires_at                  timestamptz not null,
  completing_at               timestamptz,
  completed_at                timestamptz,
  voided_at                   timestamptz,
  void_reason                 text,
  declined_by_recipient_id    uuid,                      -- no FK: avoids a create-time cycle
  expired_at                  timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Columns added after the table shape was first published (no-ops on a fresh table).
alter table public.signature_envelope
  add column if not exists seal_lease_id         uuid,
  add column if not exists seal_lease_until      timestamptz,
  add column if not exists seal_attempts         smallint not null default 0,
  add column if not exists seal_next_attempt_at  timestamptz;

alter table public.signature_envelope drop constraint if exists signature_envelope_status_check;
alter table public.signature_envelope add constraint signature_envelope_status_check
  check (status in ('in_progress','completing','completed','declined','voided','expired'));

alter table public.signature_envelope drop constraint if exists signature_envelope_mode_check;
alter table public.signature_envelope add constraint signature_envelope_mode_check
  check (routing_mode in ('parallel','sequential')
     and source_mode  in ('pdf','image_pdf','certificate'));

alter table public.signature_envelope drop constraint if exists signature_envelope_hash_format_check;
alter table public.signature_envelope add constraint signature_envelope_hash_format_check
  check (original_sha256 ~ '^[0-9a-f]{64}$'
     and render_sha256   ~ '^[0-9a-f]{64}$'
     and document_hash   ~ '^[0-9a-f]{64}$'
     and (envelope_hash       is null or envelope_hash       ~ '^[0-9a-f]{64}$')
     and (last_receipt_sha256 is null or last_receipt_sha256 ~ '^[0-9a-f]{64}$')
     and (sealed_pdf_sha256   is null or sealed_pdf_sha256   ~ '^[0-9a-f]{64}$'));

alter table public.signature_envelope drop constraint if exists signature_envelope_shape_check;
alter table public.signature_envelope add constraint signature_envelope_shape_check
  check (page_count between 1 and 200
     and original_byte_size >= 0
     and char_length(original_file_name) between 1 and 400
     and char_length(original_content_type) between 1 and 200
     and (void_reason is null or char_length(void_reason) <= 1000)
     and seal_attempts between 0 and 1000);

alter table public.signature_envelope drop constraint if exists signature_envelope_before_send_check;
alter table public.signature_envelope add constraint signature_envelope_before_send_check
  check (doc_status_before_send in ('draft','sent','executed','superseded')
     and (doc_type_before_send is null
          or doc_type_before_send in ('msa','sow','onboarding','report','deliverable','other')));

-- A completed envelope must carry its sealed output and its chain head, and no lease.
alter table public.signature_envelope drop constraint if exists signature_envelope_completed_check;
alter table public.signature_envelope add constraint signature_envelope_completed_check
  check (status <> 'completed' or (
        completed_at is not null
    and sealed_pdf_path is not null and sealed_pdf_sha256 is not null
    and envelope_hash is not null and last_receipt_sha256 is not null
    and seal_lease_id is null and seal_lease_until is null));

-- certificate mode never has a separate render: the generated signature page IS
-- the render, and it is always distinct from the original.
alter table public.signature_envelope drop constraint if exists signature_envelope_source_check;
alter table public.signature_envelope add constraint signature_envelope_source_check
  check ((source_mode = 'pdf' and render_sha256 = original_sha256)
      or (source_mode in ('image_pdf','certificate')));

-- A lease is a (id, until) pair and only exists while completing.
alter table public.signature_envelope drop constraint if exists signature_envelope_lease_check;
alter table public.signature_envelope add constraint signature_envelope_lease_check
  check ((seal_lease_id is null) = (seal_lease_until is null)
     and (seal_lease_id is null or status = 'completing'));

create unique index if not exists uq_signature_envelope_open_per_document
  on public.signature_envelope (document_id) where status in ('in_progress','completing');
create unique index if not exists uq_signature_envelope_completed_per_document
  on public.signature_envelope (document_id) where status = 'completed';
create index if not exists idx_signature_envelope_client
  on public.signature_envelope (client_id, sent_at desc);
create index if not exists idx_signature_envelope_document
  on public.signature_envelope (document_id, sent_at desc);
create index if not exists idx_signature_envelope_due
  on public.signature_envelope (expires_at) where status = 'in_progress';

drop trigger if exists trg_signature_envelope_touch on public.signature_envelope;
create trigger trg_signature_envelope_touch before update on public.signature_envelope
  for each row execute function public.touch_updated_at();


-- ── §3 signature_recipient ──────────────────────────────────────────────────

create table if not exists public.signature_recipient (
  id                     uuid primary key,               -- app-supplied
  envelope_id            uuid not null references public.signature_envelope (id) on delete restrict,
  client_id              uuid not null references public.clients (id) on delete restrict,
  kind                   text not null,                  -- client_contact | outside | staff
  routing_order          smallint not null,
  status                 text not null default 'pending',

  contact_id             uuid references public.client_contacts (id) on delete set null,
  staff_user_id          uuid,                           -- deliberately NO FK
  name                   text not null,
  email                  text not null,
  phone                  text,                           -- E.164 when present

  consent_text           text not null,                  -- FILLED, per recipient kind
  checkbox_text          text not null,
  recipient_hash         text not null,

  require_sms_otp        boolean not null default false,
  otp_hash               text,
  otp_expires_at         timestamptz,
  otp_attempts           int not null default 0,
  otp_sends              int not null default 0,
  otp_last_sent_at       timestamptz,
  otp_verified_at        timestamptz,
  otp_session_hash       text,
  otp_session_expires_at timestamptz,

  activated_at           timestamptz,
  viewed_at              timestamptz,
  source_opened_at       timestamptz,
  original_downloaded_at timestamptz,
  consent_agreed_at      timestamptz,
  signed_at              timestamptz,
  printed_name           text,
  signature_method       text,                           -- drawn | typed
  signature_image_path   text,                           -- esign bucket, drawn only
  signature_image_sha256 text,
  typed_signature_text   text,                           -- typed only
  typed_signature_font   text,                           -- typed only, e.g. 'great-vibes-1'
  date_text              text,                           -- exactly what was stamped
  time_zone              text,                           -- IANA zone used for date_text
  prev_receipt_sha256    text,
  receipt_sha256         text,
  applied_field_ids      uuid[],                         -- signature fields this signer applied (evidence)
  chain_index            smallint,                       -- 1-based position in the receipt chain
  signed_ip              text,
  signed_user_agent      text,
  declined_at            timestamptz,
  decline_reason         text,
  canceled_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.signature_recipient
  add column if not exists applied_field_ids  uuid[],
  add column if not exists chain_index        smallint;

alter table public.signature_recipient drop constraint if exists signature_recipient_status_check;
alter table public.signature_recipient add constraint signature_recipient_status_check
  check (status in ('pending','sent','viewed','otp_sent','otp_verified','signed','declined','canceled'));

-- No contact_id requirement: ON DELETE SET NULL must be able to run on a signed
-- recipient; document_snapshot.recipients[].contact_id keeps the evidence.
alter table public.signature_recipient drop constraint if exists signature_recipient_kind_check;
alter table public.signature_recipient add constraint signature_recipient_kind_check
  check (kind in ('client_contact','outside','staff')
     and routing_order between 1 and 10
     and (kind <> 'staff' or staff_user_id is not null)
     and (kind =  'staff' or staff_user_id is null));

alter table public.signature_recipient drop constraint if exists signature_recipient_email_check;
alter table public.signature_recipient add constraint signature_recipient_email_check
  check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     and char_length(email) <= 254
     and char_length(name) between 1 and 200
     and (printed_name is null or char_length(printed_name) between 2 and 120)
     and (decline_reason is null or char_length(decline_reason) <= 1000)
     and (typed_signature_text is null or char_length(typed_signature_text) between 2 and 120));

alter table public.signature_recipient drop constraint if exists signature_recipient_hash_format_check;
alter table public.signature_recipient add constraint signature_recipient_hash_format_check
  check (recipient_hash ~ '^[0-9a-f]{64}$'
     and (otp_session_hash       is null or otp_session_hash       ~ '^[0-9a-f]{64}$')
     and (signature_image_sha256 is null or signature_image_sha256 ~ '^[0-9a-f]{64}$')
     and (receipt_sha256         is null or receipt_sha256         ~ '^[0-9a-f]{64}$')
     and (prev_receipt_sha256    is null or prev_receipt_sha256    ~ '^[0-9a-f]{64}$'));

alter table public.signature_recipient drop constraint if exists signature_recipient_otp_check;
alter table public.signature_recipient add constraint signature_recipient_otp_check
  check ((not require_sms_otp or phone is not null)
     and otp_attempts >= 0 and otp_sends >= 0);

-- Method-aware completion. Replaces 0031's signed_complete_check (240-248),
-- which assumed one drawn image AND a sealed output at the moment of signing.
alter table public.signature_recipient drop constraint if exists signature_recipient_signed_check;
alter table public.signature_recipient add constraint signature_recipient_signed_check
  check (status <> 'signed' or (
        signed_at is not null and consent_agreed_at is not null
    and printed_name is not null and receipt_sha256 is not null
    and date_text is not null and time_zone is not null
    and signature_method in ('drawn','typed')
    and (signature_method <> 'drawn'
         or (signature_image_path is not null and signature_image_sha256 is not null))
    and (signature_method <> 'typed'
         or (typed_signature_text is not null and typed_signature_font is not null))
    and (not require_sms_otp or otp_verified_at is not null)
    and applied_field_ids is not null and cardinality(applied_field_ids) between 1 and 100
    and chain_index is not null));

alter table public.signature_recipient drop constraint if exists signature_recipient_chain_check;
alter table public.signature_recipient add constraint signature_recipient_chain_check
  check (chain_index is null or chain_index between 1 and 10);

create unique index if not exists uq_signature_recipient_email
  on public.signature_recipient (envelope_id, lower(email));
create unique index if not exists uq_signature_recipient_staff
  on public.signature_recipient (envelope_id) where kind = 'staff';
create unique index if not exists uq_signature_recipient_chain
  on public.signature_recipient (envelope_id, chain_index) where chain_index is not null;
create index if not exists idx_signature_recipient_envelope
  on public.signature_recipient (envelope_id, routing_order, id);

drop trigger if exists trg_signature_recipient_touch on public.signature_recipient;
create trigger trg_signature_recipient_touch before update on public.signature_recipient
  for each row execute function public.touch_updated_at();


-- ── §4 signature_field, signature_access_token, signature_supersede ─────────

create table if not exists public.signature_field (
  id             uuid primary key,                       -- app-supplied (matches the snapshot)
  envelope_id    uuid not null references public.signature_envelope (id)  on delete restrict,
  recipient_id   uuid not null references public.signature_recipient (id) on delete restrict,
  client_id      uuid not null references public.clients (id) on delete restrict,
  kind           text not null,                          -- signature | date_signed | printed_name
  page           int  not null,
  x_ppm          int  not null,
  y_ppm          int  not null,
  w_ppm          int  not null,
  h_ppm          int  not null,
  required       boolean not null default true,
  origin         text not null default 'staff',          -- detected | staff | generated
  detected_label text,
  created_at     timestamptz not null default now()
);

alter table public.signature_field drop constraint if exists signature_field_shape_check;
alter table public.signature_field add constraint signature_field_shape_check
  check (kind in ('signature','date_signed','printed_name')
     and origin in ('detected','staff','generated')
     and page >= 0
     and x_ppm >= 0 and y_ppm >= 0 and w_ppm > 0 and h_ppm > 0
     and x_ppm + w_ppm <= 1000000
     and y_ppm + h_ppm <= 1000000
     and (detected_label is null or char_length(detected_label) <= 200));

create index if not exists idx_signature_field_envelope
  on public.signature_field (envelope_id, page, id);
create index if not exists idx_signature_field_recipient
  on public.signature_field (recipient_id, id);

-- ── Access tokens (append-only; rotation = revoke + issue) ──────────────────
create table if not exists public.signature_access_token (
  id            uuid primary key default gen_random_uuid(),
  envelope_id   uuid not null references public.signature_envelope (id)  on delete restrict,
  recipient_id  uuid not null references public.signature_recipient (id) on delete restrict,
  client_id     uuid not null references public.clients (id) on delete restrict,
  token_hash    text not null,
  issued_at     timestamptz not null default now(),
  issued_by     uuid,                                    -- deliberately NO FK
  revoked_at    timestamptz,
  revoke_reason text
);

alter table public.signature_access_token drop constraint if exists signature_access_token_shape_check;
alter table public.signature_access_token add constraint signature_access_token_shape_check
  check (token_hash ~ '^[0-9a-f]{64}$'
     and (revoked_at is null) = (revoke_reason is null)
     and (revoke_reason is null or revoke_reason in ('rotated','closed','expired','replaced')));

create unique index if not exists uq_signature_access_token_hash
  on public.signature_access_token (token_hash);
-- At most ONE live token per recipient.
create unique index if not exists uq_signature_access_token_live
  on public.signature_access_token (recipient_id) where revoked_at is null;
create index if not exists idx_signature_access_token_envelope
  on public.signature_access_token (envelope_id, id);
create index if not exists idx_signature_access_token_recipient_issued
  on public.signature_access_token (recipient_id, issued_at desc);

-- ── Supersede bookkeeping (follow-up (b)) ───────────────────────────────────
create table if not exists public.signature_supersede (
  envelope_id     uuid not null references public.signature_envelope (id) on delete restrict,
  document_id     uuid not null references public.documents (id) on delete restrict,
  status_before   text not null,
  doc_type_before text,
  superseded_at   timestamptz not null default now(),
  restored_at     timestamptz,
  primary key (envelope_id, document_id)
);

alter table public.signature_supersede drop constraint if exists signature_supersede_status_check;
alter table public.signature_supersede add constraint signature_supersede_status_check
  check (status_before in ('draft','sent','executed','superseded'));

create index if not exists idx_signature_supersede_document
  on public.signature_supersede (document_id);


-- ── §5 signature_envelope_event (append-only) ───────────────────────────────

create table if not exists public.signature_envelope_event (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,
  envelope_id   uuid not null references public.signature_envelope (id)  on delete restrict,
  recipient_id  uuid references public.signature_recipient (id) on delete restrict,
  event         text not null,
  actor         text not null default 'signer',
  actor_user_id uuid,                                    -- deliberately NO FK
  ip            text,
  user_agent    text,
  meta          jsonb not null default '{}'::jsonb,      -- never a token, OTP, path, email, phone or typed text
  at            timestamptz not null default now()
);

alter table public.signature_envelope_event drop constraint if exists signature_envelope_event_event_check;
alter table public.signature_envelope_event add constraint signature_envelope_event_event_check
  check (event in (
    -- envelope level
    'sent','superseded','supersede_restored','voided','expired','completing','completed',
    'sealed','seal_failed','seal_abandoned','engagement_activated','drift_detected',
    'notified','notify_failed',
    -- recipient level
    'recipient_activated','token_issued','token_revoked','viewed','source_opened',
    'original_downloaded','otp_sent','otp_send_failed','otp_failed','otp_locked','otp_verified',
    'consented','signed','declined','canceled','sealed_downloaded'));

alter table public.signature_envelope_event drop constraint if exists signature_envelope_event_shape_check;
alter table public.signature_envelope_event add constraint signature_envelope_event_shape_check
  check (actor in ('signer','staff','system')
     and (ip is null or char_length(ip) <= 64)
     and (user_agent is null or char_length(user_agent) <= 512)
     and jsonb_typeof(meta) = 'object');

-- Only a signer's own network details are evidence (0031 header note 3), and a
-- signer row must name which recipient it belongs to.
alter table public.signature_envelope_event drop constraint if exists signature_envelope_event_network_check;
alter table public.signature_envelope_event add constraint signature_envelope_event_network_check
  check ((actor = 'signer' and recipient_id is not null)
      or (actor <> 'signer' and ip is null and user_agent is null));

create index if not exists idx_signature_envelope_event_envelope
  on public.signature_envelope_event (envelope_id, seq);
create index if not exists idx_signature_envelope_event_recipient
  on public.signature_envelope_event (recipient_id, seq);


-- ── §6 documents pointer ────────────────────────────────────────────────────

alter table public.documents
  add column if not exists esign_envelope_id uuid
      references public.signature_envelope (id) on delete set null;

comment on column public.documents.esign_envelope_id is
  'Latest e-sign v2 envelope for this document (set at send, kept after completion). Supersedes signature_request_id, which 0033 drops.';

create index if not exists idx_documents_esign_envelope
  on public.documents (esign_envelope_id) where esign_envelope_id is not null;


-- ── §7a Helpers ─────────────────────────────────────────────────────────────

-- S1/S11: the countersigner predicate. The ONE place to widen later (an
-- employee rule, once lib/auth.ts refuses employee targets). SECURITY INVOKER;
-- p_client_id is unused on purpose. EXECUTE: service_role only (§10).
create or replace function public.esign_is_countersigner(p_user_id uuid, p_client_id uuid)
returns boolean language sql stable as $$
  select p_user_id is not null and exists (
    select 1 from public.profiles p where p.id = p_user_id and p.role = 'admin');
$$;

-- S3: once a document has e-sign records its client-files bytes are service-role
-- only (staff included). SECURITY DEFINER because documents_select hides
-- visible_to_client = false rows from members.
create or replace function public.document_esign_locked(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.documents d
     where d.storage_path = p_name
       and (d.signature_request_id is not null or d.esign_envelope_id is not null or d.signed_at is not null));
$$;
revoke all on function public.document_esign_locked(text) from public, anon;
grant execute on function public.document_esign_locked(text) to authenticated, service_role;

-- A superseded (or superseded-then-restored) sibling carries no e-sign pointer
-- but is pinned by signature_supersede's ON DELETE RESTRICT FK. The documents
-- guard asks this before a DELETE so the refusal is a plain message, not FK
-- text. SECURITY DEFINER because signature_supersede is staff-read under RLS
-- and client members reach the guard through the cookie client.
create or replace function public.document_esign_superseded(p_document_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.signature_supersede s where s.document_id = p_document_id);
$$;
revoke all on function public.document_esign_superseded(uuid) from public, anon;
grant execute on function public.document_esign_superseded(uuid) to authenticated, service_role;


-- ── §7 Guards (SECURITY INVOKER; EXECUTE revoked from everyone in §10) ──────

-- ── Events: append-only for EVERY role, service role included. ─────────────
create or replace function public.esign_envelope_event_guard()
returns trigger language plpgsql as $$
begin
  if public.esign_override_on() then return coalesce(new, old); end if;
  if tg_op in ('UPDATE','DELETE','TRUNCATE') then
    raise exception 'signature_envelope_event is append-only.' using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign events are written by the server only.' using errcode = 'insufficient_privilege';
  end if;
  -- A recipient event must belong to the same envelope.
  if new.recipient_id is not null and not exists (
       select 1 from public.signature_recipient r
        where r.id = new.recipient_id and r.envelope_id = new.envelope_id) then
    raise exception 'esign_tenant_mismatch: recipient % is not in envelope %', new.recipient_id, new.envelope_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_signature_envelope_event_guard on public.signature_envelope_event;
create trigger trg_signature_envelope_event_guard
  before insert or update or delete on public.signature_envelope_event
  for each row execute function public.esign_envelope_event_guard();

drop trigger if exists trg_signature_envelope_event_no_truncate on public.signature_envelope_event;
create trigger trg_signature_envelope_event_no_truncate
  before truncate on public.signature_envelope_event
  for each statement execute function public.esign_envelope_event_guard();

-- ── Envelope: tenancy, immutable evidence, legal transitions. ──────────────
-- There is NO completing -> in_progress transition (C1): once every recipient
-- has signed, the envelope either completes or is voided (drift / abandon).
create or replace function public.esign_envelope_guard()
returns trigger language plpgsql as $$
declare
  v_client    uuid;
  v_immutable text[] := array[
    'id','client_id','document_id','document_type','created_by','routing_mode','source_mode',
    'original_frozen_path','original_sha256','original_content_type','original_file_name',
    'original_byte_size','render_frozen_path','render_sha256','page_count',
    'hash_version','document_snapshot','document_hash','sent_at','expires_at','created_at',
    'doc_status_before_send','doc_type_before_send','doc_engagement_before_send','supersede_siblings'];
  v_fk_nullable text[] := array['engagement_id','updated_at'];
begin
  if public.esign_override_on() then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    raise exception 'Signature envelopes are retained as evidence; void instead.'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign envelopes are written by the server only.' using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' then
    select d.client_id into v_client from public.documents d where d.id = new.document_id;
    if v_client is distinct from new.client_id then
      raise exception 'esign_tenant_mismatch: document % is not client %', new.document_id, new.client_id
        using errcode = 'check_violation';
    end if;
    if new.engagement_id is not null then
      select e.client_id into v_client from public.engagements e where e.id = new.engagement_id;
      if v_client is distinct from new.client_id then
        raise exception 'esign_tenant_mismatch: engagement % is not client %', new.engagement_id, new.client_id
          using errcode = 'check_violation';
      end if;
    end if;
    if new.status <> 'in_progress' or new.completed_at is not null
       or new.sealed_pdf_path is not null or new.envelope_hash is not null
       or new.last_receipt_sha256 is not null
       or new.seal_lease_id is not null or new.seal_attempts <> 0 then
      raise exception 'esign_bad_insert: envelopes start as in_progress' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE
  if (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_immutable) k)
     is distinct from
     (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_immutable) k) then
    raise exception 'esign_immutable: evidence columns cannot change' using errcode = 'check_violation';
  end if;
  if new.engagement_id is not null and new.engagement_id is distinct from old.engagement_id then
    raise exception 'esign_immutable: references cannot be re-pointed' using errcode = 'check_violation';
  end if;
  if old.status in ('completed','declined','voided','expired')
     and (to_jsonb(new) - v_fk_nullable) is distinct from (to_jsonb(old) - v_fk_nullable) then
    raise exception 'esign_terminal: envelope % is %', old.id, old.status using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'in_progress' and new.status in ('completing','declined','voided','expired'))
    or (old.status = 'completing'  and new.status in ('completed','voided'))
  ) then
    raise exception 'esign_bad_transition: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_signature_envelope_guard on public.signature_envelope;
create trigger trg_signature_envelope_guard
  before insert or update or delete on public.signature_envelope
  for each row execute function public.esign_envelope_guard();

-- ── Recipient: tenancy, countersigner check, immutable evidence, transitions. ─
create or replace function public.esign_recipient_guard()
returns trigger language plpgsql as $$
declare
  v_env        public.signature_envelope%rowtype;
  v_env_status text;
  v_client     uuid;
  v_immutable  text[] := array[
    'id','envelope_id','client_id','kind','routing_order','staff_user_id','name','email','phone',
    'consent_text','checkbox_text','recipient_hash','require_sms_otp','created_at'];
  v_fk_nullable text[] := array['contact_id','updated_at'];
begin
  if public.esign_override_on() then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    raise exception 'Signature recipients are retained as evidence.' using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign recipients are written by the server only.' using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' then
    select * into v_env from public.signature_envelope where id = new.envelope_id;
    if not found or v_env.client_id is distinct from new.client_id then
      raise exception 'esign_tenant_mismatch: recipient % is not client %', new.id, new.client_id
        using errcode = 'check_violation';
    end if;
    if new.contact_id is not null then
      select c.client_id into v_client from public.client_contacts c where c.id = new.contact_id;
      if v_client is distinct from new.client_id then
        raise exception 'esign_tenant_mismatch: contact % is not client %', new.contact_id, new.client_id
          using errcode = 'check_violation';
      end if;
    end if;
    -- A GBTN countersigner must pass the one countersigner predicate (S1).
    if new.kind = 'staff' and not public.esign_is_countersigner(new.staff_user_id, new.client_id) then
      raise exception 'esign_countersigner_not_staff' using errcode = 'check_violation';
    end if;
    if new.status not in ('pending','sent') or new.signed_at is not null
       or new.otp_verified_at is not null or new.otp_session_hash is not null
       or new.receipt_sha256 is not null
       or new.applied_field_ids is not null or new.chain_index is not null then
      raise exception 'esign_bad_insert: recipients start pending or sent' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE
  if (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_immutable) k)
     is distinct from
     (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_immutable) k) then
    raise exception 'esign_immutable: evidence columns cannot change' using errcode = 'check_violation';
  end if;
  if new.contact_id is not null and new.contact_id is distinct from old.contact_id then
    raise exception 'esign_immutable: references cannot be re-pointed' using errcode = 'check_violation';
  end if;
  if old.status in ('signed','declined','canceled')
     and (to_jsonb(new) - v_fk_nullable) is distinct from (to_jsonb(old) - v_fk_nullable) then
    raise exception 'esign_terminal: recipient % is %', old.id, old.status using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending'          and new.status in ('sent','canceled'))
    or (old.status in ('sent','viewed') and new.status in ('viewed','otp_sent','signed','declined','canceled'))
    or (old.status = 'otp_sent'         and new.status in ('otp_verified','declined','canceled'))
    or (old.status = 'otp_verified'     and new.status in ('otp_sent','signed','declined','canceled'))
  ) then
    raise exception 'esign_bad_transition: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;

  -- S13.3: recipient moves are bound to the parent envelope's state. Every close
  -- path updates the envelope row FIRST, in the same transaction.
  if new.status is distinct from old.status and new.status in ('canceled','declined','signed') then
    select e.status into v_env_status from public.signature_envelope e where e.id = new.envelope_id;
    if (new.status = 'canceled' and v_env_status in ('in_progress','completing'))
       or (new.status = 'declined' and v_env_status is distinct from 'declined')
       or (new.status = 'signed'   and v_env_status is distinct from 'in_progress') then
      raise exception 'esign_bad_transition: envelope is %', v_env_status using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_signature_recipient_guard on public.signature_recipient;
create trigger trg_signature_recipient_guard
  before insert or update or delete on public.signature_recipient
  for each row execute function public.esign_recipient_guard();

-- ── Fields: immutable after insert; must match their envelope and recipient. ─
create or replace function public.esign_field_guard()
returns trigger language plpgsql as $$
declare v_env public.signature_envelope%rowtype; v_rec public.signature_recipient%rowtype;
begin
  if public.esign_override_on() then return coalesce(new, old); end if;
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'Signature fields are hashed evidence and cannot change.'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign fields are written by the server only.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_env from public.signature_envelope where id = new.envelope_id;
  if not found or v_env.client_id is distinct from new.client_id then
    raise exception 'esign_tenant_mismatch: field % is not client %', new.id, new.client_id
      using errcode = 'check_violation';
  end if;
  if new.page >= v_env.page_count then
    raise exception 'esign_field_off_document' using errcode = 'check_violation';
  end if;
  select * into v_rec from public.signature_recipient where id = new.recipient_id;
  if not found or v_rec.envelope_id is distinct from new.envelope_id then
    raise exception 'esign_tenant_mismatch: recipient % is not in envelope %', new.recipient_id, new.envelope_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_signature_field_guard on public.signature_field;
create trigger trg_signature_field_guard
  before insert or update or delete on public.signature_field
  for each row execute function public.esign_field_guard();

-- ── Tokens: append-only except a one-way revoke. ────────────────────────────
create or replace function public.esign_token_guard()
returns trigger language plpgsql as $$
declare v_rec public.signature_recipient%rowtype;
begin
  if public.esign_override_on() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    raise exception 'Access tokens are retained as evidence.' using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign tokens are written by the server only.' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    select * into v_rec from public.signature_recipient where id = new.recipient_id;
    if not found or v_rec.envelope_id is distinct from new.envelope_id
       or v_rec.client_id is distinct from new.client_id then
      raise exception 'esign_tenant_mismatch: token for recipient %', new.recipient_id
        using errcode = 'check_violation';
    end if;
    if new.revoked_at is not null then
      raise exception 'esign_bad_insert: tokens are issued live' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE: only a one-way revoke.
  if (to_jsonb(new) - array['revoked_at','revoke_reason'])
     is distinct from (to_jsonb(old) - array['revoked_at','revoke_reason'])
     or old.revoked_at is not null or new.revoked_at is null then
    raise exception 'esign_immutable: tokens may only be revoked' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_signature_access_token_guard on public.signature_access_token;
create trigger trg_signature_access_token_guard
  before insert or update or delete on public.signature_access_token
  for each row execute function public.esign_token_guard();

-- ── Supersede records: append-only except a one-way restore stamp. ──────────
create or replace function public.esign_supersede_guard()
returns trigger language plpgsql as $$
begin
  if public.esign_override_on() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    raise exception 'Supersede records are retained as evidence.' using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign supersede records are written by the server only.'
      using errcode = 'insufficient_privilege';
  end if;
  -- S13.2: the superseded document must belong to the envelope's client.
  if tg_op = 'INSERT' then
    if not exists (
         select 1 from public.signature_envelope e
           join public.documents d on d.id = new.document_id
          where e.id = new.envelope_id and d.client_id = e.client_id) then
      raise exception 'esign_tenant_mismatch: supersede %', new.document_id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and (
       (to_jsonb(new) - array['restored_at']) is distinct from (to_jsonb(old) - array['restored_at'])
    or old.restored_at is not null or new.restored_at is null) then
    raise exception 'esign_immutable: supersede records may only be marked restored'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_signature_supersede_guard on public.signature_supersede;
create trigger trg_signature_supersede_guard
  before insert or update or delete on public.signature_supersede
  for each row execute function public.esign_supersede_guard();

-- ── §7b documents_esign_guard, replaced to cover both pointers ──────────────
-- documents: e-sign columns are server-only; signed rows are frozen for EVERY
-- role (this is what stops scripts/seed-client.mjs resetting an executed MSA
-- to 'sent'). Also closes the members-can-relabel hole (documents_write FOR
-- ALL lets a member UPDATE status/doc_type) and pins every non-trusted write
-- to the row's own {client_id}/ storage prefix. Every clause that names
-- signature_request_id (v1) also names esign_envelope_id (v2).
create or replace function public.documents_esign_guard()
returns trigger language plpgsql as $$
declare
  v_trusted boolean := public.esign_is_trusted_role();
begin
  if public.esign_override_on() then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    if not v_trusted and (new.signature_request_id is not null or new.esign_envelope_id is not null
                          or new.signed_at is not null
                          or new.sealed_storage_path is not null or new.signature_expires_at is not null) then
      raise exception 'E-sign fields are set by the server only.' using errcode = 'insufficient_privilege';
    end if;
    if not v_trusted and split_part(new.storage_path, '/', 1) <> new.client_id::text then
      raise exception 'Storage path must be under this client.' using errcode = 'check_violation';
    end if;
    if not v_trusted and not public.is_staff()
       and (new.doc_type is not null or new.engagement_id is not null or new.status <> 'executed') then
      raise exception 'Only GBTN staff can file contract documents.' using errcode = 'insufficient_privilege';
    end if;
    -- The staff-uploader rule for engagement-activating types trusts
    -- uploaded_by, so a cookie caller can only attribute a file to itself.
    if not v_trusted and new.uploaded_by is distinct from auth.uid() then
      raise exception 'A document''s uploader must be the current user.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- BEFORE ROW, so this fires ahead of the signature_supersede FK check.
    if old.signed_at is not null or old.signature_request_id is not null
       or old.esign_envelope_id is not null
       or public.document_esign_superseded(old.id) then
      raise exception 'This document has e-signature records and cannot be deleted.'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  -- UPDATE: (a) signed rows frozen for everyone; only a move to 'superseded'.
  if old.signed_at is not null and (
       new.signed_at            is distinct from old.signed_at
    or new.sealed_storage_path  is distinct from old.sealed_storage_path
    or new.signature_request_id is distinct from old.signature_request_id
    or new.esign_envelope_id    is distinct from old.esign_envelope_id
    or new.storage_path         is distinct from old.storage_path
    or new.client_id            is distinct from old.client_id
    or new.doc_type             is distinct from old.doc_type
    or new.version              is distinct from old.version
    or (new.status is distinct from old.status and new.status <> 'superseded')) then
    raise exception 'This document is signed; its record cannot change.' using errcode = 'check_violation';
  end if;

  if not v_trusted then
    -- (b) e-sign columns are server-only.
    if new.signature_request_id is distinct from old.signature_request_id
       or new.esign_envelope_id is distinct from old.esign_envelope_id
       or new.signed_at is distinct from old.signed_at
       or new.sealed_storage_path is distinct from old.sealed_storage_path
       or new.signature_expires_at is distinct from old.signature_expires_at then
      raise exception 'E-sign fields are set by the server only.' using errcode = 'insufficient_privilege';
    end if;
    -- (b2) nobody re-attributes a file through the cookie client (the uploader
    -- rule depends on it). ON DELETE SET NULL runs as the owner, so it passes.
    if new.uploaded_by is distinct from old.uploaded_by then
      raise exception 'The uploader of a document cannot be changed.' using errcode = 'insufficient_privilege';
    end if;
    -- (c) a document that has been sent for signature keeps its bytes path.
    if (old.signature_request_id is not null or old.esign_envelope_id is not null)
       and new.storage_path is distinct from old.storage_path then
      raise exception 'This document was sent for signature; its file cannot be replaced.'
        using errcode = 'check_violation';
    end if;
    -- (c2) S2: a document sent for signature keeps its category and visibility.
    if (old.signature_request_id is not null or old.esign_envelope_id is not null)
       and (new.category is distinct from old.category
            or new.visible_to_client is distinct from old.visible_to_client) then
      raise exception 'This document was sent for signature; its category and visibility cannot change.'
        using errcode = 'check_violation';
    end if;
    -- (d) client members cannot relabel lifecycle / identity fields.
    if not public.is_staff() and (
         new.status        is distinct from old.status
      or new.doc_type      is distinct from old.doc_type
      or new.engagement_id is distinct from old.engagement_id
      or new.storage_path  is distinct from old.storage_path
      or new.client_id     is distinct from old.client_id
      or new.version       is distinct from old.version) then
      raise exception 'Only GBTN staff can change a document''s status.' using errcode = 'insufficient_privilege';
    end if;
    -- (e) a re-pathed or re-parented row must stay under its own client prefix.
    if (new.storage_path is distinct from old.storage_path or new.client_id is distinct from old.client_id)
       and split_part(new.storage_path, '/', 1) <> new.client_id::text then
      raise exception 'Storage path must be under this client.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
-- The trigger from 0031 (trg_documents_esign_guard) already points at this
-- function; it is not recreated.


-- ── §8 Transition functions (service role only; see §10) ────────────────────
-- Staff paths RAISE 'esign_<code>'; signer paths RETURN a result code.

-- (1) Put a no-longer-out-for-signature document back the way it was before the
-- send. Only while the document still points at THIS envelope, is still 'sent'
-- and is unsigned. The pointer is kept (it keeps the row undeletable).
create or replace function public.esign_envelope_restore_document(p_envelope_id uuid)
returns boolean language plpgsql as $$
begin
  update public.documents d
     set status               = e.doc_status_before_send,
         doc_type             = e.doc_type_before_send,
         engagement_id        = case when e.doc_engagement_before_send is null then null else d.engagement_id end,
         signature_expires_at = null
    from public.signature_envelope e
   where e.id = p_envelope_id and d.id = e.document_id and d.esign_envelope_id = e.id
     and d.status = 'sent' and d.signed_at is null;
  return found;
end $$;

-- (2) Follow-up (b): undo this envelope's supersede records.
create or replace function public.esign_envelope_restore_superseded(p_envelope_id uuid)
returns int language plpgsql as $$
declare v_row record; v_n int := 0;
begin
  for v_row in
    select s.document_id, s.status_before, s.doc_type_before
      from public.signature_supersede s
     where s.envelope_id = p_envelope_id and s.restored_at is null
     order by s.document_id
     for update                       -- NOT skip locked: a skipped sibling would
  loop                                -- stay wrongly superseded forever.
    update public.documents d
       set status   = v_row.status_before,
           doc_type = coalesce(d.doc_type, v_row.doc_type_before)
     where d.id = v_row.document_id
       and d.status = 'superseded'                 -- still superseded
       and d.signed_at is null                     -- never signed since
       and d.signature_request_id is null          -- no v1 pointer
       and d.esign_envelope_id is null             -- no v2 pointer
       -- and nothing else superseded it in the meantime
       and not exists (
             select 1 from public.signature_supersede s2
              join public.signature_envelope e2 on e2.id = s2.envelope_id
             where s2.document_id = d.id and s2.envelope_id <> p_envelope_id
               and s2.restored_at is null
               and e2.status in ('in_progress','completing','completed'));
    if found then v_n := v_n + 1; end if;
    update public.signature_supersede
       set restored_at = now()
     where envelope_id = p_envelope_id and document_id = v_row.document_id;
  end loop;
  if v_n > 0 then
    insert into public.signature_envelope_event (envelope_id, event, actor, meta)
    values (p_envelope_id, 'supersede_restored', 'system', jsonb_build_object('restored', v_n));
  end if;
  return v_n;
end $$;

-- (3) Shared tail of every close. The caller holds the envelope + recipient
-- locks and has ALREADY set the envelope's terminal status.
create or replace function public.esign_envelope_finish_close(
  p_envelope_id uuid, p_revoke_reason text, p_actor text, p_actor_user_id uuid)
returns void language plpgsql as $$
begin
  if p_revoke_reason is null or p_revoke_reason not in ('closed','expired','replaced')
     or p_actor is null or p_actor not in ('staff','signer','system') then
    raise exception 'esign_bad_args';
  end if;

  -- (a) every open recipient is canceled.
  with c as (
    update public.signature_recipient
       set status = 'canceled', canceled_at = now(), otp_session_hash = null
     where envelope_id = p_envelope_id
       and status in ('pending','sent','viewed','otp_sent','otp_verified')
    returning id
  )
  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor)
  select p_envelope_id, c.id, 'canceled', 'system' from c order by c.id;

  -- (b) every live token is revoked.
  with t as (
    update public.signature_access_token
       set revoked_at = now(), revoke_reason = p_revoke_reason
     where envelope_id = p_envelope_id and revoked_at is null
    returning recipient_id
  )
  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, actor_user_id, meta)
  select p_envelope_id, t.recipient_id, 'token_revoked',
         case when p_actor = 'staff' then 'staff' else 'system' end,
         case when p_actor = 'staff' then p_actor_user_id end,
         jsonb_build_object('reason', p_revoke_reason)
    from t order by t.recipient_id;

  -- (c) the document, (d) its superseded siblings.
  perform public.esign_envelope_restore_document(p_envelope_id);
  perform public.esign_envelope_restore_superseded(p_envelope_id);
end $$;

-- (4) Lazy expiry. The caller holds the envelope lock. A completing envelope
-- never expires; an in_progress one whose recipients have all signed is
-- promoted to completing instead of expiring (C1).
create or replace function public.esign_envelope_expire_if_due(p_envelope_id uuid)
returns text language plpgsql as $$
declare v_env public.signature_envelope%rowtype;
begin
  select * into v_env from public.signature_envelope where id = p_envelope_id for update;
  if not found or v_env.status <> 'in_progress' or v_env.expires_at > now() then
    return 'none';
  end if;

  if exists (select 1 from public.signature_recipient where envelope_id = p_envelope_id)
     and not exists (select 1 from public.signature_recipient
                      where envelope_id = p_envelope_id and status <> 'signed') then
    update public.signature_envelope
       set status = 'completing', completing_at = now()
     where id = p_envelope_id;
    -- Everyone has signed: the link deadline no longer applies, so no viewer may
    -- see "Signature link expired" while the seal runs.
    update public.documents
       set signature_expires_at = null
     where id = v_env.document_id and esign_envelope_id = v_env.id
       and status = 'sent' and signed_at is null;
    insert into public.signature_envelope_event (envelope_id, event, actor)
    values (p_envelope_id, 'completing', 'system');
    return 'promoted';
  end if;

  perform 1 from public.signature_recipient where envelope_id = p_envelope_id order by id for update;
  update public.signature_envelope
     set status = 'expired', expired_at = now()
   where id = p_envelope_id;
  insert into public.signature_envelope_event (envelope_id, event, actor)
  values (p_envelope_id, 'expired', 'system');
  perform public.esign_envelope_finish_close(p_envelope_id, 'expired', 'system', null);
  return 'expired';
end $$;

-- (5) Follow-up (b) mechanism: the pg_cron job esign-sweep-expired (§12).
-- One envelope's failure is isolated in its own subtransaction so a single bad
-- row cannot stall the sweep for every other envelope; only the SQLSTATE is
-- reported (never row data).
create or replace function public.esign_sweep_expired(p_limit int)
returns int language plpgsql as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v       record;
  v_n     int := 0;
begin
  for v in
    select id from public.signature_envelope
     where status = 'in_progress' and expires_at <= now()
     order by id
     limit v_limit
  loop
    begin
      perform 1 from public.signature_envelope
       where id = v.id and status = 'in_progress'
       for update skip locked;
      if found then
        if public.esign_envelope_expire_if_due(v.id) <> 'none' then
          v_n := v_n + 1;
        end if;
      end if;
    exception when others then
      raise warning 'esign_sweep_expired: envelope % failed (sqlstate %)', v.id, sqlstate;
    end;
  end loop;
  return v_n;
end $$;

-- (6) CREATE (staff). The app uploads the frozen original and render FIRST, and
-- on an RPC error re-reads the envelope before removing them (I25).
create or replace function public.esign_create_envelope(
  p_envelope_id uuid, p_client_id uuid, p_document_id uuid, p_engagement_id uuid,
  p_document_type text, p_created_by uuid, p_routing_mode text, p_source_mode text,
  p_original_frozen_path text, p_original_sha256 text, p_original_content_type text,
  p_original_file_name text, p_original_byte_size bigint,
  p_render_frozen_path text, p_render_sha256 text, p_page_count int,
  p_document_snapshot jsonb, p_document_hash text, p_expires_at timestamptz,
  p_replace_open boolean, p_supersede_siblings boolean,
  p_recipients jsonb, p_fields jsonb)
returns jsonb language plpgsql as $$
declare
  c_uuid_re  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  c_hex64_re constant text := '^[0-9a-f]{64}$';
  c_rec_keys constant text[] := array['id','kind','routing_order','contact_id','staff_user_id','name',
    'email','phone','consent_text','checkbox_text','recipient_hash','require_sms_otp','token_hash'];
  c_fld_keys constant text[] := array['id','recipient_id','kind','page','x_ppm','y_ppm','w_ppm','h_ppm',
    'required','origin','detected_label'];
  c_tol_pt   constant numeric := 0.01;   -- ppm rounding tolerance on minimum sizes

  v_type              public.esign_document_type%rowtype;
  v_doc               public.documents%rowtype;
  v_prev              public.signature_envelope%rowtype;
  v_open              public.signature_envelope%rowtype;
  v_e                 jsonb;
  v_page              jsonb;
  v_n_recipients      int;
  v_n_fields          int;
  v_rid               uuid;
  v_kind              text;
  v_order             int;
  v_contact           uuid;
  v_staff             uuid;
  v_activated         boolean;
  v_staff_count       int := 0;
  v_recipient_ids     uuid[] := '{}';
  v_activated_ids     uuid[] := '{}';
  v_pg                int;
  v_x                 int;
  v_y                 int;
  v_w                 int;
  v_h                 int;
  v_rot               int;
  v_bw                numeric;
  v_bh                numeric;
  v_vw                numeric;
  v_vh                numeric;
  v_sib               record;
  v_superseded        int := 0;
  v_status_before     text;
  v_type_before       text;
  v_engagement_before uuid;
begin
  -- 0. Frozen artifact paths are bound to this envelope id.
  if p_envelope_id is null
     or p_original_frozen_path is distinct from ('envelopes/' || p_envelope_id::text || '/original.bin')
     or p_render_frozen_path   is distinct from ('envelopes/' || p_envelope_id::text || '/render.pdf') then
    raise exception 'esign_bad_artifact_path';
  end if;

  -- 1. Type.
  select * into v_type from public.esign_document_type where document_type = p_document_type;
  if not found or not v_type.esign_enabled then
    raise exception 'esign_type_disabled';
  end if;

  -- 2. Expiry window.
  if p_expires_at is null
     or p_expires_at <= now() + interval '1 hour'
     or p_expires_at >= now() + interval '91 days' then
    raise exception 'esign_bad_expiry';
  end if;

  -- 3. Modes vs the type's sealing_mode.
  if p_routing_mode is null or p_routing_mode not in ('parallel','sequential')
     or p_source_mode is null or p_source_mode not in ('pdf','image_pdf','certificate')
     or (v_type.sealing_mode = 'page' and p_source_mode = 'certificate')
     or (v_type.sealing_mode = 'certificate' and p_source_mode <> 'certificate') then
    raise exception 'esign_bad_mode';
  end if;

  -- 4. Locks, in the binding order: open envelopes of this document, their
  -- recipients, then the document. Two creates on one document serialize here.
  perform 1 from public.signature_envelope
   where document_id = p_document_id and status in ('in_progress','completing')
   order by id
   for update;
  perform 1 from public.signature_recipient r
   where r.envelope_id in (select e.id from public.signature_envelope e
                            where e.document_id = p_document_id
                              and e.status in ('in_progress','completing'))
   order by r.id
   for update;

  select * into v_doc from public.documents
   where id = p_document_id and client_id = p_client_id
   for update;
  if not found then raise exception 'esign_document_not_found'; end if;

  -- 5. Eligibility (I18/I19). The prefix test comes before is_financial_object;
  -- the uuid-casting storage_object_client() is never used.
  if v_doc.signed_at is not null or v_doc.status = 'superseded' or v_doc.category = 'Financials'
     or (v_doc.status = 'executed' and v_doc.doc_type is not null) then
    raise exception 'esign_document_not_eligible';
  end if;
  if split_part(v_doc.storage_path, '/', 1) <> p_client_id::text then
    raise exception 'esign_document_not_eligible';
  end if;
  if public.is_financial_object(v_doc.storage_path) then
    raise exception 'esign_document_not_eligible';
  end if;
  -- S7: a still-open v1 request blocks a v2 send.
  if v_doc.signature_request_id is not null and exists (
       select 1 from public.signature_request sr
        where sr.id = v_doc.signature_request_id
          and sr.status in ('sent','viewed','otp_sent','otp_verified')) then
    raise exception 'esign_open_envelope_exists';
  end if;

  -- 6. Type, engagement, snapshot.
  if v_doc.doc_type is not null and v_doc.doc_type <> p_document_type then
    raise exception 'esign_doc_type_mismatch';
  end if;
  if v_doc.engagement_id is not null and p_engagement_id is distinct from v_doc.engagement_id then
    raise exception 'esign_engagement_mismatch';
  end if;
  if v_doc.storage_path is distinct from (p_document_snapshot #>> '{source,storage_path}') then
    raise exception 'esign_source_changed';
  end if;

  -- 7. Agreements that activate an engagement must be staff-uploaded files.
  -- A null uploader fails.
  if v_type.activates_engagement and not exists (
       select 1 from public.profiles p
        where p.id = v_doc.uploaded_by and p.role in ('admin','employee')) then
    raise exception 'esign_uploader_not_staff';
  end if;

  -- 8. Rate limit per document.
  if (select count(*) from public.signature_envelope
       where document_id = p_document_id and sent_at > now() - interval '24 hours') >= 10 then
    raise exception 'esign_rate_limited';
  end if;

  -- 9. Open envelope. A completing envelope ALWAYS refuses: every recipient has
  -- signed, and replacing it would discard an executed agreement.
  if exists (select 1 from public.signature_envelope
              where document_id = p_document_id and status = 'completing') then
    raise exception 'esign_open_envelope_exists';
  end if;
  if not coalesce(p_replace_open, false) and exists (
       select 1 from public.signature_envelope
        where document_id = p_document_id and status = 'in_progress' and expires_at > now()) then
    raise exception 'esign_open_envelope_exists';
  end if;

  -- 10. Recipients.
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' then
    raise exception 'esign_bad_recipients';
  end if;
  v_n_recipients := jsonb_array_length(p_recipients);
  if v_n_recipients < 1 or v_n_recipients > least(v_type.max_recipients, 10) then
    raise exception 'esign_bad_recipients';
  end if;

  for v_e in select value from jsonb_array_elements(p_recipients) loop
    -- Shape first (no casts in these expressions; NULL counts as a failure).
    -- The object test is its own statement so jsonb_object_keys never sees a
    -- non-object.
    if jsonb_typeof(v_e) is distinct from 'object' then
      raise exception 'esign_bad_recipients';
    end if;
    if coalesce(
         not (array(select jsonb_object_keys(v_e)) @> c_rec_keys
              and array(select jsonb_object_keys(v_e)) <@ c_rec_keys)
      or jsonb_typeof(v_e->'id') <> 'string' or (v_e->>'id') !~ c_uuid_re
      or jsonb_typeof(v_e->'kind') <> 'string'
      or (v_e->>'kind') not in ('client_contact','outside','staff')
      or jsonb_typeof(v_e->'routing_order') <> 'number' or (v_e->>'routing_order') !~ '^[0-9]{1,2}$'
      or jsonb_typeof(v_e->'contact_id') not in ('string','null')
      or (jsonb_typeof(v_e->'contact_id') = 'string' and (v_e->>'contact_id') !~ c_uuid_re)
      or jsonb_typeof(v_e->'staff_user_id') not in ('string','null')
      or (jsonb_typeof(v_e->'staff_user_id') = 'string' and (v_e->>'staff_user_id') !~ c_uuid_re)
      or jsonb_typeof(v_e->'name') <> 'string'
      or jsonb_typeof(v_e->'email') <> 'string'
      or jsonb_typeof(v_e->'phone') not in ('string','null')
      or jsonb_typeof(v_e->'consent_text') <> 'string'
      or jsonb_typeof(v_e->'checkbox_text') <> 'string'
      or jsonb_typeof(v_e->'recipient_hash') <> 'string' or (v_e->>'recipient_hash') !~ c_hex64_re
      or jsonb_typeof(v_e->'require_sms_otp') <> 'boolean'
      or jsonb_typeof(v_e->'token_hash') not in ('string','null')
      , true) then
      raise exception 'esign_bad_recipients';
    end if;

    v_rid     := (v_e->>'id')::uuid;
    v_kind    := v_e->>'kind';
    v_order   := (v_e->>'routing_order')::int;
    v_contact := (v_e->>'contact_id')::uuid;
    v_staff   := (v_e->>'staff_user_id')::uuid;

    if v_order < 1 or v_order > 10
       or (p_routing_mode = 'parallel' and v_order <> 1)
       or (v_e->>'require_sms_otp')::boolean <> v_type.require_sms_otp
       or (v_type.require_sms_otp and (v_e->>'phone') is null)
       or (v_kind = 'client_contact' and v_contact is null)
       or (v_kind = 'outside' and not v_type.allow_outside_signers)
       or (v_kind = 'staff' and v_staff is null)
       or (v_kind <> 'staff' and v_staff is not null) then
      raise exception 'esign_bad_recipients';
    end if;

    if v_kind = 'staff' then
      v_staff_count := v_staff_count + 1;
      if not public.esign_is_countersigner(v_staff, p_client_id) then
        raise exception 'esign_countersigner_not_staff';
      end if;
    end if;

    -- Exactly the activated set carries a token hash (parallel: all; sequential: order 1).
    v_activated := (p_routing_mode = 'parallel' or v_order = 1);
    if v_activated then
      if coalesce(jsonb_typeof(v_e->'token_hash') <> 'string' or (v_e->>'token_hash') !~ c_hex64_re, true) then
        raise exception 'esign_bad_recipients';
      end if;
      v_activated_ids := v_activated_ids || v_rid;
    elsif jsonb_typeof(v_e->'token_hash') <> 'null' then
      raise exception 'esign_bad_recipients';
    end if;

    v_recipient_ids := v_recipient_ids || v_rid;
  end loop;

  if v_staff_count > 1
     or (select count(distinct x) from unnest(v_recipient_ids) x) <> v_n_recipients
     or (select count(distinct lower(value->>'email')) from jsonb_array_elements(p_recipients)) <> v_n_recipients
     or (select count(value->>'token_hash') - count(distinct value->>'token_hash')
           from jsonb_array_elements(p_recipients)) <> 0 then
    raise exception 'esign_bad_recipients';
  end if;
  if p_routing_mode = 'sequential' and not (
       select min(o) = 1 and max(o) = count(distinct o)
         from (select (value->>'routing_order')::int as o from jsonb_array_elements(p_recipients)) s) then
    raise exception 'esign_bad_recipients';
  end if;

  -- 11. Fields.
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'esign_bad_fields';
  end if;
  v_n_fields := jsonb_array_length(p_fields);
  if v_n_fields > 100 then
    raise exception 'esign_bad_fields';
  end if;
  if p_page_count is null or p_page_count < 1
     or jsonb_typeof(p_document_snapshot->'pages') is distinct from 'array'
     or jsonb_typeof(p_document_snapshot->'fields') is distinct from 'array' then
    raise exception 'esign_bad_fields';
  end if;

  for v_e in select value from jsonb_array_elements(p_fields) loop
    if jsonb_typeof(v_e) is distinct from 'object' then
      raise exception 'esign_bad_fields';
    end if;
    if coalesce(
         not (array(select jsonb_object_keys(v_e)) @> c_fld_keys
              and array(select jsonb_object_keys(v_e)) <@ c_fld_keys)
      or jsonb_typeof(v_e->'id') <> 'string' or (v_e->>'id') !~ c_uuid_re
      or jsonb_typeof(v_e->'recipient_id') <> 'string' or (v_e->>'recipient_id') !~ c_uuid_re
      or jsonb_typeof(v_e->'kind') <> 'string'
      or (v_e->>'kind') not in ('signature','date_signed','printed_name')
      or jsonb_typeof(v_e->'page')  <> 'number' or (v_e->>'page')  !~ '^[0-9]{1,3}$'
      or jsonb_typeof(v_e->'x_ppm') <> 'number' or (v_e->>'x_ppm') !~ '^[0-9]{1,7}$'
      or jsonb_typeof(v_e->'y_ppm') <> 'number' or (v_e->>'y_ppm') !~ '^[0-9]{1,7}$'
      or jsonb_typeof(v_e->'w_ppm') <> 'number' or (v_e->>'w_ppm') !~ '^[0-9]{1,7}$'
      or jsonb_typeof(v_e->'h_ppm') <> 'number' or (v_e->>'h_ppm') !~ '^[0-9]{1,7}$'
      or jsonb_typeof(v_e->'required') <> 'boolean'
      or jsonb_typeof(v_e->'origin') <> 'string'
      or (v_e->>'origin') not in ('detected','staff','generated')
      or jsonb_typeof(v_e->'detected_label') not in ('string','null')
      or char_length(coalesce(v_e->>'detected_label', '')) > 200
      , true) then
      raise exception 'esign_bad_fields';
    end if;

    v_pg := (v_e->>'page')::int;
    v_x  := (v_e->>'x_ppm')::int;
    v_y  := (v_e->>'y_ppm')::int;
    v_w  := (v_e->>'w_ppm')::int;
    v_h  := (v_e->>'h_ppm')::int;

    if not ((v_e->>'recipient_id')::uuid = any(v_recipient_ids))
       or v_pg >= p_page_count
       or v_w <= 0 or v_h <= 0
       or v_x + v_w > 1000000 or v_y + v_h > 1000000
       or (p_source_mode = 'certificate' and (v_e->>'origin') <> 'generated') then
      raise exception 'esign_bad_fields';
    end if;

    -- §A.1 minimum sizes, measured on the snapshot's displayed page.
    select pg into v_page
      from jsonb_array_elements(p_document_snapshot->'pages') pg
     where pg->'index' = to_jsonb(v_pg)
     limit 1;
    if v_page is null or jsonb_typeof(v_page->'box_mpt') is distinct from 'array' then
      raise exception 'esign_bad_fields';
    end if;
    if coalesce(
         jsonb_typeof(v_page->'rotate') <> 'number'
      or (v_page->>'rotate') not in ('0','90','180','270')
      or jsonb_array_length(v_page->'box_mpt') <> 4
      or jsonb_typeof(v_page->'box_mpt'->2) <> 'number'
      or jsonb_typeof(v_page->'box_mpt'->3) <> 'number'
      , true) then
      raise exception 'esign_bad_fields';
    end if;
    v_rot := (v_page->>'rotate')::int;
    v_bw  := (v_page->'box_mpt'->>2)::numeric / 1000;
    v_bh  := (v_page->'box_mpt'->>3)::numeric / 1000;
    v_vw  := case when v_rot in (90, 270) then v_bh else v_bw end;
    v_vh  := case when v_rot in (90, 270) then v_bw else v_bh end;
    if v_bw < 72 or v_bh < 72
       or ((v_e->>'kind') = 'signature'
           and (v_w * v_vw / 1000000 < 90 - c_tol_pt or v_h * v_vh / 1000000 < 22 - c_tol_pt))
       or ((v_e->>'kind') <> 'signature'
           and (v_w * v_vw / 1000000 < 50 - c_tol_pt or v_h * v_vh / 1000000 < 10 - c_tol_pt)) then
      raise exception 'esign_bad_fields';
    end if;
  end loop;

  -- Unique field ids; every recipient has a signature field (the recipient
  -- signed-check needs >= 1 applied), and a REQUIRED one in placed modes.
  if (select count(distinct value->>'id') from jsonb_array_elements(p_fields)) <> v_n_fields
     or exists (
       select 1 from unnest(v_recipient_ids) rid
        where not exists (
          select 1 from jsonb_array_elements(p_fields) f
           where (f->>'recipient_id')::uuid = rid
             and f->>'kind' = 'signature'
             and (p_source_mode = 'certificate' or (f->>'required')::boolean))) then
    raise exception 'esign_bad_fields';
  end if;

  -- The field set must equal the hashed snapshot's fields (page, id order).
  if (select coalesce(jsonb_agg(f order by f->'page', f->>'id'), '[]'::jsonb)
        from jsonb_array_elements(p_fields) f)
     is distinct from
     (select coalesce(jsonb_agg(f order by f->'page', f->>'id'), '[]'::jsonb)
        from jsonb_array_elements(p_document_snapshot->'fields') f) then
    raise exception 'esign_bad_fields';
  end if;

  -- 12. Before-send values. A replace chain inherits the open envelope's values
  -- so a later close restores the ORIGINAL state, not 'sent'.
  v_status_before     := v_doc.status;
  v_type_before       := v_doc.doc_type;
  v_engagement_before := v_doc.engagement_id;
  if v_doc.esign_envelope_id is not null and v_doc.status = 'sent' then
    select * into v_prev from public.signature_envelope where id = v_doc.esign_envelope_id;
    if found and v_prev.status in ('in_progress','completing') then
      v_status_before     := v_prev.doc_status_before_send;
      v_type_before       := v_prev.doc_type_before_send;
      v_engagement_before := v_prev.doc_engagement_before_send;
    end if;
  end if;

  -- 13. Close whatever is still in_progress for this document. The envelope row
  -- is updated FIRST, then the shared close tail (recipients, tokens, restores).
  for v_open in
    select * from public.signature_envelope
     where document_id = p_document_id and status = 'in_progress'
     order by id
  loop
    if v_open.expires_at <= now() then
      update public.signature_envelope
         set status = 'expired', expired_at = now()
       where id = v_open.id;
      insert into public.signature_envelope_event (envelope_id, event, actor, meta)
      values (v_open.id, 'expired', 'system', jsonb_build_object('replaced_by', p_envelope_id));
      perform public.esign_envelope_finish_close(v_open.id, 'expired', 'system', null);
    else
      update public.signature_envelope
         set status = 'voided', voided_at = now(), void_reason = 'replaced_by_new_envelope'
       where id = v_open.id;
      insert into public.signature_envelope_event (envelope_id, event, actor, actor_user_id, meta)
      values (v_open.id, 'voided', 'staff', p_created_by,
              jsonb_build_object('reason', 'replaced_by_new_envelope', 'replaced_by', p_envelope_id));
      perform public.esign_envelope_finish_close(v_open.id, 'replaced', 'staff', p_created_by);
    end if;
  end loop;

  -- 14. Envelope -> recipients -> fields -> tokens -> events.
  insert into public.signature_envelope (
    id, client_id, document_id, engagement_id, document_type, created_by,
    routing_mode, source_mode,
    original_frozen_path, original_sha256, original_content_type, original_file_name, original_byte_size,
    render_frozen_path, render_sha256, page_count,
    document_snapshot, document_hash, expires_at,
    doc_status_before_send, doc_type_before_send, doc_engagement_before_send, supersede_siblings)
  values (
    p_envelope_id, p_client_id, p_document_id, p_engagement_id, p_document_type, p_created_by,
    p_routing_mode, p_source_mode,
    p_original_frozen_path, p_original_sha256, p_original_content_type, p_original_file_name, p_original_byte_size,
    p_render_frozen_path, p_render_sha256, p_page_count,
    p_document_snapshot, p_document_hash, p_expires_at,
    v_status_before, v_type_before, v_engagement_before, coalesce(p_supersede_siblings, false));

  insert into public.signature_recipient (
    id, envelope_id, client_id, kind, routing_order, status,
    contact_id, staff_user_id, name, email, phone,
    consent_text, checkbox_text, recipient_hash, require_sms_otp, activated_at)
  select (e->>'id')::uuid, p_envelope_id, p_client_id, e->>'kind', (e->>'routing_order')::smallint,
         case when (e->>'id')::uuid = any(v_activated_ids) then 'sent' else 'pending' end,
         (e->>'contact_id')::uuid, (e->>'staff_user_id')::uuid, e->>'name', e->>'email', e->>'phone',
         e->>'consent_text', e->>'checkbox_text', e->>'recipient_hash', v_type.require_sms_otp,
         case when (e->>'id')::uuid = any(v_activated_ids) then now() end
    from jsonb_array_elements(p_recipients) e
   order by (e->>'routing_order')::int, (e->>'id')::uuid;

  insert into public.signature_field (
    id, envelope_id, recipient_id, client_id, kind, page, x_ppm, y_ppm, w_ppm, h_ppm,
    required, origin, detected_label)
  select (f->>'id')::uuid, p_envelope_id, (f->>'recipient_id')::uuid, p_client_id, f->>'kind',
         (f->>'page')::int, (f->>'x_ppm')::int, (f->>'y_ppm')::int, (f->>'w_ppm')::int, (f->>'h_ppm')::int,
         (f->>'required')::boolean, f->>'origin', f->>'detected_label'
    from jsonb_array_elements(p_fields) f
   order by (f->>'page')::int, (f->>'id')::uuid;

  insert into public.signature_access_token (envelope_id, recipient_id, client_id, token_hash, issued_by)
  select p_envelope_id, (e->>'id')::uuid, p_client_id, e->>'token_hash', p_created_by
    from jsonb_array_elements(p_recipients) e
   where (e->>'id')::uuid = any(v_activated_ids)
   order by (e->>'id')::uuid;

  insert into public.signature_envelope_event (envelope_id, event, actor, actor_user_id, meta)
  values (p_envelope_id, 'sent', 'staff', p_created_by,
          jsonb_build_object('recipients', v_n_recipients, 'routing', p_routing_mode));

  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, actor_user_id)
  select p_envelope_id, a.rid, ev.event, 'staff', p_created_by
    from unnest(v_activated_ids) as a(rid)
   cross join (values (1, 'recipient_activated'), (2, 'token_issued')) as ev(n, event)
   order by a.rid, ev.n;

  -- 15. Supersede unsigned, never-sent siblings of the same type + engagement.
  -- A sibling another transaction holds is being sent right now and must not be
  -- superseded, so locked rows are skipped. Each is RECORDED before the update.
  if coalesce(p_supersede_siblings, false) and p_engagement_id is not null then
    for v_sib in
      select d.id, d.status, d.doc_type
        from public.documents d
       where d.client_id = p_client_id and d.id <> p_document_id
         and d.doc_type = p_document_type and d.engagement_id = p_engagement_id
         and d.signed_at is null
         and d.signature_request_id is null and d.esign_envelope_id is null
         and d.status in ('draft','sent')
       order by d.id
       for update skip locked
    loop
      insert into public.signature_supersede (envelope_id, document_id, status_before, doc_type_before)
      values (p_envelope_id, v_sib.id, v_sib.status, v_sib.doc_type);
      update public.documents set status = 'superseded' where id = v_sib.id;
      v_superseded := v_superseded + 1;
    end loop;
    if v_superseded > 0 then
      insert into public.signature_envelope_event (envelope_id, event, actor, actor_user_id, meta)
      values (p_envelope_id, 'superseded', 'staff', p_created_by, jsonb_build_object('count', v_superseded));
    end if;
  end if;

  -- 16. The document is now out for signature.
  update public.documents
     set status               = 'sent',
         esign_envelope_id    = p_envelope_id,
         signature_expires_at = p_expires_at,
         doc_type             = coalesce(doc_type, p_document_type),
         engagement_id        = coalesce(engagement_id, p_engagement_id)
   where id = p_document_id;

  -- 17.
  return jsonb_build_object('envelope_id', p_envelope_id, 'superseded', v_superseded,
                            'activated_recipient_ids', to_jsonb(v_activated_ids));
end $$;

-- (7) ACTIVATE a pending recipient (sequential turn, or staff "Send link now").
create or replace function public.esign_activate_recipient(
  p_envelope_id uuid, p_client_id uuid, p_recipient_id uuid,
  p_token_hash text, p_issued_by uuid, p_actor text)
returns jsonb language plpgsql as $$
declare
  v_env public.signature_envelope%rowtype;
  v_rec public.signature_recipient%rowtype;
  v_exp text;
begin
  if p_actor is null or p_actor not in ('system','staff')
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'esign_bad_args';
  end if;

  select * into v_env from public.signature_envelope
   where id = p_envelope_id and client_id = p_client_id
   for update;
  if not found then
    return jsonb_build_object('result', 'not_found', 'recipient_id', p_recipient_id);
  end if;

  v_exp := public.esign_envelope_expire_if_due(v_env.id);
  if v_exp = 'expired' then
    return jsonb_build_object('result', 'expired', 'recipient_id', p_recipient_id);
  elsif v_exp = 'promoted' then
    return jsonb_build_object('result', 'completing', 'recipient_id', p_recipient_id);
  end if;
  if v_env.status <> 'in_progress' then
    return jsonb_build_object('result', v_env.status, 'recipient_id', p_recipient_id);
  end if;

  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  select * into v_rec from public.signature_recipient
   where id = p_recipient_id and envelope_id = v_env.id and client_id = v_env.client_id;
  if not found then
    return jsonb_build_object('result', 'not_found', 'recipient_id', p_recipient_id);
  end if;
  if v_rec.status in ('sent','viewed','otp_sent','otp_verified') then
    return jsonb_build_object('result', 'already_active', 'recipient_id', v_rec.id);
  end if;
  if v_rec.status in ('signed','declined','canceled') then
    return jsonb_build_object('result', v_rec.status, 'recipient_id', v_rec.id);
  end if;
  if v_rec.kind = 'staff' and not public.esign_is_countersigner(v_rec.staff_user_id, v_rec.client_id) then
    return jsonb_build_object('result', 'countersigner_not_staff', 'recipient_id', v_rec.id);
  end if;
  if exists (select 1 from public.signature_recipient r
              where r.envelope_id = v_env.id and r.routing_order < v_rec.routing_order
                and r.status <> 'signed') then
    return jsonb_build_object('result', 'out_of_order', 'recipient_id', v_rec.id);
  end if;

  insert into public.signature_access_token (envelope_id, recipient_id, client_id, token_hash, issued_by)
  values (v_env.id, v_rec.id, v_env.client_id, p_token_hash, p_issued_by);

  update public.signature_recipient
     set status = 'sent', activated_at = now()
   where id = v_rec.id;

  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, actor_user_id) values
    (v_env.id, v_rec.id, 'recipient_activated', p_actor, case when p_actor = 'staff' then p_issued_by end),
    (v_env.id, v_rec.id, 'token_issued',        p_actor, case when p_actor = 'staff' then p_issued_by end);

  return jsonb_build_object('result', 'ok', 'recipient_id', v_rec.id);
end $$;

-- (8) ROTATE an active recipient's token (staff resend).
create or replace function public.esign_rotate_recipient_token(
  p_envelope_id uuid, p_client_id uuid, p_recipient_id uuid,
  p_token_hash text, p_issued_by uuid)
returns jsonb language plpgsql as $$
declare
  v_env    public.signature_envelope%rowtype;
  v_rec    public.signature_recipient%rowtype;
  v_exp    text;
  v_old_id uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'esign_bad_args';
  end if;

  select * into v_env from public.signature_envelope
   where id = p_envelope_id and client_id = p_client_id
   for update;
  if not found then
    return jsonb_build_object('result', 'not_found', 'recipient_id', p_recipient_id);
  end if;

  v_exp := public.esign_envelope_expire_if_due(v_env.id);
  if v_exp = 'expired' then
    return jsonb_build_object('result', 'expired', 'recipient_id', p_recipient_id);
  elsif v_exp = 'promoted' then
    return jsonb_build_object('result', 'completing', 'recipient_id', p_recipient_id);
  end if;
  if v_env.status <> 'in_progress' then
    return jsonb_build_object('result', v_env.status, 'recipient_id', p_recipient_id);
  end if;

  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  select * into v_rec from public.signature_recipient
   where id = p_recipient_id and envelope_id = v_env.id and client_id = v_env.client_id;
  if not found then
    return jsonb_build_object('result', 'not_found', 'recipient_id', p_recipient_id);
  end if;
  if v_rec.status = 'pending' then
    return jsonb_build_object('result', 'pending', 'recipient_id', v_rec.id);
  end if;
  if v_rec.status in ('signed','declined','canceled') then
    return jsonb_build_object('result', v_rec.status, 'recipient_id', v_rec.id);
  end if;
  if v_rec.kind = 'staff' and not public.esign_is_countersigner(v_rec.staff_user_id, v_rec.client_id) then
    return jsonb_build_object('result', 'countersigner_not_staff', 'recipient_id', v_rec.id);
  end if;
  if (select count(*) from public.signature_access_token
       where recipient_id = v_rec.id and issued_at > now() - interval '24 hours') >= 5 then
    return jsonb_build_object('result', 'rate_limited', 'recipient_id', v_rec.id);
  end if;

  select id into v_old_id from public.signature_access_token
   where recipient_id = v_rec.id and revoked_at is null
   for update;
  if found then
    update public.signature_access_token
       set revoked_at = now(), revoke_reason = 'rotated'
     where id = v_old_id;
  end if;

  insert into public.signature_access_token (envelope_id, recipient_id, client_id, token_hash, issued_by)
  values (v_env.id, v_rec.id, v_env.client_id, p_token_hash, p_issued_by);

  -- A new link is a new browser session.
  update public.signature_recipient
     set otp_session_hash = null, otp_session_expires_at = null
   where id = v_rec.id;

  if v_old_id is not null then
    insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, actor_user_id, meta)
    values (v_env.id, v_rec.id, 'token_revoked', 'staff', p_issued_by, jsonb_build_object('reason', 'rotated'));
  end if;
  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, actor_user_id)
  values (v_env.id, v_rec.id, 'token_issued', 'staff', p_issued_by);

  return jsonb_build_object('result', 'ok', 'recipient_id', v_rec.id);
end $$;

-- (9) VIEW / SOURCE OPENED / ORIGINAL DOWNLOADED (signer). 'viewed' is recorded
-- only by the explicit "Review the document" click, never by server render.
create or replace function public.esign_envelope_touch(
  p_token_hash text, p_step text, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare
  v_tok  public.signature_access_token%rowtype;
  v_env  public.signature_envelope%rowtype;
  v_rec  public.signature_recipient%rowtype;
  v_exp  text;
  v_last timestamptz;
begin
  if p_step is null or p_step not in ('viewed','source_opened','original_downloaded') then
    raise exception 'esign_bad_step';
  end if;

  select * into v_tok from public.signature_access_token
   where token_hash = p_token_hash and revoked_at is null;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  select * into v_env from public.signature_envelope where id = v_tok.envelope_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  select * into v_tok from public.signature_access_token
   where id = v_tok.id and revoked_at is null
   for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  v_exp := public.esign_envelope_expire_if_due(v_env.id);
  if v_exp = 'expired' then
    return jsonb_build_object('result', 'expired', 'envelope_id', v_env.id, 'recipient_id', v_tok.recipient_id);
  elsif v_exp = 'promoted' then
    return jsonb_build_object('result', 'completing', 'envelope_id', v_env.id, 'recipient_id', v_tok.recipient_id);
  end if;
  if v_env.status <> 'in_progress' then
    return jsonb_build_object('result', v_env.status, 'envelope_id', v_env.id, 'recipient_id', v_tok.recipient_id);
  end if;

  select * into v_rec from public.signature_recipient where id = v_tok.recipient_id;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if v_rec.status in ('pending','signed','declined','canceled') then
    return jsonb_build_object('result', v_rec.status, 'envelope_id', v_env.id, 'recipient_id', v_rec.id);
  end if;
  if p_step = 'original_downloaded' and v_env.source_mode <> 'certificate' then
    return jsonb_build_object('result', 'not_available', 'envelope_id', v_env.id, 'recipient_id', v_rec.id);
  end if;

  if p_step = 'viewed' then
    update public.signature_recipient
       set status    = case when status = 'sent' then 'viewed' else status end,
           viewed_at = coalesce(viewed_at, now())
     where id = v_rec.id;
  elsif p_step = 'source_opened' then
    update public.signature_recipient
       set source_opened_at = coalesce(source_opened_at, now()),
           status           = case when status = 'sent' then 'viewed' else status end,
           viewed_at        = coalesce(viewed_at, now())
     where id = v_rec.id;
  else
    update public.signature_recipient
       set original_downloaded_at = coalesce(original_downloaded_at, now())
     where id = v_rec.id;
  end if;

  select max(at) into v_last from public.signature_envelope_event
   where envelope_id = v_env.id and recipient_id = v_rec.id and event = p_step;
  if v_last is null or v_last < now() - interval '30 minutes' then       -- dedupe reloads
    insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, ip, user_agent)
    values (v_env.id, v_rec.id, p_step, 'signer', left(p_ip, 64), left(p_user_agent, 512));
  end if;

  return jsonb_build_object('result', 'ok', 'envelope_id', v_env.id, 'recipient_id', v_rec.id);
end $$;

-- (10) OTP SEND (signer). Reserve-then-send: the app texts the code only on 'ok'.
create or replace function public.esign_envelope_otp_send(
  p_token_hash text, p_otp_hash text, p_ttl_seconds int, p_cooldown_seconds int,
  p_max_sends int, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare
  v_tok public.signature_access_token%rowtype;
  v_env public.signature_envelope%rowtype;
  v_rec public.signature_recipient%rowtype;
  v_exp text;
begin
  select * into v_tok from public.signature_access_token
   where token_hash = p_token_hash and revoked_at is null;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  select * into v_env from public.signature_envelope where id = v_tok.envelope_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  select * into v_tok from public.signature_access_token
   where id = v_tok.id and revoked_at is null
   for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  v_exp := public.esign_envelope_expire_if_due(v_env.id);
  if v_exp = 'expired' then return jsonb_build_object('result', 'expired'); end if;
  if v_exp = 'promoted' then return jsonb_build_object('result', 'completing'); end if;
  if v_env.status <> 'in_progress' then return jsonb_build_object('result', v_env.status); end if;

  select * into v_rec from public.signature_recipient where id = v_tok.recipient_id;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if v_rec.status in ('pending','signed','declined','canceled') then
    return jsonb_build_object('result', v_rec.status);
  end if;
  if not v_rec.require_sms_otp then return jsonb_build_object('result', 'not_required'); end if;
  if v_rec.otp_last_sent_at is not null
     and v_rec.otp_last_sent_at > now() - make_interval(secs => p_cooldown_seconds) then
    return jsonb_build_object('result', 'cooldown',
      'resend_available_at', v_rec.otp_last_sent_at + make_interval(secs => p_cooldown_seconds));
  end if;
  if v_rec.otp_sends >= p_max_sends then return jsonb_build_object('result', 'limit'); end if;

  -- A verified recipient stays otp_verified (verification is per browser
  -- session), exactly as 0031.
  update public.signature_recipient
     set otp_hash         = p_otp_hash,
         otp_expires_at   = now() + make_interval(secs => p_ttl_seconds),
         otp_attempts     = 0,
         otp_sends        = otp_sends + 1,
         otp_last_sent_at = now(),
         status           = case when status in ('sent','viewed') then 'otp_sent' else status end
   where id = v_rec.id;
  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, ip, user_agent, meta)
  values (v_env.id, v_rec.id, 'otp_sent', 'signer', left(p_ip, 64), left(p_user_agent, 512),
          jsonb_build_object('send', v_rec.otp_sends + 1));

  return jsonb_build_object('result', 'ok', 'recipient_id', v_rec.id, 'phone', v_rec.phone,
    'resend_available_at', now() + make_interval(secs => p_cooldown_seconds));
end $$;

-- (11) OTP CHECK (signer). Atomic attempt counter; on success the code hash is
-- replaced by the hash of a fresh browser session secret.
create or replace function public.esign_envelope_otp_check(
  p_token_hash text, p_candidate_hash text, p_max_attempts int,
  p_session_hash text, p_session_ttl_seconds int, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare
  v_tok             public.signature_access_token%rowtype;
  v_env             public.signature_envelope%rowtype;
  v_rec             public.signature_recipient%rowtype;
  v_exp             text;
  v_session_expires timestamptz;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
     or p_session_ttl_seconds is null or p_session_ttl_seconds not between 60 and 3600 then
    raise exception 'esign_bad_session';
  end if;

  select * into v_tok from public.signature_access_token
   where token_hash = p_token_hash and revoked_at is null;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  select * into v_env from public.signature_envelope where id = v_tok.envelope_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  select * into v_tok from public.signature_access_token
   where id = v_tok.id and revoked_at is null
   for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  v_exp := public.esign_envelope_expire_if_due(v_env.id);
  if v_exp = 'expired' then return jsonb_build_object('result', 'expired'); end if;
  if v_exp = 'promoted' then return jsonb_build_object('result', 'completing'); end if;
  if v_env.status <> 'in_progress' then return jsonb_build_object('result', v_env.status); end if;

  select * into v_rec from public.signature_recipient where id = v_tok.recipient_id;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if v_rec.status in ('pending','signed','declined','canceled') then
    return jsonb_build_object('result', v_rec.status);
  end if;
  if not v_rec.require_sms_otp then return jsonb_build_object('result', 'not_required'); end if;
  if v_rec.otp_hash is null or v_rec.otp_expires_at <= now() then
    return jsonb_build_object('result', 'code_expired');
  end if;
  if v_rec.otp_attempts >= p_max_attempts then return jsonb_build_object('result', 'locked'); end if;

  if v_rec.otp_hash = p_candidate_hash then
    v_session_expires := now() + make_interval(secs => p_session_ttl_seconds);
    update public.signature_recipient
       set otp_verified_at        = now(),
           otp_hash               = null,
           otp_expires_at         = null,
           otp_session_hash       = p_session_hash,
           otp_session_expires_at = v_session_expires,
           status                 = 'otp_verified'
     where id = v_rec.id;
    insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, ip, user_agent)
    values (v_env.id, v_rec.id, 'otp_verified', 'signer', left(p_ip, 64), left(p_user_agent, 512));
    return jsonb_build_object('result', 'verified', 'session_expires_at', v_session_expires);
  end if;

  update public.signature_recipient set otp_attempts = otp_attempts + 1 where id = v_rec.id;
  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, ip, user_agent, meta)
  values (v_env.id, v_rec.id, 'otp_failed', 'signer', left(p_ip, 64), left(p_user_agent, 512),
          jsonb_build_object('attempt', v_rec.otp_attempts + 1));
  if v_rec.otp_attempts + 1 >= p_max_attempts then
    insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor)
    values (v_env.id, v_rec.id, 'otp_locked', 'system');
    return jsonb_build_object('result', 'locked');
  end if;
  return jsonb_build_object('result', 'incorrect');
end $$;

-- (12) RECORD one recipient's signature (signer submit). Never seals: the
-- caller drives completion through the seal route when completion_required.
create or replace function public.esign_record_signature(
  p_token_hash text, p_recipient_id uuid, p_session_user_id uuid, p_signed_at timestamptz,
  p_printed_name text, p_signature_method text,
  p_signature_image_path text, p_signature_image_sha256 text,
  p_typed_signature_text text, p_typed_signature_font text,
  p_date_text text, p_time_zone text,
  p_applied_field_ids uuid[], p_chain_index smallint,
  p_prev_receipt_sha256 text, p_receipt_sha256 text,
  p_otp_session_hash text, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare
  v_tok          public.signature_access_token%rowtype;
  v_env          public.signature_envelope%rowtype;
  v_rec          public.signature_recipient%rowtype;
  v_exp          text;
  v_signed_count int;
  v_unsigned     int;
  v_next_order   int;
  v_next         uuid[] := '{}';
begin
  -- 1. Live token, unlocked.
  select * into v_tok from public.signature_access_token
   where token_hash = p_token_hash and revoked_at is null;
  if not found then
    return jsonb_build_object('result', 'not_found', 'completion_required', false);
  end if;

  -- 2. Envelope, recipients, then the token again under the locks (C10).
  select * into v_env from public.signature_envelope where id = v_tok.envelope_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found', 'completion_required', false);
  end if;
  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  select * into v_tok from public.signature_access_token
   where id = v_tok.id and revoked_at is null
   for update;
  if not found then
    return jsonb_build_object('result', 'not_found', 'completion_required', false);
  end if;

  -- 3. Lazy expiry / promotion.
  v_exp := public.esign_envelope_expire_if_due(v_env.id);
  if v_exp = 'expired' then
    return jsonb_build_object('result', 'expired', 'envelope_id', v_env.id,
      'recipient_id', v_tok.recipient_id, 'completion_required', false);
  elsif v_exp = 'promoted' then
    return jsonb_build_object('result', 'completion_required', 'envelope_id', v_env.id,
      'recipient_id', v_tok.recipient_id, 'completion_required', true);
  end if;

  -- 4. Envelope state.
  if v_env.status = 'completing' then
    return jsonb_build_object('result', 'completion_required', 'envelope_id', v_env.id,
      'recipient_id', v_tok.recipient_id, 'completion_required', true);
  end if;
  if v_env.status <> 'in_progress' then
    return jsonb_build_object('result', v_env.status, 'envelope_id', v_env.id,
      'recipient_id', v_tok.recipient_id, 'completion_required', false);
  end if;

  -- 5. The token's own recipient.
  if p_recipient_id is distinct from v_tok.recipient_id then
    return jsonb_build_object('result', 'not_found', 'completion_required', false);
  end if;
  select * into v_rec from public.signature_recipient where id = v_tok.recipient_id;
  if not found then
    return jsonb_build_object('result', 'not_found', 'completion_required', false);
  end if;
  if v_rec.status = 'signed' then
    return jsonb_build_object('result', 'already_signed', 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false);
  end if;
  if v_rec.status = 'pending' then
    return jsonb_build_object('result', 'not_active', 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false);
  end if;
  if v_rec.status in ('declined','canceled') then
    return jsonb_build_object('result', v_rec.status, 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false);
  end if;

  -- 6. A staff countersigner signs only from their own live staff session (S1/S11).
  if v_rec.kind = 'staff' and not (
       p_session_user_id is not null
       and p_session_user_id = v_rec.staff_user_id
       and public.esign_is_countersigner(p_session_user_id, v_rec.client_id)) then
    return jsonb_build_object('result', 'staff_session_required', 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false);
  end if;

  -- 7. OTP browser session.
  if v_rec.require_sms_otp and (
       v_rec.otp_verified_at is null
    or v_rec.otp_session_hash is null
    or p_otp_session_hash is distinct from v_rec.otp_session_hash
    or v_rec.otp_session_expires_at is null
    or v_rec.otp_session_expires_at <= now()) then
    return jsonb_build_object('result', 'otp_required', 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false);
  end if;

  -- 8. Timestamp.
  if p_signed_at is null
     or p_signed_at > now() + interval '1 minute'
     or p_signed_at < now() - interval '15 minutes' then
    raise exception 'esign_bad_timestamp';
  end if;

  -- 9. Ordering (I44).
  if v_env.routing_mode = 'sequential' and exists (
       select 1 from public.signature_recipient r
        where r.envelope_id = v_env.id and r.routing_order < v_rec.routing_order
          and r.status <> 'signed') then
    return jsonb_build_object('result', 'out_of_order', 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false);
  end if;

  -- 10. Evidence shape.
  if p_signature_method = 'drawn' then
    if not coalesce(p_signature_image_path like
                      'envelopes/' || v_env.id::text || '/recipients/' || v_rec.id::text || '/attempts/%/signature.png',
                    false) then
      raise exception 'esign_bad_artifact_path';
    end if;
    if p_signature_image_sha256 is null or p_signature_image_sha256 !~ '^[0-9a-f]{64}$'
       or p_typed_signature_text is not null or p_typed_signature_font is not null then
      raise exception 'esign_bad_signature';
    end if;
  elsif p_signature_method = 'typed' then
    if p_typed_signature_text is null or char_length(p_typed_signature_text) not between 2 and 120
       or p_typed_signature_font is distinct from 'great-vibes-1'
       or p_signature_image_path is not null or p_signature_image_sha256 is not null then
      raise exception 'esign_bad_signature';
    end if;
  else
    raise exception 'esign_bad_signature';
  end if;
  if p_printed_name is null or char_length(p_printed_name) not between 2 and 120
     or p_date_text is null or char_length(p_date_text) not between 1 and 64
     or p_time_zone is null or char_length(p_time_zone) not between 1 and 64
     or p_receipt_sha256 is null or p_receipt_sha256 !~ '^[0-9a-f]{64}$'
     or (p_prev_receipt_sha256 is not null and p_prev_receipt_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'esign_bad_signature';
  end if;

  -- 11. Applied signature fields (S5): non-empty, no nulls or duplicates, each a
  -- signature field of THIS recipient, and every required one included.
  if coalesce(
       p_applied_field_ids is null
    or array_ndims(p_applied_field_ids) is distinct from 1
    or cardinality(p_applied_field_ids) not between 1 and 100
    or array_position(p_applied_field_ids, null) is not null
    or (select count(distinct x) from unnest(p_applied_field_ids) x) <> cardinality(p_applied_field_ids)
    or exists (select 1 from unnest(p_applied_field_ids) x
                where not exists (select 1 from public.signature_field f
                                   where f.id = x and f.envelope_id = v_env.id
                                     and f.recipient_id = v_rec.id and f.kind = 'signature'))
    or exists (select 1 from public.signature_field f
                where f.envelope_id = v_env.id and f.recipient_id = v_rec.id
                  and f.kind = 'signature' and f.required
                  and not (f.id = any(p_applied_field_ids)))
    , true) then
    return jsonb_build_object('result', 'fields_incomplete', 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false);
  end if;

  -- 12. Receipt chain (C5). current_chain_index is the index the caller must use
  -- next (signed count + 1), paired with the current chain head.
  select count(*) into v_signed_count from public.signature_recipient
   where envelope_id = v_env.id and status = 'signed';
  if p_prev_receipt_sha256 is distinct from v_env.last_receipt_sha256
     or p_chain_index is distinct from (v_signed_count + 1) then
    return jsonb_build_object('result', 'chain_moved', 'envelope_id', v_env.id,
      'recipient_id', v_rec.id, 'completion_required', false,
      'current_last_receipt_sha256', v_env.last_receipt_sha256,
      'current_chain_index', v_signed_count + 1);
  end if;

  -- 13. Write the signature.
  update public.signature_recipient
     set status                 = 'signed',
         signed_at              = p_signed_at,
         consent_agreed_at      = p_signed_at,
         printed_name           = p_printed_name,
         signature_method       = p_signature_method,
         signature_image_path   = p_signature_image_path,
         signature_image_sha256 = p_signature_image_sha256,
         typed_signature_text   = p_typed_signature_text,
         typed_signature_font   = p_typed_signature_font,
         date_text              = p_date_text,
         time_zone              = p_time_zone,
         applied_field_ids      = p_applied_field_ids,
         chain_index            = p_chain_index,
         prev_receipt_sha256    = p_prev_receipt_sha256,
         receipt_sha256         = p_receipt_sha256,
         signed_ip              = left(p_ip, 64),
         signed_user_agent      = left(p_user_agent, 512),
         otp_session_hash       = null
   where id = v_rec.id;

  update public.signature_envelope
     set last_receipt_sha256 = p_receipt_sha256
   where id = v_env.id;

  insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, ip, user_agent, meta, at) values
    (v_env.id, v_rec.id, 'consented', 'signer', left(p_ip, 64), left(p_user_agent, 512), '{}'::jsonb, p_signed_at),
    (v_env.id, v_rec.id, 'signed',    'signer', left(p_ip, 64), left(p_user_agent, 512),
       jsonb_build_object('method', p_signature_method, 'chain_index', p_chain_index), p_signed_at);

  -- 14. Last signature -> completing.
  select count(*) into v_unsigned from public.signature_recipient
   where envelope_id = v_env.id and status <> 'signed';
  if v_unsigned = 0 then
    update public.signature_envelope
       set status = 'completing', completing_at = now()
     where id = v_env.id;
    -- Everyone has signed: clear the link deadline so the document never reads
    -- "Signature link expired" while the seal runs.
    update public.documents
       set signature_expires_at = null
     where id = v_env.document_id and esign_envelope_id = v_env.id
       and status = 'sent' and signed_at is null;
    insert into public.signature_envelope_event (envelope_id, event, actor)
    values (v_env.id, 'completing', 'system');
    return jsonb_build_object('result', 'ok', 'envelope_id', v_env.id, 'recipient_id', v_rec.id,
      'completion_required', true, 'remaining', 0, 'next_recipient_ids', to_jsonb('{}'::uuid[]),
      'current_last_receipt_sha256', p_receipt_sha256, 'current_chain_index', p_chain_index);
  end if;

  -- 15. Otherwise the next turn (sequential only). The caller mints tokens and
  -- calls esign_activate_recipient AFTER this transaction commits.
  if v_env.routing_mode = 'sequential' then
    select min(routing_order) into v_next_order from public.signature_recipient
     where envelope_id = v_env.id and status <> 'signed';
    v_next := array(select r.id from public.signature_recipient r
                     where r.envelope_id = v_env.id and r.routing_order = v_next_order
                       and r.status = 'pending'
                     order by r.id);
  end if;
  return jsonb_build_object('result', 'ok', 'envelope_id', v_env.id, 'recipient_id', v_rec.id,
    'completion_required', false, 'remaining', v_unsigned, 'next_recipient_ids', to_jsonb(v_next),
    'current_last_receipt_sha256', p_receipt_sha256, 'current_chain_index', p_chain_index);
end $$;

-- (13) CLAIM the exclusive seal lease (S8/C12). No event.
create or replace function public.esign_claim_seal(
  p_envelope_id uuid, p_lease_seconds int, p_force boolean)
returns jsonb language plpgsql as $$
declare
  v_env  public.signature_envelope%rowtype;
  v_secs int := least(greatest(coalesce(p_lease_seconds, 240), 60), 290);
begin
  select * into v_env from public.signature_envelope where id = p_envelope_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if v_env.status = 'completed' then return jsonb_build_object('result', 'completed'); end if;
  if v_env.status <> 'completing' then return jsonb_build_object('result', 'not_completing'); end if;
  if v_env.seal_lease_until is not null and v_env.seal_lease_until > now() then
    return jsonb_build_object('result', 'held', 'lease_until', v_env.seal_lease_until);
  end if;
  if not coalesce(p_force, false)
     and v_env.seal_next_attempt_at is not null and v_env.seal_next_attempt_at > now() then
    return jsonb_build_object('result', 'backoff', 'retry_at', v_env.seal_next_attempt_at);
  end if;

  update public.signature_envelope
     set seal_lease_id    = gen_random_uuid(),
         seal_lease_until = now() + make_interval(secs => v_secs)
   where id = v_env.id
  returning * into v_env;

  return jsonb_build_object('result', 'claimed', 'lease_id', v_env.seal_lease_id,
                            'lease_until', v_env.seal_lease_until);
end $$;

-- (14) RELEASE a lease after a failed attempt: exactly ONE seal_failed event
-- per lease, backoff 2 min -> 10 min -> 60 min (then 60 min).
create or replace function public.esign_release_seal(
  p_envelope_id uuid, p_lease_id uuid, p_error_class text, p_check text)
returns jsonb language plpgsql as $$
declare
  v_env     public.signature_envelope%rowtype;
  v_attempt int;
begin
  select * into v_env from public.signature_envelope where id = p_envelope_id for update;
  if not found or p_lease_id is null or v_env.seal_lease_id is distinct from p_lease_id then
    return jsonb_build_object('result', 'not_holder', 'attempt', v_env.seal_attempts);
  end if;

  v_attempt := least(v_env.seal_attempts + 1, 1000);
  update public.signature_envelope
     set seal_attempts        = v_attempt,
         seal_next_attempt_at = now() + case v_attempt
                                          when 1 then interval '2 minutes'
                                          when 2 then interval '10 minutes'
                                          else interval '60 minutes' end,
         seal_lease_id        = null,
         seal_lease_until     = null
   where id = v_env.id;

  insert into public.signature_envelope_event (envelope_id, event, actor, meta)
  values (v_env.id, 'seal_failed', 'system',
          jsonb_build_object('attempt', v_attempt,
                             'error_class', left(coalesce(p_error_class, ''), 80),
                             'check', left(coalesce(p_check, ''), 40)));

  return jsonb_build_object('result', 'released', 'attempt', v_attempt);
end $$;

-- (15) COMPLETE (seal route / staff Finish sealing). Completes from FROZEN
-- evidence only: no live category / path / financial re-test (S2/S3). Roster,
-- chain or document-row mismatches release the lease and stay completing (C6).
create or replace function public.esign_complete_envelope(
  p_envelope_id uuid, p_lease_id uuid, p_signed_recipient_ids uuid[], p_receipt_chain text[],
  p_envelope_hash text, p_sealed_pdf_path text, p_sealed_pdf_sha256 text)
returns jsonb language plpgsql as $$
declare
  v_env   public.signature_envelope%rowtype;
  v_doc   public.documents%rowtype;
  v_type  public.esign_document_type%rowtype;
  v_rel   jsonb;
  v_chain text[];
  v_eng   uuid;
begin
  -- 1. Envelope.
  select * into v_env from public.signature_envelope where id = p_envelope_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if v_env.status = 'completed' then
    return jsonb_build_object('result', 'already_completed', 'sealed_pdf_path', v_env.sealed_pdf_path,
      'document_id', v_env.document_id, 'client_id', v_env.client_id,
      'engagement_id', v_env.engagement_id, 'engagement_activated', false);
  end if;
  if v_env.status <> 'completing' then
    return jsonb_build_object('result', 'not_completing', 'document_id', v_env.document_id,
      'client_id', v_env.client_id, 'engagement_id', v_env.engagement_id, 'engagement_activated', false);
  end if;

  -- 2. S12: artifact path and hashes (raise).
  if not coalesce(p_sealed_pdf_path like 'envelopes/' || v_env.id::text || '/attempts/%/sealed.pdf', false)
     or p_sealed_pdf_sha256 is null or p_sealed_pdf_sha256 !~ '^[0-9a-f]{64}$'
     or p_envelope_hash is null or p_envelope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'esign_bad_artifact_path';
  end if;

  -- 3. Lease.
  if p_lease_id is null or v_env.seal_lease_id is distinct from p_lease_id
     or v_env.seal_lease_until is null or v_env.seal_lease_until <= now() then
    return jsonb_build_object('result', 'not_holder', 'document_id', v_env.document_id,
      'client_id', v_env.client_id, 'engagement_id', v_env.engagement_id, 'engagement_activated', false);
  end if;

  -- 4. Roster: every recipient signed, and exactly the set that was sealed.
  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  if coalesce(
       exists (select 1 from public.signature_recipient
                where envelope_id = v_env.id and status <> 'signed')
    or p_signed_recipient_ids is null
    or (select array_agg(x order by x) from unnest(p_signed_recipient_ids) x)
       is distinct from
       (select array_agg(r.id order by r.id) from public.signature_recipient r where r.envelope_id = v_env.id)
    , true) then
    v_rel := public.esign_release_seal(v_env.id, p_lease_id, 'roster_moved', 'roster');
    return jsonb_build_object('result', 'roster_moved', 'attempt', v_rel->'attempt',
      'document_id', v_env.document_id, 'client_id', v_env.client_id,
      'engagement_id', v_env.engagement_id, 'engagement_activated', false);
  end if;

  -- 5. Chain: chain_index exactly 1..n, receipts in chain_index order equal the
  -- sealed chain, each prev links to the previous receipt, head matches.
  select array_agg(r.receipt_sha256 order by r.chain_index) into v_chain
    from public.signature_recipient r where r.envelope_id = v_env.id;
  if coalesce(
       exists (select 1 from public.signature_recipient
                where envelope_id = v_env.id and chain_index is null)
    or exists (select 1 from (
                 select r.chain_index, row_number() over (order by r.chain_index) as rn
                   from public.signature_recipient r where r.envelope_id = v_env.id) s
                where s.chain_index <> s.rn)
    or p_receipt_chain is null
    or v_chain is distinct from p_receipt_chain
    or exists (select 1 from (
                 select r.prev_receipt_sha256,
                        lag(r.receipt_sha256) over (order by r.chain_index) as expected_prev
                   from public.signature_recipient r where r.envelope_id = v_env.id) s
                where s.prev_receipt_sha256 is distinct from s.expected_prev)
    or v_chain[cardinality(v_chain)] is distinct from v_env.last_receipt_sha256
    , true) then
    v_rel := public.esign_release_seal(v_env.id, p_lease_id, 'chain_moved', 'chain');
    return jsonb_build_object('result', 'chain_moved', 'attempt', v_rel->'attempt',
      'document_id', v_env.document_id, 'client_id', v_env.client_id,
      'engagement_id', v_env.engagement_id, 'engagement_activated', false);
  end if;

  -- 6. Document row (identity only; NO category / path / financial test).
  select * into v_doc from public.documents
   where id = v_env.document_id and client_id = v_env.client_id
   for update;
  if not found or v_doc.signed_at is not null or v_doc.esign_envelope_id is distinct from v_env.id then
    v_rel := public.esign_release_seal(v_env.id, p_lease_id, 'document_changed', 'document_row');
    return jsonb_build_object('result', 'document_changed', 'attempt', v_rel->'attempt',
      'document_id', v_env.document_id, 'client_id', v_env.client_id,
      'engagement_id', v_env.engagement_id, 'engagement_activated', false);
  end if;

  -- 7. One statement group: envelope, document, engagement, events.
  update public.signature_envelope
     set status            = 'completed',
         completed_at      = now(),
         envelope_hash     = p_envelope_hash,
         sealed_pdf_path   = p_sealed_pdf_path,
         sealed_pdf_sha256 = p_sealed_pdf_sha256,
         seal_lease_id     = null,
         seal_lease_until  = null
   where id = v_env.id;

  -- sealed_storage_path stays NULL: v2 writes no client-files copy.
  update public.documents
     set status = 'executed', signed_at = now(), signature_expires_at = null
   where id = v_doc.id;

  select * into v_type from public.esign_document_type where document_type = v_env.document_type;
  if found and v_type.activates_engagement and v_env.engagement_id is not null
     and v_doc.engagement_id = v_env.engagement_id then
    update public.engagements
       set status = 'active'
     where id = v_env.engagement_id and client_id = v_env.client_id and status = 'pending_signature'
    returning id into v_eng;
  end if;

  insert into public.signature_envelope_event (envelope_id, event, actor, meta) values
    (v_env.id, 'sealed',    'system', jsonb_build_object('sealed_pdf_sha256', p_sealed_pdf_sha256)),
    (v_env.id, 'completed', 'system', '{}'::jsonb);
  if v_eng is not null then
    insert into public.signature_envelope_event (envelope_id, event, actor, meta)
    values (v_env.id, 'engagement_activated', 'system', jsonb_build_object('engagement_id', v_eng));
  end if;

  return jsonb_build_object('result', 'ok', 'document_id', v_env.document_id, 'client_id', v_env.client_id,
    'engagement_id', v_env.engagement_id, 'engagement_activated', v_eng is not null,
    'sealed_pdf_path', p_sealed_pdf_path);
end $$;

-- (16) CLOSE: staff void (id + client) / signer decline (token) / system drift
-- void. Every close restores the document's pre-send state.
create or replace function public.esign_close_envelope(
  p_envelope_id uuid, p_client_id uuid, p_token_hash text, p_new_status text,
  p_actor text, p_actor_user_id uuid, p_session_user_id uuid, p_reason text,
  p_extra_event text, p_meta jsonb, p_otp_session_hash text, p_ip text, p_user_agent text)
returns text language plpgsql as $$
declare
  v_tok       public.signature_access_token%rowtype;
  v_env       public.signature_envelope%rowtype;
  v_rec       public.signature_recipient%rowtype;
  v_exp       text;
  v_env_id    uuid;
  v_client_id uuid;
begin
  -- 1. Argument shape.
  if p_new_status is null or p_new_status not in ('voided','declined')
     or p_actor is null or p_actor not in ('staff','signer','system')
     or (p_extra_event is not null and p_extra_event <> 'drift_detected')
     or ((p_new_status = 'declined') <> (p_actor = 'signer' and p_token_hash is not null))
     or (p_actor = 'signer' and p_token_hash is null)
     or (p_actor = 'staff'  and (p_envelope_id is null or p_client_id is null
                                 or p_actor_user_id is null or p_new_status <> 'voided'))
     or (p_actor = 'system' and (p_envelope_id is null or p_client_id is null
                                 or p_new_status <> 'voided')) then
    raise exception 'esign_bad_close';
  end if;

  -- 2. Resolve and lock.
  if p_actor = 'signer' then
    select * into v_tok from public.signature_access_token
     where token_hash = p_token_hash and revoked_at is null;
    if not found then return 'not_found'; end if;
    if p_envelope_id is not null and p_envelope_id is distinct from v_tok.envelope_id then
      return 'not_found';
    end if;
    v_env_id    := v_tok.envelope_id;
    v_client_id := coalesce(p_client_id, v_tok.client_id);
  else
    v_env_id    := p_envelope_id;
    v_client_id := p_client_id;
  end if;

  select * into v_env from public.signature_envelope
   where id = v_env_id and client_id = v_client_id
   for update;
  if not found then return 'not_found'; end if;
  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  if p_actor = 'signer' then
    select * into v_tok from public.signature_access_token
     where id = v_tok.id and revoked_at is null
     for update;
    if not found then return 'not_found'; end if;
  end if;

  -- 3. Lazy expiry has already cancelled recipients, revoked tokens and restored.
  v_exp := public.esign_envelope_expire_if_due(v_env.id);
  if v_exp = 'expired' then return 'expired'; end if;
  if v_exp = 'promoted' then return 'completing'; end if;

  -- 4. Only in_progress closes; completing only for a system drift void.
  if v_env.status = 'completing' then
    if not (p_actor = 'system' and p_extra_event = 'drift_detected') then
      return 'completing';
    end if;
  elsif v_env.status <> 'in_progress' then
    return v_env.status;
  end if;

  -- 5. Signer (S4/C8): the token's own recipient must still be able to decline.
  if p_actor = 'signer' then
    select * into v_rec from public.signature_recipient where id = v_tok.recipient_id;
    if not found then return 'not_found'; end if;
    if v_rec.status = 'signed' then return 'already_signed'; end if;
    if v_rec.status = 'pending' then return 'not_active'; end if;
    if v_rec.status in ('declined','canceled') then return v_rec.status; end if;
    if v_rec.kind = 'staff' and not (
         p_session_user_id is not null
         and p_session_user_id = v_rec.staff_user_id
         and public.esign_is_countersigner(p_session_user_id, v_rec.client_id)) then
      return 'staff_session_required';
    end if;
    if v_rec.require_sms_otp and (
         v_rec.otp_session_hash is null
      or p_otp_session_hash is distinct from v_rec.otp_session_hash
      or v_rec.otp_session_expires_at is null
      or v_rec.otp_session_expires_at <= now()) then
      return 'otp_required';
    end if;
  end if;

  -- 6. Extra event (drift).
  if p_extra_event is not null then
    insert into public.signature_envelope_event (envelope_id, event, actor, meta)
    values (v_env.id, p_extra_event, 'system', coalesce(p_meta, '{}'::jsonb));
  end if;

  -- 7. Envelope FIRST (the recipient guard reads it).
  if p_new_status = 'voided' then
    update public.signature_envelope
       set status = 'voided', voided_at = now(), void_reason = left(p_reason, 1000),
           seal_lease_id = null, seal_lease_until = null
     where id = v_env.id;
  else
    update public.signature_envelope
       set status = 'declined', declined_by_recipient_id = v_rec.id,
           seal_lease_id = null, seal_lease_until = null
     where id = v_env.id;
    -- 8. The declining recipient.
    update public.signature_recipient
       set status = 'declined', declined_at = now(), decline_reason = left(p_reason, 1000),
           otp_session_hash = null
     where id = v_rec.id;
  end if;

  -- 9. Close event. Only a signer row carries network details.
  insert into public.signature_envelope_event
    (envelope_id, recipient_id, event, actor, actor_user_id, ip, user_agent, meta)
  values (v_env.id,
          case when p_actor = 'signer' then v_rec.id end,
          p_new_status, p_actor,
          case when p_actor = 'staff' then p_actor_user_id end,
          case when p_actor = 'signer' then left(p_ip, 64) end,
          case when p_actor = 'signer' then left(p_user_agent, 512) end,
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 1000)));

  -- 10. Shared close tail.
  perform public.esign_envelope_finish_close(v_env.id, 'closed', p_actor, p_actor_user_id);
  return 'ok';
end $$;

-- (17) ABANDON a stuck seal (C2, staff). Voids a fully signed envelope after 30
-- minutes in completing with no live lease; signed recipients stay signed.
create or replace function public.esign_abandon_seal(
  p_envelope_id uuid, p_client_id uuid, p_actor_user_id uuid, p_reason text)
returns text language plpgsql as $$
declare v_env public.signature_envelope%rowtype;
begin
  if p_actor_user_id is null then
    raise exception 'esign_bad_args';
  end if;

  select * into v_env from public.signature_envelope
   where id = p_envelope_id and client_id = p_client_id
   for update;
  if not found then return 'not_found'; end if;
  if v_env.status = 'completed' then return 'completed'; end if;
  if v_env.status <> 'completing' then return 'not_completing'; end if;
  if coalesce(v_env.completing_at, v_env.sent_at) > now() - interval '30 minutes' then
    return 'too_soon';
  end if;
  if v_env.seal_lease_until is not null and v_env.seal_lease_until > now() then
    return 'sealing_now';
  end if;

  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;

  insert into public.signature_envelope_event (envelope_id, event, actor, actor_user_id, meta)
  values (v_env.id, 'seal_abandoned', 'staff', p_actor_user_id,
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 1000)));

  -- Clear both lease columns: an expired lease may still be stored, and
  -- signature_envelope_lease_check forbids a lease outside completing.
  update public.signature_envelope
     set status               = 'voided',
         voided_at            = now(),
         void_reason          = 'seal_failed: ' || left(coalesce(p_reason, ''), 980),
         seal_next_attempt_at = null,
         seal_lease_id        = null,
         seal_lease_until     = null
   where id = v_env.id;

  insert into public.signature_envelope_event (envelope_id, event, actor, actor_user_id, meta)
  values (v_env.id, 'voided', 'staff', p_actor_user_id, jsonb_build_object('reason', 'seal_failed'));

  perform public.esign_envelope_finish_close(v_env.id, 'closed', 'staff', p_actor_user_id);
  return 'ok';
end $$;

-- (18) SEALED DOWNLOAD (signed recipient, within the window). The app mints the
-- 60 s URL on every 'ok'; only the audit row is throttled.
create or replace function public.esign_envelope_sealed_download(
  p_token_hash text, p_window_days int, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare
  v_tok public.signature_access_token%rowtype;
  v_env public.signature_envelope%rowtype;
  v_rec public.signature_recipient%rowtype;
begin
  select * into v_tok from public.signature_access_token
   where token_hash = p_token_hash and revoked_at is null;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  select * into v_env from public.signature_envelope where id = v_tok.envelope_id for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  perform 1 from public.signature_recipient where envelope_id = v_env.id order by id for update;
  select * into v_tok from public.signature_access_token
   where id = v_tok.id and revoked_at is null
   for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;

  select * into v_rec from public.signature_recipient where id = v_tok.recipient_id;
  if not found or v_rec.status <> 'signed' then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_env.status = 'completing' then
    return jsonb_build_object('result', 'completing', 'completing_at', v_env.completing_at);
  end if;
  if v_env.status <> 'completed' then
    return jsonb_build_object('result', 'not_completed');
  end if;
  if v_env.completed_at <= now() - make_interval(days => p_window_days) then
    return jsonb_build_object('result', 'download_expired');
  end if;

  if not exists (
       select 1 from public.signature_envelope_event
        where envelope_id = v_env.id and recipient_id = v_rec.id and event = 'sealed_downloaded'
          and at > now() - interval '30 minutes') then
    insert into public.signature_envelope_event (envelope_id, recipient_id, event, actor, ip, user_agent)
    values (v_env.id, v_rec.id, 'sealed_downloaded', 'signer', left(p_ip, 64), left(p_user_agent, 512));
  end if;

  return jsonb_build_object('result', 'ok', 'sealed_pdf_path', v_env.sealed_pdf_path,
    'title', v_env.document_snapshot #>> '{document,title}');
end $$;


-- ── §8b v1 restructure (S7/C17) ─────────────────────────────────────────────
-- Identical argument names/types and return types as prod (verified with
-- pg_get_function_identity_arguments), so create or replace keeps OID and ACL.
-- v1 tables, guards and the remaining six v1 functions are untouched (0033).

create or replace function public.esign_create_request(
  p_request_id uuid, p_token_hash text, p_client_id uuid, p_document_id uuid,
  p_engagement_id uuid, p_document_type text,
  p_signer_contact_id uuid, p_signer_name text, p_signer_email text, p_signer_phone text,
  p_created_by uuid, p_document_snapshot jsonb, p_source_frozen_path text, p_source_sha256 text,
  p_consent_text text, p_checkbox_text text, p_document_hash text,
  p_expires_at timestamptz, p_replace_open boolean, p_supersede_siblings boolean)
returns jsonb language plpgsql as $$
begin
  -- v1 sends are retired: deployed v1 shows "E-signature isn't enabled".
  raise exception 'esign_type_disabled';
end $$;

create or replace function public.esign_finalize_signature(
  p_request_id uuid, p_token_hash text, p_signed_at timestamptz, p_printed_name text,
  p_signature_image_path text, p_signature_image_sha256 text,
  p_sealed_pdf_path text, p_sealed_pdf_sha256 text, p_sealed_client_path text,
  p_otp_session_hash text, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
begin
  raise exception 'esign_closed:retired';
end $$;

-- v1 restore never touches a document that a v2 envelope now owns.
create or replace function public.esign_restore_document(p_request_id uuid)
returns boolean language plpgsql as $$
begin
  update public.documents d
     set status               = r.doc_status_before_send,
         doc_type             = r.doc_type_before_send,
         engagement_id        = case when r.doc_engagement_before_send is null then null else d.engagement_id end,
         signature_expires_at = null
    from public.signature_request r
   where r.id = p_request_id and d.id = r.document_id and d.signature_request_id = r.id
     and d.status = 'sent' and d.signed_at is null
     and d.esign_envelope_id is null;
  return found;
end $$;


-- ── §9 RLS, grants, column-level SELECT ─────────────────────────────────────

alter table public.signature_envelope       enable row level security;
alter table public.signature_recipient      enable row level security;
alter table public.signature_field          enable row level security;
alter table public.signature_access_token   enable row level security;
alter table public.signature_supersede      enable row level security;
alter table public.signature_envelope_event enable row level security;

-- Undo this project's default ACL. A table-level REVOKE ALL also strips column
-- grants, so re-running this block resets to exactly the grants below.
revoke all on table
  public.signature_envelope, public.signature_recipient, public.signature_field,
  public.signature_access_token, public.signature_supersede, public.signature_envelope_event
  from public, anon, authenticated;

grant select, insert, update, delete on table
  public.signature_envelope, public.signature_recipient, public.signature_field,
  public.signature_access_token, public.signature_supersede, public.signature_envelope_event
  to service_role;

-- authenticated: SELECT only, and NOTHING on signature_access_token at all.
grant select on table public.signature_field          to authenticated;
grant select on table public.signature_supersede      to authenticated;
grant select on table public.signature_envelope_event to authenticated;

-- Column-level: hide every esign-bucket path, the lease and every capability
-- hash. Consequence: PostgREST select('*') as a user fails; always list columns.
grant select (
  id, client_id, document_id, engagement_id, document_type, created_by, status,
  routing_mode, source_mode,
  original_sha256, original_content_type, original_file_name, original_byte_size,
  render_sha256, page_count,
  hash_version, document_snapshot, document_hash, envelope_hash, last_receipt_sha256,
  doc_status_before_send, doc_type_before_send, doc_engagement_before_send, supersede_siblings,
  sealed_pdf_sha256, seal_attempts, seal_next_attempt_at,
  sent_at, expires_at, completing_at, completed_at, voided_at, void_reason,
  declined_by_recipient_id, expired_at, created_at, updated_at
) on public.signature_envelope to authenticated;
-- withheld: original_frozen_path, render_frozen_path, sealed_pdf_path,
--           seal_lease_id, seal_lease_until

grant select (
  id, envelope_id, client_id, kind, routing_order, status,
  contact_id, staff_user_id, name, email, phone,
  consent_text, checkbox_text, recipient_hash, require_sms_otp, otp_sends, otp_verified_at,
  activated_at, viewed_at, source_opened_at, original_downloaded_at,
  consent_agreed_at, signed_at, printed_name, signature_method,
  signature_image_sha256, typed_signature_text, typed_signature_font,
  date_text, time_zone, prev_receipt_sha256, receipt_sha256, applied_field_ids, chain_index,
  signed_ip, signed_user_agent, declined_at, decline_reason, canceled_at,
  created_at, updated_at
) on public.signature_recipient to authenticated;
-- withheld: otp_hash, otp_expires_at, otp_attempts, otp_last_sent_at,
--           otp_session_hash, otp_session_expires_at, signature_image_path

-- The event identity sequence inherits the default ACL too.
do $$
declare v_seq text := pg_get_serial_sequence('public.signature_envelope_event', 'seq');
begin
  if v_seq is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated', v_seq);
    execute format('grant usage, select on sequence %s to service_role', v_seq);
  end if;
end $$;

-- Staff read only; is_member_of short-circuits true for platform admins. No
-- client-member policy and no write policy on any of the six tables.
drop policy if exists signature_envelope_staff_read on public.signature_envelope;
create policy signature_envelope_staff_read on public.signature_envelope
  for select to authenticated using ( public.is_staff() and public.is_member_of(client_id) );

drop policy if exists signature_recipient_staff_read on public.signature_recipient;
create policy signature_recipient_staff_read on public.signature_recipient
  for select to authenticated using ( public.is_staff() and public.is_member_of(client_id) );

drop policy if exists signature_field_staff_read on public.signature_field;
create policy signature_field_staff_read on public.signature_field
  for select to authenticated using ( public.is_staff() and public.is_member_of(client_id) );

drop policy if exists signature_supersede_staff_read on public.signature_supersede;
create policy signature_supersede_staff_read on public.signature_supersede
  for select to authenticated using (
    public.is_staff() and exists (
      select 1 from public.signature_envelope e
       where e.id = signature_supersede.envelope_id and public.is_member_of(e.client_id)) );

drop policy if exists signature_envelope_event_staff_read on public.signature_envelope_event;
create policy signature_envelope_event_staff_read on public.signature_envelope_event
  for select to authenticated using (
    public.is_staff() and exists (
      select 1 from public.signature_envelope e
       where e.id = signature_envelope_event.envelope_id and public.is_member_of(e.client_id)) );

-- signature_access_token gets NO policy and NO grant: service role only,
-- because the row is the capability.


-- ── §10 Function ACLs ───────────────────────────────────────────────────────
-- Guards are revoked from everyone, service_role included (EXECUTE is checked
-- when a trigger is created, not when it fires). Transition functions and the
-- countersigner predicate are service_role only. Explicit name lists, never a
-- LIKE pattern. document_esign_locked is granted in §7a; esign_override_on and
-- esign_is_trusted_role stay executable by everyone (0031).
do $$
declare
  f        record;
  v_guards text[] := array[
    'esign_envelope_guard','esign_recipient_guard','esign_field_guard','esign_token_guard',
    'esign_supersede_guard','esign_envelope_event_guard','documents_esign_guard'];
  v_fns    text[] := array[
    'esign_is_countersigner',
    'esign_envelope_restore_document','esign_envelope_restore_superseded',
    'esign_envelope_finish_close','esign_envelope_expire_if_due','esign_sweep_expired',
    'esign_create_envelope','esign_activate_recipient','esign_rotate_recipient_token',
    'esign_envelope_touch','esign_envelope_otp_send','esign_envelope_otp_check',
    'esign_record_signature','esign_claim_seal','esign_release_seal','esign_complete_envelope',
    'esign_close_envelope','esign_abandon_seal','esign_envelope_sealed_download',
    'esign_create_request','esign_finalize_signature','esign_restore_document'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname = any(v_guards) or p.proname = any(v_fns))
  loop
    if f.proname = any(v_guards) then
      execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    else
      execute format('revoke all on function %s from public, anon, authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;


-- ── §11 Storage ─────────────────────────────────────────────────────────────
-- Widen the esign bucket: certificate-mode originals are stored as
-- application/octet-stream so no storage origin ever serves HTML or SVG.
update storage.buckets
   set allowed_mime_types = array['image/png','application/pdf','application/octet-stream']
 where id = 'esign';
update storage.buckets set public = false where id = 'esign' and public;

-- Still NO storage.objects policy for 'esign': service role only.
drop policy if exists esign_auth_read_signatures on storage.objects;

-- Object layout (v2):
--   esign  envelopes/{env}/original.bin                                     at send (frozen original)
--   esign  envelopes/{env}/render.pdf                                       at send (the signed PDF)
--   esign  envelopes/{env}/recipients/{rid}/attempts/{aid}/signature.png    at submit (drawn only)
--   esign  envelopes/{env}/attempts/{aid}/sealed.pdf                        at completion
--   client-files  (nothing — v2 writes no convenience copy)

-- Follow-up (a): client members must not read {client_id}/esign/**. The live
-- policy body plus a staff-only clause; the name is dropped first because
-- permissive policies OR (the 0014 -> 0015 bug).
drop policy if exists client_files_select on storage.objects;
create policy client_files_select on storage.objects
  for select using (
    bucket_id = 'client-files'
    and public.is_member_of(public.storage_object_client(name))
    and ( not public.is_financial_object(name)
          or public.can_read_financials(public.storage_object_client(name)) )
    and (public.is_staff() or strpos(name, '/esign/') = 0)
  );

-- S3: once a document is sent, nobody but the service role writes or deletes its
-- client-files object — staff included (no is_staff bypass on the new clause).
drop policy if exists client_files_insert on storage.objects;
create policy client_files_insert on storage.objects
  for insert with check (
    bucket_id = 'client-files'
    and public.is_member_of(((storage.foldername(name))[1])::uuid)
    and strpos(name, '/esign/') = 0
    and (public.is_staff() or not public.document_object_locked(name))
    and not public.document_esign_locked(name)
  );

drop policy if exists client_files_delete on storage.objects;
create policy client_files_delete on storage.objects
  for delete using (
    bucket_id = 'client-files'
    and public.is_member_of(public.storage_object_client(name))
    and ( not public.is_financial_object(name)
          or public.can_read_financials(public.storage_object_client(name)) )
    and strpos(name, '/esign/') = 0
    and (public.is_staff() or not public.document_object_locked(name))
    and not public.document_esign_locked(name)
  );

-- storage move() and overwrite update() are authorized by the UPDATE policy,
-- not insert/delete. Live 0031 body plus the lock in both clauses: USING stops
-- renaming or overwriting a locked object, WITH CHECK stops moving another
-- object onto a locked path.
drop policy if exists client_files_update on storage.objects;
create policy client_files_update on storage.objects
  for update using (
    bucket_id = 'client-files'
    and public.is_member_of(((storage.foldername(name))[1])::uuid)
    and public.is_staff()
    and strpos(name, '/esign/') = 0
    and not public.document_esign_locked(name)
  ) with check (
    bucket_id = 'client-files'
    and public.is_member_of(((storage.foldername(name))[1])::uuid)
    and public.is_staff()
    and strpos(name, '/esign/') = 0
    and not public.document_esign_locked(name)
  );


-- ── §12 pg_cron: expiry sweep (C4) ──────────────────────────────────────────
-- Pure SQL, runs as the job owner (a trusted role for the guards). pg_cron
-- 1.6.x updates a same-named job, so re-running is a no-op. Retire with
-- select cron.unschedule('esign-sweep-expired');
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('esign-sweep-expired', '*/15 * * * *',
                          $cmd$select public.esign_sweep_expired(50)$cmd$);
  end if;
end $$;


-- ── Post-apply verification (SELECT only) ───────────────────────────────────
-- select document_type, sealing_mode, max_recipients, allow_typed_signature,
--        allowed_content_types, expiry_days
--   from public.esign_document_type;                       -- msa | auto | 10 | t | 8 types | 14
-- select id, public, file_size_limit, allowed_mime_types
--   from storage.buckets where id = 'esign';               -- png + pdf + octet-stream
-- select policyname, cmd, qual from pg_policies
--  where schemaname='storage' and tablename='objects' and policyname='client_files_select';
--                                                          -- qual must contain strpos(name,'/esign/')
-- select tablename, policyname, cmd from pg_policies
--  where schemaname='public' and tablename like 'signature%';   -- 5 staff_read policies, no token policy
-- select grantee, table_name, count(*) from information_schema.role_column_grants
--  where table_schema='public' and table_name in ('signature_envelope','signature_recipient')
--    and grantee in ('anon','authenticated') group by 1,2;      -- authenticated only; no anon
-- select has_table_privilege('authenticated','public.signature_access_token','select');  -- false
-- select p.proname, p.prosecdef, p.proacl from pg_proc p
--  where p.pronamespace='public'::regnamespace and p.proname like 'esign%'
--  order by 1;                       -- all secdef=false; guards: postgres only; rest: + service_role
-- select tgname, tgrelid::regclass from pg_trigger where tgname like 'trg_signature%';
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='documents' and column_name='esign_envelope_id';
-- select jobname, schedule, command, active from cron.job where jobname = 'esign-sweep-expired';  -- 1 row, active
-- select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace
--    and proname in ('esign_claim_seal','esign_release_seal','esign_abandon_seal','esign_sweep_expired',
--                    'esign_envelope_finish_close','esign_is_countersigner','document_esign_locked',
--                    'document_esign_superseded');
--                           -- 8 rows; only document_esign_locked + document_esign_superseded are secdef
-- select policyname from pg_policies where schemaname = 'storage'
--    and policyname in ('client_files_insert','client_files_delete','client_files_update')
--    and coalesce(with_check, qual) like '%document_esign_locked%';   -- 3 rows
-- select policyname from pg_policies where schemaname = 'storage' and policyname = 'client_files_update'
--    and qual like '%document_esign_locked%' and with_check like '%document_esign_locked%';  -- 1 row
-- select position('esign_type_disabled' in pg_get_functiondef('public.esign_create_request'::regproc)) > 0;  -- true
-- select conname from pg_constraint where conname in ('signature_access_token_shape_check',
--    'signature_envelope_lease_check','signature_recipient_chain_check');   -- 3 rows
-- select count(*) from public.signature_envelope;        -- 0 until the first v2 send
-- select count(*) from public.signature_request;         -- must still be 0 before 0033
-- select count(*) from public.signature_event;           -- must still be 0 before 0033

-- ── Rollback (0032 only; run before any v2 send) ────────────────────────────
-- select cron.unschedule('esign-sweep-expired');
-- begin;
-- set local gbtn.esign_override = 'on';
-- drop trigger if exists trg_signature_envelope_event_guard    on public.signature_envelope_event;
-- drop trigger if exists trg_signature_envelope_event_no_truncate on public.signature_envelope_event;
-- drop trigger if exists trg_signature_envelope_guard          on public.signature_envelope;
-- drop trigger if exists trg_signature_recipient_guard         on public.signature_recipient;
-- drop trigger if exists trg_signature_field_guard             on public.signature_field;
-- drop trigger if exists trg_signature_access_token_guard      on public.signature_access_token;
-- drop trigger if exists trg_signature_supersede_guard         on public.signature_supersede;
-- alter table public.documents drop column if exists esign_envelope_id;
-- drop table if exists public.signature_envelope_event, public.signature_supersede,
--                      public.signature_access_token, public.signature_field,
--                      public.signature_recipient, public.signature_envelope;
-- drop function if exists public.esign_create_envelope, public.esign_activate_recipient,
--   public.esign_rotate_recipient_token, public.esign_envelope_touch, public.esign_envelope_otp_send,
--   public.esign_envelope_otp_check, public.esign_record_signature, public.esign_complete_envelope,
--   public.esign_close_envelope, public.esign_envelope_sealed_download,
--   public.esign_envelope_expire_if_due, public.esign_envelope_restore_document,
--   public.esign_envelope_restore_superseded, public.esign_envelope_guard,
--   public.esign_recipient_guard, public.esign_field_guard, public.esign_token_guard,
--   public.esign_supersede_guard, public.esign_envelope_event_guard,
--   public.esign_claim_seal, public.esign_release_seal, public.esign_abandon_seal,
--   public.esign_sweep_expired, public.esign_envelope_finish_close, public.esign_is_countersigner;
-- alter table public.esign_document_type
--   drop column if exists sealing_mode, drop column if exists max_recipients,
--   drop column if exists allow_typed_signature, drop column if exists allow_outside_signers,
--   drop column if exists consent_text_outside, drop column if exists consent_text_staff;
-- alter table public.esign_document_type alter column allowed_content_types set default array['application/pdf'];
-- update public.esign_document_type set allowed_content_types = array['application/pdf'] where document_type = 'msa';
-- update storage.buckets set allowed_mime_types = array['image/png','application/pdf'] where id = 'esign';
-- -- Restore client_files_select to its live pre-0032 body (0031 never changed it):
-- drop policy if exists client_files_select on storage.objects;
-- create policy client_files_select on storage.objects for select using (
--   bucket_id = 'client-files' and public.is_member_of(public.storage_object_client(name))
--   and (not public.is_financial_object(name)
--        or public.can_read_financials(public.storage_object_client(name))));
-- -- Restore client_files_insert / client_files_delete to their 0031 text:
-- drop policy if exists client_files_insert on storage.objects;
-- create policy client_files_insert on storage.objects
--   for insert with check (
--     bucket_id = 'client-files'
--     and public.is_member_of(((storage.foldername(name))[1])::uuid)
--     and strpos(name, '/esign/') = 0
--     and (public.is_staff() or not public.document_object_locked(name)));
-- drop policy if exists client_files_delete on storage.objects;
-- create policy client_files_delete on storage.objects
--   for delete using (
--     bucket_id = 'client-files'
--     and public.is_member_of(public.storage_object_client(name))
--     and (not public.is_financial_object(name)
--          or public.can_read_financials(public.storage_object_client(name)))
--     and strpos(name, '/esign/') = 0
--     and (public.is_staff() or not public.document_object_locked(name)));
-- -- Restore client_files_update to its 0031 text (live pre-0032 body):
-- drop policy if exists client_files_update on storage.objects;
-- create policy client_files_update on storage.objects
--   for update using (
--     bucket_id = 'client-files'
--     and public.is_member_of(((storage.foldername(name))[1])::uuid)
--     and public.is_staff()
--     and strpos(name, '/esign/') = 0
--   ) with check (
--     bucket_id = 'client-files'
--     and public.is_member_of(((storage.foldername(name))[1])::uuid)
--     and public.is_staff()
--     and strpos(name, '/esign/') = 0
--   );
-- -- THEN (no policy references it any more):
-- drop function if exists public.document_esign_locked(text);
-- -- The 0032 documents_esign_guard calls this; re-run 0031 (below) in the same
-- -- sitting so no DELETE on documents lands in between:
-- drop function if exists public.document_esign_superseded(uuid);
-- commit;
-- Then re-run 0031 to restore esign_create_request, esign_finalize_signature,
-- esign_restore_document and documents_esign_guard (and their ACLs).
-- Then empty envelopes/** from the esign bucket by hand (Supabase -> Storage).

-- ── 0033 sketch — DO NOT WRITE IN THIS WORKSTREAM ───────────────────────────
-- After v2 ships and a human re-confirms signature_request = 0 and
-- signature_event = 0 rows: revoke service_role EXECUTE on the nine v1
-- functions (or replace each body with `raise 'esign_v1_retired'`), drop
-- documents.signature_request_id, and drop signature_event + signature_request
-- under `set local gbtn.esign_override = 'on'`.
