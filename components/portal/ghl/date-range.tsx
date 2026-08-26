"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RANGE_OPTIONS, type RangeKey } from "@/lib/ghl/ranges";

/**
 * Date-range picker for the Conversations views. Preset chips plus a custom
 * two-date form. State lives entirely in the URL (?range, &from, &to) so the
 * server component re-resolves the window and re-queries — no client data fetch,
 * and the choice survives a refresh or a shared link.
 */
export function DateRange({
  current,
  from,
  to,
}: {
  current: RangeKey;
  /** Current custom bounds (YYYY-MM-DD), to seed the inputs. */
  from?: string;
  to?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [showCustom, setShowCustom] = useState(current === "custom");
  const [customFrom, setCustomFrom] = useState(from ?? "");
  const [customTo, setCustomTo] = useState(to ?? "");

  function apply(next: Record<string, string | null>) {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    // Preserve the selected client and any open thread; drop nothing else.
    router.push(`${pathname}?${q.toString()}`);
  }

  function pick(key: RangeKey) {
    if (key === "custom") {
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    apply({ range: key, from: null, to: null });
  }

  const today = todayInPhoenix();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {RANGE_OPTIONS.map((opt) => {
          const active = opt.key === "custom" ? showCustom || current === "custom" : current === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => pick(opt.key)}
              aria-pressed={active}
              className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                active
                  ? "border-ink bg-ink text-white"
                  : "border-line bg-white text-muted hover:border-ink/30 hover:text-ink"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {showCustom ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white px-3 py-2.5">
          <label className="flex flex-col gap-1">
            <span className="font-label text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
              From
            </span>
            <input
              type="date"
              value={customFrom}
              max={customTo || today}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1 text-[13px] text-ink focus:border-ink focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-label text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
              To
            </span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              max={today}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-line bg-white px-2 py-1 text-[13px] text-ink focus:border-ink focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={!customFrom || !customTo || customFrom > customTo}
            onClick={() => apply({ range: "custom", from: customFrom, to: customTo })}
            className="rounded-md border border-ink bg-ink px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Today's date as YYYY-MM-DD in Phoenix, to cap the date inputs at today. */
function todayInPhoenix(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
