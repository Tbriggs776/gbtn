-- ───────────────────────────────────────────────────────────────────────────
-- Phase 29: client entity profile, contacts, engagements (phases +
-- deliverables), onboarding checklist, and contract lifecycle on documents.
--
-- Driven by a client onboarding, but every shape here is generic — no client
-- name, term, fee or personnel detail belongs in this file. Those are Client
-- Confidential Information and this repo is PUBLIC; they live only in a
-- gitignored payload under scripts/clients/.
--
-- Deliberate deviations from the original brief, and why:
--
--  1. NO `client_documents` table. `public.documents` has existed since 0001
--     and is wired end to end: the browser uploads to the private
--     `client-files` bucket, `recordDocumentAction` records the row,
--     `getDownloadUrlAction` signs a 60s URL. 0016's `is_financial_object()`
--     storage gate reads `public.documents` BY NAME. A parallel table would be
--     invisible to the Documents page, invisible to that storage gate, and a
--     second source of truth for the same objects. Contract lifecycle is added
--     to `documents` as columns instead.
--
--  2. `visible_to_client` is ENFORCED in the RLS policy, not merely stored.
--     0014's `documents_select` lets any member read any non-Financials row, so
--     adding the column without rewriting that policy would make the flag
--     decorative — the same mistake 0014 shipped and 0015 had to correct. Both
--     policies are dropped BY NAME and recreated, because Postgres ORs
--     permissive policies and a stricter policy added alongside the old one
--     changes nothing.
--
--  3. Reads are membership-scoped; writes are staff-only. Per the house rule,
--     client-facing data tables get no client INSERT/UPDATE/DELETE policies —
--     writes go through the service role behind a requireCapability /
--     assertCapability gate. That includes the client ticking an
--     `onboarding_items` row: it travels through a gated server action, not a
--     direct client-side write.
--
--  4. `clients.status` / `clients.source` are also added by the uncommitted
--     0019_qbo_app_leads.sql with identical definitions. Both use
--     `add column if not exists`, so either apply order converges — do not
--     "reconcile" them by changing one side's default.
--
-- Storage path convention is not negotiable: `{client_id}/...`. 0016's
-- `storage_object_client()` casts the first path segment to uuid and every
-- `client-files` policy gates on it, and `recordDocumentAction` asserts the
-- path starts with `{clientId}/`. A `clients/<slug>/...` prefix breaks both.
-- ───────────────────────────────────────────────────────────────────────────

-- ── 1. Client entity profile ────────────────────────────────────────────────
-- `clients` has carried only (id, name, slug, created_at) since 0001. The
-- registered-entity facts needed for contracting had nowhere to live.

alter table public.clients
  add column if not exists status            text not null default 'active',  -- active | prospect | archived
  add column if not exists source            text,                            -- 'manual' | 'qbo_app_store'
  add column if not exists legal_name        text,
  add column if not exists dba               text,
  add column if not exists entity_type       text,
  add column if not exists home_state        text,
  add column if not exists address           text,
  add column if not exists registered_agent  text,
  add column if not exists state_entity_no   text,
  add column if not exists naics             text,
  add column if not exists industry          text,
  add column if not exists fiscal_year_end   text,
  add column if not exists onboarded_on      date;

comment on column public.clients.state_entity_no is
  'Home-state registration/DBA number. Generic on purpose — not UT-specific.';

comment on column public.clients.fiscal_year_end is
  'MM-DD. Left null until confirmed; do not assume 12-31.';

-- ── 2. Contacts at the client ───────────────────────────────────────────────
-- Distinct from `crm_contacts` (GBTN's OWN agency CRM — not client-scoped, has
-- no client_id) and distinct from `memberships` (who can log in). A contact may
-- have no portal login, and a login need not be a listed contact.

create table if not exists public.client_contacts (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients (id) on delete cascade,
  full_name          text not null,
  title              text,
  email              text,
  phone              text,
  is_primary         boolean not null default false,
  is_decision_maker  boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_client_contacts_client on public.client_contacts (client_id);
-- Natural key: a rerun of the seed must update, never duplicate.
create unique index if not exists uq_client_contacts_name
  on public.client_contacts (client_id, full_name);

-- ── 3. Affiliates / related entities ────────────────────────────────────────
-- An entity served under the MSA but NOT billed separately and NOT a
-- contracting party. Kept OFF `clients` on purpose: a second `clients` row
-- would split the RLS scope and break the single-portal view.

create table if not exists public.client_affiliates (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients (id) on delete cascade,
  name                  text not null,
  legal_name            text,
  state                 text,
  relationship          text not null default 'affiliate',       -- affiliate | subsidiary | sister
  billing               text not null default 'through_parent',  -- through_parent | separate
  is_contracting_party  boolean not null default false,
  notes                 text,
  created_at            timestamptz not null default now()
);

create index if not exists idx_client_affiliates_client on public.client_affiliates (client_id);
create unique index if not exists uq_client_affiliates_name
  on public.client_affiliates (client_id, name);

-- ── 4. Engagements ──────────────────────────────────────────────────────────

create table if not exists public.engagements (
  id                       uuid primary key default gen_random_uuid(),
  client_id                uuid not null references public.clients (id) on delete cascade,
  name                     text not null,
  engagement_type          text,
  status                   text not null default 'active',
  start_date               date,
  initial_term_end         date,
  auto_renew               boolean not null default true,
  cancellation_notice_days int default 30,
  monthly_fee_cents        int,
  billing_day_of_month     int check (billing_day_of_month is null
                                      or billing_day_of_month between 1 and 31),
  created_at               timestamptz not null default now()
);

create index if not exists idx_engagements_client on public.engagements (client_id);
create unique index if not exists uq_engagements_name
  on public.engagements (client_id, name);

-- ── 5. Phases (drives the journey view: current step, next step) ────────────

create table if not exists public.engagement_phases (
  id             uuid primary key default gen_random_uuid(),
  engagement_id  uuid not null references public.engagements (id) on delete cascade,
  sequence       int not null,
  name           text not null,
  purpose        text,
  starts_on      date,
  ends_on        date,   -- null = open-ended (the ongoing phase)
  status         text not null default 'not_started'
);

create unique index if not exists uq_engagement_phases_seq
  on public.engagement_phases (engagement_id, sequence);

-- ── 6. Deliverables ─────────────────────────────────────────────────────────

create table if not exists public.engagement_deliverables (
  id            uuid primary key default gen_random_uuid(),
  phase_id      uuid not null references public.engagement_phases (id) on delete cascade,
  sequence      int not null,
  name          text not null,
  description   text,
  status        text not null default 'not_started',
  due_on        date,
  delivered_on  date
);

create unique index if not exists uq_engagement_deliverables_seq
  on public.engagement_deliverables (phase_id, sequence);

-- ── 7. Onboarding checklist ─────────────────────────────────────────────────
-- The needs list as rows, so arrival is timestamped rather than buried in an
-- email thread. `category` keeps the source document's letter prefix.

create table if not exists public.onboarding_items (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  engagement_id uuid references public.engagements (id) on delete set null,
  category      text not null,
  item          text not null,
  priority      text,                                -- day_1 | week_1 | week_2
  owner         text not null default 'client',      -- client | gbtn
  status        text not null default 'requested',   -- requested | received | waived
  requested_on  date,
  received_on   date,
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_onboarding_items_client on public.onboarding_items (client_id);
create unique index if not exists uq_onboarding_items_item
  on public.onboarding_items (client_id, category, item);

-- ── 8. Contract lifecycle on the EXISTING documents table ───────────────────
-- `category` stays as it is (the Documents page and 0014's financials gate both
-- read it); `doc_type` adds contract semantics alongside it.

alter table public.documents
  add column if not exists engagement_id     uuid references public.engagements (id) on delete set null,
  add column if not exists title             text,
  add column if not exists doc_type          text,
  add column if not exists version           int not null default 1,
  add column if not exists status            text not null default 'executed',
  add column if not exists effective_date    date,
  add column if not exists visible_to_client boolean not null default true;

-- `status` defaults to 'executed', not 'draft': all 15 pre-existing rows are
-- delivered files already visible in the portal, and a 'draft' backfill would
-- silently relabel every one of them.

alter table public.documents drop constraint if exists documents_doc_type_check;
alter table public.documents
  add constraint documents_doc_type_check
  check (doc_type is null or doc_type in
         ('msa', 'sow', 'onboarding', 'report', 'deliverable', 'other'));

alter table public.documents drop constraint if exists documents_lifecycle_status_check;
alter table public.documents
  add constraint documents_lifecycle_status_check
  check (status in ('draft', 'sent', 'executed', 'superseded'));

-- Idempotency key for the seed: one row per stored object.
create unique index if not exists uq_documents_storage_path
  on public.documents (storage_path);

create index if not exists idx_documents_engagement on public.documents (engagement_id);

-- ── 9. RLS ──────────────────────────────────────────────────────────────────
-- Defense in depth. Dashboards read through the service role, so the
-- requireCapability/assertCapability call in the page or handler is the real
-- boundary; these policies stop anything querying AS the end user.

alter table public.client_contacts          enable row level security;
alter table public.client_affiliates        enable row level security;
alter table public.engagements              enable row level security;
alter table public.engagement_phases        enable row level security;
alter table public.engagement_deliverables  enable row level security;
alter table public.onboarding_items         enable row level security;

-- Client-scoped tables: members read, staff write.
do $$
declare
  t text;
begin
  for t in
    select unnest(array['client_contacts', 'client_affiliates',
                        'engagements', 'onboarding_items'])
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using ( public.is_member_of(client_id) )',
      t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_staff_write', t);
    execute format(
      'create policy %I on public.%I for all using ( public.is_staff() ) '
      || 'with check ( public.is_staff() )',
      t || '_staff_write', t);
  end loop;
end $$;

-- Phases and deliverables reach the client through their engagement.
drop policy if exists engagement_phases_select on public.engagement_phases;
create policy engagement_phases_select on public.engagement_phases
  for select using (
    exists (
      select 1 from public.engagements e
       where e.id = engagement_phases.engagement_id
         and public.is_member_of(e.client_id)
    )
  );

drop policy if exists engagement_phases_staff_write on public.engagement_phases;
create policy engagement_phases_staff_write on public.engagement_phases
  for all using ( public.is_staff() ) with check ( public.is_staff() );

drop policy if exists engagement_deliverables_select on public.engagement_deliverables;
create policy engagement_deliverables_select on public.engagement_deliverables
  for select using (
    exists (
      select 1 from public.engagement_phases p
        join public.engagements e on e.id = p.engagement_id
       where p.id = engagement_deliverables.phase_id
         and public.is_member_of(e.client_id)
    )
  );

drop policy if exists engagement_deliverables_staff_write on public.engagement_deliverables;
create policy engagement_deliverables_staff_write on public.engagement_deliverables
  for all using ( public.is_staff() ) with check ( public.is_staff() );

-- ── 10. Re-assert the documents policies so visible_to_client BINDS ─────────
-- Both 0014 policy names are dropped and recreated. The Financials clause is
-- preserved verbatim; the only addition is the visibility gate, which staff
-- bypass so GBTN can stage a document before revealing it.

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select using (
    public.is_member_of(client_id)
    and (category <> 'Financials' or public.can_read_financials(client_id))
    and (visible_to_client or public.is_staff())
  );

drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents
  for all using (
    public.is_member_of(client_id)
    and (category <> 'Financials' or public.can_read_financials(client_id))
    and (visible_to_client or public.is_staff())
  )
  with check (
    public.is_member_of(client_id)
    and (category <> 'Financials' or public.can_read_financials(client_id))
    and (visible_to_client or public.is_staff())
  );
