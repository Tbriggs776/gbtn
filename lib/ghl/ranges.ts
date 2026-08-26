// Date-range presets for the Conversations views.
//
// Pure and dependency-free so the server page can resolve a window once and the
// picker (a client component) only needs to know the KEYS. Day boundaries are
// computed in the client's timezone (Phoenix, UTC-7, no DST — the same fixed
// offset lib/ghl/metrics.ts uses) so "today"/"this month" line up with what the
// showroom actually sees, not with the server's UTC clock.

const PHX_OFFSET_MS = 7 * 60 * 60 * 1000; // Phoenix is UTC-7, no DST.

export type RangeKey =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thismonth"
  | "lastmonth"
  | "custom";

export type ResolvedRange = { key: RangeKey; label: string; from: Date; to: Date };

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "last30", label: "Last 30 days" },
  { key: "thismonth", label: "This month" },
  { key: "lastmonth", label: "Last month" },
  { key: "custom", label: "Custom" },
];

export const DEFAULT_RANGE: RangeKey = "last30";

/** Midnight (Phoenix local) of the day containing `d`, as a UTC instant. */
function phxStartOfDay(d: Date): Date {
  const shifted = new Date(d.getTime() - PHX_OFFSET_MS); // into Phoenix wall-clock
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() + PHX_OFFSET_MS); // back to real UTC
}

/** First day of the Phoenix-local month containing `d`, as a UTC instant. */
function phxStartOfMonth(d: Date): Date {
  const shifted = new Date(d.getTime() - PHX_OFFSET_MS);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() + PHX_OFFSET_MS);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

const MONTH = { timeZone: "America/Phoenix", month: "long" } as const;
const DAY = { timeZone: "America/Phoenix", month: "short", day: "numeric" } as const;

/**
 * Resolve a range key (and, for "custom", two YYYY-MM-DD strings) into a
 * concrete [from, to] window plus a human label. Unknown keys and malformed
 * custom dates fall back to the default range, so a hand-edited URL can't 500.
 */
export function resolveRange(
  key: string | undefined,
  now: Date,
  customFrom?: string,
  customTo?: string
): ResolvedRange {
  const startToday = phxStartOfDay(now);

  switch (key) {
    case "today":
      return { key: "today", label: "Today", from: startToday, to: now };

    case "yesterday": {
      const start = addDays(startToday, -1);
      return { key: "yesterday", label: "Yesterday", from: start, to: startToday };
    }

    case "last7":
      return { key: "last7", label: "Last 7 days", from: addDays(now, -7), to: now };

    case "last30":
      return { key: "last30", label: "Last 30 days", from: addDays(now, -30), to: now };

    case "thismonth": {
      const start = phxStartOfMonth(now);
      return {
        key: "thismonth",
        label: new Intl.DateTimeFormat("en-US", MONTH).format(now),
        from: start,
        to: now,
      };
    }

    case "lastmonth": {
      const thisMonth = phxStartOfMonth(now);
      const start = phxStartOfMonth(addDays(thisMonth, -1));
      return {
        key: "lastmonth",
        label: new Intl.DateTimeFormat("en-US", MONTH).format(start),
        from: start,
        to: thisMonth,
      };
    }

    case "custom": {
      const from = parseDay(customFrom);
      const to = parseDay(customTo);
      if (from && to && from.getTime() <= to.getTime()) {
        // Inclusive of the end day: run to the START of the following day.
        const end = addDays(to, 1);
        const fmt = new Intl.DateTimeFormat("en-US", DAY);
        return { key: "custom", label: `${fmt.format(from)} – ${fmt.format(to)}`, from, to: end };
      }
      break; // malformed → fall through to default
    }
  }

  return resolveRange(DEFAULT_RANGE, now);
}

/** A YYYY-MM-DD string → Phoenix-local midnight of that day, or null. */
function parseDay(s?: string): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + PHX_OFFSET_MS); // interpret the wall-clock date as Phoenix
}
