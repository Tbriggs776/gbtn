"use client";

import { useMemo, useState } from "react";
import type { LineStatus } from "@/lib/ops/csv-import";
import type { HygieneReport } from "@/lib/ops/hygiene";
import { fmtDate, money } from "@/lib/ops/format";
import { downloadCSV } from "@/lib/ops/csv";
import { ExportButton, STATUS_COLOR, Tile } from "./shared";

export function StatusHygiene({ report, asOf }: { report: HygieneReport; asOf: string }) {
  const [band, setBand] = useState<string>("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<LineStatus | "">("");

  const rows = useMemo(() => {
    const b = report.bands.find((x) => x.label === band);
    const needle = q.trim().toLowerCase();
    return report.staleCGs.filter((g) => {
      if (b && !(g.daysSince >= b.lo && g.daysSince < b.hi)) return false;
      // Match on the CG's WORST status, not "contains": the list's Stalled-at
      // column shows the worst, so filtering by containment would render rows
      // whose badge contradicts the active chip.
      if (statusFilter && g.status !== statusFilter) return false;
      if (needle && !`${g.invoiceNum} ${g.custName} ${g.salesperson}`.toLowerCase().includes(needle))
        return false;
      return true;
    });
  }, [report.staleCGs, report.bands, band, q, statusFilter]);

  // Exports the FILTERED set — all of it, not just the 60 rows on screen.
  const exportRows = () =>
    downloadCSV(
      `status-hygiene-${asOf}.csv`,
      ["CG", "Customer", "Rep", "Installed", "Days since install", "Stalled at (worst)", "Lines", "Value"],
      rows.map((g) => [
        g.invoiceNum,
        g.custName,
        g.salesperson,
        g.installDate,
        g.daysSince,
        g.status,
        g.lines,
        Math.round(g.value * 100) / 100,
      ])
    );

  if (report.staleLines === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-white px-6 py-14 text-center">
        <p className="text-base font-semibold text-ink">Nothing stale</p>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
          Every installed job has its material marked received. That&apos;s the state the playbook assumes —
          the status-driven reports can be trusted.
        </p>
      </div>
    );
  }

  const pct = Math.round((100 * report.staleLines) / Math.max(1, report.pastDueMaterial));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Tile
          label="Material never received"
          value={report.staleLines.toLocaleString()}
          sub={`${pct}% of installed material · ${report.staleCGs.length} CGs`}
          flag
          onClick={() => {
            setBand("");
            setQ("");
            setStatusFilter("");
          }}
          clickTitle="Show the full list (clears every filter)"
        />
        <Tile label="Value in limbo" value={money(report.staleValue)} sub="line value on those lines" flag />
        <Tile
          label="Median age"
          value={report.age ? `${report.age.median}d` : "—"}
          sub="since the job was installed"
        />
        <Tile label="Oldest" value={report.age ? `${report.age.max}d` : "—"} sub="since install" flag />
        <Tile
          label="Material ever delivered"
          value={report.materialEverDelivered.toLocaleString()}
          sub={`vs ${report.laborDelivered.toLocaleString()} labor lines — the tell`}
        />
      </div>

      {/* The diagnosis */}
      <div className="rounded-lg border border-crimson/30 bg-white p-4">
        <h3 className="font-label text-[11px] font-semibold uppercase tracking-[0.1em] text-crimson">
          What this is
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          On {report.staleCGs.length.toLocaleString()} jobs that have{" "}
          <span className="font-semibold text-ink">already been installed</span>, the material is still
          sitting at <em>None</em>, <em>Gen PO</em>, or <em>On Order</em> — the system believes it was never
          received. Median{" "}
          <span className="font-semibold text-ink">{report.age?.median ?? 0} days</span> since the crew
          finished.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          The tell is in the last tile:{" "}
          <span className="font-semibold text-ink">
            {report.laborDelivered.toLocaleString()} labor lines
          </span>{" "}
          have reached <em>Delivered</em>, but only{" "}
          <span className="font-semibold text-crimson">
            {report.materialEverDelivered.toLocaleString()} material lines
          </span>{" "}
          ever have. The crew&apos;s work gets closed out; the material behind it doesn&apos;t. That&apos;s a
          process gap, not a vendor backlog — the floors are down.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          <span className="font-semibold text-ink">Why it costs money:</span> material stuck pre-receipt
          overstates what you still owe vendors and understates what&apos;s been consumed, Close Out
          can&apos;t find the work to bill, and every status-driven report in the playbook — aged Gen PO,
          On Order past due, unbilled Delivered — reads fiction until this is cleared.
        </p>
      </div>

      {/* Aging bands */}
      <div>
        <h3 className="font-label mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          How far behind
        </h3>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          {report.bands.map((b) => {
            const on = band === b.label;
            const share = report.staleValue ? (100 * b.value) / report.staleValue : 0;
            return (
              <button
                key={b.label}
                onClick={() => setBand(on ? "" : b.label)}
                aria-pressed={on}
                disabled={b.cgs === 0}
                className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-40 ${
                  on ? "border-crimson bg-paper-tint" : "border-line bg-white hover:border-stone"
                }`}
              >
                <span className="font-label text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
                  {b.label}
                </span>
                <span className="text-lg font-bold tabular-nums text-ink">{b.cgs}</span>
                <span className="text-[10.5px] text-muted-soft">
                  {b.lines} lines · {money(b.value)}
                </span>
                <span className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-paper-soft">
                  <span
                    className="block h-full"
                    style={{ width: `${share}%`, background: b.lo >= 91 ? "#9e2335" : "#b3761e" }}
                  />
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-soft">
          CGs by days since install. Click a band to filter the list. The bar is that band&apos;s share of
          the {money(report.staleValue)} total.
        </p>
      </div>

      {/* Where it stalled */}
      <div className="flex flex-wrap items-center gap-3 border-y border-line py-3">
        <span className="font-label text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
          Stalled at
        </span>
        {report.byStatus.map((s) => {
          const on = statusFilter === s.status;
          return (
            <button
              key={s.status}
              onClick={() => setStatusFilter(on ? "" : s.status)}
              aria-pressed={on}
              title={`Show CGs whose worst line is stalled at ${s.status}`}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                on ? "border-ink bg-paper-tint" : "border-transparent hover:border-line"
              }`}
            >
              <span className="h-2 w-2 rounded-sm" style={{ background: STATUS_COLOR[s.status] }} />
              <span className="font-medium text-ink">{s.status}</span>
              <span className="tabular-nums text-muted">
                {s.lines.toLocaleString()} lines · {money(s.value)}
              </span>
            </button>
          );
        })}
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search CG, customer, rep…"
          aria-label="Search"
          className="ml-auto min-w-[190px] rounded-md border border-line bg-white px-2.5 py-1.5 text-xs text-ink placeholder:text-muted-soft"
        />
        <ExportButton onClick={exportRows} />
        <span className="text-[11px] tabular-nums text-muted">
          {rows.length} CG{rows.length === 1 ? "" : "s"} ·{" "}
          {money(rows.reduce((a, g) => a + g.value, 0))}
        </span>
      </div>

      {/* The list */}
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="bg-paper-soft">
              {["CG", "Customer", "Rep", "Installed", "Days ago", "Stalled at", "Lines", "Value"].map(
                (h, i) => (
                  <th
                    key={h}
                    className={`font-label px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted ${
                      i >= 4 ? "text-right" : "text-left"
                    }`}
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((g) => (
              <tr key={g.invoiceNum} className="border-b border-line/50 last:border-0 hover:bg-paper-soft">
                <td className="px-3 py-1.5 text-xs font-semibold tabular-nums text-ink">{g.invoiceNum}</td>
                <td className="max-w-[200px] truncate px-3 py-1.5 text-xs text-ink" title={g.custName}>
                  {g.custName}
                </td>
                <td className="px-3 py-1.5 text-xs text-muted">{g.salesperson || "—"}</td>
                <td className="px-3 py-1.5 text-xs tabular-nums text-muted">{fmtDate(g.installDate)}</td>
                <td
                  className="px-3 py-1.5 text-right text-xs font-semibold tabular-nums"
                  style={{ color: g.daysSince >= 91 ? "#9e2335" : "#5a606b" }}
                >
                  {g.daysSince}
                </td>
                <td className="px-3 py-1.5 text-right text-xs">
                  <span
                    className="font-label rounded border px-1.5 py-px text-[10px] font-semibold uppercase"
                    style={{ color: STATUS_COLOR[g.status], borderColor: STATUS_COLOR[g.status] }}
                  >
                    {g.status}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted-soft">{g.lines}</td>
                <td className="px-3 py-1.5 text-right text-xs tabular-nums text-ink">
                  {g.value ? money(g.value) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 60 ? (
        <p className="text-[11px] text-muted-soft">
          Showing the 60 oldest of {rows.length.toLocaleString()}. Filter by band or search to narrow.
        </p>
      ) : null}
    </div>
  );
}
