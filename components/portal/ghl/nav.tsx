"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Secondary menu for the Conversations section. Mirrors the Ops Reports nav:
 * these are peers you switch between while working, so they read better as tabs
 * than as a fly-out.
 */

const VIEWS = [
  {
    href: "/portal/conversations",
    label: "Overview",
    blurb: "How fast leads get answered, and how many don't",
    exact: true,
  },
  {
    href: "/portal/conversations/coaching",
    label: "Coaching",
    blurb: "Per-salesperson scorecards and AI review",
    exact: false,
  },
  {
    href: "/portal/conversations/threads",
    label: "Threads",
    blurb: "Read the conversations behind the numbers",
    exact: false,
  },
] as const;

export function ConversationsNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const client = searchParams.get("client");

  const href = (h: string) => (client ? `${h}?client=${client}` : h);

  return (
    <nav
      aria-label="Conversation views"
      className="-mb-px flex gap-1 overflow-x-auto border-b border-line"
    >
      {VIEWS.map((v) => {
        // The overview sits at the section root, so a prefix match would light
        // it up on every child route.
        const active = v.exact ? pathname === v.href : pathname.startsWith(v.href);
        return (
          <Link
            key={v.href}
            href={href(v.href)}
            aria-current={active ? "page" : undefined}
            title={v.blurb}
            className={`font-label whitespace-nowrap border-b-2 px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] transition-colors ${
              active
                ? "border-crimson text-ink"
                : "border-transparent text-muted hover:border-line hover:text-ink"
            }`}
          >
            {v.label}
          </Link>
        );
      })}
    </nav>
  );
}
