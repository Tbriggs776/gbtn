// FP&A aggregation: turns the loaded monthly line items into the month-over-month
// series the FP&A tab renders — each SG&A and COGS line as a % of revenue, the
// headline margin trends, and the biggest movers in the latest month.
//
// The % tables need per-raw-label detail, which the P&L metrics roll up away, so
// this groups the raw items itself. Headline KPIs reuse computePL so they tie to
// the same numbers the Financials dashboard shows.

import { computePL, type LineItem } from "./metrics";
import { normalizeLabel } from "./categories";

export type FpaRawItem = {
  periodLabel: string;
  periodEnd: string | null;
  statementType: string; // "pl" | "bs"
  category: string;
  rawLabel: string;
  amount: number;
};

export type FpaMonth = { label: string; end: string | null; revenue: number };

// One expense line (e.g. "Payroll Expense") tracked across every month.
export type FpaLine = {
  label: string;
  byMonth: number[]; // dollars, index-aligned to months
  pctByMonth: (number | null)[]; // % of that month's revenue (null if no revenue)
  total: number; // dollars across the whole window
  totalPct: number | null; // total / total revenue, as a %
};

export type FpaKpi = {
  label: string;
  end: string | null;
  revenue: number;
  revenueGrowth: number | null; // MoM %, null for the first month
  grossMargin: number | null;
  ebitdaMargin: number | null;
  opexRatio: number | null;
};

export type FpaMover = {
  label: string;
  group: "SG&A" | "COGS";
  prev: number;
  curr: number;
  deltaDollars: number;
  prevPct: number | null;
  currPct: number | null;
  deltaBps: number | null; // change in % of revenue, in basis points
};

export type FpaReport = {
  months: FpaMonth[];
  sga: FpaLine[];
  cogs: FpaLine[];
  kpis: FpaKpi[];
  movers: FpaMover[];
  totalRevenue: number;
  latest: string | null; // label of the most recent month
  prior: string | null; // label of the month before it
};

const pctOf = (num: number, den: number): number | null => (den ? (num / den) * 100 : null);

const MONTH_NUM: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// A CHRONOLOGICAL sort key. period_end (ISO) is authoritative and collates
// correctly as a string. When it's absent — the manual uploader makes the end
// date optional — sorting by the raw label would order months alphabetically
// (Apr, Aug, Dec, Feb…), silently mispairing every MoM comparison. So fall back
// to parsing a "Mon YYYY" label into YYYY-MM-01, and push anything unparseable
// to the end in stable label order rather than into the middle of the timeline.
function monthSortKey(label: string, end: string | null): string {
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) return end;
  const m = label.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{4})$/);
  if (m && MONTH_NUM[m[1]]) return `${m[2]}-${MONTH_NUM[m[1]]}-01`;
  return `9999-99-99 ${label}`;
}

// Order the periods chronologically so month i-1 really is the month before i —
// every MoM growth and every mover pairing depends on this being time order.
function orderedMonths(items: FpaRawItem[]): { label: string; end: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const it of items) if (!seen.has(it.periodLabel)) seen.set(it.periodLabel, it.periodEnd);
  return [...seen.entries()]
    .map(([label, end]) => ({ label, end }))
    .sort((a, b) => {
      const ak = monthSortKey(a.label, a.end);
      const bk = monthSortKey(b.label, b.end);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
}

// Build the per-line series for one P&L category (opex -> SG&A, cogs -> COGS).
// Lines are keyed by normalized label so a stray capitalization can't split one
// account into two rows; the first spelling seen is the display label.
function linesFor(
  items: FpaRawItem[],
  months: { label: string }[],
  category: string,
  revenueByMonth: number[]
): FpaLine[] {
  const monthIndex = new Map(months.map((m, i) => [m.label, i]));
  const byKey = new Map<string, { label: string; byMonth: number[] }>();

  for (const it of items) {
    if (it.statementType !== "pl" || it.category !== category) continue;
    const key = normalizeLabel(it.rawLabel);
    let row = byKey.get(key);
    if (!row) {
      row = { label: it.rawLabel.trim(), byMonth: new Array(months.length).fill(0) };
      byKey.set(key, row);
    }
    const mi = monthIndex.get(it.periodLabel);
    if (mi != null) row.byMonth[mi] += it.amount;
  }

  const totalRevenue = revenueByMonth.reduce((t, r) => t + r, 0);
  const lines: FpaLine[] = [...byKey.values()].map((row) => {
    const total = row.byMonth.reduce((t, v) => t + v, 0);
    return {
      label: row.label,
      byMonth: row.byMonth,
      pctByMonth: row.byMonth.map((v, i) => pctOf(v, revenueByMonth[i])),
      total,
      totalPct: pctOf(total, totalRevenue),
    };
  });

  // Largest lines first — that's the order a CFO scans overhead in.
  lines.sort((a, b) => b.total - a.total);
  return lines;
}

export function buildFpaReport(items: FpaRawItem[]): FpaReport {
  const monthMeta = orderedMonths(items);
  const n = monthMeta.length;

  // Per-month P&L items -> computePL, so KPIs match the Financials dashboard.
  const plByMonth = new Map<string, LineItem[]>();
  for (const it of items) {
    if (it.statementType !== "pl") continue;
    const arr = plByMonth.get(it.periodLabel) ?? [];
    arr.push({ category: it.category, amount: it.amount });
    plByMonth.set(it.periodLabel, arr);
  }

  const revenueByMonth: number[] = [];
  const kpis: FpaKpi[] = [];
  for (let i = 0; i < n; i++) {
    const m = monthMeta[i];
    const pl = computePL(plByMonth.get(m.label) ?? []);
    revenueByMonth.push(pl.revenue);
    const prevRev = i > 0 ? revenueByMonth[i - 1] : null;
    kpis.push({
      label: m.label,
      end: m.end,
      revenue: pl.revenue,
      revenueGrowth: prevRev ? ((pl.revenue - prevRev) / prevRev) * 100 : null,
      grossMargin: pl.grossMargin,
      ebitdaMargin: pl.ebitdaMargin,
      opexRatio: pl.opexRatio,
    });
  }

  const months: FpaMonth[] = monthMeta.map((m, i) => ({
    label: m.label,
    end: m.end,
    revenue: revenueByMonth[i],
  }));

  const sga = linesFor(items, monthMeta, "opex", revenueByMonth);
  const cogs = linesFor(items, monthMeta, "cogs", revenueByMonth);

  // Movers: latest month vs the one before, across both expense groups.
  const movers: FpaMover[] = [];
  if (n >= 2) {
    const ci = n - 1;
    const pi = n - 2;
    const rc = revenueByMonth[ci];
    const rp = revenueByMonth[pi];
    for (const [group, lines] of [
      ["SG&A", sga],
      ["COGS", cogs],
    ] as const) {
      for (const l of lines) {
        const curr = l.byMonth[ci];
        const prev = l.byMonth[pi];
        const currPct = pctOf(curr, rc);
        const prevPct = pctOf(prev, rp);
        movers.push({
          label: l.label,
          group,
          prev,
          curr,
          deltaDollars: curr - prev,
          prevPct,
          currPct,
          deltaBps: currPct != null && prevPct != null ? (currPct - prevPct) * 100 : null,
        });
      }
    }
    // Biggest absolute dollar swing first — that's what needs explaining.
    movers.sort((a, b) => Math.abs(b.deltaDollars) - Math.abs(a.deltaDollars));
  }

  return {
    months,
    sga,
    cogs,
    kpis,
    movers,
    totalRevenue: revenueByMonth.reduce((t, r) => t + r, 0),
    latest: n ? monthMeta[n - 1].label : null,
    prior: n >= 2 ? monthMeta[n - 2].label : null,
  };
}
