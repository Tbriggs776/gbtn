-- Contact lifetime stats, rolled up from won crm_deals.
--
-- Semantics (also documented in lib/crm/actions.ts recalcContactLifetime):
--   lifetime_value  = SUM(value) for won deals with value_type = one_time
--   mrr             = SUM(value) for monthly + SUM(value)/12 for annual
--   ARR is not stored; treat as mrr * 12.
--   won_deal_count / first_won_at / last_won_at from status = 'won' rows.

alter table public.crm_contacts
  add column if not exists won_deal_count int not null default 0,
  add column if not exists lifetime_value numeric not null default 0,
  add column if not exists mrr numeric not null default 0,
  add column if not exists first_won_at timestamptz,
  add column if not exists last_won_at timestamptz;
