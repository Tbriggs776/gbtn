// Floor Daddy pricing engine. Mirrors the Excel model, solved to closed form
// (the sheet is circular: commission depends on price depends on commission).
//
//   cash       = cost / [(1-gm)(1-warranty) - commission]
//   financeFee = cash * financeFee%
//   book       = cash + financeFee        (financed / list price)
//   commission = cash * commission%        (a cost)
//   warranty   = cash * warranty%          (a cost)
//
// Cash deal: customer pays `cash` (a cash discount = the finance fee), and the
// finance fee is NOT a cost. Financed: customer pays `book`, finance fee is a cost.
// Pure + client-safe.

export type Assumptions = {
  commission: number;
  warranty: number;
  gm: number;
  financeFee: number;
  tiers?: number[]; // legacy (unused in UI; kept for DB compatibility)
};

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  commission: 0.12,
  warranty: 0.02,
  gm: 0.5,
  financeFee: 0.1,
  tiers: [0.1, 0.08, 0.06, 0.03, 0.01],
};

export type PriceResult = {
  productCost: number; // COGS (sum of cost components)
  cash: number; // cash sell price
  financeFee: number; // amount
  book: number; // financed / list price (cash + finance fee)
  commission: number; // cost amount
  warranty: number; // cost amount
};

export function priceProduct(cost: number, a: Assumptions): PriceResult {
  const denom = (1 - a.gm) * (1 - a.warranty) - a.commission;
  const cash = denom > 0 ? cost / denom : NaN;
  const financeFee = cash * a.financeFee;
  return {
    productCost: cost,
    cash,
    financeFee,
    book: cash + financeFee,
    commission: cash * a.commission,
    warranty: cash * a.warranty,
  };
}

export function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}
