"use client";

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
import { money, percent, ratio } from "@/lib/financials/metrics";
import type { Finding, Severity } from "@/lib/financials/analysis";

const SEV_STYLES: Record<Severity, { dot: string; ring: string; chip: string }> = {
  critical: { dot: "bg-red-500", ring: "border-red-200", chip: "bg-red-50 text-red-700" },
  warn: { dot: "bg-amber-500", ring: "border-amber-200", chip: "bg-amber-50 text-amber-700" },
  good: { dot: "bg-brand-500", ring: "border-brand-200", chip: "bg-brand-50 text-brand-700" },
};

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
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

export function FinancialDashboard({
  periods,
  findings,
}: {
  periods: Period[];
  findings: Finding[];
}) {
  const latest = periods[periods.length - 1];
  const pl = latest?.pl;
  const bs = latest?.bs;

  const improvements = findings.filter((f) => f.severity !== "good");
  const strengths = findings.filter((f) => f.severity === "good");

  const chartData = periods.map((p) => ({
    label: p.label,
    revenue: p.pl?.revenue ?? null,
    grossMargin: p.pl?.grossMargin ?? null,
    ebitdaMargin: p.pl?.ebitdaMargin ?? null,
  }));
  const hasPlSeries = chartData.some((d) => d.revenue != null);

  return (
    <div className="space-y-8">
      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pl && (
          <>
            <Kpi label="Revenue" value={money(pl.revenue)} sub={`Latest: ${latest.label}`} />
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
                <CartesianGrid stroke="#e4e9f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#5b6573" }} tickLine={false} axisLine={{ stroke: "#e4e9f0" }} />
                <YAxis yAxisId="rev" tick={{ fontSize: 12, fill: "#5b6573" }} tickLine={false} axisLine={false} tickFormatter={(v) => money(v)} width={60} />
                <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 12, fill: "#5b6573" }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={44} />
                <Tooltip
                  formatter={(value: unknown, name: unknown) =>
                    name === "Revenue"
                      ? money(Number(value))
                      : percent(Number(value))
                  }
                  contentStyle={{ borderRadius: 12, border: "1px solid #e4e9f0", fontSize: 13 }}
                />
                <Bar yAxisId="rev" dataKey="revenue" name="Revenue" fill="#10b981" radius={[6, 6, 0, 0]} maxBarSize={56} />
                <Line yAxisId="pct" dataKey="grossMargin" name="Gross Margin" stroke="#0a0f1c" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                <Line yAxisId="pct" dataKey="ebitdaMargin" name="EBITDA Margin" stroke="#06b6d4" strokeWidth={2} dot={{ r: 3 }} connectNulls />
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
            Nothing flagged against our benchmarks — the numbers look healthy. Keep
            the cadence and protect what&apos;s working.
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
