// Floor Daddy pricing engine. Mirrors the Excel model, solved to closed form
// (the sheet is circular: commission depends on price depends on commission).
//
//   cash  = cost / [(1-gm)(1-warranty) - commission]
//   book  = cash * (1 + financeFee)
//   Y     = cost + commission*cash                       (total cost incl. commission)
//   tierN = Y / [(1-gm)(1-warranty) - tierRate]          (per finance program)
//
// Pure + client-safe.

export type Assumptions = {
  commission: number; // e.g. 0.12
  warranty: number; // e.g. 0.02
  gm: number; // target gross margin, e.g. 0.5
  financeFee: number; // e.g. 0.1
  tiers: number[]; // finance program commission rates, e.g. [0.1,0.08,0.06,0.03,0.01]
};

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  commission: 0.12,
  warranty: 0.02,
  gm: 0.5,
  financeFee: 0.1,
  tiers: [0.1, 0.08, 0.06, 0.03, 0.01],
};

export type PriceResult = {
  cost: number;
  cash: number; // cash sell price (pre finance fee)
  cashBook: number; // cash price + finance fee
  marginPct: number | null; // gross margin on the cash sell price
  tiers: { rate: number; book: number }[]; // one book price per finance program
};

export function priceProduct(cost: number, a: Assumptions): PriceResult {
  const k = (1 - a.gm) * (1 - a.warranty); // shared denominator base
  const denomCash = k - a.commission;

  const cash = denomCash > 0 ? cost / denomCash : NaN;
  const cashBook = cash * (1 + a.financeFee);
  const y = cost + a.commission * cash;

  const tiers = a.tiers.map((rate) => {
    const d = k - rate;
    const tierCash = d > 0 ? y / d : NaN;
    return { rate, book: tierCash * (1 + a.financeFee) };
  });

  // Gross margin on the cash sell price (sell − cost) ÷ sell.
  const marginPct = cash > 0 ? ((cash - cost) / cash) * 100 : null;

  return { cost, cash, cashBook, marginPct, tiers };
}

export function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}
