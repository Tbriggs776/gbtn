"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Bucket, DateWindow, Grain, LineMix } from "@/lib/ops/pipeline";
import { periodEnd } from "@/lib/ops/pipeline";
import type { DrillKind, LineScope } from "@/lib/ops/drill";
import type { CSVValue } from "@/lib/ops/csv";
import { downloadCSV } from "@/lib/ops/csv";
import { fmtDate, fmtMonth, money } from "@/lib/ops/format";
import { ExportButton, Tile } from "./shared";
import { DrilldownDrawer, type DrillColumn, type DrillDataRow, type DrillView } from "./drilldown";

type Measure = "lines" | "cgs" | "revenue";

// Kinds this page can drill into: the period cells plus the two schedule tiles.
type PeriodKind = "ordered-period" | "installing-period" | "no-po-period";

const dateFmt = (v: CSVValue) => fmtDate(typeof v === "string" ? v : null);
const moneyFmt = (v: CSVValue) => (typeof v === "number" ? money(v) : "—");

const BASE_COLS: DrillColumn[] = [
  { key: "invoiceNum", label: "CG" },
  { key: "custName", label: "Customer" },
  { key: "shipCity", label: "City" },
  { key: "salesperson", label: "Rep" },
];
const TAIL_COLS: DrillColumn[] = [
  { key: "lines", label: "Lines", align: "right" },
  { key: "value", label: "Value", align: "right", format: moneyFmt },
];
const ORDERED_COLS: DrillColumn[] = [
  ...BASE_COLS,
  { key: "firstDate", label: "Ordered", format: dateFmt },
  ...TAIL_COLS,
];
const INSTALL_COLS: DrillColumn[] = [
  ...BASE_COLS,
  { key: "orderDate", label: "Ordered", format: dateFmt },
  { key: "firstDate", label: "First install", format: dateFmt },
  { key: "lastDate", label: "Last install", format: dateFmt },
  ...TAIL_COLS,
];

const ORDERED = "#11294a";  // navy — demand coming in
const INSTALL = "#b3761e";  // amber — load going out
const RISK = "#b3313f";

export function OrdersPipeline({
  buckets,
  asOf,
  scope,
  mix,
  clientId,
  window,
  bounds,
  ahead,
}: {
  /** Pre-bucketed on the server for each grain, so switching is instant. */
  buckets: Record<Grain, Bucket[]>;
  asOf: string;
  scope: LineScope;
  mix: LineMix;
  clientId: string;
  window: DateWindow;
  /** Full data span, so the pickers can't point outside the export. */
  bounds: { min: string; max: string };
  /** Forward schedule from the UNWINDOWED set — a snapshot fact, not a period one. */
  ahead: { lines: number; noPO: number };
}) {
  const [grain, setGrain] = useState<Grain>("week");
  const [measure, setMeasure] = useState<Measure>("lines");

  // ── Drill-down: click a number, get the CGs behind it ─────────────────────
  // The page ships aggregates only, so slices are fetched from
  // /api/ops/drilldown, which rebuilds them with the same filters that made
  // the buckets. `seq` discards stale responses if the user clicks fast.
  const [drill, setDrill] = useState<DrillView | null>(null);
  const seq = useRef(0);
  // A Bar click fires before the chart-level click; this flag lets the bar
  // claim the click (ordered slice) without the chart also opening installing.
  const barClaimed = useRef(false);

  const openDrill = (
    spec: { kind: DrillKind; key?: string },
    title: string,
    subtitle: string,
    columns: DrillColumn[]
  ) => {
    const my = ++seq.current;
    const q = new URLSearchParams({ client: clientId, kind: spec.kind, scope });
    if (spec.key) {
      q.set("grain", grain);
      q.set("key", spec.key);
    }
    // The drawer must reproduce the number that was clicked, so the active
    // window rides along with the request.
    if (window.from) q.set("from", window.from);
    if (window.to) q.set("to", window.to);
    if (window.basis !== "either") q.set("basis", window.basis);
    setDrill({
      title,
      subtitle,
      filename: `${spec.kind}${spec.key ? `-${spec.key}` : ""}-${scope}-as-of-${asOf}.csv`,
      columns,
      rows: "loading",
    });
    fetch(`/api/ops/drilldown?${q.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (seq.current === my) setDrill((v) => (v ? { ...v, rows: d.rows as DrillDataRow[] } : v));
      })
      .catch(() => {
        if (seq.current === my) setDrill((v) => (v ? { ...v, rows: "error" } : v));
      });
  };

  const scopeWord = { all: "All", work: "Work", material: "Material", labor: "Labor" }[scope];

  const openPeriod = (kind: PeriodKind, key: string) => {
    const period = labelFor(key, grain, true);
    if (kind === "ordered-period") {
      openDrill({ kind, key }, `Ordered — ${period}`, `${scopeWord} lines ordered in this period, grouped by CG.`, ORDERED_COLS);
    } else if (kind === "installing-period") {
      openDrill({ kind, key }, `Installing — ${period}`, `${scopeWord} lines installing in this period, grouped by CG.`, INSTALL_COLS);
    } else {
      openDrill({ kind, key }, `No PO — ${period}`, "Material lines still at status None, installing in this period.", INSTALL_COLS);
    }
  };
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  // Line scope and the date window both re-bucket on the server (CG counts
  // aren't additive), so they travel in the URL rather than component state.
  const setParams = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    startTransition(() => router.push(`${pathname}?${p.toString()}`, { scroll: false }));
  };
  const setScope = (v: string) => setParams({ lines: v === "all" ? null : v });

  // Presets are computed from the SNAPSHOT date, not today's clock — the export
  // is a point in time, so "last 90 days" must mean 90 days before the data
  // ends or it silently returns nothing on an older file.
  const preset = (days: number) => {
    const [y, m, d] = asOf.split("-").map(Number);
    const start = new Date(y, m - 1, d - days + 1);
    const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    setParams({ from: iso, to: asOf });
  };
  const presetMonth = (offset: number) => {
    const [y, m] = asOf.split("-").map(Number);
    const s = new Date(y, m - 1 + offset, 1);
    const e = new Date(y, m + offset, 0);
    const f = (dt: Date) =>
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    setParams({ from: f(s), to: f(e) });
  };
  const windowed = Boolean(window.from || window.to);

  const all = buckets[grain];

  /**
   * Three kinds of period, and conflating them is how this chart lies:
   *   • complete  — ended on or before the snapshot. The only honest basis for
   *                 an average.
   *   • partial   — contains the snapshot date. Half-observed: at month grain
   *                 a mid-month export shows ~half the orders, so averaging it
   *                 in understates real capacity by a wide margin.
   *   • ahead     — starts after the snapshot. Install load with no intake yet.
   */
  const { complete, partial } = useMemo(() => {
    const done: Bucket[] = [];
    let part: Bucket | null = null;
    for (const b of all) {
      if (periodEnd(b.key, grain) <= asOf) done.push(b);
      else if (b.key <= asOf) part = b;
    }
    return { complete: done, partial: part };
  }, [all, grain, asOf]);

  const pick = (b: Bucket, which: "ordered" | "installing"): number => {
    if (measure === "lines") return which === "ordered" ? b.ordered : b.installing;
    if (measure === "cgs") return which === "ordered" ? b.orderedCGs : b.installingCGs;
    return which === "ordered" ? b.orderedRevenue : b.installingRevenue;
  };

  const data = useMemo(
    () =>
      all.map((b) => ({
        key: b.key,
        label: labelFor(b.key, grain),
        ordered: pick(b, "ordered"),
        installing: pick(b, "installing"),
        noPO: b.installingNoPO,
        raw: b,
        isFuture: b.key > asOf,
        isPartial: partial !== null && b.key === partial.key,
      })),
    [all, grain, measure, asOf, partial]
  );

  // Averages over complete periods only — the capacity baseline.
  const avgOrdered = complete.length
    ? complete.reduce((a, b) => a + pick(b, "ordered"), 0) / complete.length
    : 0;
  const avgInstalling = complete.length
    ? complete.reduce((a, b) => a + pick(b, "installing"), 0) / complete.length
    : 0;

  const peak = data.reduce((a, d) => (d.installing > a.installing ? d : a), data[0]);

  /**
   * Snapshot-level facts, computed server-side from the UNWINDOWED set at day
   * grain. Two reasons they don't come from `buckets` here:
   *   • grain — deriving them from the selected grain once made the month view
   *     report 66 lines ahead where day reported 195, because the month bucket
   *     holding the snapshot got discarded whole.
   *   • window — the buckets are clipped to the date filter, so a period ending
   *     before the snapshot would report the backlog as zero. The forward
   *     schedule exists regardless of which period you're looking at.
   */
  const backlog = ahead.lines;
  const futureNoPO = ahead.noPO;

  const unit = (n: number) => (measure === "revenue" ? money(n) : Math.round(n).toLocaleString());
  const grainWord = { day: "day", week: "week", month: "month" }[grain];
  // The measure toggle changes what every number on this page counts, so the
  // labels have to say which — a bare "47" invites reading a CG count as lines.
  const measureWord = { lines: "lines", cgs: "CGs", revenue: "value" }[measure];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          label={`Avg ${measureWord} ordered / ${grainWord}`}
          value={unit(avgOrdered)}
          sub={`${complete.length} complete ${grainWord}${complete.length === 1 ? "" : "s"}${
            partial ? ` · this ${grainWord} still open` : ""
          }`}
        />
        <Tile
          label={`Avg ${measureWord} installing / ${grainWord}`}
          value={unit(avgInstalling)}
          sub="the capacity actually consumed"
        />
        <Tile
          label={`Peak install ${grainWord}`}
          value={unit(peak?.installing ?? 0)}
          sub={peak ? `${labelFor(peak.key, grain)} · ${measureWord} installing` : "—"}
          onClick={peak && peak.installing > 0 ? () => openPeriod("installing-period", peak.key) : undefined}
        />
        <Tile
          label="Scheduled ahead"
          value={backlog.toLocaleString()}
          sub={`lines installing after ${fmtDate(asOf)}${windowed ? " · all periods" : ""}`}
          onClick={
            backlog > 0
              ? () =>
                  openDrill(
                    { kind: "scheduled-ahead" },
                    "Scheduled ahead",
                    `${scopeWord} lines installing after ${fmtDate(asOf)}, grouped by CG.`,
                    INSTALL_COLS
                  )
              : undefined
          }
        />
        <Tile
          label="Scheduled w/o a PO"
          value={futureNoPO.toLocaleString()}
          sub={
            futureNoPO
              ? `material lines, status None${windowed ? " · all periods" : ""}`
              : "all scheduled material ordered"
          }
          flag={futureNoPO > 0}
          onClick={
            futureNoPO > 0
              ? () =>
                  openDrill(
                    { kind: "scheduled-no-po" },
                    "Scheduled w/o a PO",
                    `Material lines at status None installing after ${fmtDate(asOf)}.`,
                    INSTALL_COLS
                  )
              : undefined
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
        <Seg
          options={[
            ["day", "Day"],
            ["week", "Week"],
            ["month", "Month"],
          ]}
          value={grain}
          onChange={(v) => setGrain(v as Grain)}
        />
        <Seg
          options={[
            ["lines", "Lines"],
            ["cgs", "CGs"],
            ["revenue", "Revenue"],
          ]}
          value={measure}
          onChange={(v) => setMeasure(v as Measure)}
        />
        <span className="ml-1 flex items-center gap-1.5" style={{ opacity: pending ? 0.5 : 1 }}>
          <span className="font-label text-[10px] uppercase tracking-[0.1em] text-muted-soft">Counting</span>
          <Seg
            options={[
              ["all", `All ${mix.total.toLocaleString()}`],
              ["work", `Work ${(mix.material + mix.labor).toLocaleString()}`],
              ["material", `Material ${mix.material.toLocaleString()}`],
              ["labor", `Labor ${mix.labor.toLocaleString()}`],
            ]}
            value={scope}
            onChange={setScope}
          />
        </span>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-muted">
          <Key color={ORDERED} label="Ordered (demand in)" />
          <Key color={INSTALL} label="Installing (load out)" />
        </div>
      </div>

      {/* Date window */}
      <div
        className="flex flex-wrap items-center gap-2 border-b border-line pb-3"
        style={{ opacity: pending ? 0.5 : 1 }}
      >
        <span className="font-label text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-soft">
          Period
        </span>
        <input
          type="date"
          value={window.from ?? ""}
          min={bounds.min}
          max={bounds.max}
          onChange={(e) => setParams({ from: e.target.value || null })}
          aria-label="From date"
          className="rounded-md border border-line bg-white px-2 py-1 text-xs tabular-nums text-ink"
        />
        <span className="text-xs text-muted-soft">→</span>
        <input
          type="date"
          value={window.to ?? ""}
          min={bounds.min}
          max={bounds.max}
          onChange={(e) => setParams({ to: e.target.value || null })}
          aria-label="To date"
          className="rounded-md border border-line bg-white px-2 py-1 text-xs tabular-nums text-ink"
        />

        <span className="ml-1 flex items-center gap-1.5">
          <span className="font-label text-[10px] uppercase tracking-[0.1em] text-muted-soft">on</span>
          <Seg
            options={[
              ["either", "Either date"],
              ["order", "Ordered"],
              ["install", "Installing"],
            ]}
            value={window.basis}
            onChange={(v) => setParams({ basis: v === "either" ? null : v })}
          />
        </span>

        <span className="flex flex-wrap items-center gap-1">
          {([["30d", 30], ["90d", 90], ["12mo", 365]] as const).map(([label, days]) => (
            <button
              key={label}
              onClick={() => preset(days)}
              className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-muted transition-colors hover:border-stone hover:text-ink"
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => presetMonth(0)}
            className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-muted transition-colors hover:border-stone hover:text-ink"
          >
            This month
          </button>
          <button
            onClick={() => presetMonth(-1)}
            className="rounded-md border border-line bg-white px-2 py-1 text-[11px] text-muted transition-colors hover:border-stone hover:text-ink"
          >
            Last month
          </button>
          {windowed ? (
            <button
              onClick={() => setParams({ from: null, to: null, basis: null })}
              className="font-label rounded-md bg-ink px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-cream transition-colors hover:bg-ink-soft"
            >
              Clear ✕
            </button>
          ) : null}
        </span>

        <span className="ml-auto text-[11px] tabular-nums text-muted">
          {windowed
            ? `${fmtDate(window.from ?? bounds.min)} – ${fmtDate(window.to ?? bounds.max)}`
            : "All time"}
        </span>
      </div>

      {windowed && window.basis !== "either" ? (
        <p className="-mt-2 text-[11px] text-muted-soft">
          Filtering on the{" "}
          <span className="font-medium text-ink">
            {window.basis === "order" ? "order" : "install"}
          </span>{" "}
          date, so the{" "}
          <span className="font-medium text-ink">
            {window.basis === "order" ? "installing" : "ordered"}
          </span>{" "}
          series can extend outside the window — that&apos;s the{" "}
          {window.basis === "order" ? "lead time on what you sold" : "lead time behind what you installed"}.
        </p>
      ) : null}

      {scope === "all" && mix.boilerplate > 0 ? (
        <p className="-mt-2 text-[11px] text-muted-soft">
          Counting every line in the export, including{" "}
          <span className="font-medium text-crimson">{mix.boilerplate.toLocaleString()}</span> that carry no
          quantity and no value (RFMS prints them on the customer&apos;s paperwork — &ldquo;5 YR WORRY FREE
          GUARANTEE&rdquo; and the like). They inflate volume by ~
          {Math.round((100 * mix.boilerplate) / Math.max(1, mix.total - mix.boilerplate))}% without
          representing work. Switch to <span className="font-medium text-ink">Work</span> to exclude them.
        </p>
      ) : null}

      <div className="rounded-lg border border-line bg-white p-4">
        <div className="h-[340px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data}
              margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
              style={{ cursor: "pointer" }}
              onClick={(st) => {
                if (barClaimed.current) {
                  barClaimed.current = false;
                  return; // the Bar's own handler already opened the ordered slice
                }
                // recharts 3 chart-level clicks carry activeTooltipIndex (as a
                // STRING, e.g. "44"), not activePayload — resolve through data[].
                const raw = (st as { activeTooltipIndex?: number | string | null })?.activeTooltipIndex;
                const idx = raw === null || raw === undefined ? NaN : Number(raw);
                const d = Number.isInteger(idx) && idx >= 0 && idx < data.length ? data[idx] : undefined;
                if (!d) return;
                // Prefer the installing slice (the line); fall back to ordered;
                // never open a drawer for a period with nothing in it.
                if (d.raw.installing > 0) openPeriod("installing-period", d.key);
                else if (d.raw.ordered > 0) openPeriod("ordered-period", d.key);
              }}
            >
              <CartesianGrid stroke="#e7e0d3" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "#5a606b" }}
                stroke="#e7e0d3"
                interval="preserveStartEnd"
                minTickGap={grain === "day" ? 28 : 8}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#5a606b" }}
                stroke="#e7e0d3"
                width={measure === "revenue" ? 60 : 34}
                tickFormatter={(v: number) => (measure === "revenue" ? `$${Math.round(v / 1000)}k` : String(v))}
              />
              <Tooltip content={<TipCard measure={measure} grain={grain} />} cursor={{ fill: "#fbf8f2" }} />
              <ReferenceLine
                y={avgInstalling}
                stroke={INSTALL}
                strokeDasharray="4 4"
                strokeOpacity={0.55}
                label={{
                  value: `avg ${unit(avgInstalling)}`,
                  position: "insideTopRight",
                  fontSize: 9,
                  fill: INSTALL,
                }}
              />
              <Bar
                dataKey="ordered"
                fill={ORDERED}
                radius={[2, 2, 0, 0]}
                maxBarSize={grain === "day" ? 6 : 26}
                onClick={(d) => {
                  const p = (d as { payload?: { key?: string; raw?: Bucket } })?.payload;
                  if (!p?.key || !p.raw || p.raw.ordered === 0) return;
                  barClaimed.current = true;
                  openPeriod("ordered-period", p.key);
                }}
              />
              <Line
                type="monotone"
                dataKey="installing"
                stroke={INSTALL}
                strokeWidth={2}
                dot={grain === "month" ? { r: 2.5 } : false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-soft">
          Bars are lines <span className="font-medium text-ink">ordered</span> in each {grainWord} (when
          the sale happened). The line is what&apos;s <span className="font-medium text-ink">installing</span>{" "}
          in that {grainWord} — the capacity actually consumed. Everything to the right of{" "}
          <span className="font-medium text-ink">{fmtDate(asOf)}</span> is forward schedule: install load
          with no order intake yet.
          {partial ? (
            <>
              {" "}
              The {grainWord} of{" "}
              <span className="font-medium text-ink">{labelFor(partial.key, grain)}</span> was still open
              when the export ran, so it&apos;s half-counted — both it and the forward schedule sit out of
              the averages.
            </>
          ) : null}{" "}
          Click a navy bar for the CGs <span className="font-medium text-ink">ordered</span> that{" "}
          {grainWord}, anywhere else on a {grainWord} for the CGs{" "}
          <span className="font-medium text-ink">installing</span> — or use the table below, where each
          cell opens its own slice.
        </p>
      </div>

      <PeriodTable data={data} grain={grain} scope={scope} asOf={asOf} onCell={openPeriod} />

      <DrilldownDrawer view={drill} onClose={() => setDrill(null)} />
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

function PeriodTable({
  data,
  grain,
  scope,
  asOf,
  onCell,
}: {
  data: { key: string; label: string; raw: Bucket; isFuture: boolean; isPartial: boolean }[];
  grain: Grain;
  scope: LineScope;
  asOf: string;
  onCell: (kind: PeriodKind, key: string) => void;
}) {
  const [desc, setDesc] = useState(true);
  const rows = useMemo(() => {
    const r = data.filter((d) => d.raw.ordered > 0 || d.raw.installing > 0);
    return desc ? [...r].reverse() : r;
  }, [data, desc]);

  const exportTable = () =>
    downloadCSV(
      `orders-pipeline-${grain}-${scope}-as-of-${asOf}.csv`,
      [
        grain === "week" ? "Week of" : grain === "month" ? "Month" : "Day",
        "Lines ordered",
        "CGs ordered",
        "Order value",
        "Lines installing",
        "CGs installing",
        "Install value",
        "Material w/o PO",
      ],
      rows.map((d) => [
        d.key,
        d.raw.ordered,
        d.raw.orderedCGs,
        Math.round(d.raw.orderedRevenue * 100) / 100,
        d.raw.installing,
        d.raw.installingCGs,
        Math.round(d.raw.installingRevenue * 100) / 100,
        d.raw.installingNoPO,
      ])
    );

  return (
    <div>
    <div className="mb-2 flex items-center justify-end">
      <ExportButton onClick={exportTable} label={`Export ${grain}s CSV`} />
    </div>
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          {/* Two tiers. Both halves have a Lines / CGs / Value column, so a flat
              header leaves two columns reading just "CGs" and invites comparing
              ordered CGs against an installing number. The group row is what
              tells them apart. */}
          <tr className="bg-paper-soft">
            <th className="border-b border-line px-3 py-1.5" />
            <th
              colSpan={3}
              className="font-label border-b border-l border-line px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: ORDERED }}
            >
              <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: ORDERED }} />
              Ordered — demand in
            </th>
            <th
              colSpan={4}
              className="font-label border-b border-l border-line px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: INSTALL }}
            >
              <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: INSTALL }} />
              Installing — load out
            </th>
          </tr>
          <tr className="bg-paper-soft">
            <th
              onClick={() => setDesc((v) => !v)}
              className="font-label cursor-pointer px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted hover:text-ink"
            >
              {grain === "week" ? "Week of" : grain === "month" ? "Month" : "Day"}{" "}
              <span className="text-crimson">{desc ? "▼" : "▲"}</span>
            </th>
            {(
              [
                ["Lines", true],
                ["CGs", false],
                ["Value", false],
                ["Lines", true],
                ["CGs", false],
                ["Value", false],
                ["No PO", false],
              ] as const
            ).map(([h, startsGroup], i) => (
              <th
                key={i}
                className={`font-label px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-[0.08em] ${
                  i === 6 ? "text-crimson/70" : "text-muted"
                } ${startsGroup ? "border-l border-line" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr
              key={d.key}
              className={`border-b border-line/50 last:border-0 hover:bg-paper-soft ${
                d.isFuture ? "bg-paper-tint/40" : ""
              }`}
            >
              <td className="whitespace-nowrap px-3 py-1.5 text-xs font-medium tabular-nums text-ink">
                {d.label}
                {d.isFuture ? (
                  <span className="font-label ml-1.5 rounded-sm border border-ink px-1 text-[9px] font-bold uppercase text-ink">
                    Sched
                  </span>
                ) : null}
                {d.isPartial ? (
                  <span
                    title="Still in progress at the snapshot date — excluded from the averages."
                    className="font-label ml-1.5 rounded-sm border border-crimson px-1 text-[9px] font-bold uppercase text-crimson"
                  >
                    Partial
                  </span>
                ) : null}
              </td>
              <Num v={d.raw.ordered} border onClick={d.raw.ordered > 0 ? () => onCell("ordered-period", d.key) : undefined} />
              <Num v={d.raw.orderedCGs} dim onClick={d.raw.ordered > 0 ? () => onCell("ordered-period", d.key) : undefined} />
              <Num v={d.raw.orderedRevenue} money dim onClick={d.raw.ordered > 0 ? () => onCell("ordered-period", d.key) : undefined} />
              <Num v={d.raw.installing} border onClick={d.raw.installing > 0 ? () => onCell("installing-period", d.key) : undefined} />
              <Num v={d.raw.installingCGs} dim onClick={d.raw.installing > 0 ? () => onCell("installing-period", d.key) : undefined} />
              <Num v={d.raw.installingRevenue} money dim onClick={d.raw.installing > 0 ? () => onCell("installing-period", d.key) : undefined} />
              <Num v={d.raw.installingNoPO} risk onClick={d.raw.installingNoPO > 0 ? () => onCell("no-po-period", d.key) : undefined} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}

function Num({
  v,
  dim = false,
  money: isMoney = false,
  risk = false,
  border = false,
  onClick,
}: {
  v: number;
  dim?: boolean;
  money?: boolean;
  risk?: boolean;
  border?: boolean;
  onClick?: () => void;
}) {
  return (
    <td
      onClick={onClick}
      title={onClick ? "See the CGs behind this number" : undefined}
      className={`px-3 py-1.5 text-right text-xs tabular-nums ${border ? "border-l border-line" : ""} ${
        risk && v > 0 ? "font-semibold text-crimson" : dim ? "text-muted-soft" : "text-ink"
      } ${onClick ? "cursor-pointer hover:bg-paper-tint" : ""}`}
    >
      {v === 0 ? <span className="text-line">·</span> : isMoney ? money(v) : v.toLocaleString()}
    </td>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function TipCard({
  active,
  payload,
  measure,
  grain,
}: {
  active?: boolean;
  payload?: { payload: { key: string; raw: Bucket } }[];
  measure: Measure;
  grain: Grain;
}) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload.raw;
  const fmt = (n: number) => (measure === "revenue" ? money(n) : n.toLocaleString());
  return (
    <div className="rounded-md border border-line bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-ink">{labelFor(payload[0].payload.key, grain, true)}</p>
      <p className="mt-1.5 flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm" style={{ background: ORDERED }} />
        <span className="text-muted">Ordered</span>
        <span className="ml-auto font-semibold tabular-nums text-ink">
          {fmt(measure === "cgs" ? b.orderedCGs : measure === "revenue" ? b.orderedRevenue : b.ordered)}
        </span>
      </p>
      <p className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm" style={{ background: INSTALL }} />
        <span className="text-muted">Installing</span>
        <span className="ml-auto font-semibold tabular-nums text-ink">
          {fmt(measure === "cgs" ? b.installingCGs : measure === "revenue" ? b.installingRevenue : b.installing)}
        </span>
      </p>
      {b.installingNoPO > 0 ? (
        <p className="mt-1 flex items-center gap-1.5 border-t border-line pt-1">
          <span className="h-2 w-2 rounded-sm" style={{ background: RISK }} />
          <span className="text-muted">Installing, no PO</span>
          <span className="ml-auto font-semibold tabular-nums text-crimson">{b.installingNoPO}</span>
        </p>
      ) : null}
    </div>
  );
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function Seg({
  options,
  value,
  onChange,
}: {
  options: readonly (readonly [string, string])[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-md border border-line bg-paper-soft p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === v ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function labelFor(key: string, grain: Grain, long = false): string {
  if (grain === "month") return fmtMonth(key);
  if (grain === "week") return long ? `Week of ${fmtDate(key)}` : fmtDate(key);
  return fmtDate(key);
}

