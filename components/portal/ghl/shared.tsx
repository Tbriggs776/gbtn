"use client";

import type { ReactNode } from "react";

/** A headline number. Mirrors the Ops report tile so the two sections read as
 *  one product rather than two. */
export function Tile({
  label,
  value,
  sub,
  flag = false,
}: {
  label: string;
  value: string | number;
  sub?: string;
  /** Draws attention to a number that represents lost work, not just a stat. */
  flag?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-lg border bg-white px-3.5 py-3 ${
        flag ? "border-crimson/40" : "border-line"
      }`}
    >
      <span className="font-label text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
        {label}
      </span>
      <span
        className={`text-2xl font-bold tabular-nums tracking-tight ${flag ? "text-crimson" : "text-ink"}`}
      >
        {value}
      </span>
      {sub ? <span className="text-[11px] leading-snug text-muted-soft">{sub}</span> : null}
    </div>
  );
}

export function Panel({
  title,
  hint,
  children,
  actions,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-label text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            {title}
          </h2>
          {hint ? <p className="mt-1 text-[11.5px] leading-snug text-muted-soft">{hint}</p> : null}
        </div>
        {actions}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Th({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      className={`font-label border-b border-line px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  right = false,
  flag = false,
}: {
  children: ReactNode;
  right?: boolean;
  flag?: boolean;
}) {
  return (
    <td
      className={`border-b border-line/60 px-2.5 py-2 text-[13px] ${right ? "text-right tabular-nums" : ""} ${
        flag ? "font-semibold text-crimson" : "text-ink"
      }`}
    >
      {children}
    </td>
  );
}
