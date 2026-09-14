-- ───────────────────────────────────────────────────────────────────────────
-- Phase 30: Advantage OS offer-ladder rung + CRM-deal link on engagements.
--
-- Additive extension of 0029_client_engagements.sql — NOT a second engagements
-- system. Two facts the intake rail needs:
--
--  1. `offer_rung` — where this engagement sits on the ladder
--     (diagnose → install → institutionalize). Null allowed so the pre-0030
--     rows created by 0029 stay valid.
--
--  2. `crm_deal_id` — the agency CRM deal this engagement was converted from,
--     so a won deal ties to the client engagement it produced. Nullable
--     (engagements can exist without a deal), ON DELETE SET NULL (deleting a
--     deal must not cascade-delete a live client engagement), and unique where
--     present so one deal maps to at most one engagement.
--
-- `client_id` stays NOT NULL (0029). The convert flow provisions/links a
-- clients row first, then inserts the engagement — no orphan firm-only rows.
--
-- Idempotent: re-running is the normal recovery path (no migration ledger).
-- ───────────────────────────────────────────────────────────────────────────

alter table public.engagements
  add column if not exists offer_rung text;

alter table public.engagements
  drop constraint if exists engagements_offer_rung_check;
alter table public.engagements
  add constraint engagements_offer_rung_check
  check (offer_rung is null
         or offer_rung in ('diagnose', 'install', 'institutionalize'));

comment on column public.engagements.offer_rung is
  'Advantage OS ladder rung: diagnose | install | institutionalize. Null = legacy/unset.';

alter table public.engagements
  add column if not exists crm_deal_id uuid
  references public.crm_deals (id) on delete set null;

-- One deal → at most one engagement. Partial so multiple null-deal engagements
-- (the normal case for directly-created client work) don't collide.
create unique index if not exists uq_engagements_crm_deal
  on public.engagements (crm_deal_id)
  where crm_deal_id is not null;

comment on column public.engagements.crm_deal_id is
  'The agency crm_deals row this engagement was converted from, if any.';
