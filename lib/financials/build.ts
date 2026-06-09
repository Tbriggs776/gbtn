import { computePL, computeBS, type Period } from "./metrics";

type RawItem = {
  statement_type: string;
  period_label: string;
  category: string;
  amount: number;
};

// Groups confirmed line items into sorted reporting periods with computed metrics.
export function buildPeriods(
  items: RawItem[],
  periodEndByLabel: Record<string, string | null>
): Period[] {
  const labels = Array.from(new Set(items.map((i) => i.period_label)));

  const periods: Period[] = labels.map((label) => {
    const pl = items.filter(
      (i) => i.period_label === label && i.statement_type === "pl"
    );
    const bs = items.filter(
      (i) => i.period_label === label && i.statement_type === "bs"
    );
    return {
      label,
      periodEnd: periodEndByLabel[label] ?? null,
      pl: pl.length ? computePL(pl) : null,
      bs: bs.length ? computeBS(bs) : null,
    };
  });

  periods.sort((a, b) => {
    const ae = a.periodEnd ?? a.label;
    const be = b.periodEnd ?? b.label;
    return ae < be ? -1 : ae > be ? 1 : 0;
  });
  return periods;
}
