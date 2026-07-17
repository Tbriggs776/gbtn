import type { LineClass } from "./pc";
import type { Grain, OrderLine } from "./pipeline";
import { bucketKey, isCanceled, isMaterial } from "./pipeline";

/**
 * Drill-down slices: the CGs behind a number on the Orders Pipeline.
 *
 * Every tile and period-table cell is an aggregate over the same line set that
 * bucketOrders() consumes. A drill-down must reproduce that aggregate's filter
 * EXACTLY — same canceled-order exclusion, same line-class scope, same period
 * key from the same bucketKey() — or the list won't tie to the number that was
 * clicked. That's why this lives beside the bucketing code and shares its
 * primitives instead of re-deriving the filter in the API route.
 */

export type LineScope = "all" | "work" | "material" | "labor";
export const LINE_SCOPES = ["all", "work", "material", "labor"] as const;

export const SCOPE_FILTER: Record<LineScope, (c: LineClass) => boolean> = {
  all: () => true,
  work: (c) => c === "material" || c === "labor",
  material: (c) => c === "material",
  labor: (c) => c === "labor",
};

export const DRILL_KINDS = [
  "ordered-period",
  "installing-period",
  "no-po-period",
  "scheduled-ahead",
  "scheduled-no-po",
] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

export type DrillSpec =
  | { kind: "ordered-period"; grain: Grain; key: string; scope: LineScope }
  | { kind: "installing-period"; grain: Grain; key: string; scope: LineScope }
  | { kind: "no-po-period"; grain: Grain; key: string; scope: LineScope }
  | { kind: "scheduled-ahead"; scope: LineScope }
  | { kind: "scheduled-no-po"; scope: LineScope };

export type DrillRow = {
  invoiceNum: string;
  custName: string;
  shipCity: string;
  salesperson: string;
  jobType: string;
  orderDate: string | null;
  /** First/last date the slice matched on (order date for ordered slices, install date for the rest). */
  firstDate: string | null;
  lastDate: string | null;
  /** Lines in THIS slice, not the whole CG — so a period's rows sum to its cell. */
  lines: number;
  /** Line value in this slice. */
  value: number;
};

/** The date a line matches the slice on, or null if it isn't in the slice. */
function matcherFor(spec: DrillSpec, asOf: string): (l: OrderLine) => string | null {
  switch (spec.kind) {
    case "ordered-period":
      return (l) =>
        l.orderDate && bucketKey(l.orderDate, spec.grain) === spec.key ? l.orderDate : null;
    case "installing-period":
      return (l) =>
        l.installDate && bucketKey(l.installDate, spec.grain) === spec.key ? l.installDate : null;
    case "no-po-period":
      return (l) =>
        l.installDate &&
        bucketKey(l.installDate, spec.grain) === spec.key &&
        l.lineStatus === "None" &&
        isMaterial(l)
          ? l.installDate
          : null;
    case "scheduled-ahead":
      return (l) => (l.installDate && l.installDate > asOf ? l.installDate : null);
    case "scheduled-no-po":
      return (l) =>
        l.installDate && l.installDate > asOf && l.lineStatus === "None" && isMaterial(l)
          ? l.installDate
          : null;
  }
}

export function buildDrillRows(lines: OrderLine[], spec: DrillSpec, asOf: string): DrillRow[] {
  const match = matcherFor(spec, asOf);
  const by = new Map<
    string,
    { head: OrderLine; order: string | null; dates: string[]; lines: number; value: number }
  >();

  for (const l of lines) {
    if (isCanceled(l.jobType)) continue; // mirrors bucketOrders' default
    if (!SCOPE_FILTER[spec.scope](l.lineClass)) continue;
    const d = match(l);
    if (d === null) continue;
    let g = by.get(l.invoiceNum);
    if (!g) {
      g = { head: l, order: null, dates: [], lines: 0, value: 0 };
      by.set(l.invoiceNum, g);
    }
    // Earliest order date across matched lines — the CG-level convention the
    // boards use, not whichever line happened to match first.
    if (l.orderDate && (!g.order || l.orderDate < g.order)) g.order = l.orderDate;
    g.dates.push(d);
    g.lines++;
    g.value += l.lineTotal;
  }

  const rows: DrillRow[] = [];
  for (const [invoiceNum, g] of by) {
    g.dates.sort();
    rows.push({
      invoiceNum,
      custName: g.head.custName,
      shipCity: g.head.shipCity,
      salesperson: g.head.salesperson,
      jobType: g.head.jobType,
      orderDate: g.order,
      firstDate: g.dates[0] ?? null,
      lastDate: g.dates[g.dates.length - 1] ?? null,
      lines: g.lines,
      value: Math.round(g.value * 100) / 100,
    });
  }

  rows.sort((a, b) => b.value - a.value || a.invoiceNum.localeCompare(b.invoiceNum));
  return rows;
}
