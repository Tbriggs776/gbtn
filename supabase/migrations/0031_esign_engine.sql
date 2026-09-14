-- ───────────────────────────────────────────────────────────────────────────
-- Phase 31: in-house e-signature engine (port of the Razzle engine).
--
-- Staff send a client document for signature; the signer opens a token link
-- (no login), consents, signs; the server seals a PDF and stamps the document
-- executed, flipping a linked pending_signature engagement to active.
--
--  * The signer never touches these tables. Every signer action goes through
--    app/api/esign/route.ts with the service role AFTER a token-hash lookup.
--    The token itself is never stored — only sha256hex(token).
--  * Every state transition is one esign_* function below: one statement
--    boundary, request row locked FOR UPDATE, status + expiry re-checked.
--    Signer-path functions RETURN a result code; esign_create_request and
--    esign_finalize_signature RAISE '<code>' (lib/esign/errors.ts maps them).
--  * Evidence is immutable: signature_event is append-only and requests are
--    never deleted, even by the service role. Manual recovery only via
--    `set local gbtn.esign_override = 'on'` inside a transaction.
--  * This project's default ACLs GRANT anon/authenticated full DML on every
--    new public table (and sequence) and EXECUTE on every new function, so
--    this file revokes explicitly. RLS stays enabled as defense in depth.
--  * No client-member policies on any e-sign table. Clients see the outcome on
--    their documents row (status / signed_at / sealed_storage_path /
--    signature_expires_at).
--  * Guard trigger functions are SECURITY INVOKER on purpose: current_user
--    must be the CALLER (service_role via PostgREST). Inside a SECURITY
--    DEFINER function current_user is the owner. Every transition function
--    is INVOKER too, so the guards see service_role and trust it.
--
-- Deliberate choices a reviewer should not "fix":
--
--  1. created_by / actor_user_id are plain uuids, NOT FKs to auth.users. An
--     FK with ON DELETE SET NULL would try to UPDATE append-only event rows
--     and frozen terminal requests, so deleting a staff user who ever sent or
--     voided a request would fail.
--  2. Closing a request (void, decline, drift, expiry) restores the document's
--     PRE-SEND status / doc_type / engagement link, captured in SQL at create
--     (doc_*_before_send). A replace chain inherits the replaced request's
--     values rather than recording 'sent'. The request pointer is kept, so a
--     document that was ever sent stays undeletable.
--  3. SMS verification is bound to one browser: esign_check_otp stores the
--     hash of a one-time session secret (30 min), and finalize / decline
--     require it. Staff and system events never carry an IP or user agent
--     (signature_event_network_actor_check), so the client-facing certificate
--     cannot print a GBTN staff member's network details.
--  4. The storage path of any document sent for signature must sit under its
--     own {client_id}/ prefix and must not be a financial object. The prefix
--     is tested with split_part FIRST: storage_object_client() casts segment
--     1 to uuid and throws on anything else, so it is never called here.
--  5. client-files write policies are tightened in §9: no cookie role (staff
--     included) may INSERT/UPDATE/DELETE an `/esign/` path, and UPDATE is
--     staff-only. client_files_select is untouched. Sealed copies are served
--     only from the private esign bucket.
--
-- storage.objects / storage.buckets are owned by supabase_storage_admin; the
-- policy DDL in §9 works as postgres only because supautils.policy_grants
-- lists storage.objects for postgres (verified 2026-09-14).
--
-- Idempotent: re-running is the normal recovery path (no migration ledger).
-- Every constraint, policy and trigger is dropped by name, then created.
-- ───────────────────────────────────────────────────────────────────────────

-- ── 0. Helpers ──────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at()          -- identical to 0005
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create or replace function public.esign_override_on()
returns boolean language sql stable as $$
  select coalesce(current_setting('gbtn.esign_override', true), '') = 'on';
$$;

create or replace function public.esign_is_trusted_role()
returns boolean language sql stable as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin');
$$;

-- ── 1. Per-type configuration ───────────────────────────────────────────────
create table if not exists public.esign_document_type (
  document_type          text primary key,
  label                  text not null,
  esign_enabled          boolean not null default false,
  require_sms_otp        boolean not null default false,
  activates_engagement   boolean not null default false,
  allowed_content_types  text[] not null default array['application/pdf'],
  consent_text           text not null,
  checkbox_text          text not null,
  expiry_days            int  not null default 14,
  notify_emails          jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.esign_document_type drop constraint if exists esign_document_type_key_check;
alter table public.esign_document_type add constraint esign_document_type_key_check
  check (document_type in ('msa','sow','onboarding','report','deliverable','other'));  -- mirrors documents_doc_type_check

alter table public.esign_document_type drop constraint if exists esign_document_type_expiry_check;
alter table public.esign_document_type add constraint esign_document_type_expiry_check
  check (expiry_days between 1 and 90);

alter table public.esign_document_type drop constraint if exists esign_document_type_notify_check;
alter table public.esign_document_type add constraint esign_document_type_notify_check
  check (jsonb_typeof(notify_emails) = 'array');

drop trigger if exists trg_esign_document_type_touch on public.esign_document_type;
create trigger trg_esign_document_type_touch before update on public.esign_document_type
  for each row execute function public.touch_updated_at();

-- Seed MSA ENABLED so the path works end to end (called out in the PR).
-- {{placeholders}} are filled at send time from a fixed allowlist
-- (lib/esign/config.ts); the FILLED text is snapshotted and hashed.
-- require_sms_otp is read from this row at create; the app never passes it.
-- LEGAL: adapted from Razzle 0014. Counsel should review before a real client
-- signs. Existing rows are never overwritten (on conflict do nothing).
insert into public.esign_document_type
  (document_type, label, esign_enabled, require_sms_otp, activates_engagement,
   allowed_content_types, consent_text, checkbox_text, expiry_days, notify_emails)
values (
  'msa', 'Master Services Agreement', true, false, true,
  array['application/pdf'],
  $c$CONSENT TO ELECTRONIC RECORDS AND SIGNATURES

{{provider_legal_name}}, doing business as {{provider_name}} ("GBTN"), asks you to review and sign the {{document_title}} electronically. Please read this before you sign.

1. Scope. This consent covers only the document presented on this page and the record of your signature of it.

2. Electronic signature. By checking the box and signing below, you agree to use electronic records and an electronic signature for this document. You agree that your electronic signature is the legal equivalent of your handwritten signature, that you have reviewed the document in full, and that you intend to be legally bound by it, consistent with the federal Electronic Signatures in Global and National Commerce Act (ESIGN) and the Uniform Electronic Transactions Act as adopted in your state.

3. Authority. If you sign on behalf of {{client_legal_name}} or any other organization, you confirm that you are authorized to bind it.

4. Paper copy. You may request a paper copy of the signed document at any time, at no charge, by emailing {{provider_contact_email}}.

5. Withdrawing consent. You may decline to sign electronically by choosing "Decline to sign" or by closing this page and contacting GBTN at {{provider_contact_email}}; GBTN will arrange another way to sign. Withdrawing consent does not affect anything you signed electronically before withdrawing.

6. What you need. A current web browser, an internet connection, a device that can open PDF files, and access to the email address this link was sent to. A signed copy will be emailed to you.

7. Record of signing. GBTN records your IP address, browser details, and the date and time of each step, and seals the signed document with a SHA-256 fingerprint so any later change is detectable.$c$,
  $c$I have read the Consent to Electronic Records and Signatures and the {{document_title}}, I agree to sign electronically, and I understand my electronic signature is legally binding.$c$,
  14, '[]'::jsonb
)
on conflict (document_type) do nothing;
-- notify_emails stays '[]' in this PUBLIC repo; code falls back to CONTACT_NOTIFY_TO.

-- ── 2. Signature requests ───────────────────────────────────────────────────
create table if not exists public.signature_request (
  id                          uuid primary key default gen_random_uuid(),  -- app supplies it (frozen-source path)
  token_hash                  text not null,                               -- sha256hex(token); token never stored
  client_id                   uuid not null references public.clients (id) on delete restrict,
  document_id                 uuid not null references public.documents (id) on delete restrict,
  engagement_id               uuid references public.engagements (id) on delete set null,
  document_type               text not null references public.esign_document_type (document_type) on delete restrict,
  status                      text not null default 'sent',

  signer_contact_id           uuid references public.client_contacts (id) on delete set null,
  signer_name                 text not null,
  signer_email                text not null,
  signer_phone                text,                 -- E.164 when present
  created_by                  uuid,                 -- staff user id; deliberately NO FK (header note 1)

  hash_version                smallint not null default 1,
  document_snapshot           jsonb not null,
  source_frozen_path          text not null,        -- esign bucket: requests/{id}/source.pdf
  source_sha256               text not null,
  consent_text                text not null,        -- FILLED text exactly as shown
  checkbox_text               text not null,        -- FILLED text exactly as shown
  document_hash               text not null,        -- sha256(canonical {v, snapshot, consent, checkbox, source})

  -- The document as it was before this send; restored on void/decline/drift/expiry.
  doc_status_before_send      text not null,
  doc_type_before_send        text,
  doc_engagement_before_send  uuid,                 -- deliberately NO FK: a snapshot, not a reference

  require_sms_otp             boolean not null default false,
  otp_hash                    text,
  otp_expires_at              timestamptz,
  otp_attempts                int not null default 0,
  otp_sends                   int not null default 0,
  otp_last_sent_at            timestamptz,
  otp_verified_at             timestamptz,
  otp_session_hash            text,                 -- sha256hex of the browser-held session secret
  otp_session_expires_at      timestamptz,

  consent_agreed_at           timestamptz,
  signer_printed_name         text,
  signature_image_path        text,                 -- esign bucket
  signature_image_sha256      text,
  sealed_pdf_path             text,                 -- esign bucket (authoritative copy)
  sealed_pdf_sha256           text,
  sealed_client_path          text,                 -- client-files convenience copy (never served)
  signed_ip                   text,
  signed_user_agent           text,

  sent_at                     timestamptz not null default now(),
  viewed_at                   timestamptz,
  source_opened_at            timestamptz,
  signed_at                   timestamptz,
  expires_at                  timestamptz not null,
  voided_at                   timestamptz,
  void_reason                 text,
  declined_at                 timestamptz,
  decline_reason              text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

alter table public.signature_request drop constraint if exists signature_request_status_check;
alter table public.signature_request add constraint signature_request_status_check
  check (status in ('sent','viewed','otp_sent','otp_verified','signed','declined','expired','voided'));

alter table public.signature_request drop constraint if exists signature_request_hash_format_check;
alter table public.signature_request add constraint signature_request_hash_format_check
  check (token_hash ~ '^[0-9a-f]{64}$'
     and source_sha256 ~ '^[0-9a-f]{64}$'
     and document_hash ~ '^[0-9a-f]{64}$'
     and (sealed_pdf_sha256 is null or sealed_pdf_sha256 ~ '^[0-9a-f]{64}$')
     and (signature_image_sha256 is null or signature_image_sha256 ~ '^[0-9a-f]{64}$')
     and (otp_session_hash is null or otp_session_hash ~ '^[0-9a-f]{64}$'));

alter table public.signature_request drop constraint if exists signature_request_email_check;
alter table public.signature_request add constraint signature_request_email_check
  check (signer_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     and char_length(signer_email) <= 254
     and char_length(signer_name) between 1 and 200
     and (signer_printed_name is null or char_length(signer_printed_name) between 2 and 120)
     and (decline_reason is null or char_length(decline_reason) <= 1000)
     and (void_reason is null or char_length(void_reason) <= 1000));

alter table public.signature_request drop constraint if exists signature_request_otp_check;
alter table public.signature_request add constraint signature_request_otp_check
  check ((not require_sms_otp or signer_phone is not null)
     and otp_attempts >= 0 and otp_sends >= 0);

alter table public.signature_request drop constraint if exists signature_request_before_send_check;
alter table public.signature_request add constraint signature_request_before_send_check
  check (doc_status_before_send in ('draft','sent','executed','superseded')
     and (doc_type_before_send is null
          or doc_type_before_send in ('msa','sow','onboarding','report','deliverable','other')));

alter table public.signature_request drop constraint if exists signature_request_signed_complete_check;
alter table public.signature_request add constraint signature_request_signed_complete_check
  check (status <> 'signed' or (
        signed_at is not null and consent_agreed_at is not null
    and signer_printed_name is not null
    and signature_image_path is not null and signature_image_sha256 is not null
    and sealed_pdf_path is not null and sealed_pdf_sha256 is not null
    and sealed_client_path is not null
    and (not require_sms_otp or otp_verified_at is not null)));

create unique index if not exists uq_signature_request_token_hash
  on public.signature_request (token_hash);
-- At most ONE open request per document (makes create race-safe) …
create unique index if not exists uq_signature_request_open_per_document
  on public.signature_request (document_id)
  where status in ('sent','viewed','otp_sent','otp_verified');
-- … and a document is signed at most once.
create unique index if not exists uq_signature_request_signed_per_document
  on public.signature_request (document_id)
  where status = 'signed';
create index if not exists idx_signature_request_client
  on public.signature_request (client_id, sent_at desc);
create index if not exists idx_signature_request_document
  on public.signature_request (document_id, sent_at desc);

drop trigger if exists trg_signature_request_touch on public.signature_request;
create trigger trg_signature_request_touch before update on public.signature_request
  for each row execute function public.touch_updated_at();

-- ── 3. Audit events (append-only) ───────────────────────────────────────────
create table if not exists public.signature_event (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,       -- stable order for equal `at`
  request_id     uuid not null references public.signature_request (id) on delete restrict,
  event          text not null,
  actor          text not null default 'signer',
  actor_user_id  uuid,                                      -- deliberately NO FK (header note 1)
  ip             text,
  user_agent     text,
  meta           jsonb not null default '{}'::jsonb,        -- never an OTP code, token, or path
  at             timestamptz not null default now()
);

alter table public.signature_event drop constraint if exists signature_event_event_check;
alter table public.signature_event add constraint signature_event_event_check
  check (event in ('sent','viewed','source_opened','otp_sent','otp_send_failed','otp_failed',
                   'otp_locked','otp_verified','consented','signed','sealed',
                   'engagement_activated','declined','voided','expired','drift_detected',
                   'sealed_downloaded','notified','notify_failed'));

alter table public.signature_event drop constraint if exists signature_event_shape_check;
alter table public.signature_event add constraint signature_event_shape_check
  check (actor in ('signer','staff','system')
     and (ip is null or char_length(ip) <= 64)
     and (user_agent is null or char_length(user_agent) <= 512)
     and jsonb_typeof(meta) = 'object');

-- Only the signer's own network details are evidence; staff/system rows carry none.
alter table public.signature_event drop constraint if exists signature_event_network_actor_check;
alter table public.signature_event add constraint signature_event_network_actor_check
  check (actor = 'signer' or (ip is null and user_agent is null));

create index if not exists idx_signature_event_request
  on public.signature_event (request_id, seq);

-- ── 4. Additive documents columns ───────────────────────────────────────────
alter table public.documents
  add column if not exists signature_request_id uuid
      references public.signature_request (id) on delete set null,  -- latest request (set at send)
  add column if not exists signed_at            timestamptz,
  add column if not exists sealed_storage_path  text,               -- client-files path of the sealed PDF
  add column if not exists signature_expires_at timestamptz;        -- lets every viewer tell a live link from a lapsed one

create unique index if not exists uq_documents_sealed_storage_path
  on public.documents (sealed_storage_path)
  where sealed_storage_path is not null;

comment on column public.documents.signature_request_id is
  'Latest e-sign request for this document (set at send, kept after signing).';
comment on column public.documents.sealed_storage_path is
  'client-files path of the sealed (signed) PDF. The authoritative copy lives in the esign bucket.';
comment on column public.documents.signature_expires_at is
  'Expiry of the request in signature_request_id while it is out for signature; cleared when closed.';

-- ── 5. Guards ───────────────────────────────────────────────────────────────
-- signature_event: append-only for EVERY role (service role included).
create or replace function public.esign_event_guard()
returns trigger language plpgsql as $$
begin
  if public.esign_override_on() then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE', 'TRUNCATE') then
    raise exception 'signature_event is append-only.' using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign events are written by the server only.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists trg_signature_event_guard on public.signature_event;
create trigger trg_signature_event_guard
  before insert or update or delete on public.signature_event
  for each row execute function public.esign_event_guard();

drop trigger if exists trg_signature_event_no_truncate on public.signature_event;
create trigger trg_signature_event_no_truncate
  before truncate on public.signature_event
  for each statement execute function public.esign_event_guard();
-- (signature_request needs no truncate trigger: documents and signature_event
-- reference it, so TRUNCATE fails without CASCADE, and CASCADE reaches the
-- signature_event trigger above.)

-- signature_request: tenant consistency, immutable evidence, legal transitions.
create or replace function public.esign_request_guard()
returns trigger language plpgsql as $$
declare
  v_client      uuid;
  v_immutable   text[] := array[
    'id','token_hash','client_id','document_id','document_type','signer_name','signer_email',
    'signer_phone','hash_version','document_snapshot','source_frozen_path','source_sha256',
    'consent_text','checkbox_text','document_hash','require_sms_otp','sent_at','expires_at','created_at',
    'created_by','doc_status_before_send','doc_type_before_send','doc_engagement_before_send'];
  v_fk_nullable text[] := array['signer_contact_id','engagement_id','updated_at'];
begin
  if public.esign_override_on() then return coalesce(new, old); end if;

  if tg_op = 'DELETE' then
    raise exception 'Signature requests are retained as evidence; void instead.'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.esign_is_trusted_role() then
    raise exception 'E-sign requests are written by the server only.' using errcode = 'insufficient_privilege';
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
    if new.signer_contact_id is not null then
      select c.client_id into v_client from public.client_contacts c where c.id = new.signer_contact_id;
      if v_client is distinct from new.client_id then
        raise exception 'esign_tenant_mismatch: contact % is not client %', new.signer_contact_id, new.client_id
          using errcode = 'check_violation';
      end if;
    end if;
    if new.status <> 'sent' or new.signed_at is not null or new.otp_verified_at is not null
       or new.otp_session_hash is not null or new.otp_session_expires_at is not null then
      raise exception 'esign_bad_insert: requests start as sent' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_immutable) k)
     is distinct from
     (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_immutable) k) then
    raise exception 'esign_immutable: evidence columns cannot change' using errcode = 'check_violation';
  end if;

  -- Nullable FKs may only move to NULL (ON DELETE SET NULL of a contact/engagement).
  if (new.signer_contact_id is not null and new.signer_contact_id is distinct from old.signer_contact_id)
     or (new.engagement_id  is not null and new.engagement_id  is distinct from old.engagement_id) then
    raise exception 'esign_immutable: references cannot be re-pointed' using errcode = 'check_violation';
  end if;

  -- Terminal rows are frozen (except the FK SET NULL above).
  if old.status in ('signed', 'declined', 'expired', 'voided')
     and (to_jsonb(new) - v_fk_nullable) is distinct from (to_jsonb(old) - v_fk_nullable) then
    raise exception 'esign_terminal: request % is %', old.id, old.status using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status and not (
       (old.status in ('sent', 'viewed') and new.status in ('viewed', 'otp_sent', 'signed', 'declined', 'expired', 'voided'))
    or (old.status = 'otp_sent'          and new.status in ('otp_verified', 'declined', 'expired', 'voided'))
    or (old.status = 'otp_verified'      and new.status in ('signed', 'declined', 'expired', 'voided'))
  ) then
    raise exception 'esign_bad_transition: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists trg_signature_request_guard on public.signature_request;
create trigger trg_signature_request_guard
  before insert or update or delete on public.signature_request
  for each row execute function public.esign_request_guard();
-- Trigger order: trg_signature_request_guard fires before trg_signature_request_touch
-- (alphabetical); the guard ignores updated_at, so order does not matter.

-- documents: e-sign columns are server-only; signed rows are frozen for EVERY
-- role (this is what stops scripts/seed-client.mjs resetting an executed MSA
-- to 'sent'). Also closes the members-can-relabel hole (documents_write FOR
-- ALL lets a member UPDATE status/doc_type today) and pins every non-trusted
-- write to the row's own {client_id}/ storage prefix.
create or replace function public.documents_esign_guard()
returns trigger language plpgsql as $$
declare
  v_trusted boolean := public.esign_is_trusted_role();
begin
  if public.esign_override_on() then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    if not v_trusted and (new.signature_request_id is not null or new.signed_at is not null
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
    if old.signed_at is not null or old.signature_request_id is not null then
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
    if old.signature_request_id is not null and new.storage_path is distinct from old.storage_path then
      raise exception 'This document was sent for signature; its file cannot be replaced.'
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

drop trigger if exists trg_documents_esign_guard on public.documents;
create trigger trg_documents_esign_guard
  before insert or update or delete on public.documents
  for each row execute function public.documents_esign_guard();

-- ── 6. Transition functions (service role only; see §7) ─────────────────────

-- Put a no-longer-out-for-signature document back the way it was before the
-- send. Only while the document still points at THIS request, is still 'sent'
-- and is unsigned. The request pointer is kept (it keeps the row undeletable).
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
     and d.status = 'sent' and d.signed_at is null;
  return found;
end $$;

-- Expire-in-place helper used by every signer path (row must already be locked).
create or replace function public.esign_expire_if_due(p_id uuid)
returns boolean language plpgsql as $$
begin
  update public.signature_request
     set status = 'expired', otp_session_hash = null
   where id = p_id and status in ('sent','viewed','otp_sent','otp_verified') and expires_at <= now();
  if found then
    insert into public.signature_event (request_id, event, actor, ip, user_agent)
    values (p_id, 'expired', 'system', null, null);
    perform public.esign_restore_document(p_id);
    return true;
  end if;
  return false;
end $$;

-- CREATE (staff). Freezes nothing itself: the app uploads the frozen source to
-- esign/requests/{p_request_id}/source.pdf FIRST, and on an RPC error re-reads
-- the request before removing it (the commit may have gone through).
create or replace function public.esign_create_request(
  p_request_id uuid, p_token_hash text, p_client_id uuid, p_document_id uuid,
  p_engagement_id uuid, p_document_type text,
  p_signer_contact_id uuid, p_signer_name text, p_signer_email text, p_signer_phone text,
  p_created_by uuid, p_document_snapshot jsonb, p_source_frozen_path text, p_source_sha256 text,
  p_consent_text text, p_checkbox_text text, p_document_hash text,
  p_expires_at timestamptz, p_replace_open boolean, p_supersede_siblings boolean)
returns jsonb language plpgsql as $$
declare
  v_type              public.esign_document_type%rowtype;
  v_doc               public.documents%rowtype;
  v_prev              public.signature_request%rowtype;
  v_closed            record;
  v_superseded        int := 0;
  v_status_before     text;
  v_type_before       text;
  v_engagement_before uuid;
begin
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

  -- 3. Lock order is request rows THEN document: the signer paths (touch, OTP,
  -- close, finalize, expire) lock the request before touching the document, so
  -- taking the document first here would deadlock against them. Sibling
  -- documents (step 13) are locked in id order with SKIP LOCKED, so two
  -- concurrent sends on one engagement cannot deadlock either.
  perform 1 from public.signature_request
   where document_id = p_document_id and status in ('sent','viewed','otp_sent','otp_verified')
   for update;

  -- Document (locked: two creates on one document serialize here).
  select * into v_doc from public.documents
   where id = p_document_id and client_id = p_client_id
   for update;
  if not found then raise exception 'esign_document_not_found'; end if;

  -- 4. Eligibility. The prefix test comes before is_financial_object; the
  -- uuid-casting storage_object_client() is never used.
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

  -- 5. Type, engagement, snapshot.
  if v_doc.doc_type is not null and v_doc.doc_type <> p_document_type then
    raise exception 'esign_doc_type_mismatch';
  end if;
  if v_doc.engagement_id is not null and p_engagement_id is distinct from v_doc.engagement_id then
    raise exception 'esign_engagement_mismatch';
  end if;
  if v_doc.storage_path is distinct from (p_document_snapshot #>> '{source,storage_path}') then
    raise exception 'esign_source_changed';
  end if;

  -- 6. Agreements that activate an engagement must be staff-uploaded files.
  -- A null uploader fails.
  if v_type.activates_engagement and not exists (
       select 1 from public.profiles p
        where p.id = v_doc.uploaded_by and p.role in ('admin', 'employee')) then
    raise exception 'esign_uploader_not_staff';
  end if;

  -- 7. Rate limit per document.
  if (select count(*) from public.signature_request
       where document_id = p_document_id and sent_at > now() - interval '24 hours') >= 10 then
    raise exception 'esign_rate_limited';
  end if;

  -- 8. Open request.
  if not coalesce(p_replace_open, false) and exists (
       select 1 from public.signature_request
        where document_id = p_document_id
          and status in ('sent','viewed','otp_sent','otp_verified') and expires_at > now()) then
    raise exception 'esign_open_request_exists';
  end if;

  -- 9. Before-send values. A replace chain inherits the open request's values
  -- so a later close restores the ORIGINAL state, not 'sent'.
  v_status_before     := v_doc.status;
  v_type_before       := v_doc.doc_type;
  v_engagement_before := v_doc.engagement_id;
  if v_doc.signature_request_id is not null and v_doc.status = 'sent' then
    select * into v_prev from public.signature_request where id = v_doc.signature_request_id;
    if found and v_prev.status in ('sent','viewed','otp_sent','otp_verified') then
      v_status_before     := v_prev.doc_status_before_send;
      v_type_before       := v_prev.doc_type_before_send;
      v_engagement_before := v_prev.doc_engagement_before_send;
    end if;
  end if;

  -- 10. Close whatever is still open for this document (expired, or replaced).
  -- The document is not restored here; step 14 re-stamps it.
  for v_closed in
    update public.signature_request
       set status           = case when expires_at <= now() then 'expired' else 'voided' end,
           voided_at        = case when expires_at <= now() then null else now() end,
           void_reason      = case when expires_at <= now() then null else 'replaced_by_new_request' end,
           otp_session_hash = null
     where document_id = p_document_id
       and status in ('sent','viewed','otp_sent','otp_verified')
    returning id, status
  loop
    insert into public.signature_event (request_id, event, actor, actor_user_id, ip, user_agent, meta)
    values (v_closed.id, v_closed.status,
            case when v_closed.status = 'expired' then 'system' else 'staff' end,
            case when v_closed.status = 'expired' then null else p_created_by end,
            null, null, jsonb_build_object('replaced_by', p_request_id));
  end loop;

  -- 11. The request.
  insert into public.signature_request (
    id, token_hash, client_id, document_id, engagement_id, document_type,
    signer_contact_id, signer_name, signer_email, signer_phone, created_by,
    document_snapshot, source_frozen_path, source_sha256, consent_text, checkbox_text,
    document_hash, require_sms_otp, expires_at,
    doc_status_before_send, doc_type_before_send, doc_engagement_before_send)
  values (
    p_request_id, p_token_hash, p_client_id, p_document_id, p_engagement_id, p_document_type,
    p_signer_contact_id, p_signer_name, p_signer_email, p_signer_phone, p_created_by,
    p_document_snapshot, p_source_frozen_path, p_source_sha256, p_consent_text, p_checkbox_text,
    p_document_hash, v_type.require_sms_otp, p_expires_at,
    v_status_before, v_type_before, v_engagement_before);

  -- 12. 'sent' event. Staff rows never carry IP / user agent.
  insert into public.signature_event (request_id, event, actor, actor_user_id, ip, user_agent, meta)
  values (p_request_id, 'sent', 'staff', p_created_by, null, null,
          jsonb_build_object('signer_email', p_signer_email, 'expires_at', p_expires_at));

  -- 13. Supersede unsigned, never-sent siblings of the same type + engagement.
  -- A sibling another transaction holds is being sent right now and must not be
  -- superseded, so locked rows are skipped rather than waited on.
  if coalesce(p_supersede_siblings, false) and p_engagement_id is not null then
    with siblings as (
      select id from public.documents
       where client_id = p_client_id and id <> p_document_id
         and doc_type = p_document_type and engagement_id = p_engagement_id
         and signed_at is null and signature_request_id is null
         and status in ('draft', 'sent')
       order by id
       for update skip locked
    )
    update public.documents d
       set status = 'superseded'
      from siblings s
     where d.id = s.id;
    get diagnostics v_superseded = row_count;
  end if;

  -- 14. The document is now out for signature.
  update public.documents
     set status               = 'sent',
         signature_request_id = p_request_id,
         signature_expires_at = p_expires_at,
         doc_type             = coalesce(doc_type, p_document_type),
         engagement_id        = coalesce(engagement_id, p_engagement_id)
   where id = p_document_id;

  return jsonb_build_object('request_id', p_request_id, 'superseded', v_superseded);
end $$;

-- VIEW / SOURCE OPENED (signer). 'viewed' is recorded only by the explicit
-- "Review the document" click (route action `view`), never by server render
-- or mount, so link scanners and mail-security fetches write nothing.
create or replace function public.esign_signer_touch(
  p_token_hash text, p_step text, p_ip text, p_user_agent text)
returns text language plpgsql as $$
declare
  r      public.signature_request%rowtype;
  v_last timestamptz;
begin
  if p_step is null or p_step not in ('viewed', 'source_opened') then
    raise exception 'esign_bad_step';
  end if;
  select * into r from public.signature_request where token_hash = p_token_hash for update;
  if not found then return 'not_found'; end if;
  if public.esign_expire_if_due(r.id) then return 'expired'; end if;
  if r.status not in ('sent','viewed','otp_sent','otp_verified') then return r.status; end if;

  -- viewed_at is back-filled whatever the open status, so a signer who reached
  -- otp_sent without a recorded view is not stuck behind the Review gate.
  if p_step = 'viewed' then
    update public.signature_request
       set status    = case when status = 'sent' then 'viewed' else status end,
           viewed_at = coalesce(viewed_at, now())
     where id = r.id;
  else
    update public.signature_request
       set source_opened_at = coalesce(source_opened_at, now()),
           status           = case when status = 'sent' then 'viewed' else status end,
           viewed_at        = coalesce(viewed_at, now())
     where id = r.id;
  end if;

  select max(at) into v_last from public.signature_event where request_id = r.id and event = p_step;
  if v_last is null or v_last < now() - interval '30 minutes' then       -- dedupe reloads
    insert into public.signature_event (request_id, event, actor, ip, user_agent)
    values (r.id, p_step, 'signer', left(p_ip, 64), left(p_user_agent, 512));
  end if;
  return 'ok';
end $$;

-- OTP SEND (signer). Reserve-then-send: the app texts the code only on 'ok'.
-- A new code can always be requested (subject to cooldown and the send cap),
-- including after a verification: verification is per browser session.
create or replace function public.esign_record_otp_send(
  p_token_hash text, p_otp_hash text, p_ttl_seconds int, p_cooldown_seconds int,
  p_max_sends int, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare r public.signature_request%rowtype;
begin
  select * into r from public.signature_request where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if public.esign_expire_if_due(r.id) then return jsonb_build_object('result', 'expired'); end if;
  if r.status not in ('sent','viewed','otp_sent','otp_verified') then
    return jsonb_build_object('result', r.status);
  end if;
  if not r.require_sms_otp then return jsonb_build_object('result', 'not_required'); end if;
  if r.otp_last_sent_at is not null
     and r.otp_last_sent_at > now() - make_interval(secs => p_cooldown_seconds) then
    return jsonb_build_object('result', 'cooldown',
      'resend_available_at', r.otp_last_sent_at + make_interval(secs => p_cooldown_seconds));
  end if;
  if r.otp_sends >= p_max_sends then return jsonb_build_object('result', 'limit'); end if;

  update public.signature_request
     set otp_hash         = p_otp_hash,
         otp_expires_at   = now() + make_interval(secs => p_ttl_seconds),
         otp_attempts     = 0,
         otp_sends        = otp_sends + 1,
         otp_last_sent_at = now(),
         status           = case when status in ('sent', 'viewed') then 'otp_sent' else status end
   where id = r.id;
  insert into public.signature_event (request_id, event, actor, ip, user_agent, meta)
  values (r.id, 'otp_sent', 'signer', left(p_ip, 64), left(p_user_agent, 512),
          jsonb_build_object('send', r.otp_sends + 1));

  return jsonb_build_object('result', 'ok', 'request_id', r.id, 'phone', r.signer_phone,
    'resend_available_at', now() + make_interval(secs => p_cooldown_seconds));
end $$;

-- OTP CHECK (signer). Atomic attempt counter; the code hash is cleared on
-- success and replaced by the hash of a fresh browser session secret, which
-- invalidates any session another browser held.
create or replace function public.esign_check_otp(
  p_token_hash text, p_candidate_hash text, p_max_attempts int,
  p_session_hash text, p_session_ttl_seconds int, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare
  r                  public.signature_request%rowtype;
  v_session_expires  timestamptz;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$'
     or p_session_ttl_seconds is null or p_session_ttl_seconds not between 60 and 3600 then
    raise exception 'esign_bad_session';
  end if;

  select * into r from public.signature_request where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if public.esign_expire_if_due(r.id) then return jsonb_build_object('result', 'expired'); end if;
  if r.status not in ('sent','viewed','otp_sent','otp_verified') then
    return jsonb_build_object('result', r.status);
  end if;
  if not r.require_sms_otp then return jsonb_build_object('result', 'not_required'); end if;
  if r.otp_hash is null or r.otp_expires_at <= now() then
    return jsonb_build_object('result', 'code_expired');
  end if;
  if r.otp_attempts >= p_max_attempts then return jsonb_build_object('result', 'locked'); end if;

  if r.otp_hash = p_candidate_hash then
    v_session_expires := now() + make_interval(secs => p_session_ttl_seconds);
    update public.signature_request
       set otp_verified_at        = now(),
           otp_hash               = null,
           otp_expires_at         = null,
           otp_session_hash       = p_session_hash,
           otp_session_expires_at = v_session_expires,
           status                 = 'otp_verified'
     where id = r.id;
    insert into public.signature_event (request_id, event, actor, ip, user_agent)
    values (r.id, 'otp_verified', 'signer', left(p_ip, 64), left(p_user_agent, 512));
    return jsonb_build_object('result', 'verified', 'session_expires_at', v_session_expires);
  end if;

  update public.signature_request set otp_attempts = otp_attempts + 1 where id = r.id;
  insert into public.signature_event (request_id, event, actor, ip, user_agent, meta)
  values (r.id, 'otp_failed', 'signer', left(p_ip, 64), left(p_user_agent, 512),
          jsonb_build_object('attempt', r.otp_attempts + 1));
  if r.otp_attempts + 1 >= p_max_attempts then
    insert into public.signature_event (request_id, event, actor, ip, user_agent)
    values (r.id, 'otp_locked', 'system', null, null);
    return jsonb_build_object('result', 'locked');
  end if;
  return jsonb_build_object('result', 'incorrect');
end $$;

-- FINALIZE (signer submit). Artifacts are already uploaded; this is the ONE
-- write that makes the signing real: request signed + document executed +
-- engagement active + events, all or nothing.
create or replace function public.esign_finalize_signature(
  p_request_id uuid, p_token_hash text, p_signed_at timestamptz, p_printed_name text,
  p_signature_image_path text, p_signature_image_sha256 text,
  p_sealed_pdf_path text, p_sealed_pdf_sha256 text, p_sealed_client_path text,
  p_otp_session_hash text, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare
  r      public.signature_request%rowtype;
  v_doc  public.documents%rowtype;
  v_type public.esign_document_type%rowtype;
  v_eng  uuid;
begin
  select * into r from public.signature_request
   where id = p_request_id and token_hash = p_token_hash
   for update;
  if not found then raise exception 'esign_not_found'; end if;
  if r.status = 'signed' then raise exception 'esign_already_signed'; end if;
  if r.status not in ('sent','viewed','otp_sent','otp_verified') then
    raise exception 'esign_closed:%', r.status;
  end if;
  if r.expires_at <= now() then raise exception 'esign_expired'; end if;
  if r.require_sms_otp and (
       r.otp_verified_at is null
    or r.otp_session_hash is null
    or p_otp_session_hash is distinct from r.otp_session_hash
    or r.otp_session_expires_at is null
    or r.otp_session_expires_at <= now()) then
    raise exception 'esign_otp_required';
  end if;
  if p_signed_at is null
     or p_signed_at > now() + interval '1 minute'
     or p_signed_at < now() - interval '15 minutes' then
    raise exception 'esign_bad_timestamp';
  end if;
  -- Attempt-scoped artifact paths must belong to THIS request and client.
  if not coalesce(
       p_signature_image_path like 'requests/' || r.id::text || '/attempts/%/signature.png'
   and p_sealed_pdf_path      like 'requests/' || r.id::text || '/attempts/%/sealed.pdf'
   and p_sealed_client_path   like r.client_id::text || '/esign/' || r.id::text || '/%-signed.pdf',
     false) then
    raise exception 'esign_bad_artifact_path';
  end if;

  select * into v_doc from public.documents
   where id = r.document_id and client_id = r.client_id
   for update;
  if not found or v_doc.signed_at is not null or v_doc.status = 'superseded'
     or v_doc.storage_path is distinct from (r.document_snapshot #>> '{source,storage_path}')
     or split_part(v_doc.storage_path, '/', 1) <> r.client_id::text then
    raise exception 'esign_document_changed';
  end if;
  if public.is_financial_object(v_doc.storage_path) then
    raise exception 'esign_document_changed';
  end if;

  update public.signature_request
     set status = 'signed', signed_at = p_signed_at, consent_agreed_at = p_signed_at,
         signer_printed_name = p_printed_name,
         signature_image_path = p_signature_image_path, signature_image_sha256 = p_signature_image_sha256,
         sealed_pdf_path = p_sealed_pdf_path, sealed_pdf_sha256 = p_sealed_pdf_sha256,
         sealed_client_path = p_sealed_client_path,
         signed_ip = left(p_ip, 64), signed_user_agent = left(p_user_agent, 512),
         otp_session_hash = null
   where id = r.id;

  update public.documents
     set status = 'executed', signed_at = p_signed_at,
         sealed_storage_path = p_sealed_client_path, signature_request_id = r.id,
         signature_expires_at = null
   where id = r.document_id;

  select * into v_type from public.esign_document_type where document_type = r.document_type;
  if v_type.activates_engagement and r.engagement_id is not null
     and v_doc.engagement_id = r.engagement_id then
    update public.engagements
       set status = 'active'
     where id = r.engagement_id and client_id = r.client_id and status = 'pending_signature'
    returning id into v_eng;
  end if;

  insert into public.signature_event (request_id, event, actor, ip, user_agent, meta, at) values
    (r.id, 'consented', 'signer', left(p_ip, 64), left(p_user_agent, 512), '{}'::jsonb, p_signed_at),
    (r.id, 'signed',    'signer', left(p_ip, 64), left(p_user_agent, 512),
       jsonb_build_object('printed_name', p_printed_name, 'signature_image_sha256', p_signature_image_sha256),
       p_signed_at),
    (r.id, 'sealed',    'system', null, null,
       jsonb_build_object('sealed_pdf_sha256', p_sealed_pdf_sha256), now());
  if v_eng is not null then
    insert into public.signature_event (request_id, event, actor, ip, user_agent, meta)
    values (r.id, 'engagement_activated', 'system', null, null, jsonb_build_object('engagement_id', v_eng));
  end if;

  return jsonb_build_object('request_id', r.id, 'document_id', r.document_id,
    'client_id', r.client_id, 'engagement_id', r.engagement_id,
    'engagement_activated', v_eng is not null);
end $$;

-- CLOSE: staff void (by id + client) / signer decline (by token hash) / drift
-- void (system). Every close restores the document's pre-send state.
create or replace function public.esign_close_request(
  p_request_id uuid, p_client_id uuid, p_token_hash text, p_new_status text,
  p_actor text, p_actor_user_id uuid, p_reason text, p_extra_event text, p_meta jsonb,
  p_otp_session_hash text, p_ip text, p_user_agent text)
returns text language plpgsql as $$
declare r public.signature_request%rowtype;
begin
  if p_new_status is null or p_new_status not in ('voided', 'declined')
     or p_actor is null or p_actor not in ('staff', 'signer', 'system')
     or (p_extra_event is not null and p_extra_event <> 'drift_detected')
     or (p_request_id is null and p_token_hash is null)
     or (p_new_status = 'declined' and (p_actor <> 'signer' or p_token_hash is null)) then
    raise exception 'esign_bad_close';
  end if;

  if p_request_id is null then
    select * into r from public.signature_request
     where token_hash = p_token_hash
     for update;
  else
    select * into r from public.signature_request
     where id = p_request_id and client_id = p_client_id
       and (p_token_hash is null or token_hash = p_token_hash)
     for update;
  end if;
  if not found then return 'not_found'; end if;

  -- 1. Lazily expired: expire_if_due has already restored the document.
  if public.esign_expire_if_due(r.id) then return 'expired'; end if;
  -- 2. Already terminal.
  if r.status not in ('sent','viewed','otp_sent','otp_verified') then return r.status; end if;
  -- 3. Declining an OTP type needs the same browser session as signing. Nothing written.
  if p_new_status = 'declined' and r.require_sms_otp and (
       r.otp_session_hash is null
    or p_otp_session_hash is distinct from r.otp_session_hash
    or r.otp_session_expires_at is null
    or r.otp_session_expires_at <= now()) then
    return 'otp_required';
  end if;

  -- 4. Extra event (drift).
  if p_extra_event is not null then
    insert into public.signature_event (request_id, event, actor, actor_user_id, ip, user_agent, meta)
    values (r.id, p_extra_event, 'system', null, null, null, coalesce(p_meta, '{}'::jsonb));
  end if;

  -- 5. Close.
  if p_new_status = 'voided' then
    update public.signature_request
       set status = 'voided', voided_at = now(), void_reason = left(p_reason, 1000),
           otp_session_hash = null
     where id = r.id;
  else
    update public.signature_request
       set status = 'declined', declined_at = now(), decline_reason = left(p_reason, 1000),
           otp_session_hash = null
     where id = r.id;
  end if;

  -- 6. Close event. Only a signer row carries network details.
  insert into public.signature_event (request_id, event, actor, actor_user_id, ip, user_agent, meta)
  values (r.id, p_new_status, p_actor, p_actor_user_id,
          case when p_actor = 'signer' then left(p_ip, 64) end,
          case when p_actor = 'signer' then left(p_user_agent, 512) end,
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 1000)));

  -- 7. No longer out for signature.
  perform public.esign_restore_document(r.id);
  return 'ok';
end $$;

-- SEALED DOWNLOAD (signer, within the window). The app mints the 60 s URL on
-- every 'ok'; only the audit row is throttled (one per 30 minutes).
create or replace function public.esign_record_sealed_download(
  p_token_hash text, p_window_days int, p_ip text, p_user_agent text)
returns jsonb language plpgsql as $$
declare r public.signature_request%rowtype;
begin
  select * into r from public.signature_request where token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if r.status <> 'signed' then return jsonb_build_object('result', 'not_signed'); end if;
  if r.signed_at <= now() - make_interval(days => p_window_days) then
    return jsonb_build_object('result', 'download_expired');
  end if;

  if not exists (
       select 1 from public.signature_event
        where request_id = r.id and event = 'sealed_downloaded'
          and at > now() - interval '30 minutes') then
    insert into public.signature_event (request_id, event, actor, ip, user_agent)
    values (r.id, 'sealed_downloaded', 'signer', left(p_ip, 64), left(p_user_agent, 512));
  end if;

  return jsonb_build_object('result', 'ok', 'request_id', r.id,
    'sealed_pdf_path', r.sealed_pdf_path,
    'title', r.document_snapshot #>> '{document,title}');
end $$;

-- ── 7. RLS + grants ─────────────────────────────────────────────────────────
alter table public.esign_document_type enable row level security;
alter table public.signature_request   enable row level security;
alter table public.signature_event     enable row level security;

-- Undo this project's default ACL (anon/authenticated = arwdDxtm on new
-- tables). A table-level REVOKE ALL also strips column grants, so re-running
-- this block resets to exactly the grants below.
revoke all on table public.esign_document_type, public.signature_request, public.signature_event
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.esign_document_type, public.signature_request, public.signature_event
  to service_role;

grant select on table public.esign_document_type to authenticated;
grant select on table public.signature_event     to authenticated;
-- Column-level: staff can see status and evidence, never token_hash, otp_hash,
-- otp_expires_at, otp_attempts, otp_last_sent_at, the OTP session columns or
-- the esign-bucket paths (source_frozen_path, signature_image_path,
-- sealed_pdf_path). Consequence: PostgREST select('*') as a user fails;
-- always list columns.
grant select (
  id, client_id, document_id, engagement_id, document_type, status,
  signer_contact_id, signer_name, signer_email, signer_phone, created_by,
  hash_version, document_snapshot, source_sha256, consent_text, checkbox_text, document_hash,
  doc_status_before_send, doc_type_before_send, doc_engagement_before_send,
  require_sms_otp, otp_sends, otp_verified_at, consent_agreed_at, signer_printed_name,
  signature_image_sha256, sealed_pdf_sha256, sealed_client_path, signed_ip, signed_user_agent,
  sent_at, viewed_at, source_opened_at, signed_at, expires_at,
  voided_at, void_reason, declined_at, decline_reason, created_at, updated_at
) on public.signature_request to authenticated;

-- The identity sequence inherits the default ACL too (anon/authenticated = rwU).
do $$
declare v_seq text := pg_get_serial_sequence('public.signature_event', 'seq');
begin
  if v_seq is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated', v_seq);
    execute format('grant usage, select on sequence %s to service_role', v_seq);
  end if;
end $$;

-- Staff read; employees only for clients they are members of (is_member_of
-- short-circuits true for platform admins). No client-member policy, no write
-- policy on any of the three tables.
drop policy if exists esign_document_type_staff_read on public.esign_document_type;
create policy esign_document_type_staff_read on public.esign_document_type
  for select to authenticated using ( public.is_staff() );

drop policy if exists signature_request_staff_read on public.signature_request;
create policy signature_request_staff_read on public.signature_request
  for select to authenticated using ( public.is_staff() and public.is_member_of(client_id) );

drop policy if exists signature_event_staff_read on public.signature_event;
create policy signature_event_staff_read on public.signature_event
  for select to authenticated using (
    public.is_staff() and exists (
      select 1 from public.signature_request r
       where r.id = signature_event.request_id and public.is_member_of(r.client_id))
  );

-- Functions: the default ACL grants EXECUTE to public/anon/authenticated. Every
-- transition function is locked to service_role. The three guard trigger
-- functions are revoked from everyone, service_role included, and never
-- granted: EXECUTE is checked when a trigger is created, not when it fires.
-- Two helpers are deliberately LEFT executable: esign_override_on() and
-- esign_is_trusted_role() are called from SECURITY INVOKER guard triggers
-- that fire for ordinary members (e.g. a client uploading a document), and a
-- nested call needs EXECUTE for the caller. Both return only a boolean about
-- the caller's own session.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('esign_restore_document', 'esign_expire_if_due', 'esign_create_request',
                         'esign_signer_touch', 'esign_record_otp_send', 'esign_check_otp',
                         'esign_finalize_signature', 'esign_close_request',
                         'esign_record_sealed_download',
                         'esign_event_guard', 'esign_request_guard', 'documents_esign_guard')
  loop
    if f.proname like '%guard' then
      execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    else
      execute format('revoke all on function %s from public, anon, authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

-- ── 8. Private storage for signature PNGs, frozen sources, sealed PDFs ──────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('esign', 'esign', false, 52428800, array['image/png', 'application/pdf'])
on conflict (id) do nothing;

-- The insert never overwrites an existing bucket; this only ever tightens.
update storage.buckets set public = false where id = 'esign' and public;

-- Deliberately NO storage.objects policy for 'esign': service role only.
-- Razzle's esign_auth_read_signatures let ANY authenticated user read ANY
-- signer's PNG. Dropped by name in case it was ever hand-applied.
drop policy if exists esign_auth_read_signatures on storage.objects;

-- Object layout:
--   esign         requests/{request_id}/source.pdf                            at create (frozen bytes)
--   esign         requests/{request_id}/attempts/{attempt_id}/signature.png   at submit
--   esign         requests/{request_id}/attempts/{attempt_id}/sealed.pdf      at submit (authoritative)
--   client-files  {client_id}/esign/{request_id}/{attempt_id}-signed.pdf      at submit (never served)

-- ── 9. client-files write hardening ─────────────────────────────────────────
-- Sealed convenience copies live at {client_id}/esign/…; only the service role
-- (which bypasses RLS) may write there. UPDATE is staff-only: clients upload
-- with upsert:false and never need it. client_files_select is unchanged.
-- Each body is the live policy text (pg_policies, 2026-09-14) plus the new
-- clauses; the names are dropped first because permissive policies OR.
--
-- A file's bytes belong to whoever uploaded its documents row. Without this, a
-- member could delete the object behind a staff-uploaded MSA and upload a
-- doctored file under the same name, leaving documents.uploaded_by (which the
-- staff-uploader rule in esign_create_request trusts) untouched. SECURITY
-- DEFINER because documents_select hides visible_to_client = false rows from
-- members. deleteDocumentAction removes the row BEFORE the object, so a
-- member's own delete still works.
create or replace function public.document_object_locked(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.documents d
     where d.storage_path = p_name
       and d.uploaded_by is distinct from auth.uid());
$$;
revoke all on function public.document_object_locked(text) from public, anon;
grant execute on function public.document_object_locked(text) to authenticated, service_role;

drop policy if exists client_files_insert on storage.objects;
create policy client_files_insert on storage.objects
  for insert with check (
    bucket_id = 'client-files'
    and public.is_member_of(((storage.foldername(name))[1])::uuid)
    and strpos(name, '/esign/') = 0
    and (public.is_staff() or not public.document_object_locked(name))
  );

drop policy if exists client_files_update on storage.objects;
create policy client_files_update on storage.objects
  for update using (
    bucket_id = 'client-files'
    and public.is_member_of(((storage.foldername(name))[1])::uuid)
    and public.is_staff()
    and strpos(name, '/esign/') = 0
  ) with check (
    bucket_id = 'client-files'
    and public.is_member_of(((storage.foldername(name))[1])::uuid)
    and public.is_staff()
    and strpos(name, '/esign/') = 0
  );

drop policy if exists client_files_delete on storage.objects;
create policy client_files_delete on storage.objects
  for delete using (
    bucket_id = 'client-files'
    and public.is_member_of(public.storage_object_client(name))
    and (
      not public.is_financial_object(name)
      or public.can_read_financials(public.storage_object_client(name))
    )
    and strpos(name, '/esign/') = 0
    and (public.is_staff() or not public.document_object_locked(name))
  );

-- ── Post-apply verification (SELECT only) ───────────────────────────────────
-- select document_type, esign_enabled, require_sms_otp, activates_engagement, allowed_content_types, expiry_days
--   from public.esign_document_type;                                  -- expect msa | t | f | t | {application/pdf} | 14
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'esign';
-- select grantee, privilege_type, count(*) from information_schema.role_column_grants
--  where table_schema = 'public' and table_name = 'signature_request' and grantee in ('anon', 'authenticated')
--  group by 1, 2;                                                     -- authenticated SELECT only, no anon
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename in ('esign_document_type', 'signature_request', 'signature_event');
-- select tgname, tgrelid::regclass from pg_trigger
--  where tgname like 'trg_%esign%' or tgname like 'trg_signature_%';
-- select p.proname, p.proacl from pg_proc p
--  where p.pronamespace = 'public'::regnamespace
--    and (p.proname like 'esign_%' or p.proname = 'documents_esign_guard');  -- service_role only, except the 2 helpers; guards: owner only
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'documents'
--    and column_name in ('signature_request_id', 'signed_at', 'sealed_storage_path', 'signature_expires_at');
-- select policyname, cmd, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects';

-- ── Rollback (only if abandoning the feature; DESTROYS evidence) ─────────────
-- begin;
-- set local gbtn.esign_override = 'on';
-- drop trigger if exists trg_documents_esign_guard on public.documents;
-- alter table public.documents drop column if exists signature_request_id,
--                              drop column if exists signed_at,
--                              drop column if exists sealed_storage_path,
--                              drop column if exists signature_expires_at;
-- drop table if exists public.signature_event, public.signature_request, public.esign_document_type;
-- drop function if exists public.esign_create_request, public.esign_signer_touch, public.esign_record_otp_send,
--   public.esign_check_otp, public.esign_finalize_signature, public.esign_close_request,
--   public.esign_expire_if_due, public.esign_restore_document, public.esign_record_sealed_download,
--   public.esign_event_guard, public.esign_request_guard,
--   public.documents_esign_guard, public.esign_override_on, public.esign_is_trusted_role;
-- -- Original client-files write policies (live text before 0031):
-- drop function if exists public.document_object_locked(text);  -- after the three policies below are restored
-- drop policy if exists client_files_insert on storage.objects;
-- create policy client_files_insert on storage.objects
--   for insert with check (
--     bucket_id = 'client-files' and public.is_member_of(((storage.foldername(name))[1])::uuid));
-- drop policy if exists client_files_update on storage.objects;
-- create policy client_files_update on storage.objects
--   for update using (
--     bucket_id = 'client-files' and public.is_member_of(((storage.foldername(name))[1])::uuid));
-- drop policy if exists client_files_delete on storage.objects;
-- create policy client_files_delete on storage.objects
--   for delete using (
--     bucket_id = 'client-files'
--     and public.is_member_of(public.storage_object_client(name))
--     and (not public.is_financial_object(name) or public.can_read_financials(public.storage_object_client(name))));
-- commit;
-- Then empty and delete the 'esign' bucket from the Supabase dashboard (Storage).
-- Revert business effects by hand, per affected row:
--   update public.engagements set status = 'pending_signature' where id = '<id>';
--   update public.documents   set status = 'sent' where id = '<id>';
