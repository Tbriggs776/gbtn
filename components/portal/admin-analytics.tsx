"use client";

import { useMemo, useState } from "react";

export type ActivityEvent = { userId: string; path: string; at: string };
type Range = "today" | "yesterday" | "7d" | "mtd" | "30d";

const RANGES: { key: Range; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "mtd", label: "MTD" },
  { key: "30d", label: "Last 30 days" },
];

const PAGE_LABELS: { prefix: string; label: string }[] = [
  { prefix: "/portal/documents", label: "Documents" },
  { prefix: "/portal/financials", label: "Financials" },
  { prefix: "/portal/marketing", label: "Marketing" },
  { prefix: "/portal/operational-levers", label: "Operational Levers" },
  { prefix: "/portal/settings", label: "Settings" },
  { prefix: "/portal/account", label: "Account" },
  { prefix: "/portal/admin", label: "Admin" },
];

function pageLabel(path: string): string {
  if (path === "/portal") return "Overview";
  const m = PAGE_LABELS.find((p) => path.startsWith(p.prefix));
  return m ? m.label : path;
}

function bounds(range: Range): { start: number; end: number } {
  const now = new Date();
  const end = now.getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  switch (range) {
    case "today":
      return { start: startOfToday, end };
    case "yesterday":
      return { start: startOfToday - 86_400_000, end: startOfToday };
    case "7d":
      return { start: end - 7 * 86_400_000, end };
    case "mtd":
      return { start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end };
    case "30d":
      return { start: end - 30 * 86_400_000, end };
  }
}

function tally(events: ActivityEvent[], key: (e: ActivityEvent) => string) {
  const m = new Map<string, number>();
  for (const e of events) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function Bars({
  rows,
  label,
}: {
  rows: [string, number][];
  label: string;
}) {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h3 className="text-sm font-bold text-ink">{label}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-soft">No activity in this range.</p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {rows.slice(0, 10).map(([name, count]) => (
            <div key={name}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="truncate pr-2 text-ink">{name}</span>
                <span className="font-semibold text-muted">{count}</span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-paper-soft">
                <div
                  className="h-full rounded-full bg-navy-2"
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminAnalytics({
  events,
  names,
}: {
  events: ActivityEvent[];
  names: Record<string, string>;
}) {
  const [range, setRange] = useState<Range>("7d");
  const { start, end } = useMemo(() => bounds(range), [range]);

  const inRange = useMemo(
    () =>
      events.filter((e) => {
        const t = new Date(e.at).getTime();
        return t >= start && t < end;
      }),
    [events, start, end]
  );

  const byUser = useMemo(
    () => tally(inRange, (e) => names[e.userId] ?? "Unknown").map(([n, c]) => [n, c] as [string, number]),
    [inRange, names]
  );
  const byPage = useMemo(() => tally(inRange, (e) => pageLabel(e.path)), [inRange]);

  const totalViews = inRange.length;
  const activeUsers = new Set(inRange.map((e) => e.userId)).size;

  return (
    <div className="px-6 py-5">
      <div className="inline-flex flex-wrap rounded-lg border border-line bg-white p-1 ring-soft">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              range === r.key ? "bg-ink text-cream" : "text-muted hover:text-ink"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">Active users</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
            <span className="text-gradient">{activeUsers}</span>
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">Page views</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
            <span className="text-gradient">{totalViews.toLocaleString()}</span>
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Bars rows={byUser} label="Who's using it (by user)" />
        <Bars rows={byPage} label="What's used most (by page)" />
      </div>
    </div>
  );
}
