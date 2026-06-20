"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type { Period } from "@/lib/financials/metrics";
import { aggregatePL, money, percent, ratio } from "@/lib/financials/metrics";
import { analyze, type Finding, type Severity } from "@/lib/financials/analysis";

const SEV_STYLES: Record<Severity, { dot: string; ring: string; chip: string }> = {
  critical: { dot: "bg-red-500", ring: "border-red-200", chip: "bg-red-50 text-red-700" },
  warn: { dot: "bg-amber-500", ring: "border-amber-200", chip: "bg-amber-50 text-amber-700" },
  good: { dot: "bg-brand-500", ring: "border-brand-200", chip: "bg-brand-50 text-brand-700" },
};

type RangeKind = "ytd" | "last" | "custom";

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
        <span className="text-gradient">{value}</span>
      </p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

// A P&L aggregated over [start..end] of the monthly periods, with a balance
// sheet snapshot from the last month in range — shaped like a single Period so
// the existing analyze() engine works unchanged.
function rangePeriod(periods: Period[], start: number, end: number): Period {
  const slice = periods.slice(start, end + 1);
  const pls = slice.map((p) => p.pl).filter((p): p is NonNullable<typeof p> => p != null);
  const lastBs = [...slice].reverse().find((p) => p.bs != null)?.bs ?? null;
  const first = slice[0];
  const last = slice[slice.length - 1];
  const label =
    slice.length <= 1
      ? last?.label ?? ""
      : `${first.label} – ${last.label}`;
  return {
    label,
    periodEnd: last?.periodEnd ?? null,
    pl: aggregatePL(pls),
    bs: lastBs,
  };
}

export function FinancialDashboard({ periods }: { periods: Period[] }) {
  const n = periods.length;
  const lastIdx = n - 1;

  // Year of the most recent period drives the YTD window.
  const latestYear = useMemo(() => {
    const end = periods[lastIdx]?.periodEnd;
    return end ? end.slice(0, 4) : null;
  }, [periods, lastIdx]);

  const ytdStart = useMemo(() => {
    if (latestYear == null) return 0;
    const i = periods.findIndex((p) => (p.periodEnd ?? "").slice(0, 4) === latestYear);
    return i < 0 ? 0 : i;
  }, [periods, latestYear]);

  const [kind, setKind] = useState<RangeKind>("ytd");
  const [fromIdx, setFromIdx] = useState(ytdStart);
  const [toIdx, setToIdx] = useState(lastIdx);

  // Resolve the selected window to [start, end] indices.
  const [start, end] =
    kind === "last"
      ? [lastIdx, lastIdx]
      : kind === "ytd"
        ? [ytdStart, lastIdx]
        : [Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx)];

  const current = useMemo(
    () => rangePeriod(periods, start, end),
    [periods, start, end]
  );

  // A prior window of equal length for trend findings (revenue/GM movement).
  const findings: Finding[] = useMemo(() => {
    const len = end - start + 1;
    const prevEnd = start - 1;
    const prevStart = prevEnd - len + 1;
    const series: Period[] = [];
    if (prevEnd >= 0) series.push(rangePeriod(periods, Math.max(0, prevStart), prevEnd));
    series.push(current);
    return analyze(series);
  }, [periods, start, end, current]);

  const pl = current.pl;
  const bs = current.bs;
  const improvements = findings.filter((f) => f.severity !== "good");
  const strengths = findings.filter((f) => f.severity === "good");

  // The trend chart always shows the full monthly history for context.
  const chartData = periods.map((p) => ({
    label: p.label,
    revenue: p.pl?.revenue ?? null,
    grossMargin: p.pl?.grossMargin ?? null,
    ebitdaMargin: p.pl?.ebitdaMargin ?? null,
  }));
  const hasPlSeries = chartData.some((d) => d.revenue != null);

  const segBtn = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
      active ? "bg-ink text-cream" : "text-muted hover:text-ink"
    }`;
  const selectCls =
    "rounded-md border border-line bg-white px-2.5 py-1.5 text-xs font-medium text-ink focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100";

  return (
    <div className="space-y-8">
      {/* Range selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">
            Showing
          </p>
          <p className="text-sm font-bold text-ink">{current.label || "—"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-line bg-white p-1 ring-soft">
            <button onClick={() => setKind("ytd")} className={segBtn(kind === "ytd")}>
              YTD
            </button>
            <button onClick={() => setKind("last")} className={segBtn(kind === "last")}>
              Last month
            </button>
            <button onClick={() => setKind("custom")} className={segBtn(kind === "custom")}>
              Custom
            </button>
          </div>
          {kind === "custom" && (
            <div className="flex items-center gap-2">
              <select
                value={fromIdx}
                onChange={(e) => setFromIdx(Number(e.target.value))}
                className={selectCls}
                aria-label="From month"
              >
                {periods.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted-soft">to</span>
              <select
                value={toIdx}
                onChange={(e) => setToIdx(Number(e.target.value))}
                className={selectCls}
                aria-label="To month"
              >
                {periods.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pl && (
          <>
            <Kpi label="Revenue" value={money(pl.revenue)} sub={current.label} />
            <Kpi label="Gross Margin" value={percent(pl.grossMargin)} sub={`Gross profit ${money(pl.grossProfit)}`} />
            <Kpi label="EBITDA Margin" value={percent(pl.ebitdaMargin)} sub={`EBITDA ${money(pl.ebitda)}`} />
          </>
        )}
        {bs && (
          <>
            <Kpi label="Current Ratio" value={ratio(bs.currentRatio)} sub={`Working capital ${money(bs.workingCapital)}`} />
            <Kpi label="Cash" value={money(bs.cash)} sub={`Quick ratio ${ratio(bs.quickRatio)}`} />
            <Kpi label="Equity" value={money(bs.equity)} sub={`Debt/Equity ${ratio(bs.debtToEquity)}`} />
          </>
        )}
      </div>

      {/* Trend chart */}
      {hasPlSeries && (
        <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h3 className="text-base font-bold text-ink">Revenue &amp; margin trend</h3>
          <div className="mt-4 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e7e0d3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#5a606b" }} tickLine={false} axisLine={{ stroke: "#e7e0d3" }} />
                <YAxis yAxisId="rev" tick={{ fontSize: 12, fill: "#5a606b" }} tickLine={false} axisLine={false} tickFormatter={(v) => money(v)} width={60} />
                <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 12, fill: "#5a606b" }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={44} />
                <Tooltip
                  formatter={(value: unknown, name: unknown) =>
                    name === "Revenue"
                      ? money(Number(value))
                      : percent(Number(value))
                  }
                  contentStyle={{ borderRadius: 6, border: "1px solid #e7e0d3", fontSize: 13 }}
                />
                <Bar yAxisId="rev" dataKey="revenue" name="Revenue" fill="#16335b" radius={[4, 4, 0, 0]} maxBarSize={56} />
                <Line yAxisId="pct" dataKey="grossMargin" name="Gross Margin" stroke="#9e2335" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                <Line yAxisId="pct" dataKey="ebitdaMargin" name="EBITDA Margin" stroke="#9a958c" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Top areas for improvement */}
      <div>
        <h3 className="text-lg font-bold tracking-tight text-ink">
          Top areas for improvement
        </h3>
        {improvements.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-brand-200 bg-brand-50/50 p-5 text-sm text-ink/80">
            Nothing flagged against our benchmarks for {current.label || "this range"} —
            the numbers look healthy. Keep the cadence and protect what&apos;s working.
          </p>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {improvements.map((f) => {
              const s = SEV_STYLES[f.severity];
              return (
                <div key={f.id} className={`rounded-2xl border bg-white p-5 ring-soft ${s.ring}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${s.dot}`} />
                      <h4 className="text-sm font-bold text-ink">{f.title}</h4>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${s.chip}`}>
                      {f.lever}
                    </span>
                  </div>
                  <div className="mt-3 flex gap-6 text-sm">
                    <div>
                      <p className="text-xs text-muted-soft">Current</p>
                      <p className="font-bold text-ink">{f.current}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-soft">Target</p>
                      <p className="font-bold text-ink">{f.target}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-muted">{f.body}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Strengths */}
      {strengths.length > 0 && (
        <div>
          <h3 className="text-base font-bold tracking-tight text-ink">What&apos;s working</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {strengths.map((f) => (
              <div key={f.id} className="rounded-xl border border-brand-100 bg-brand-50/40 p-4">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-brand-500" />
                  <p className="text-sm font-semibold text-ink">{f.title}</p>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {f.current} <span className="text-muted-soft">vs {f.target}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
