"use client";

import { useMemo, useState } from "react";
import type { LineStatus } from "@/lib/ops/csv-import";
import { readinessOf, STATUS_ORDER, type CGSummary, type OrderLine, type PipelineSummary } from "@/lib/ops/pipeline";
import { fmtDate, money } from "@/lib/ops/format";
import { StatusBadge, STATUS_COLOR, STATUS_HELP, Tile } from "./shared";

type Scope = "future" | "past" | "all" | "none";
type SortKey = "invoice" | "cust" | "city" | "install" | "order" | "lines" | "ready" | LineStatus;

const RLAB = ["No", "Partial", "Yes"] as const;

export function InstallPipeline({
  cgs,
  summary,
  asOf,
  clientId,
}: {
  cgs: CGSummary[];
  summary: PipelineSummary;
  asOf: string;
  clientId: string;
}) {
  const [view, setView] = useState<"board" | "calendar">("board");
  const [scope, setScope] = useState<Scope>("future");
  const [q, setQ] = useState("");
  const [rep, setRep] = useState("");
  const [hideCanceled, setHideCanceled] = useState(true);
  const [materialOnly, setMaterialOnly] = useState(false);
  const [statuses, setStatuses] = useState<LineStatus[]>([...STATUS_ORDER]);
  const [sort, setSort] = useState<SortKey>("install");
  const [dir, setDir] = useState(1);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [month, setMonth] = useState<string | null>(null);
  // Line detail is fetched per-CG on expand and cached here for the session.
  const [lines, setLines] = useState<Record<string, OrderLine[] | "loading" | "error">>({});

  const toggleRow = (inv: string) => {
    setOpen((v) => ({ ...v, [inv]: !v[inv] }));
    if (lines[inv] !== undefined) return;
    setLines((v) => ({ ...v, [inv]: "loading" }));
    fetch(`/api/ops/lines?client=${encodeURIComponent(clientId)}&cg=${encodeURIComponent(inv)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setLines((v) => ({ ...v, [inv]: d.lines as OrderLine[] })))
      .catch(() => setLines((v) => ({ ...v, [inv]: "error" })));
  };

  const reps = useMemo(
    () => [...new Set(cgs.map((g) => g.salesperson).filter(Boolean))].sort(),
    [cgs]
  );

  /**
   * Everything except the status chips. The chips read their counts off this,
   * so a chip always answers "how many would I get if I turned this on" rather
   * than zeroing itself the moment it's switched off.
   */
  const base = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cgs.filter((g) => {
      if (scope === "future" && !g.hasFuture) return false;
      if (scope === "past" && (g.installDates.length === 0 || g.hasFuture)) return false;
      if (scope === "none" && g.installDates.length > 0) return false;
      if (hideCanceled && g.canceled) return false;
      if (materialOnly && g.serviceOnly) return false;
      if (rep && g.salesperson !== rep) return false;
      if (needle) {
        const hay = `${g.invoiceNum} ${g.custName} ${g.shipCity} ${g.salesperson}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [cgs, scope, q, rep, hideCanceled, materialOnly]);

  const rows = useMemo(() => {
    const anyOff = statuses.length < STATUS_ORDER.length;
    const kept = anyOff ? base.filter((g) => statuses.some((s) => g.counts[s] > 0)) : base;

    const key = (g: CGSummary): string | number => {
      switch (sort) {
        case "invoice": return g.invoiceNum;
        case "cust": return g.custName;
        case "city": return g.shipCity;
        case "install": return g.installDate ?? "9999-99-99";
        case "order": return g.orderDate ?? "9999-99-99";
        case "lines": return g.total;
        case "ready": return g.delShare;
        default: return g.counts[sort];
      }
    };
    return [...kept].sort((a, b) => {
      const x = key(a), y = key(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      return a.invoiceNum.localeCompare(b.invoiceNum);
    });
  }, [base, statuses, sort, dir]);

  const chipCounts = useMemo(() => {
    const n = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<LineStatus, number>;
    for (const g of base) for (const s of STATUS_ORDER) n[s] += g.counts[s];
    return n;
  }, [base]);

  /**
   * The rows are CGs but the status chips filter LINES, so "lines" alone is
   * ambiguous once a chip is off: a CG is kept if *any* of its lines match, and
   * the row still shows all of them. Report both — matched lines out of the
   * lines actually on screen — instead of quietly showing one and implying the
   * other. Revenue stays CG-level, because that's the row's value.
   */
  const totals = useMemo(() => {
    const filtered = statuses.length < STATUS_ORDER.length;
    return {
      lines: rows.reduce((a, g) => a + g.total, 0),
      matched: filtered
        ? rows.reduce((a, g) => a + statuses.reduce((n, s) => n + g.counts[s], 0), 0)
        : null,
      revenue: rows.reduce((a, g) => a + g.revenue, 0),
    };
  }, [rows, statuses]);

  const toggleStatus = (s: LineStatus) =>
    setStatuses((cur) =>
      cur.includes(s)
        ? cur.length === 1
          ? [...STATUS_ORDER]           // last one off = show everything again
          : cur.filter((x) => x !== s)
        : [...cur, s]
    );

  const sortBy = (k: SortKey) => {
    if (sort === k) setDir((d) => -d);
    else {
      setSort(k);
      setDir(k === "install" || k === "order" || k === "invoice" || k === "cust" || k === "city" ? 1 : -1);
    }
  };

  const arrow = (k: SortKey) => (sort === k ? (dir > 0 ? "▲" : "▼") : "");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          label="Real work ahead"
          value={summary.realCGs}
          sub={`of ${summary.futureCGs} future CGs · ${summary.serviceOnlyCGs} are promo/fees only`}
        />
        <Tile label="Upcoming revenue" value={money(summary.realRevenue)} sub="material installs only" />
        <Tile label="Installing ≤ 14 days" value={summary.installingSoon} sub="next two weeks" />
        <Tile
          label="Material w/o a PO"
          value={summary.noPOLines}
          sub={summary.noPOLines ? `lines · ${summary.noPOCGs} CGs — status None` : "all future material ordered"}
          flag={summary.noPOLines > 0}
        />
        <Tile
          label="Split-date CGs"
          value={summary.mixedCGs}
          sub="part installed, part upcoming"
          flag={summary.mixedCGs > 0}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
        <Segmented
          options={[
            ["future", "Future installs"],
            ["past", "Past"],
            ["all", "All"],
            ["none", "No date"],
          ]}
          value={scope}
          onChange={(v) => {
            setScope(v as Scope);
            setMonth(null);
          }}
        />

        <div className="flex flex-wrap gap-1.5">
          {STATUS_ORDER.map((s) => {
            const on = statuses.includes(s);
            return (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                aria-pressed={on}
                title={STATUS_HELP[s]}
                className="font-label inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-semibold tabular-nums transition-colors"
                style={{
                  color: on ? STATUS_COLOR[s] : "#9a958c",
                  borderColor: on ? STATUS_COLOR[s] : "#e7e0d3",
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: on ? STATUS_COLOR[s] : "#9a958c" }}
                />
                {s} <span className="opacity-70">{chipCounts[s]}</span>
              </button>
            );
          })}
        </div>

        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search CG, customer, city, rep…"
          aria-label="Search"
          className="min-w-[190px] rounded-md border border-line bg-white px-2.5 py-1.5 text-xs text-ink placeholder:text-muted-soft"
        />

        <select
          value={rep}
          onChange={(e) => setRep(e.target.value)}
          aria-label="Salesperson"
          className="rounded-md border border-line bg-white px-2.5 py-1.5 text-xs text-ink"
        >
          <option value="">All salespeople</option>
          {reps.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>

        <Check label="Hide canceled" checked={hideCanceled} onChange={setHideCanceled} />
        <Check
          label="Real work only"
          checked={materialOnly}
          onChange={setMaterialOnly}
          title="Hides CGs with nothing but promo, fee, or paperwork lines still dated ahead — the floor is already down."
        />

        <div className="ml-auto flex items-center gap-3">
          <span
            className="text-[11px] tabular-nums text-muted"
            title={
              totals.matched === null
                ? undefined
                : `${totals.matched.toLocaleString()} lines match the status filter, out of ${totals.lines.toLocaleString()} on the ${rows.length} CGs shown.`
            }
          >
            {rows.length.toLocaleString()} CG{rows.length === 1 ? "" : "s"} ·{" "}
            {totals.matched === null ? (
              <>{totals.lines.toLocaleString()} lines</>
            ) : (
              <>
                <span className="font-semibold text-ink">{totals.matched.toLocaleString()}</span> of{" "}
                {totals.lines.toLocaleString()} lines
              </>
            )}{" "}
            · {money(totals.revenue)}
          </span>
          <Segmented
            options={[
              ["board", "Board"],
              ["calendar", "Calendar"],
            ]}
            value={view}
            onChange={(v) => setView(v as "board" | "calendar")}
          />
        </div>
      </div>

      {view === "board" ? (
        <Board
          rows={rows}
          asOf={asOf}
          scope={scope}
          open={open}
          toggleRow={toggleRow}
          lines={lines}
          sortBy={sortBy}
          arrow={arrow}
        />
      ) : (
        <Calendar rows={rows} asOf={asOf} month={month} setMonth={setMonth} />
      )}
    </div>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

function Board({
  rows,
  asOf,
  scope,
  open,
  toggleRow,
  lines,
  sortBy,
  arrow,
}: {
  rows: CGSummary[];
  asOf: string;
  scope: Scope;
  open: Record<string, boolean>;
  toggleRow: (inv: string) => void;
  lines: Record<string, OrderLine[] | "loading" | "error">;
  sortBy: (k: SortKey) => void;
  arrow: (k: SortKey) => string;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-white py-14 text-center text-sm text-muted">
        No CGs match these filters.
      </p>
    );
  }

  const Th = ({ k, children, center = false }: { k: SortKey; children: React.ReactNode; center?: boolean }) => (
    <th
      onClick={() => sortBy(k)}
      className={`font-label sticky top-0 z-10 cursor-pointer whitespace-nowrap bg-paper-soft px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted hover:text-ink ${
        center ? "text-center" : "text-left"
      }`}
    >
      {children} <span className="text-crimson">{arrow(k)}</span>
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="w-full min-w-[1060px] border-collapse">
        <thead>
          <tr>
            <Th k="invoice">Invoice</Th>
            <Th k="cust">Customer</Th>
            <Th k="city">City</Th>
            <Th k="install">Install Date</Th>
            <Th k="order">Order Date</Th>
            {STATUS_ORDER.map((s) => (
              <Th key={s} k={s} center>
                {s}
              </Th>
            ))}
            <Th k="lines" center>Lines</Th>
            <Th k="ready">Completed?</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <FragmentRow
              key={g.invoiceNum}
              g={g}
              asOf={asOf}
              scope={scope}
              isOpen={Boolean(open[g.invoiceNum])}
              detail={lines[g.invoiceNum]}
              toggle={() => toggleRow(g.invoiceNum)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  g,
  asOf,
  scope,
  isOpen,
  detail,
  toggle,
}: {
  g: CGSummary;
  asOf: string;
  scope: Scope;
  isOpen: boolean;
  detail: OrderLine[] | "loading" | "error" | undefined;
  toggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={toggle}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className={`cursor-pointer border-b border-line/60 ${isOpen ? "bg-paper-tint" : "hover:bg-paper-soft"}`}
      >
        <td className="whitespace-nowrap px-2.5 py-1.5 text-[12.5px] font-semibold tabular-nums text-ink">
          <span className="inline-block w-3 text-muted-soft">{isOpen ? "▾" : "▸"}</span>
          {g.invoiceNum}
        </td>
        <td className="max-w-[210px] truncate px-2.5 py-1.5 text-[13px] text-ink" title={g.custName}>
          {g.custName}
          {g.canceled ? <Tag tone="crimson">Canceled</Tag> : null}
          {g.hold ? <Tag tone="amber">Hold</Tag> : null}
        </td>
        <td className="whitespace-nowrap px-2.5 py-1.5 text-xs text-muted">{g.shipCity || "—"}</td>
        <td className="whitespace-nowrap px-2.5 py-1.5 text-xs tabular-nums text-ink">
          {fmtDate(g.installDate)}
          {g.installDates.length > 1 ? (
            <span className="ml-1 text-[10.5px] text-muted-soft">+{g.installDates.length - 1} more</span>
          ) : null}
          {g.hasFuture && scope !== "future" ? <Tag tone="navy">Fut</Tag> : null}
        </td>
        <td className="whitespace-nowrap px-2.5 py-1.5 text-xs tabular-nums text-muted">
          {fmtDate(g.orderDate)}
        </td>
        {STATUS_ORDER.map((s) => (
          <td
            key={s}
            className="px-2.5 py-1.5 text-center text-[12.5px] font-medium tabular-nums"
            style={{ color: g.counts[s] ? STATUS_COLOR[s] : "#e7e0d3" }}
          >
            {g.counts[s] || "·"}
          </td>
        ))}
        <td className="px-2.5 py-1.5 text-center text-[12.5px] font-semibold tabular-nums text-ink">
          {g.total}
        </td>
        <td className="whitespace-nowrap px-2.5 py-1.5">
          <span className="inline-flex items-center gap-2">
            <span className="h-1 w-10 overflow-hidden rounded-full border border-line bg-paper-soft">
              <span
                className="block h-full bg-[#2f7d57]"
                style={{ width: `${g.delShare * 100}%` }}
              />
            </span>
            <span
              className="font-label text-[10.5px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: g.ready === 2 ? "#2f7d57" : g.ready === 1 ? "#b3761e" : "#9a958c" }}
            >
              {RLAB[g.ready]}
            </span>
          </span>
        </td>
      </tr>

      {isOpen ? (
        <tr>
          <td colSpan={13} className="border-b border-line bg-paper-soft p-0">
            <div className="px-4 py-2.5 pl-8">
              {detail === "loading" || detail === undefined ? (
                <p className="py-3 text-xs text-muted-soft">Loading lines…</p>
              ) : detail === "error" ? (
                <p className="py-3 text-xs text-red-600">
                  Couldn&apos;t load the lines for {g.invoiceNum}. Close the row and try again.
                </p>
              ) : (
                <>
                  <div className="font-label grid grid-cols-[46px_78px_74px_92px_1fr_84px] gap-2.5 border-b border-line pb-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted">
                    <span>Line</span>
                    <span>Status</span>
                    <span>Class</span>
                    <span>Install</span>
                    <span>Item</span>
                    <span className="text-right">Total</span>
                  </div>
                  {detail.map((l) => (
                    <div
                      key={l.lineNum}
                      className="grid grid-cols-[46px_78px_74px_92px_1fr_84px] items-center gap-2.5 border-b border-line/50 py-1 text-xs last:border-0"
                    >
                      <span className="tabular-nums text-muted">{l.lineNum}</span>
                      <StatusBadge status={l.lineStatus} />
                      <span className="text-[10px] uppercase tracking-[0.06em] text-muted-soft">
                        {l.lineClass === "other" ? "promo" : l.lineClass}
                      </span>
                      <span className="tabular-nums text-ink">
                        {fmtDate(l.installDate)}
                        {l.installDate && l.installDate > asOf ? <Tag tone="navy">Fut</Tag> : null}
                      </span>
                      <span className="truncate text-muted" title={l.styleItem}>
                        {l.styleItem || "—"}
                      </span>
                      <span className="text-right tabular-nums text-muted">
                        {l.lineTotal ? money(l.lineTotal) : "—"}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────

type Ev = { cg: CGSummary; count: number; status: LineStatus };

function Calendar({
  rows,
  asOf,
  month,
  setMonth,
}: {
  rows: CGSummary[];
  asOf: string;
  month: string | null;
  setMonth: (m: string) => void;
}) {
  // Reads the server-side `schedule` rollup (one entry per CG per install day)
  // rather than raw lines — the board never ships lines.
  const events = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const g of rows) {
      for (const d of g.schedule) {
        const ev = { cg: g, count: d.lines, status: d.status };
        const arr = m.get(d.date);
        if (arr) arr.push(ev);
        else m.set(d.date, [ev]);
      }
    }
    return m;
  }, [rows]);

  const keys = useMemo(() => [...events.keys()].sort(), [events]);
  const lo = keys[0]?.slice(0, 7) ?? asOf.slice(0, 7);
  const hi = keys[keys.length - 1]?.slice(0, 7) ?? asOf.slice(0, 7);
  const cur = clamp(month ?? asOf.slice(0, 7), lo, hi);

  const [y, m] = cur.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const dim = new Date(y, m, 0).getDate();
  const prevDim = new Date(y, m - 1, 0).getDate();
  const start = first.getDay();

  const cells: { day: number; key?: string; pad?: boolean }[] = [];
  for (let i = 0; i < start; i++) cells.push({ day: prevDim - start + 1 + i, pad: true });
  for (let d = 1; d <= dim; d++) {
    cells.push({ day: d, key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }
  while (cells.length % 7) cells.push({ day: cells.length % 7, pad: true });

  const monthEvents = keys.filter((k) => k.startsWith(cur));
  const cgSet = new Set<string>();
  let lineCount = 0;
  for (const k of monthEvents) {
    for (const e of events.get(k) ?? []) {
      cgSet.add(e.cg.invoiceNum);
      lineCount += e.count;
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          onClick={() => setMonth(shiftMonth(cur, -1))}
          disabled={cur <= lo}
          aria-label="Previous month"
          className="grid h-7 w-7 place-items-center rounded-md border border-line bg-white text-ink disabled:opacity-35"
        >
          ‹
        </button>
        <button
          onClick={() => setMonth(shiftMonth(cur, 1))}
          disabled={cur >= hi}
          aria-label="Next month"
          className="grid h-7 w-7 place-items-center rounded-md border border-line bg-white text-ink disabled:opacity-35"
        >
          ›
        </button>
        <span className="text-[15px] font-bold tracking-tight text-ink">
          {new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" })} {y}
        </span>
        <span className="text-[11px] tabular-nums text-muted">
          {cgSet.size} CGs · {lineCount} lines this month · bar colour = weakest line status
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-white">
        <div className="grid grid-cols-7 border-b border-line bg-paper-soft">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div
              key={d}
              className="font-label px-2 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((c, i) => {
            const list = (c.key ? events.get(c.key) : undefined) ?? [];
            const sorted = [...list].sort((a, b) => readinessOf(a.status) - readinessOf(b.status));
            const lines = list.reduce((a, e) => a + e.count, 0);
            return (
              <div
                key={i}
                className={`flex min-h-[92px] flex-col gap-0.5 border-b border-r border-line/50 p-1.5 ${
                  c.pad ? "bg-paper-soft/50" : c.key === asOf ? "bg-paper-tint" : ""
                }`}
              >
                <span className="flex items-center justify-between text-[11px] font-semibold tabular-nums text-muted">
                  <span className={c.pad ? "opacity-40" : c.key === asOf ? "text-crimson" : ""}>{c.day}</span>
                  {lines ? <span className="text-[9.5px] text-muted-soft">{lines}L</span> : null}
                </span>
                {sorted.slice(0, 3).map((e) => (
                  <span
                    key={e.cg.invoiceNum}
                    title={`${e.cg.invoiceNum} · ${e.cg.custName} · ${e.count} line(s) · weakest: ${e.status}`}
                    className="truncate rounded-sm border-l-[3px] bg-paper-soft px-1 py-px text-[10.5px] font-semibold tabular-nums"
                    style={{ borderColor: STATUS_COLOR[e.status], color: STATUS_COLOR[e.status] }}
                  >
                    {e.cg.invoiceNum.replace("CG", "")}{" "}
                    <span className="font-normal text-muted">{e.cg.custName.split(",")[0]}</span>
                  </span>
                ))}
                {sorted.length > 3 ? (
                  <span className="pl-1 text-[9.5px] text-muted-soft">+{sorted.length - 3} more</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function Segmented({
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
          className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === v ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <label title={title} className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Tag({ tone, children }: { tone: "crimson" | "amber" | "navy"; children: React.ReactNode }) {
  const c = { crimson: "#b3313f", amber: "#b3761e", navy: "#11294a" }[tone];
  return (
    <span
      className="font-label ml-1 inline-block rounded-sm border px-1 text-[9px] font-bold uppercase tracking-[0.06em] align-[1px]"
      style={{ color: c, borderColor: c }}
    >
      {children}
    </span>
  );
}

function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function clamp(v: string, lo: string, hi: string): string {
  return v < lo ? lo : v > hi ? hi : v;
}
