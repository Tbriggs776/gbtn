"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Secondary menu for the Ops Reports section. Sits under the page header rather
 * than nesting inside the sidebar: the reports are peers you switch between
 * while working, so they read better as tabs than as a fly-out.
 */

const REPORTS = [
  {
    href: "/portal/ops-reports/install-pipeline",
    label: "Install Pipeline",
    blurb: "What's scheduled and whether the material is ready",
  },
  {
    href: "/portal/ops-reports/orders-pipeline",
    label: "Orders Pipeline",
    blurb: "Order volume by day, week, and month",
  },
] as const;

export function OpsReportsNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const client = searchParams.get("client");

  const href = (h: string) => (client ? `${h}?client=${client}` : h);

  return (
    <nav aria-label="Ops reports" className="-mb-px flex gap-1 overflow-x-auto border-b border-line">
      {REPORTS.map((r) => {
        const active = pathname.startsWith(r.href);
        return (
          <Link
            key={r.href}
            href={href(r.href)}
            aria-current={active ? "page" : undefined}
            title={r.blurb}
            className={`font-label whitespace-nowrap border-b-2 px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] transition-colors ${
              active
                ? "border-crimson text-ink"
                : "border-transparent text-muted hover:border-line hover:text-ink"
            }`}
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
