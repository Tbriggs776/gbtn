"use client";

import { useMemo, useState, useTransition } from "react";
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
import type { Bucket, Grain, LineMix } from "@/lib/ops/pipeline";
import { fmtDate, fmtMonth, money } from "@/lib/ops/format";
import { Tile } from "./shared";

type Measure = "lines" | "cgs" | "revenue";
type LineScope = "all" | "work" | "material" | "labor";

const ORDERED = "#11294a";  // navy — demand coming in
const INSTALL = "#b3761e";  // amber — load going out
const RISK = "#b3313f";

export function OrdersPipeline({
  buckets,
  asOf,
  scope,
  mix,
}: {
  /** Pre-bucketed on the server for each grain, so switching is instant. */
  buckets: Record<Grain, Bucket[]>;
  asOf: string;
  scope: LineScope;
  mix: LineMix;
}) {
  const [grain, setGrain] = useState<Grain>("week");
  const [measure, setMeasure] = useState<Measure>("lines");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  // Line scope re-buckets on the server (CG counts aren't additive across
  // classes), so it travels in the URL rather than component state.
  const setScope = (v: string) => {
    const p = new URLSearchParams(searchParams.toString());
    if (v === "all") p.delete("lines");
    else p.set("lines", v);
    startTransition(() => router.push(`${pathname}?${p.toString()}`, { scroll: false }));
  };

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
   * Grain-independent facts, so they're read off the DAY buckets whatever the
   * toggle says. Deriving them from the selected grain made the month view
   * report 66 lines ahead where the day view reported 195 — the month bucket
   * holding the snapshot got discarded whole, taking the rest of its installs
   * with it.
   */
  const { backlog, futureNoPO } = useMemo(() => {
    const ahead = buckets.day.filter((b) => b.key > asOf);
    return {
      backlog: ahead.reduce((a, b) => a + b.installing, 0),
      futureNoPO: ahead.reduce((a, b) => a + b.installingNoPO, 0),
    };
  }, [buckets.day, asOf]);

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
        />
        <Tile label="Scheduled ahead" value={backlog.toLocaleString()} sub={`lines installing after ${fmtDate(asOf)}`} />
        <Tile
          label="Scheduled w/o a PO"
          value={futureNoPO.toLocaleString()}
          sub={futureNoPO ? "material lines, status None" : "all scheduled material ordered"}
          flag={futureNoPO > 0}
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
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
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
              <Bar dataKey="ordered" fill={ORDERED} radius={[2, 2, 0, 0]} maxBarSize={grain === "day" ? 6 : 26} />
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
          ) : null}
        </p>
      </div>

      <PeriodTable data={data} grain={grain} />
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────────

function PeriodTable({
  data,
  grain,
}: {
  data: { key: string; label: string; raw: Bucket; isFuture: boolean; isPartial: boolean }[];
  grain: Grain;
}) {
  const [desc, setDesc] = useState(true);
  const rows = useMemo(() => {
    const r = data.filter((d) => d.raw.ordered > 0 || d.raw.installing > 0);
    return desc ? [...r].reverse() : r;
  }, [data, desc]);

  return (
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
              <Num v={d.raw.ordered} border />
              <Num v={d.raw.orderedCGs} dim />
              <Num v={d.raw.orderedRevenue} money dim />
              <Num v={d.raw.installing} border />
              <Num v={d.raw.installingCGs} dim />
              <Num v={d.raw.installingRevenue} money dim />
              <Num v={d.raw.installingNoPO} risk />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Num({
  v,
  dim = false,
  money: isMoney = false,
  risk = false,
  border = false,
}: {
  v: number;
  dim?: boolean;
  money?: boolean;
  risk?: boolean;
  border?: boolean;
}) {
  return (
    <td
      className={`px-3 py-1.5 text-right text-xs tabular-nums ${border ? "border-l border-line" : ""} ${
        risk && v > 0 ? "font-semibold text-crimson" : dim ? "text-muted-soft" : "text-ink"
      }`}
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

/** Last day covered by the period starting at `key`. */
function periodEnd(key: string, grain: Grain): string {
  if (grain === "day") return key;
  const [y, m, d] = key.split("-").map(Number);
  const dt = grain === "week" ? new Date(y, m - 1, d + 6) : new Date(y, m, 0);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
