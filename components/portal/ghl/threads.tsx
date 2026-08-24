"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ConversationRow } from "@/lib/ghl/types";
import { CHANNEL_COLOR, CHANNEL_LABEL, duration, stamp } from "@/lib/ghl/format";
import { Panel, Td, Th } from "./shared";

type Filter = "worst" | "unanswered" | "autoOnly" | "slow" | "all";

const FILTERS: { key: Filter; label: string; blurb: string }[] = [
  { key: "worst", label: "Needs attention", blurb: "Silent leads first, then slowest" },
  { key: "unanswered", label: "Never answered", blurb: "A person wrote in; nobody replied" },
  { key: "autoOnly", label: "Auto-reply only", blurb: "The workflow replied and nobody followed" },
  { key: "slow", label: "Slowest answered", blurb: "Answered eventually — but late" },
  { key: "all", label: "All leads", blurb: "Everything with an inbound message" },
];

/**
 * Thread browser.
 *
 * Filtering happens in the browser over the rows the page already loaded, not
 * through a round trip: the year fits comfortably in memory (a few thousand
 * rows of scalars) and the whole point of this view is flicking between cuts
 * while reading. Transcripts are the expensive part, and those load on demand.
 */
export function Threads({
  rows,
  selectedId,
}: {
  rows: ConversationRow[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("worst");
  const [query, setQuery] = useState("");

  // Selecting a thread is a navigation, not local state: the transcript is
  // fetched on the server, so the id has to live in the URL for it to be
  // fetchable — and that makes a specific thread linkable in a Slack message.
  const select = (id: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("thread", id);
    startTransition(() => router.replace(`?${next.toString()}`, { scroll: false }));
  };

  const filtered = useMemo(() => {
    const leads = rows.filter((r) => !r.outboundOnly && r.inboundCount > 0);
    const base =
      filter === "unanswered"
        ? leads.filter((r) => r.unanswered)
        : filter === "autoOnly"
          ? leads.filter((r) => r.autoRepliedOnly)
          : filter === "slow"
            ? leads
                .filter((r) => r.responseSeconds !== null)
                .sort((a, b) => (b.responseSeconds as number) - (a.responseSeconds as number))
            : filter === "all"
              ? leads
              : // "worst": unanswered first (auto-reply-only worst of all), then
                // slowest. Same ranking the AI coaching pass reads.
                [...leads].sort((a, b) => score(b) - score(a));

    const q = query.trim().toLowerCase();
    if (!q) return base.slice(0, 300);
    return base
      .filter(
        (r) =>
          (r.contactName ?? "").toLowerCase().includes(q) ||
          (r.assignedUserName ?? "").toLowerCase().includes(q)
      )
      .slice(0, 300);
  }, [rows, filter, query]);

  const active = FILTERS.find((f) => f.key === filter);

  return (
    <Panel title="Threads" hint={active?.blurb}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`font-label rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              filter === f.key
                ? "border-ink bg-ink text-white"
                : "border-line text-muted hover:border-ink/40 hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by customer or salesperson"
          className="ml-auto w-60 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink placeholder:text-muted-soft focus:border-ink focus:outline-none"
        />
      </div>

      <div className="max-h-[32rem] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-white">
            <tr>
              <Th>Customer</Th>
              <Th>Channel</Th>
              <Th>Salesperson</Th>
              <Th right>Messages</Th>
              <Th right>Replied in</Th>
              <Th right>Last activity</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                onClick={() => select(r.id)}
                className={`cursor-pointer transition-colors hover:bg-paper-soft ${
                  r.id === selectedId ? "bg-paper-tint" : ""
                }`}
              >
                <Td>{r.contactName ?? "Unknown"}</Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: CHANNEL_COLOR[r.channel] }}
                    />
                    <span className="text-[12px] text-muted">{CHANNEL_LABEL[r.channel]}</span>
                  </span>
                </Td>
                <Td>
                  <span className={r.assignedUserName ? "" : "text-muted-soft"}>
                    {r.assignedUserName ?? "Unassigned"}
                  </span>
                </Td>
                <Td right>
                  {r.inboundCount}/{r.outboundCount}
                </Td>
                <Td right flag={r.unanswered}>
                  {r.autoRepliedOnly
                    ? "auto only"
                    : r.unanswered
                      ? "never"
                      : duration(r.responseSeconds)}
                </Td>
                <Td right>{stamp(r.lastMessageAt)}</Td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <Td>Nothing matches that filter.</Td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] text-muted-soft">
        Showing {filtered.length.toLocaleString()} of{" "}
        {rows.filter((r) => !r.outboundOnly && r.inboundCount > 0).length.toLocaleString()} leads
        {filtered.length === 300 ? " (capped at 300 — narrow the filter to see more)" : ""}
        {pending ? " · loading transcript…" : ""}.
      </p>
    </Panel>
  );
}

function score(r: ConversationRow): number {
  if (r.autoRepliedOnly) return 1_000_000 + r.inboundCount;
  if (r.unanswered) return 900_000 + r.inboundCount;
  return r.responseSeconds ?? 0;
}
