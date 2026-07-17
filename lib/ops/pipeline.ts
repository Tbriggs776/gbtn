import type { LineStatus } from "./csv-import";
import type { LineClass } from "./pc";
import { isBoilerplate } from "./pc";

/**
 * Aggregations over RFMS order lines. Pure functions over plain rows — no I/O —
 * so both reports and the loader script can share them and they stay testable.
 */

export type OrderLine = {
  invoiceNum: string;
  lineNum: number;
  lineStatus: LineStatus;
  lineClass: LineClass;
  custName: string;
  shipCity: string;
  salesperson: string;
  jobType: string;
  orderDate: string | null;   // 'YYYY-MM-DD'
  installDate: string | null;
  estDelDate: string | null;
  measureDate: string | null;
  styleItem: string;
  qty: number;
  lineTotal: number;
};

/** Composition of a line set — shown so the boilerplate share is never hidden. */
export type LineMix = { material: number; labor: number; other: number; boilerplate: number; total: number };

export function mixOf(lines: OrderLine[]): LineMix {
  const m: LineMix = { material: 0, labor: 0, other: 0, boilerplate: 0, total: lines.length };
  for (const l of lines) {
    m[l.lineClass]++;
    if (isBoilerplate(l.qty, l.lineTotal)) m.boilerplate++;
  }
  return m;
}

export const STATUS_ORDER: LineStatus[] = ["None", "GenPO", "OnOrder", "Cut", "Del", "Resvd"];

/**
 * Material readiness, worst -> best. Deliberately NOT the display order above:
 * Resvd (stock allocated) is further along than OnOrder but isn't yet Cut, and
 * the calendar colours a day by its weakest line, so the ranking has to reflect
 * real readiness rather than column order.
 */
const READINESS: Record<LineStatus, number> = {
  None: 0, GenPO: 1, OnOrder: 2, Resvd: 3, Cut: 4, Del: 5,
};
export const readinessOf = (s: LineStatus): number => READINESS[s];

/**
 * A line that represents no real work: promo giveaways, fees, commission,
 * discounts, and the boilerplate RFMS prints on customer paperwork.
 *
 * Was a text match on "AIR DUCT|CLEANING" back when the export was filtered to
 * material only and the giveaway was the sole non-work line in the file. The
 * full export carries PC bands, so this is now the real classification — which
 * also catches fees and terms text the regex never saw.
 */
export const isNonWork = (l: Pick<OrderLine, "lineClass">): boolean => l.lineClass === "other";

/** Material that has to be purchased and received — the only thing a PO applies to. */
export const isMaterial = (l: Pick<OrderLine, "lineClass">): boolean => l.lineClass === "material";

export const isCanceled = (jobType: string): boolean => jobType === "CANCELED ORDER";
export const isHold = (jobType: string): boolean => jobType === "HOLD ORDER";

// ── CG rollup (Install Pipeline) ─────────────────────────────────────────────

export type CG = {
  invoiceNum: string;
  custName: string;
  shipCity: string;
  salesperson: string;
  jobType: string;
  orderDate: string | null;
  /** Distinct install dates, ascending. Phased jobs legitimately have several. */
  installDates: string[];
  /** Earliest install date — what the board shows in the Install Date column. */
  installDate: string | null;
  lines: OrderLine[];
  counts: Record<LineStatus, number>;
  total: number;
  revenue: number;
  /** Share of lines delivered. Drives the "Completed?" meter. */
  delShare: number;
  /** 0 = none delivered, 1 = some, 2 = all (the derived "Completed?"). */
  ready: 0 | 1 | 2;
  hasFuture: boolean;
  /** Some lines already installed, some still ahead — a phased job mid-flight. */
  mixed: boolean;
  /** Every future-dated line is an air-duct promo; the floor is already down. */
  serviceOnly: boolean;
  futureLines: number;
  canceled: boolean;
  hold: boolean;
};

/**
 * One install day for a CG, pre-aggregated. The calendar needs a status per day
 * per CG and nothing else, so shipping this instead of the raw lines is the
 * difference between a ~240KB page and a ~6MB one at full-export scale.
 */
export type ScheduleDay = { date: string; status: LineStatus; lines: number };

/**
 * A CG row without its lines. The board renders entirely from this; line detail
 * is fetched per-CG when a row is expanded (see /api/ops/lines).
 */
export type CGSummary = Omit<CG, "lines"> & { schedule: ScheduleDay[] };

export function toSummary(g: CG): CGSummary {
  const byDate = new Map<string, OrderLine[]>();
  for (const l of g.lines) {
    if (!l.installDate) continue;
    const a = byDate.get(l.installDate);
    if (a) a.push(l);
    else byDate.set(l.installDate, [l]);
  }
  const schedule: ScheduleDay[] = [];
  for (const [date, ls] of byDate) {
    // A day is only as ready as its weakest line.
    const worst = ls.reduce((a, l) => (readinessOf(l.lineStatus) < readinessOf(a.lineStatus) ? l : a), ls[0]);
    schedule.push({ date, status: worst.lineStatus, lines: ls.length });
  }
  schedule.sort((a, b) => a.date.localeCompare(b.date));

  const { lines: _drop, ...rest } = g;
  return { ...rest, schedule };
}

export function rollUpCGs(lines: OrderLine[], asOf: string): CG[] {
  const by = new Map<string, OrderLine[]>();
  for (const l of lines) {
    const g = by.get(l.invoiceNum);
    if (g) g.push(l);
    else by.set(l.invoiceNum, [l]);
  }

  const out: CG[] = [];
  for (const [invoiceNum, ls] of by) {
    const counts = { None: 0, GenPO: 0, OnOrder: 0, Cut: 0, Del: 0, Resvd: 0 } as Record<LineStatus, number>;
    let revenue = 0;
    for (const l of ls) {
      counts[l.lineStatus]++;
      revenue += l.lineTotal;
    }

    const dates = [...new Set(ls.map((l) => l.installDate).filter((d): d is string => Boolean(d)))].sort();
    const future = ls.filter((l) => l.installDate !== null && l.installDate > asOf);
    const hasFuture = future.length > 0;
    const head = ls[0];
    const delShare = ls.length ? counts.Del / ls.length : 0;

    out.push({
      invoiceNum,
      custName: head.custName,
      shipCity: head.shipCity,
      salesperson: head.salesperson,
      jobType: head.jobType,
      orderDate: head.orderDate,
      installDates: dates,
      installDate: dates[0] ?? null,
      lines: [...ls].sort(
        (a, b) => (a.installDate ?? "9").localeCompare(b.installDate ?? "9") || a.lineNum - b.lineNum
      ),
      counts,
      total: ls.length,
      revenue,
      delShare,
      ready: delShare === 1 ? 2 : counts.Del > 0 ? 1 : 0,
      hasFuture,
      mixed: hasFuture && !dates.every((d) => d > asOf),
      // Nothing but promo/fees left ahead: the floor is down, only the giveaway
      // and the paperwork lines still carry a future date.
      serviceOnly: hasFuture && future.every(isNonWork),
      futureLines: future.length,
      canceled: isCanceled(head.jobType),
      hold: isHold(head.jobType),
    });
  }

  return out.sort((a, b) => (a.installDate ?? "9").localeCompare(b.installDate ?? "9"));
}

// ── Date bucketing (Orders Pipeline) ─────────────────────────────────────────

export type Grain = "day" | "week" | "month";

/**
 * Period key a date falls in. Built by string surgery where possible so no
 * Date object — and therefore no timezone — can shift a day across a boundary.
 * Weeks start Sunday, matching the install calendar and US retail convention.
 */
export function bucketKey(date: string, grain: Grain): string {
  if (grain === "month") return `${date.slice(0, 7)}-01`;
  if (grain === "day") return date;
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d); // local — never UTC
  dt.setDate(dt.getDate() - dt.getDay());
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export type Bucket = {
  key: string;
  /** Lines whose ORDER date lands here — demand coming in. */
  ordered: number;
  orderedCGs: number;
  orderedRevenue: number;
  /** Lines whose INSTALL date lands here — load going out (the capacity check). */
  installing: number;
  installingCGs: number;
  installingRevenue: number;
  /** Installing lines with no PO yet, excluding air-duct promos. The risk. */
  installingNoPO: number;
};

/**
 * Orders in vs installs out, per period. Two series in one bucket because
 * capacity planning is the comparison: intake you can't install is a backlog,
 * install load you haven't ordered for is a stockout.
 *
 * Every period between the first and last is emitted, including empty ones —
 * a chart that silently drops zero-volume days misreads a shutdown as a gap.
 */
export function bucketOrders(lines: OrderLine[], grain: Grain, opts?: { includeCanceled?: boolean }): Bucket[] {
  const rows = opts?.includeCanceled ? lines : lines.filter((l) => !isCanceled(l.jobType));
  const map = new Map<string, Bucket & { _oCG: Set<string>; _iCG: Set<string> }>();

  const touch = (key: string) => {
    let b = map.get(key);
    if (!b) {
      b = {
        key, ordered: 0, orderedCGs: 0, orderedRevenue: 0,
        installing: 0, installingCGs: 0, installingRevenue: 0, installingNoPO: 0,
        _oCG: new Set(), _iCG: new Set(),
      };
      map.set(key, b);
    }
    return b;
  };

  for (const l of rows) {
    if (l.orderDate) {
      const b = touch(bucketKey(l.orderDate, grain));
      b.ordered++;
      b.orderedRevenue += l.lineTotal;
      b._oCG.add(l.invoiceNum);
    }
    if (l.installDate) {
      const b = touch(bucketKey(l.installDate, grain));
      b.installing++;
      b.installingRevenue += l.lineTotal;
      b._iCG.add(l.invoiceNum);
      if (l.lineStatus === "None" && isMaterial(l)) b.installingNoPO++;
    }
  }

  for (const b of map.values()) {
    b.orderedCGs = b._oCG.size;
    b.installingCGs = b._iCG.size;
  }

  const keys = [...map.keys()].sort();
  if (keys.length === 0) return [];

  // Fill the gaps so the x-axis is a real timeline.
  const out: Bucket[] = [];
  for (const k of eachPeriod(keys[0], keys[keys.length - 1], grain)) {
    const b = map.get(k);
    out.push(
      b
        ? {
            key: b.key, ordered: b.ordered, orderedCGs: b.orderedCGs, orderedRevenue: b.orderedRevenue,
            installing: b.installing, installingCGs: b.installingCGs,
            installingRevenue: b.installingRevenue, installingNoPO: b.installingNoPO,
          }
        : {
            key: k, ordered: 0, orderedCGs: 0, orderedRevenue: 0,
            installing: 0, installingCGs: 0, installingRevenue: 0, installingNoPO: 0,
          }
    );
  }
  return out;
}

function* eachPeriod(start: string, end: string, grain: Grain): Generator<string> {
  const [y, m, d] = start.split("-").map(Number);
  const cur = new Date(y, m - 1, d);
  const [ey, em, ed] = end.split("-").map(Number);
  const last = new Date(ey, em - 1, ed);
  let guard = 0;

  while (cur <= last && guard++ < 5000) {
    yield `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    if (grain === "day") cur.setDate(cur.getDate() + 1);
    else if (grain === "week") cur.setDate(cur.getDate() + 7);
    else cur.setMonth(cur.getMonth() + 1);
  }
}

// ── Headline numbers shared by both reports ──────────────────────────────────

export type PipelineSummary = {
  cgTotal: number;
  lineTotal: number;
  futureCGs: number;
  realCGs: number;
  serviceOnlyCGs: number;
  realRevenue: number;
  installingSoon: number;
  noPOLines: number;
  noPOCGs: number;
  mixedCGs: number;
  /**
   * The CG ids behind each tile, emitted by the SAME pass that produced the
   * counts — so a tile click can filter the board to exactly the rows it
   * counted, never a re-derived approximation that drifts.
   */
  ids: {
    realWork: string[];
    serviceOnly: string[];
    installingSoon: string[];
    noPO: string[];
    split: string[];
  };
};

export function summarize(cgs: CG[], asOf: string, horizonDays = 14): PipelineSummary {
  const live = cgs.filter((g) => !g.canceled);
  const future = live.filter((g) => g.hasFuture);
  const real = future.filter((g) => !g.serviceOnly);
  const horizon = addDays(asOf, horizonDays);

  // Only MATERIAL can be missing a PO. Labor ("INSTALL LVP") and promo lines sit
  // at status None forever by design — they're never purchased, so counting them
  // here would turn a 4-line problem into a 1,000-line phantom.
  const noPO: string[] = [];
  for (const g of future) {
    for (const l of g.lines) {
      if (l.installDate && l.installDate > asOf && l.lineStatus === "None" && isMaterial(l)) {
        noPO.push(g.invoiceNum);
      }
    }
  }

  const soon = real.filter((g) => g.installDates.some((d) => d > asOf && d <= horizon));
  const split = live.filter((g) => g.mixed);

  return {
    cgTotal: cgs.length,
    lineTotal: cgs.reduce((a, g) => a + g.total, 0),
    futureCGs: future.length,
    realCGs: real.length,
    serviceOnlyCGs: future.length - real.length,
    realRevenue: real.reduce((a, g) => a + g.revenue, 0),
    installingSoon: soon.length,
    noPOLines: noPO.length,
    noPOCGs: new Set(noPO).size,
    mixedCGs: split.length,
    ids: {
      realWork: real.map((g) => g.invoiceNum),
      serviceOnly: future.filter((g) => g.serviceOnly).map((g) => g.invoiceNum),
      installingSoon: soon.map((g) => g.invoiceNum),
      noPO: [...new Set(noPO)],
      split: split.map((g) => g.invoiceNum),
    },
  };
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** The snapshot's "today": the newest order date in the file. */
export function asOfFrom(lines: OrderLine[]): string {
  const dates = lines.map((l) => l.orderDate).filter((d): d is string => Boolean(d)).sort();
  return dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10);
}
