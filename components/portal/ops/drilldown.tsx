"use client";

import { useEffect, useRef } from "react";
import { downloadCSV, type CSVValue } from "@/lib/ops/csv";
import { money } from "@/lib/ops/format";
import { ExportButton } from "./shared";

/**
 * The drill-down drawer: any tile, cell, or chart point that names a set of
 * CGs opens this with the rows behind the number, and every view of it is
 * exportable. Generic on purpose — each report describes its slice with
 * columns + rows, and the CSV mirrors exactly the visible columns but writes
 * the RAW values (dates stay ISO, money stays numeric) so the file is
 * spreadsheet-ready.
 */

export type DrillColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Display-only formatter; the CSV export writes the raw value. */
  format?: (v: CSVValue) => string;
};

export type DrillDataRow = Record<string, CSVValue>;

export type DrillView = {
  title: string;
  subtitle?: string;
  filename: string;
  columns: DrillColumn[];
  rows: DrillDataRow[] | "loading" | "error";
};

export function DrilldownDrawer({ view, onClose }: { view: DrillView | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = view !== null;

  useEffect(() => {
    if (!open) return;
    // aria-modal is a promise: trap Tab inside the panel, lock the page
    // behind it, and put the user back where they were when it closes.
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        const els = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, [tabindex]:not([tabindex="-1"])'
        );
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        const active = document.activeElement;
        if (!active || !panelRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
    // Re-running on row loads would steal focus back to the close button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!view) return null;

  const rows = Array.isArray(view.rows) ? view.rows : null;
  const hasValue = view.columns.some((c) => c.key === "value");
  const total = rows && hasValue ? rows.reduce((a, r) => a + (Number(r.value) || 0), 0) : null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={view.title}>
      <div className="absolute inset-0 bg-navy/25" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col border-l border-line bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold tracking-tight text-ink">{view.title}</h2>
            {view.subtitle ? <p className="mt-0.5 text-xs text-muted">{view.subtitle}</p> : null}
            <p className="mt-1 text-[11px] tabular-nums text-muted-soft">
              {rows
                ? `${rows.length.toLocaleString()} CG${rows.length === 1 ? "" : "s"}${
                    total !== null ? ` · ${money(total)}` : ""
                  }`
                : view.rows === "loading"
                  ? "Loading…"
                  : ""}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            {rows && rows.length > 0 ? (
              <ExportButton
                onClick={() =>
                  downloadCSV(
                    view.filename,
                    view.columns.map((c) => c.label),
                    rows.map((r) => view.columns.map((c) => r[c.key]))
                  )
                }
              />
            ) : null}
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded-md border border-line text-sm text-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          {view.rows === "loading" ? (
            <p className="px-5 py-12 text-center text-sm text-muted">Loading…</p>
          ) : view.rows === "error" ? (
            <p className="px-5 py-12 text-center text-sm text-red-600">
              Couldn&apos;t load this slice. Close the panel and try again.
            </p>
          ) : rows && rows.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted">Nothing in this slice.</p>
          ) : (
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  {view.columns.map((c) => (
                    <th
                      key={c.key}
                      className={`font-label sticky top-0 z-10 bg-paper-soft px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted ${
                        c.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows!.map((r, i) => (
                  <tr
                    key={String(r.invoiceNum ?? i)}
                    className="border-b border-line/50 last:border-0 hover:bg-paper-soft"
                  >
                    {view.columns.map((c) => {
                      const v = r[c.key];
                      const text = c.format
                        ? c.format(v)
                        : v === null || v === undefined || v === ""
                          ? "—"
                          : String(v);
                      return (
                        <td
                          key={c.key}
                          className={`px-3 py-1.5 text-xs tabular-nums ${
                            c.align === "right" ? "text-right" : ""
                          } ${c.key === "invoiceNum" ? "font-semibold text-ink" : "text-muted"}`}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
