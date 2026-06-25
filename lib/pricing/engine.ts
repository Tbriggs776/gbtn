// Floor Daddy pricing engine — replicates the spreadsheet, including its
// circular reference, via Excel-style ITERATIVE CALCULATION.
//
//   commission = commission% * cash          (circular: cash depends on this)
//   warranty   = warranty%   * cash
//   cash       = (base + commission) / (1 - GM) + warranty
//   finance    = financeFee% * cash
//   book       = cash + finance               (everything is listed at BOOK)
//
// Iterate cash up to MAX_ITER times, stopping when the change is < MAX_DELTA —
// the same settings as Excel's iterative calculation (100 iterations, 0.001).
//
// Gross margin is measured against COGS = base + commission, on net revenue
// (customer price minus warranty + finance-fee pass-throughs); at full price it
// equals the GM assumption. Pure + client-safe.

export type Assumptions = {
  commission: number;
  warranty: number;
  gm: number;
  financeFee: number;
  tiers?: number[]; // legacy, unused
};

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  commission: 0.12,
  warranty: 0.02,
  gm: 0.5,
  financeFee: 0.1,
  tiers: [0.1, 0.08, 0.06, 0.03, 0.01],
};

export type PriceResult = {
  base: number; // product/labor cost (sum of components)
  cash: number; // cash sell price (book − finance fee)
  book: number; // list price (cash + finance fee) — what we quote
  commission: number; // amount
  warranty: number; // amount (pass-through)
  financeFee: number; // amount (pass-through, financed deals)
  cogs: number; // base + commission
};

const MAX_ITER = 100;
const MAX_DELTA = 0.001;

export function priceProduct(base: number, a: Assumptions): PriceResult {
  const gmDiv = 1 - a.gm;
  let cash = 0;
  if (gmDiv > 0) {
    for (let i = 0; i < MAX_ITER; i++) {
      const commission = cash * a.commission;
      const warranty = cash * a.warranty;
      const next = (base + commission) / gmDiv + warranty;
      const delta = Math.abs(next - cash);
      cash = next;
      if (delta < MAX_DELTA) break;
    }
  } else {
    cash = NaN;
  }

  const commission = cash * a.commission;
  const warranty = cash * a.warranty;
  const financeFee = cash * a.financeFee;
  return {
    base,
    cash,
    book: cash + financeFee,
    commission,
    warranty,
    financeFee,
    cogs: base + commission,
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
