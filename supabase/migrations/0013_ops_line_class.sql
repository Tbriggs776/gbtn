-- ───────────────────────────────────────────────────────────────────────────
-- Phase 13: line classification for the Ops Reports.
--
-- The first Orders export was filtered to material lines only (~3 lines/CG).
-- The full export carries every line RFMS holds (~20 lines/CG), which mixes
-- four different things under one "line" concept:
--
--   PC 01–25  material   real product     3,267 lines  $5.2M
--   PC 70–89  labor      install/demo/    6,118 lines  $2.8M
--                        prep/haul — this IS the crew capacity
--   PC 90–98  other      promo text, fees, commission, discounts
--                        7,372 lines  $0.1M — 73% of them qty 0 AND value 0
--
-- 36% of the full export is boilerplate ("5 YR WORRY FREE GUARANTEE") that
-- carries no quantity and no money. Counting it as work overstates capacity by
-- ~1.7x, so every report needs to be able to tell these apart. Storing the band
-- rather than deriving it at read time keeps the rule in one place and lets the
-- reports filter on it in SQL later if the table outgrows a full scan.
--
-- The band boundaries are Floor Daddy's RFMS product-code convention, confirmed
-- against item descriptions in the Jul-2026 export. If they re-code products,
-- this mapping and lib/ops/pc.ts are the two places to change.
-- ───────────────────────────────────────────────────────────────────────────

do $$ begin
  create type ops_line_class as enum ('material', 'labor', 'other');
exception when duplicate_object then null; end $$;

alter table public.ops_order_lines
  add column if not exists pc         text,
  add column if not exists line_class ops_line_class not null default 'other';

-- Reports segment by class within a client's date window.
create index if not exists idx_ool_class on public.ops_order_lines (client_id, line_class);

comment on column public.ops_order_lines.pc is
  'RFMS product code. Bands: <70 material, 70-89 labor, 90+ promo/fee/text.';
comment on column public.ops_order_lines.line_class is
  'Derived from pc at import. See lib/ops/pc.ts — the single source of the rule.';
