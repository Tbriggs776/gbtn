// Compute financial metrics from normalized line items.

export type LineItem = { category: string; amount: number; raw_label?: string };

export type PLMetrics = {
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMargin: number | null; // %
  opex: number;
  da: number;
  ebitda: number;
  ebitdaMargin: number | null; // %
  interest: number;
  taxes: number;
  otherIncome: number;
  otherExpense: number;
  netIncome: number;
  opexRatio: number | null; // % of revenue
};

export type BSMetrics = {
  cash: number;
  accountsReceivable: number;
  inventory: number;
  currentAssets: number;
  nonCurrentAssets: number;
  totalAssets: number;
  accountsPayable: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
  totalLiabilities: number;
  equity: number;
  workingCapital: number;
  currentRatio: number | null;
  quickRatio: number | null;
  debtToEquity: number | null;
};

const EXPENSE = new Set([
  "cogs",
  "opex",
  "depreciation_amortization",
  "interest",
  "taxes",
  "other_expense",
]);

function sum(items: LineItem[], cat: string, abs = false): number {
  return items
    .filter((i) => i.category === cat)
    .reduce((t, i) => t + (abs ? Math.abs(i.amount) : i.amount), 0);
}

const pct = (num: number, den: number): number | null =>
  den ? (num / den) * 100 : null;

export function computePL(items: LineItem[]): PLMetrics {
  const revenue = sum(items, "revenue");
  const cogs = sum(items, "cogs", true);
  const opex = sum(items, "opex", true);
  const da = sum(items, "depreciation_amortization", true);
  const interest = sum(items, "interest", true);
  const taxes = sum(items, "taxes", true);
  const otherIncome = sum(items, "other_income");
  const otherExpense = sum(items, "other_expense", true);

  const grossProfit = revenue - cogs;
  const ebitda = grossProfit - opex + otherIncome - otherExpense;
  const netIncome = ebitda - da - interest - taxes;

  return {
    revenue,
    cogs,
    grossProfit,
    grossMargin: pct(grossProfit, revenue),
    opex,
    da,
    ebitda,
    ebitdaMargin: pct(ebitda, revenue),
    interest,
    taxes,
    otherIncome,
    otherExpense,
    netIncome,
    opexRatio: pct(opex, revenue),
  };
}

// Combine several months of P&L flows into one period (e.g. YTD or a custom
// range). Additive lines sum; ratio lines are recomputed off the summed totals.
export function aggregatePL(months: PLMetrics[]): PLMetrics | null {
  if (months.length === 0) return null;
  if (months.length === 1) return months[0];

  const add = (key: keyof PLMetrics) =>
    months.reduce((t, m) => t + (m[key] as number), 0);

  const revenue = add("revenue");
  const grossProfit = add("grossProfit");
  const ebitda = add("ebitda");
  const opex = add("opex");

  return {
    revenue,
    cogs: add("cogs"),
    grossProfit,
    grossMargin: pct(grossProfit, revenue),
    opex,
    da: add("da"),
    ebitda,
    ebitdaMargin: pct(ebitda, revenue),
    interest: add("interest"),
    taxes: add("taxes"),
    otherIncome: add("otherIncome"),
    otherExpense: add("otherExpense"),
    netIncome: add("netIncome"),
    opexRatio: pct(opex, revenue),
  };
}

export function computeBS(items: LineItem[]): BSMetrics {
  const cash = sum(items, "cash");
  const ar = sum(items, "accounts_receivable");
  const inventory = sum(items, "inventory");
  const otherCA = sum(items, "other_current_asset");
  const nonCurrentAssets = sum(items, "non_current_asset");

  const ap = sum(items, "accounts_payable", true);
  const otherCL = sum(items, "other_current_liability", true);
  const nonCurrentLiabilities = sum(items, "non_current_liability", true);
  const equity = sum(items, "equity");

  const currentAssets = cash + ar + inventory + otherCA;
  const totalAssets = currentAssets + nonCurrentAssets;
  const currentLiabilities = ap + otherCL;
  const totalLiabilities = currentLiabilities + nonCurrentLiabilities;

  return {
    cash,
    accountsReceivable: ar,
    inventory,
    currentAssets,
    nonCurrentAssets,
    totalAssets,
    accountsPayable: ap,
    currentLiabilities,
    nonCurrentLiabilities,
    totalLiabilities,
    equity,
    workingCapital: currentAssets - currentLiabilities,
    currentRatio: currentLiabilities ? currentAssets / currentLiabilities : null,
    quickRatio: currentLiabilities
      ? (currentAssets - inventory) / currentLiabilities
      : null,
    debtToEquity: equity ? totalLiabilities / equity : null,
  };
}

// A single reporting period combining whatever statements exist for it.
export type Period = {
  label: string;
  periodEnd: string | null;
  pl: PLMetrics | null;
  bs: BSMetrics | null;
};

// Formatting helpers.
export function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function percent(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function ratio(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}×`;
}
