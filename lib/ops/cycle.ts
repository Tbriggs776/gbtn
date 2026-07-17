import type { OrderLine } from "./pipeline";
import { isCanceled } from "./pipeline";
import { distribution, histogram, type Bin, type Dist } from "./stats";

/**
 * Speed to Install — how long a customer waits, measured at the CG.
 *
 * Three clocks, all CG-level because a customer experiences one job, not 20
 * lines:
 *
 *   measure -> order    how long the sale took. Floor Daddy closes 53% of jobs
 *                       the same day as the measure, so this is ~0 and the
 *                       "sales cycle" isn't where time goes.
 *   order   -> install  fulfilment.
 *   measure -> install  the number the customer actually feels. Because the
 *                       sale is same-day, this is essentially all fulfilment.
 *
 * &Measure Date is 100% populated in the export, which is why this is the one
 * cycle worth reporting on rather than estimating.
 *
 * COMPLETED INSTALLS ONLY. A job scheduled for October has a measure->install
 * gap you can compute, but nobody has waited it yet — it's a plan, and plans
 * don't belong in "how long customers wait". Left in, the forward schedule
 * dragged the trend to a 173-day median in a month that hasn't happened.
 * Upcoming work is the Install Pipeline's job.
 */

export type CycleJob = {
  invoiceNum: string;
  custName: string;
  shipCity: string;
  salesperson: string;
  measureDate: string;
  orderDate: string | null;
  installDate: string;
  /** measure -> install, in days. The headline. */
  days: number;
  /** measure -> order, in days. ~0 for a same-day close. */
  toSell: number | null;
  revenue: number;
};

export type RepCycle = { salesperson: string; dist: Dist; jobs: number };

export type CycleReport = {
  jobs: CycleJob[];
  measureToInstall: Dist | null;
  measureToOrder: Dist | null;
  orderToInstall: Dist | null;
  sameDaySellPct: number;
  /** Orders dated BEFORE their measure — a data oddity, not a fast sale. */
  soldBeforeMeasure: number;
  byRep: RepCycle[];
  byMonth: { month: string; median: number; p90: number; n: number }[];
  bins: Bin[];
  /** Jobs past this many days — the exception list worth working. */
  outliers: CycleJob[];
  /** Timeable jobs whose install is still ahead, so excluded from every stat above. */
  scheduledAhead: number;
};

export const OUTLIER_DAYS = 90;

/** Reps below this job count are shown but never ranked — the median is noise. */
export const MIN_JOBS_FOR_RANK = 10;

const BINS = [0, 7, 14, 21, 28, 35, 42, 60, 90];

function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  // Local dates, midnight to midnight — no timezone can shift the count.
  return Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86400000);
}

export function buildCycleReport(lines: OrderLine[], asOf: string): CycleReport {
  const byCG = new Map<string, OrderLine[]>();
  for (const l of lines) {
    const g = byCG.get(l.invoiceNum);
    if (g) g.push(l);
    else byCG.set(l.invoiceNum, [l]);
  }

  const jobs: CycleJob[] = [];
  const m2o: number[] = [];
  const o2i: number[] = [];
  let scheduledAhead = 0;

  for (const [invoiceNum, ls] of byCG) {
    const head = ls[0];
    if (isCanceled(head.jobType)) continue;

    // Earliest of each: a CG has one measure appointment, and a phased job's
    // wait ends when the first crew shows up.
    const measure = ls.map((l) => l.measureDate).filter((d): d is string => Boolean(d)).sort()[0];
    const order = ls.map((l) => l.orderDate).filter((d): d is string => Boolean(d)).sort()[0];
    const install = ls.map((l) => l.installDate).filter((d): d is string => Boolean(d)).sort()[0];

    // The sale is done whenever the install lands, so this one counts every
    // ordered job — it isn't waiting on anything.
    if (measure && order) m2o.push(dayDiff(measure, order));

    if (!measure || !install) continue;
    // A wait nobody has finished waiting isn't an observation.
    if (install > asOf) {
      scheduledAhead++;
      continue;
    }
    if (order) o2i.push(dayDiff(order, install));

    jobs.push({
      invoiceNum,
      custName: head.custName,
      shipCity: head.shipCity,
      salesperson: head.salesperson,
      measureDate: measure,
      orderDate: order ?? null,
      installDate: install,
      days: dayDiff(measure, install),
      toSell: order ? dayDiff(measure, order) : null,
      revenue: ls.reduce((a, l) => a + l.lineTotal, 0),
    });
  }

  jobs.sort((a, b) => b.days - a.days);
  const all = jobs.map((j) => j.days);

  // By rep.
  const repMap = new Map<string, number[]>();
  for (const j of jobs) {
    const k = j.salesperson || "(unassigned)";
    const a = repMap.get(k);
    if (a) a.push(j.days);
    else repMap.set(k, [j.days]);
  }
  const byRep: RepCycle[] = [];
  for (const [salesperson, ds] of repMap) {
    const dist = distribution(ds);
    if (dist) byRep.push({ salesperson, dist, jobs: ds.length });
  }
  // Ranked reps first, fastest to slowest; everyone too thin to rank drops to
  // the bottom. Sorting purely by median floats a rep with one 8-day job above
  // someone with 150 jobs, which reads as a league table and isn't one.
  byRep.sort((a, b) => {
    const aThin = a.jobs < MIN_JOBS_FOR_RANK;
    const bThin = b.jobs < MIN_JOBS_FOR_RANK;
    if (aThin !== bThin) return aThin ? 1 : -1;
    if (aThin) return b.jobs - a.jobs;
    return a.dist.median - b.dist.median;
  });

  // By install month — the trend. Keyed on install date: the question is
  // "how long did jobs we finished in June take", not when they were sold.
  const moMap = new Map<string, number[]>();
  for (const j of jobs) {
    const k = j.installDate.slice(0, 7);
    const a = moMap.get(k);
    if (a) a.push(j.days);
    else moMap.set(k, [j.days]);
  }
  const byMonth = [...moMap.entries()]
    .map(([month, ds]) => {
      const d = distribution(ds)!;
      return { month, median: d.median, p90: d.p90, n: d.n };
    })
    .sort((a, b) => a.month.localeCompare(b.month));

  const m2oDist = distribution(m2o);
  return {
    jobs,
    measureToInstall: distribution(all),
    measureToOrder: m2oDist,
    orderToInstall: distribution(o2i),
    // Strictly same-day. A negative gap means the order predates the measure —
    // a re-measure or a back-dated record, not a fast close, so it's reported
    // separately rather than flattered into this number.
    sameDaySellPct: m2o.length ? (100 * m2o.filter((d) => d === 0).length) / m2o.length : 0,
    soldBeforeMeasure: m2o.filter((d) => d < 0).length,
    byRep,
    byMonth,
    bins: histogram(all.filter((d) => d >= 0), BINS),
    outliers: jobs.filter((j) => j.days > OUTLIER_DAYS),
    scheduledAhead,
  };
}
