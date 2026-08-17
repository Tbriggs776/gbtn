"use client";

import { useMemo, useState } from "react";
import { ResponsiveContainer, LineChart, Line, YAxis } from "recharts";
import type { FpaReport, FpaLine, FpaKpi } from "@/lib/financials/fpa";
import { money, percent } from "@/lib/financials/metrics";

const NAVY = "#16335b";
const MUTED = "#9a958c";

// "Jan 2026" -> "Jan". Column heads are tight; the year rides in the caption.
const short = (label: string) => label.split(" ")[0];

function Spark({ data, color = NAVY }: { data: (number | null)[]; color?: string }) {
  const rows = data.map((v, i) => ({ i, v }));
  const nums = data.filter((v): v is number => v != null);
  if (nums.length < 2) return <div className="h-7" />;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return (
    <div className="h-7 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 3, bottom: 3, left: 0, right: 0 }}>
          <YAxis hide domain={[min, max]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function KpiCard({ kpi, series, tone }: { kpi: string; series: (number | null)[]; tone: "value" | "growth" }) {
  const latest = [...series].reverse().find((v) => v != null) ?? null;
  const color = tone === "growth" && latest != null && latest < 0 ? "#b3313f" : NAVY;
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">{kpi}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-2xl font-bold tracking-tight" style={{ color }}>
          {latest == null ? "—" : `${latest > 0 && tone === "growth" ? "+" : ""}${percent(latest)}`}
        </p>
        <Spark data={series} color={color} />
      </div>
    </div>
  );
}

// One % (or $) matrix: SG&A or COGS by month, largest lines first, current
// month emphasized, a per-row trend, and a Total row that ties to the P&L.
function RatioTable({
  title,
  caption,
  lines,
  months,
  revenue,
  mode,
  totalLabel,
}: {
  title: string;
  caption: string;
  lines: FpaLine[];
  months: string[];
  revenue: number[];
  mode: "pct" | "dollars";
  totalLabel: string;
}) {
  const lastIdx = months.length - 1;
  const cell = (line: FpaLine, i: number) =>
    mode === "pct" ? percent(line.pctByMonth[i]) : money(line.byMonth[i]);

  // Column totals (the P&L subtotal for this group) + its % of revenue.
  const colTotal = months.map((_, i) => lines.reduce((t, l) => t + l.byMonth[i], 0));
  const grand = colTotal.reduce((t, v) => t + v, 0);
  const totalRev = revenue.reduce((t, v) => t + v, 0);
  const totalCell = (i: number) =>
    mode === "pct"
      ? percent(revenue[i] ? (colTotal[i] / revenue[i]) * 100 : null)
      : money(colTotal[i]);

  return (
    <section className="rounded-2xl border border-line bg-white ring-soft">
      <div className="flex items-baseline justify-between px-5 pt-5">
        <h3 className="text-sm font-bold text-ink">{title}</h3>
        <p className="text-xs text-muted-soft">{caption}</p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-muted-soft">
              <th className="px-5 py-2 text-left font-semibold">Line</th>
              {months.map((m, i) => (
                <th
                  key={m}
                  className={`px-3 py-2 text-right font-semibold ${i === lastIdx ? "text-ink" : ""}`}
                >
                  {short(m)}
                </th>
              ))}
              <th className="px-3 py-2 text-center font-semibold">Trend</th>
              <th className="px-4 py-2 text-right font-semibold">YTD</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.label} className="border-b border-line/60 hover:bg-paper-soft/50">
                <td className="px-5 py-2 text-left font-medium text-ink">{line.label}</td>
                {months.map((m, i) => (
                  <td
                    key={m}
                    className={`px-3 py-2 text-right tabular-nums ${
                      i === lastIdx ? "font-semibold text-ink" : "text-muted"
                    } ${line.byMonth[i] < 0 ? "text-red-600" : ""}`}
                  >
                    {cell(line, i)}
                  </td>
                ))}
                <td className="px-3 py-1 align-middle">
                  <div className="flex justify-center">
                    <Spark data={mode === "pct" ? line.pctByMonth : line.byMonth} />
                  </div>
                </td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-ink">
                  {mode === "pct" ? percent(line.totalPct) : money(line.total)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line font-semibold text-ink">
              <td className="px-5 py-2.5 text-left">{totalLabel}</td>
              {months.map((m, i) => (
                <td
                  key={m}
                  className={`px-3 py-2.5 text-right tabular-nums ${i === lastIdx ? "text-ink" : "text-muted"}`}
                >
                  {totalCell(i)}
                </td>
              ))}
              <td />
              <td className="px-4 py-2.5 text-right tabular-nums">
                {mode === "pct" ? percent(totalRev ? (grand / totalRev) * 100 : null) : money(grand)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export function FpaDashboard({ report }: { report: FpaReport }) {
  const [mode, setMode] = useState<"pct" | "dollars">("pct");

  const monthLabels = report.months.map((m) => m.label);
  const revenue = report.months.map((m) => m.revenue);
  const kpis = report.kpis;

  const series = useMemo(
    () => ({
      gm: kpis.map((k: FpaKpi) => k.grossMargin),
      ebitda: kpis.map((k: FpaKpi) => k.ebitdaMargin),
      opex: kpis.map((k: FpaKpi) => k.opexRatio),
      growth: kpis.map((k: FpaKpi) => k.revenueGrowth),
    }),
    [kpis]
  );

  const first = report.months[0]?.label;
  const last = report.latest;
  const window = first && last ? (first === last ? first : `${first} – ${last}`) : "";

  // Top movers worth a callout: material dollar swings only.
  const movers = report.movers.filter((m) => Math.abs(m.deltaDollars) >= 1000).slice(0, 8);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">Window</p>
          <p className="text-lg font-bold text-ink">{window}</p>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-white p-0.5 text-xs font-semibold ring-soft">
          {(["pct", "dollars"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                mode === m ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              {m === "pct" ? "% of revenue" : "Dollars"}
            </button>
          ))}
        </div>
      </div>

      {/* Trend KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard kpi="Gross Margin" series={series.gm} tone="value" />
        <KpiCard kpi="EBITDA Margin" series={series.ebitda} tone="value" />
        <KpiCard kpi="Opex % of Revenue" series={series.opex} tone="value" />
        <KpiCard kpi="Revenue Growth MoM" series={series.growth} tone="growth" />
      </div>

      {/* SG&A */}
      <RatioTable
        title="SG&A — overhead by line"
        caption={mode === "pct" ? "% of revenue, by month" : "dollars, by month"}
        lines={report.sga}
        months={monthLabels}
        revenue={revenue}
        mode={mode}
        totalLabel="Total operating expenses"
      />

      {/* COGS */}
      <RatioTable
        title="Cost of goods — by line"
        caption={mode === "pct" ? "% of revenue, by month" : "dollars, by month"}
        lines={report.cogs}
        months={monthLabels}
        revenue={revenue}
        mode={mode}
        totalLabel="Total COGS"
      />

      {/* MoM variance */}
      {movers.length > 0 && report.prior ? (
        <section className="rounded-2xl border border-line bg-white ring-soft">
          <div className="flex items-baseline justify-between px-5 pt-5">
            <h3 className="text-sm font-bold text-ink">
              What moved — {report.latest} vs {report.prior}
            </h3>
            <p className="text-xs text-muted-soft">biggest dollar swings; bps = change in % of revenue</p>
          </div>
          <ul className="mt-3 divide-y divide-line/60">
            {movers.map((m) => {
              // These are expenses: more spend is unfavorable (red), less is green.
              const worse = m.deltaDollars > 0;
              return (
                <li key={`${m.group}:${m.label}`} className="flex items-center gap-4 px-5 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      m.group === "SG&A" ? "bg-brand-50 text-brand-700" : "bg-stone-100 text-stone-600"
                    }`}
                  >
                    {m.group}
                  </span>
                  <span className="flex-1 truncate text-sm font-medium text-ink">{m.label}</span>
                  <span className="hidden w-40 text-right text-xs text-muted sm:block">
                    {percent(m.prevPct)} → <span className="font-semibold text-ink">{percent(m.currPct)}</span>
                  </span>
                  <span className={`w-24 text-right text-sm font-semibold tabular-nums ${worse ? "text-red-600" : "text-brand-700"}`}>
                    {worse ? "+" : "−"}
                    {money(Math.abs(m.deltaDollars))}
                  </span>
                  <span className={`w-20 text-right text-xs tabular-nums ${worse ? "text-red-600" : "text-brand-700"}`}>
                    {m.deltaBps == null
                      ? "—"
                      : `${m.deltaBps > 0 ? "+" : "−"}${Math.abs(Math.round(m.deltaBps))} bps`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <p className="max-w-[70ch] text-[11.5px] leading-relaxed text-muted-soft">
        Percentages are each line divided by that month&apos;s net revenue. A negative value is a credit
        (a refund or reversal), shown in red. Totals tie to the P&L: SG&A to Total Operating Expenses,
        COGS to Total COGS. Basis points measure the change in a line&apos;s share of revenue — 100 bps
        is one point.
      </p>
    </div>
  );
}
