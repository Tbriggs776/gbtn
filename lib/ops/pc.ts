// The single source of truth for what an RFMS order line *is*.
//
// A full Orders export mixes four things under one "line" concept, and telling
// them apart is the difference between a capacity number and a fiction:
//
//   material  PC 01–25   real product: LVP, carpet, tile, base, underlayment
//   labor     PC 70–89   install / demo / prep / haul — the crew's actual work
//   other     PC 90–98   promo text, fees, commission, discounts
//
// The bands are Floor Daddy's RFMS product-code convention, confirmed against
// item descriptions in the Jul-2026 export (every PC<70 is a product name,
// every 70–89 is an "INSTALL …"/"DEMO …"/"MOVE …", every 90+ is boilerplate,
// a fee, or an adjustment). If products get re-coded, change this file and
// supabase/migrations/0013_ops_line_class.sql together.

export type LineClass = "material" | "labor" | "other";

export const LINE_CLASSES: LineClass[] = ["material", "labor", "other"];

export const CLASS_LABEL: Record<LineClass, string> = {
  material: "Material",
  labor: "Labor",
  other: "Promo / fees",
};

export const CLASS_HELP: Record<LineClass, string> = {
  material: "Product to buy and receive — PC 01–25",
  labor: "Install, demo, prep, haul — the crew's work. PC 70–89",
  other: "Promo text, fees, commission, discounts — PC 90–98. Mostly zero-value boilerplate.",
};

export function classifyPC(pc: string | null | undefined): LineClass {
  const n = parseInt(String(pc ?? "").trim(), 10);
  if (!Number.isFinite(n)) return "other";
  if (n < 70) return "material";
  if (n < 90) return "labor";
  return "other";
}

/**
 * A line with no quantity AND no money: pure boilerplate that RFMS carries on
 * the order so it prints on the customer's paperwork ("5 YR WORRY FREE
 * GUARANTEE", "BALANCE DUE UPON INSTALLATION"). 36% of a full export.
 *
 * Deliberately derived from the values rather than the PC band: a PC 96 line
 * with real money on it (a charged air-duct cleaning) is real work, and a PC 98
 * "JOB MIN" with a dollar value is a real fee. Only the empty ones are noise.
 */
export function isBoilerplate(qty: number, lineTotal: number): boolean {
  return (qty ?? 0) === 0 && (lineTotal ?? 0) === 0;
}
