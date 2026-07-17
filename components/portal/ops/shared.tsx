"use client";

import type { LineStatus } from "@/lib/ops/csv-import";

/**
 * Status vocabulary shared by both Ops reports, so a colour means the same thing
 * on the board, the calendar, and the capacity chart.
 *
 * These are semantic (a material-readiness ramp: unordered -> delivered), which
 * is why they're their own scale rather than the navy/crimson brand palette.
 */
export const STATUS_COLOR: Record<LineStatus, string> = {
  None: "#b3313f",
  GenPO: "#b3761e",
  OnOrder: "#2f6ea8",
  Cut: "#6a5aa8",
  Del: "#2f7d57",
  Resvd: "#3f8a8a",
};

export const STATUS_HELP: Record<LineStatus, string> = {
  None: "No PO raised yet",
  GenPO: "PO generated, not sent",
  OnOrder: "On order with the supplier",
  Cut: "Cut / allocated from stock",
  Del: "Delivered — ready to install",
  Resvd: "Reserved stock",
};

export function StatusBadge({ status }: { status: LineStatus }) {
  return (
    <span
      title={STATUS_HELP[status]}
      className="font-label inline-flex rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em]"
      style={{ color: STATUS_COLOR[status], borderColor: STATUS_COLOR[status] }}
    >
      {status}
    </span>
  );
}

export function Tile({
  label,
  value,
  sub,
  flag = false,
  onClick,
  active = false,
  clickTitle,
}: {
  label: string;
  value: string | number;
  sub?: string;
  flag?: boolean;
  /** Makes the tile a drill-through: shows the CGs behind the number. */
  onClick?: () => void;
  active?: boolean;
  clickTitle?: string;
}) {
  const frame = `flex flex-col gap-0.5 rounded-lg border bg-white px-3.5 py-3 ${
    active ? "border-ink bg-paper-tint" : flag ? "border-crimson/40" : "border-line"
  }`;
  const inner = (
    <>
      <span className="font-label text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
        {label}
      </span>
      <span
        className={`text-2xl font-bold tabular-nums tracking-tight ${flag ? "text-crimson" : "text-ink"}`}
      >
        {value}
      </span>
      {sub ? <span className="text-[11px] leading-snug text-muted-soft">{sub}</span> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={clickTitle ?? "See the CGs behind this number"}
        className={`${frame} cursor-pointer text-left transition-colors hover:border-ink/50 hover:shadow-sm`}
      >
        {inner}
      </button>
    );
  }
  return <div className={frame}>{inner}</div>;
}

export function ExportButton({ onClick, label = "Export CSV" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-label inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-white px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted transition-colors hover:border-stone hover:text-ink"
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden="true">
        <path
          d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </button>
  );
}

// Formatters live in lib/ops/format.ts — plain functions, imported directly by
// both the server pages and the client components. Nothing to re-export here:
// routing them back through this "use client" module would turn them into
// client references and break the server import all over again.
