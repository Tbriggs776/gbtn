// The ops <-> financials bridge: it lines RFMS booked/installed work up against
// the P&L revenue, margin, and balance-sheet cash the same months produced. It's
// the foundation the revenue projection will sit on later — for now it just makes
// the relationship visible: what was sold, what got installed, what the books
// recognized, and how much of the coming months is already sold and cash-funded.

import { bucketOrders, asOfFrom, type OrderLine } from "@/lib/ops/pipeline";
import { computePL, type LineItem } from "@/lib/financials/metrics";
import { normalizeLabel } from "@/lib/financials/categories";
import type { FpaRawItem } from "@/lib/financials/fpa";

const ymOf = (d: string) => d.slice(0, 7);

export type BridgeMonth = {
  label: string;
  end: string | null;
  ym: string; // YYYY-MM, the join key between ops and financials
  booked: number; // ops: line value ordered this month (work sold)
  installed: number; // ops: line value installed this month (work delivered)
  recognized: number | null; // P&L: revenue recognized this month
  grossMargin: number | null; // P&L: gross margin %
  deposits: number | null; // BS: customer deposits outstanding
  cwip: number | null; // BS: construction/work in progress
};

export type ForwardMonth = { ym: string; label: string; installed: number };

export type BridgeReport = {
  hasOps: boolean;
  hasFin: boolean;
  asOf: string | null; // ops snapshot date
  months: BridgeMonth[]; // financial months, with ops joined by ym
  forward: ForwardMonth[]; // installs scheduled AFTER asOf — the backlog, by month
  backlog: number; // total installed $ scheduled after asOf
  // Headline signals for the latest financial month:
  latest: BridgeMonth | null;
  bookToBill: number | null; // booked / installed, latest month (>1 = building backlog)
  avgRecognized: number | null; // mean monthly recognized revenue (complete months)
  coverageMonths: number | null; // backlog / avgRecognized — months of revenue already sold
  depositCoverage: number | null; // customer deposits / backlog — how much backlog is cash-funded
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Financial months from the loaded line items: recognized revenue + gross margin
// (via computePL, so they match the Financials dashboard) and the two balance-
// sheet lines the cash view needs.
function financialMonths(fin: FpaRawItem[]): Omit<BridgeMonth, "booked" | "installed">[] {
  const byLabel = new Map<string, { end: string | null; pl: LineItem[]; bs: FpaRawItem[] }>();
  for (const it of fin) {
    let m = byLabel.get(it.periodLabel);
    if (!m) {
      m = { end: it.periodEnd, pl: [], bs: [] };
      byLabel.set(it.periodLabel, m);
    }
    if (it.statementType === "pl") m.pl.push({ category: it.category, amount: it.amount });
    else if (it.statementType === "bs") m.bs.push(it);
  }

  const bsLine = (rows: FpaRawItem[], match: (n: string) => boolean): number | null => {
    const hit = rows.filter((r) => match(normalizeLabel(r.rawLabel)));
    return hit.length ? hit.reduce((t, r) => t + r.amount, 0) : null;
  };

  return [...byLabel.entries()]
    .map(([label, m]) => {
      const pl = computePL(m.pl);
      return {
        label,
        end: m.end,
        ym: m.end && YMD.test(m.end) ? ymOf(m.end) : label,
        recognized: m.pl.length ? pl.revenue : null,
        grossMargin: m.pl.length ? pl.grossMargin : null,
        deposits: bsLine(m.bs, (n) => n.includes("customer deposit")),
        cwip: bsLine(m.bs, (n) => n === "cwip" || n.includes("work in progress") || n.includes("work-in-process")),
      };
    })
    .sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
}

export function buildBridge(ops: OrderLine[], fin: FpaRawItem[]): BridgeReport {
  const hasOps = ops.length > 0;
  const hasFin = fin.length > 0;
  const asOf = hasOps ? asOfFrom(ops) : null;

  // Ops booked ($ by order month) and installed ($ by install month).
  const opsByYm = new Map<string, { booked: number; installed: number }>();
  if (hasOps) {
    for (const b of bucketOrders(ops, "month")) {
      opsByYm.set(ymOf(b.key), { booked: b.orderedRevenue, installed: b.installingRevenue });
    }
  }

  const finMonths = financialMonths(fin);
  const months: BridgeMonth[] = finMonths.map((m) => {
    const o = opsByYm.get(m.ym);
    return { ...m, booked: o?.booked ?? 0, installed: o?.installed ?? 0 };
  });

  // Backlog: installs scheduled strictly after the snapshot. Driven off the day
  // buckets so a partially-elapsed month doesn't count its past installs.
  const forward: ForwardMonth[] = [];
  let backlog = 0;
  if (hasOps && asOf) {
    const fwd = new Map<string, number>();
    for (const b of bucketOrders(ops, "day")) {
      if (b.key > asOf) {
        backlog += b.installingRevenue;
        const ym = ymOf(b.key);
        fwd.set(ym, (fwd.get(ym) ?? 0) + b.installingRevenue);
      }
    }
    for (const [ym, installed] of [...fwd.entries()].sort()) {
      const [y, mo] = ym.split("-");
      const label = `${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+mo]} ${y}`;
      forward.push({ ym, label, installed });
    }
  }

  const latest = months.length ? months[months.length - 1] : null;
  const bookToBill = latest && latest.installed ? latest.booked / latest.installed : null;

  // Average recognized over the complete financial months (exclude a null month).
  const recognizedVals = months.map((m) => m.recognized).filter((v): v is number => v != null);
  const avgRecognized = recognizedVals.length
    ? recognizedVals.reduce((t, v) => t + v, 0) / recognizedVals.length
    : null;

  const coverageMonths = avgRecognized ? backlog / avgRecognized : null;
  const depositCoverage = latest?.deposits != null && backlog ? latest.deposits / backlog : null;

  return {
    hasOps,
    hasFin,
    asOf,
    months,
    forward,
    backlog,
    latest,
    bookToBill,
    avgRecognized,
    coverageMonths,
    depositCoverage,
  };
}
