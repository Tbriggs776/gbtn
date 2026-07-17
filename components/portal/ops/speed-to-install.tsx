"use client";

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CycleJob, CycleReport } from "@/lib/ops/cycle";
import { MIN_JOBS_FOR_RANK, OUTLIER_DAYS } from "@/lib/ops/cycle";
import type { CSVValue } from "@/lib/ops/csv";
import { downloadCSV } from "@/lib/ops/csv";
import { fmtDate, fmtMonth, money } from "@/lib/ops/format";
import { ExportButton, Tile } from "./shared";
import { DrilldownDrawer, type DrillColumn, type DrillView } from "./drilldown";

const NAVY = "#11294a";
const AMBER = "#b3761e";
const CRIMSON = "#9e2335";

const dateFmt = (v: CSVValue) => fmtDate(typeof v === "string" ? v : null);
const moneyFmt = (v: CSVValue) => (typeof v === "number" && v ? money(v) : "—");

const JOB_COLS: DrillColumn[] = [
  { key: "invoiceNum", label: "CG" },
  { key: "custName", label: "Customer" },
  { key: "shipCity", label: "City" },
  { key: "salesperson", label: "Rep" },
  { key: "measureDate", label: "Measured", format: dateFmt },
  { key: "orderDate", label: "Ordered", format: dateFmt },
  { key: "installDate", label: "Installed", format: dateFmt },
  { key: "days", label: "Days", align: "right" },
  { key: "value", label: "Value", align: "right", format: moneyFmt },
];

const jobRows = (list: CycleJob[]) =>
  list.map((j) => ({
    invoiceNum: j.invoiceNum,
    custName: j.custName,
    shipCity: j.shipCity,
    salesperson: j.salesperson,
    measureDate: j.measureDate,
    orderDate: j.orderDate,
    installDate: j.installDate,
    days: j.days,
    value: Math.round(j.revenue * 100) / 100,
  }));

export function SpeedToInstall({ report, asOf }: { report: CycleReport; asOf: string }) {
  const m2i = report.measureToInstall;

  // Every clickable number opens this with the jobs behind it. The jobs are
  // already in the browser (the report is CG-level), so slices are instant.
  const [drill, setDrill] = useState<DrillView | null>(null);
  const openJobs = (title: string, subtitle: string, slug: string, list: CycleJob[]) =>
    setDrill({
      title,
      subtitle,
      filename: `speed-to-install-${slug}-as-of-${asOf}.csv`,
      columns: JOB_COLS,
      rows: jobRows(list),
    });

  if (!m2i) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-white py-14 text-center text-sm text-muted">
        No job has both a measure date and an install date yet.
      </p>
    );
  }

  const companyMedian = m2i.median;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          label="Median wait"
          value={`${m2i.median}d`}
          sub={`measure → install · ${m2i.n} completed jobs${
            report.scheduledAhead ? ` · ${report.scheduledAhead} still scheduled` : ""
          }`}
          onClick={() =>
            openJobs("All timed jobs", "Every completed job with a measure and an install date.", "all-jobs", report.jobs)
          }
          clickTitle="See (and export) every timed job"
        />
        <Tile
          label="Slowest 10%"
          value={`${m2i.p90}d`}
          sub="p90 — the tail customers remember"
          onClick={() =>
            openJobs(
              "Slowest 10%",
              `Jobs that waited ${m2i.p90} days or more, measure → install.`,
              "slowest-10pct",
              report.jobs.filter((j) => j.days >= m2i.p90)
            )
          }
        />
        <Tile
          label="Sold same day"
          value={`${Math.round(report.sameDaySellPct)}%`}
          sub={
            report.soldBeforeMeasure
              ? `measure → order is 0 days · ${report.soldBeforeMeasure} ordered before measuring`
              : "measure → order is 0 days"
          }
        />
        <Tile
          label={`Over ${OUTLIER_DAYS} days`}
          value={report.outliers.length}
          sub={report.outliers.length ? "jobs — the exception list" : "none"}
          flag={report.outliers.length > 0}
          onClick={
            report.outliers.length
              ? () =>
                  openJobs(
                    `Waited over ${OUTLIER_DAYS} days`,
                    "The exception list, longest first.",
                    "outliers",
                    report.outliers
                  )
              : undefined
          }
        />
        <Tile
          label="Longest"
          value={`${m2i.max}d`}
          sub={report.jobs[0]?.invoiceNum ?? "—"}
          flag
          onClick={
            report.jobs.length
              ? () =>
                  openJobs(
                    "Longest wait",
                    `${report.jobs[0].invoiceNum} — ${m2i.max} days, measure → install.`,
                    "longest",
                    report.jobs.slice(0, 1)
                  )
              : undefined
          }
          clickTitle="See this job"
        />
      </div>

      <div className="rounded-lg border border-line bg-white p-4">
        <p className="text-[13px] leading-relaxed text-muted">
          <span className="font-semibold text-ink">The sale isn&apos;t where the time goes.</span>{" "}
          {Math.round(report.sameDaySellPct)}% of jobs are sold the same day as the measure
          {report.measureToOrder ? ` (median ${report.measureToOrder.median} days)` : ""}, so nearly all of
          the <span className="font-semibold text-ink">{m2i.median}-day</span> median wait is fulfilment —
          ordering material, receiving it, and getting a crew on site. Cutting the wait means cutting{" "}
          {report.orderToInstall ? `the ${report.orderToInstall.median}-day order → install leg` : "fulfilment"}
          , not the sales process.
        </p>
      </div>

      {/* Distribution */}
      <div className="rounded-lg border border-line bg-white p-4">
        <h3 className="font-label text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          How long customers wait
        </h3>
        <div className="mt-3 h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={report.bins}
              margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
              style={{ cursor: "pointer" }}
              onClick={(st) => {
                // recharts 3 chart clicks carry activeTooltipIndex (a string),
                // not activePayload — resolve through the bins array.
                const raw = (st as { activeTooltipIndex?: number | string | null })?.activeTooltipIndex;
                const idx = raw === null || raw === undefined ? NaN : Number(raw);
                const b = Number.isInteger(idx) ? report.bins[idx] : undefined;
                if (!b || b.count === 0) return; // an empty band has nothing to show
                const hi = Number.isFinite(b.hi) ? b.hi : Infinity;
                openJobs(
                  `Waited ${b.label} days`,
                  "Jobs in this band, measure → install.",
                  `band-${b.label.replace(/[^0-9a-z+]+/gi, "-")}`,
                  report.jobs.filter((j) => j.days >= b.lo && j.days < hi)
                );
              }}
            >
              <CartesianGrid stroke="#e7e0d3" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#5a606b" }} stroke="#e7e0d3" />
              <YAxis tick={{ fontSize: 10, fill: "#5a606b" }} stroke="#e7e0d3" width={34} />
              <Tooltip
                cursor={{ fill: "#fbf8f2" }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <div className="rounded-md border border-line bg-white px-3 py-2 text-xs shadow-lg">
                      <p className="font-semibold text-ink">{payload[0].payload.label} days</p>
                      <p className="text-muted">
                        <span className="font-semibold tabular-nums text-ink">{payload[0].value}</span> jobs
                      </p>
                    </div>
                  ) : null
                }
              />
              <ReferenceLine
                x={report.bins.find((b) => companyMedian >= b.lo && companyMedian < b.hi)?.label}
                stroke={CRIMSON}
                strokeDasharray="3 3"
                label={{ value: `median ${companyMedian}d`, position: "top", fontSize: 9, fill: CRIMSON }}
              />
              <Bar dataKey="count" fill={NAVY} radius={[2, 2, 0, 0]} maxBarSize={54} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-[11px] text-muted-soft">
          Days from the measure appointment to the first install date, one bar per band.
        </p>
      </div>

      {/* Trend */}
      <div className="rounded-lg border border-line bg-white p-4">
        <h3 className="font-label text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Is it getting faster?
        </h3>
        <div className="mt-3 h-[240px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={report.byMonth}
              margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
              style={{ cursor: "pointer" }}
              onClick={(st) => {
                const mo = (st as { activeLabel?: string })?.activeLabel;
                if (!mo) return;
                openJobs(
                  `Installed ${fmtMonth(`${mo}-01`)}`,
                  "Jobs whose first install landed in this month.",
                  `month-${mo}`,
                  report.jobs.filter((j) => j.installDate.slice(0, 7) === mo)
                );
              }}
            >
              <CartesianGrid stroke="#e7e0d3" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={(m: string) => fmtMonth(`${m}-01`)}
                tick={{ fontSize: 10, fill: "#5a606b" }}
                stroke="#e7e0d3"
                minTickGap={12}
              />
              {/* Days and job counts are different units — they cannot share a
                  scale, or a 140-job month renders as a 140-day bar. */}
              <YAxis
                yAxisId="days"
                tick={{ fontSize: 10, fill: "#5a606b" }}
                stroke="#e7e0d3"
                width={34}
                tickFormatter={(v: number) => `${v}d`}
              />
              <YAxis
                yAxisId="count"
                orientation="right"
                tick={{ fontSize: 9, fill: "#9a958c" }}
                stroke="#e7e0d3"
                width={28}
              />
              <Tooltip
                cursor={{ fill: "#fbf8f2" }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <div className="rounded-md border border-line bg-white px-3 py-2 text-xs shadow-lg">
                      <p className="font-semibold text-ink">{fmtMonth(`${payload[0].payload.month}-01`)}</p>
                      <p className="mt-1 flex gap-3 text-muted">
                        median
                        <span className="ml-auto font-semibold tabular-nums text-ink">
                          {payload[0].payload.median}d
                        </span>
                      </p>
                      <p className="flex gap-3 text-muted">
                        slowest 10%
                        <span className="ml-auto font-semibold tabular-nums" style={{ color: AMBER }}>
                          {payload[0].payload.p90}d
                        </span>
                      </p>
                      <p className="mt-1 border-t border-line pt-1 text-[10px] text-muted-soft">
                        {payload[0].payload.n} jobs
                      </p>
                    </div>
                  ) : null
                }
              />
              <ReferenceLine
                yAxisId="days"
                y={companyMedian}
                stroke={CRIMSON}
                strokeDasharray="4 4"
                strokeOpacity={0.5}
              />
              <Bar yAxisId="count" dataKey="n" fill="#e7e0d3" radius={[2, 2, 0, 0]} maxBarSize={22} />
              <Line
                yAxisId="days"
                type="monotone"
                dataKey="median"
                stroke={NAVY}
                strokeWidth={2}
                dot={{ r: 2.5 }}
              />
              <Line
                yAxisId="days"
                type="monotone"
                dataKey="p90"
                stroke={AMBER}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-[11px] text-muted-soft">
          By install month, completed jobs only. Navy is the median wait, amber the slowest 10% (both on
          the left axis, in days); grey bars are the job count on the right axis — thin months swing hard
          on few jobs. Dashed red is the all-time median of {companyMedian}d.
        </p>
      </div>

      {/* By rep */}
      <div>
        <h3 className="font-label mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          By salesperson
          <span className="ml-auto">
            <ExportButton
              onClick={() =>
                downloadCSV(
                  `speed-to-install-by-rep-as-of-${asOf}.csv`,
                  ["Salesperson", "Jobs", "Median days", "p90 days", "Longest days", "vs company days"],
                  report.byRep.map((r) => [
                    r.salesperson,
                    r.jobs,
                    r.dist.median,
                    r.dist.p90,
                    r.dist.max,
                    r.jobs < MIN_JOBS_FOR_RANK ? "" : r.dist.median - companyMedian,
                  ])
                )
              }
            />
          </span>
        </h3>
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr className="bg-paper-soft">
                {["Salesperson", "Jobs", "Median", "Slowest 10%", "Longest", "vs company"].map((h, i) => (
                  <th
                    key={h}
                    className={`font-label px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted ${
                      i === 0 ? "text-left" : "text-right"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.byRep.map((r) => {
                const thin = r.jobs < MIN_JOBS_FOR_RANK;
                const delta = r.dist.median - companyMedian;
                return (
                  <tr
                    key={r.salesperson}
                    onClick={() =>
                      openJobs(
                        r.salesperson,
                        `${r.jobs} timed job${r.jobs === 1 ? "" : "s"}, median ${r.dist.median}d.`,
                        `rep-${r.salesperson.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                        report.jobs.filter((j) => (j.salesperson || "(unassigned)") === r.salesperson)
                      )
                    }
                    title="See this rep's jobs"
                    className="cursor-pointer border-b border-line/50 last:border-0 hover:bg-paper-soft"
                  >
                    <td className="px-3 py-1.5 text-xs text-ink">
                      {r.salesperson}
                      {thin ? (
                        <span
                          title={`Only ${r.jobs} jobs — too few to rank.`}
                          className="font-label ml-1.5 rounded-sm border border-line px-1 text-[9px] uppercase text-muted-soft"
                        >
                          thin
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted-soft">{r.jobs}</td>
                    <td className="px-3 py-1.5 text-right text-xs font-semibold tabular-nums text-ink">
                      {r.dist.median}d
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted">{r.dist.p90}d</td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted-soft">
                      {r.dist.max}d
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums">
                      {thin ? (
                        <span className="text-line">·</span>
                      ) : (
                        <span
                          className="font-medium"
                          style={{ color: delta > 5 ? CRIMSON : delta < -2 ? "#2f7d57" : "#5a606b" }}
                        >
                          {delta > 0 ? "+" : ""}
                          {delta}d
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-soft">
          Ranked by median. Reps under {MIN_JOBS_FOR_RANK} jobs are marked{" "}
          <span className="font-medium text-ink">thin</span> and not compared — a median off three jobs
          isn&apos;t a signal.
        </p>
      </div>

      {/* Outliers */}
      {report.outliers.length > 0 ? (
        <div>
          <h3 className="font-label mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
            Waited over {OUTLIER_DAYS} days
            <span className="rounded-sm border border-crimson px-1 text-[9px] text-crimson">
              {report.outliers.length}
            </span>
            <span className="ml-auto">
              <ExportButton
                onClick={() =>
                  downloadCSV(
                    `speed-to-install-outliers-as-of-${asOf}.csv`,
                    JOB_COLS.map((c) => c.label),
                    jobRows(report.outliers).map((r) => JOB_COLS.map((c) => r[c.key as keyof typeof r]))
                  )
                }
              />
            </span>
          </h3>
          <div className="overflow-x-auto rounded-lg border border-line bg-white">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="bg-paper-soft">
                  {["CG", "Customer", "City", "Rep", "Measured", "Installed", "Waited", "Value"].map((h, i) => (
                    <th
                      key={h}
                      className={`font-label px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted ${
                        i > 5 ? "text-right" : "text-left"
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.outliers.slice(0, 40).map((j) => (
                  <tr key={j.invoiceNum} className="border-b border-line/50 last:border-0 hover:bg-paper-soft">
                    <td className="px-3 py-1.5 text-xs font-semibold tabular-nums text-ink">{j.invoiceNum}</td>
                    <td className="max-w-[190px] truncate px-3 py-1.5 text-xs text-ink" title={j.custName}>
                      {j.custName}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted">{j.shipCity || "—"}</td>
                    <td className="px-3 py-1.5 text-xs text-muted">{j.salesperson || "—"}</td>
                    <td className="px-3 py-1.5 text-xs tabular-nums text-muted">{fmtDate(j.measureDate)}</td>
                    <td className="px-3 py-1.5 text-xs tabular-nums text-muted">{fmtDate(j.installDate)}</td>
                    <td className="px-3 py-1.5 text-right text-xs font-semibold tabular-nums text-crimson">
                      {j.days}d
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted">
                      {j.revenue ? money(j.revenue) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.outliers.length > 40 ? (
            <p className="mt-1.5 text-[11px] text-muted-soft">
              Showing the 40 longest of {report.outliers.length} — the drawer and CSV carry all of them.
            </p>
          ) : null}
        </div>
      ) : null}

      <DrilldownDrawer view={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
