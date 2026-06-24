"use client";

import { useMemo, useState } from "react";

export type ActivityEvent = {
  userId: string;
  path: string;
  at: string;
  clientId: string | null;
};
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

function tally(events: ActivityEvent[], key: (e: ActivityEvent) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const e of events) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function Bars({ rows, label }: { rows: [string, number][]; label: string }) {
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
                <div className="h-full rounded-full bg-navy-2" style={{ width: `${(count / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HourChart({ counts }: { counts: number[] }) {
  const max = Math.max(...counts, 1);
  const fmtHour = (h: number) => {
    const am = h < 12;
    const base = h % 12 === 0 ? 12 : h % 12;
    return `${base}${am ? "a" : "p"}`;
  };
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h3 className="text-sm font-bold text-ink">Most-active hours</h3>
      <div className="mt-4 flex h-28 items-end gap-[3px]">
        {counts.map((c, h) => (
          <div key={h} className="group relative flex-1" title={`${fmtHour(h)}: ${c}`}>
            <div
              className="w-full rounded-t-sm bg-navy-2"
              style={{ height: `${(c / max) * 100}%`, minHeight: c > 0 ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-soft">
        <span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span>
      </div>
    </div>
  );
}

export function AdminAnalytics({
  events,
  names,
  clientNames,
}: {
  events: ActivityEvent[];
  names: Record<string, string>;
  clientNames: Record<string, string>;
}) {
  const [range, setRange] = useState<Range>("7d");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const { start, end } = useMemo(() => bounds(range), [range]);

  const inRange = useMemo(
    () =>
      events.filter((e) => {
        const t = new Date(e.at).getTime();
        if (t < start || t >= end) return false;
        if (clientFilter !== "all" && e.clientId !== clientFilter) return false;
        return true;
      }),
    [events, start, end, clientFilter]
  );

  const byUser = useMemo(() => tally(inRange, (e) => names[e.userId] ?? "Unknown"), [inRange, names]);
  const byPage = useMemo(() => tally(inRange, (e) => pageLabel(e.path)), [inRange]);
  const byClient = useMemo(
    () => tally(inRange, (e) => (e.clientId ? clientNames[e.clientId] ?? "Unknown client" : "No client")),
    [inRange, clientNames]
  );
  const hours = useMemo(() => {
    const arr = new Array(24).fill(0) as number[];
    for (const e of inRange) arr[new Date(e.at).getHours()] += 1;
    return arr;
  }, [inRange]);

  const totalViews = inRange.length;
  const activeUsers = new Set(inRange.map((e) => e.userId)).size;

  const clientOptions = Object.entries(clientNames).sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="px-6 py-5">
      <div className="flex flex-wrap items-center gap-3">
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
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100"
          aria-label="Filter by client"
        >
          <option value="all">All clients</option>
          {clientOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Bars rows={byClient} label="Activity by client" />
        <HourChart counts={hours} />
      </div>
    </div>
  );
}
