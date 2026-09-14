import Link from "next/link";
import { HomeSection } from "./section";

// Prove: compact links into the portal surfaces where the evidence already
// lives. No new report engine. The page decides which items a viewer gets using
// the same capability each target page passes to requireCapability, so no link
// here ever bounces.

export type ProveItem = {
  key: "financials" | "documents" | "briefing" | "fpa";
  href: string;
  title: string;
  stat?: string;
  statLabel?: string;
  body: string;
};

const GRID: Record<number, string> = {
  1: "sm:grid-cols-2",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

export function ProveRail({ items }: { items: ProveItem[] }) {
  if (items.length === 0) return null;
  return (
    <HomeSection id="home-prove" eyebrow="Prove · Reports and records">
      <div className={`grid gap-4 ${GRID[items.length] ?? "sm:grid-cols-2"}`}>
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="group flex flex-col rounded-2xl border border-line bg-white p-5 ring-soft transition-all hover:-translate-y-0.5 hover:ring-card"
          >
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-soft">{item.title}</h3>
              <span aria-hidden="true" className="text-brand-600 transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </div>
            {item.stat != null ? (
              <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
                <span className="text-gradient">{item.stat}</span>{" "}
                <span className="text-sm font-medium text-muted">{item.statLabel}</span>
              </p>
            ) : null}
            <p className="mt-1.5 text-sm text-muted">{item.body}</p>
          </Link>
        ))}
      </div>
    </HomeSection>
  );
}
