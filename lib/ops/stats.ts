/**
 * Small distribution helpers. Medians and percentiles rather than averages
 * throughout the Ops reports: cycle times have a long right tail (one 447-day
 * job), and a mean quietly reports a number no customer ever experienced.
 */

export type Dist = {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  avg: number;
};

/** Nearest-rank percentile on an already-sorted ascending array. */
function at(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

export function distribution(values: number[]): Dist | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p25: at(s, 0.25),
    median: at(s, 0.5),
    p75: at(s, 0.75),
    p90: at(s, 0.9),
    max: s[s.length - 1],
    avg: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

export function median(values: number[]): number {
  return distribution(values)?.median ?? 0;
}

/** Buckets for a histogram, with the tail collapsed into a final "n+" bin. */
export type Bin = { label: string; lo: number; hi: number; count: number };

export function histogram(values: number[], edges: number[]): Bin[] {
  const bins: Bin[] = [];
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i];
    const hi = edges[i + 1] ?? Infinity;
    bins.push({
      label: hi === Infinity ? `${lo}+` : i === 0 ? `${lo}–${hi - 1}` : `${lo}–${hi - 1}`,
      lo,
      hi,
      count: 0,
    });
  }
  for (const v of values) {
    for (let i = bins.length - 1; i >= 0; i--) {
      if (v >= bins[i].lo) {
        bins[i].count++;
        break;
      }
    }
  }
  return bins;
}
