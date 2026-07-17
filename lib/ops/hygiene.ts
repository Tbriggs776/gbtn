import type { LineStatus } from "./csv-import";
import type { OrderLine } from "./pipeline";
import { isCanceled, isMaterial } from "./pipeline";
import { distribution, type Dist } from "./stats";

/**
 * Status Hygiene — material the system still thinks is on order, on jobs that
 * have already been installed.
 *
 * The playbook's first principle is that LINE STATUS is the truth. In the
 * Jul-2026 export it isn't, for material specifically:
 *
 *   • GenPO / OnOrder / Resvd are 100% material lines — only material is ever
 *     purchased, so only material can sit in them.
 *   • Delivered is almost entirely LABOR (3,329 of 4,228 lines). Just 62
 *     material lines have ever reached it.
 *
 * So the crew's work gets closed out and the material behind it doesn't: 2,004
 * material lines (73% of all past-due material) are still at None/GenPO/OnOrder
 * on jobs installed a median of 78 days ago, worth $2.76M.
 *
 * Why it matters beyond tidiness: material stuck pre-receipt means inventory and
 * WIP are overstated, the Close Out tab can't find the work to bill, and every
 * status-driven report in the playbook reads fiction.
 *
 * LABOR IS DELIBERATELY EXCLUDED. Labor lines are never purchased, so a labor
 * line at None is correct, not stale. Counting them is what turned a 9-line
 * problem into a 1,000-line phantom on the Install Pipeline.
 */

/** Statuses that mean "not yet received" — all of them material-only in practice. */
export const PRE_RECEIPT: LineStatus[] = ["None", "GenPO", "OnOrder"];

export type StaleLine = {
  invoiceNum: string;
  custName: string;
  salesperson: string;
  lineNum: number;
  status: LineStatus;
  styleItem: string;
  installDate: string;
  daysSince: number;
  value: number;
};

export type StaleCG = {
  invoiceNum: string;
  custName: string;
  salesperson: string;
  installDate: string;
  daysSince: number;
  lines: number;
  value: number;
  /** Worst (earliest-stage) status on the CG — where it actually stalled. */
  status: LineStatus;
  /** Every pre-receipt status present on the CG, for the "Stalled at" filter. */
  statuses: LineStatus[];
};

export type AgeBand = { label: string; lo: number; hi: number; cgs: number; lines: number; value: number };

export type HygieneReport = {
  /** Material lines installed but never marked received. */
  staleLines: number;
  staleValue: number;
  staleCGs: StaleCG[];
  /** Past-due material lines overall — the denominator. */
  pastDueMaterial: number;
  age: Dist | null;
  byStatus: { status: LineStatus; lines: number; value: number }[];
  bands: AgeBand[];
  /** Sanity counters that explain WHY this is a hygiene problem, not a backlog. */
  materialEverDelivered: number;
  laborDelivered: number;
};

const BANDS: [string, number, number][] = [
  ["1–30 days", 1, 31],
  ["31–60", 31, 61],
  ["61–90", 61, 91],
  ["91–180", 91, 181],
  ["180+ days", 181, Infinity],
];

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86400000);
}

export function buildHygieneReport(lines: OrderLine[], asOf: string): HygieneReport {
  const live = lines.filter((l) => !isCanceled(l.jobType));

  const pastDueMaterial = live.filter(
    (l) => isMaterial(l) && l.installDate !== null && l.installDate < asOf
  );
  const stale = pastDueMaterial.filter((l) => PRE_RECEIPT.includes(l.lineStatus));

  // Roll stale lines up to the CG: ops chases an order, not a line.
  const cgMap = new Map<string, StaleLine[]>();
  for (const l of stale) {
    const s: StaleLine = {
      invoiceNum: l.invoiceNum,
      custName: l.custName,
      salesperson: l.salesperson,
      lineNum: l.lineNum,
      status: l.lineStatus,
      styleItem: l.styleItem,
      installDate: l.installDate!,
      daysSince: dayDiff(l.installDate!, asOf),
      value: l.lineTotal,
    };
    const a = cgMap.get(l.invoiceNum);
    if (a) a.push(s);
    else cgMap.set(l.invoiceNum, [s]);
  }

  const RANK: Record<string, number> = { None: 0, GenPO: 1, OnOrder: 2 };
  const staleCGs: StaleCG[] = [];
  for (const [invoiceNum, ls] of cgMap) {
    const oldest = ls.reduce((a, b) => (a.installDate < b.installDate ? a : b));
    const worst = ls.reduce((a, b) => (RANK[a.status] <= RANK[b.status] ? a : b));
    staleCGs.push({
      invoiceNum,
      custName: oldest.custName,
      salesperson: oldest.salesperson,
      installDate: oldest.installDate,
      daysSince: oldest.daysSince,
      lines: ls.length,
      value: ls.reduce((a, l) => a + l.value, 0),
      status: worst.status,
      statuses: [...new Set(ls.map((l) => l.status))],
    });
  }
  staleCGs.sort((a, b) => b.daysSince - a.daysSince);

  const byStatus = PRE_RECEIPT.map((status) => {
    const ls = stale.filter((l) => l.lineStatus === status);
    return { status, lines: ls.length, value: ls.reduce((a, l) => a + l.lineTotal, 0) };
  }).filter((s) => s.lines > 0);

  const bands: AgeBand[] = BANDS.map(([label, lo, hi]) => {
    const cgs = staleCGs.filter((g) => g.daysSince >= lo && g.daysSince < hi);
    return {
      label,
      lo,
      hi,
      cgs: cgs.length,
      lines: cgs.reduce((a, g) => a + g.lines, 0),
      value: cgs.reduce((a, g) => a + g.value, 0),
    };
  });

  return {
    staleLines: stale.length,
    staleValue: stale.reduce((a, l) => a + l.lineTotal, 0),
    staleCGs,
    pastDueMaterial: pastDueMaterial.length,
    age: distribution(staleCGs.map((g) => g.daysSince)),
    byStatus,
    bands,
    materialEverDelivered: live.filter((l) => isMaterial(l) && l.lineStatus === "Del").length,
    laborDelivered: live.filter((l) => l.lineClass === "labor" && l.lineStatus === "Del").length,
  };
}
