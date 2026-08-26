// Aggregate analytics over synced conversations.
//
// Deliberately pure and dependency-free: every function here takes rows and
// returns numbers, so the page can compute once on the server and the same
// helpers stay testable without a database.
//
// The organising idea is that a "conversation" is not the unit anyone cares
// about. A LEAD is — someone who wrote in and is waiting. So almost everything
// below runs over `leadThreads()` rather than the raw set, which drops the
// outbound blasts and the empty shells that would otherwise flatter every
// average.

import type { Channel, ConversationRow } from "./types";

/**
 * Floor Daddy's trading hours, in their local timezone.
 *
 * Pinned to Phoenix for the same reason lib/ops/format.ts is: it's the client's
 * timezone and it has no DST, so a fixed offset is exact rather than merely
 * convenient. If GBTN onboards a client in a DST timezone this must become a
 * per-client setting with a real timezone library — a fixed offset would be
 * wrong for half the year.
 */
export const TIMEZONE = "America/Phoenix";
const UTC_OFFSET_HOURS = -7;

/**
 * Open hours by weekday (0 = Sunday), as local decimal hours. Sunday closed.
 *
 * These are the assumption most likely to be wrong on day one — they're a
 * flooring showroom's typical week, not something the GHL data can tell us.
 * Change them here and every business-hours number follows.
 */
export const BUSINESS_HOURS: Record<number, { open: number; close: number } | null> = {
  0: null, // Sunday
  1: { open: 8, close: 17 },
  2: { open: 8, close: 17 },
  3: { open: 8, close: 17 },
  4: { open: 8, close: 17 },
  5: { open: 8, close: 17 },
  6: { open: 9, close: 14 }, // Saturday
};

/** Response-time buckets, in seconds. The 5-minute line is the one that matters:
 *  it's the industry's standard threshold for lead contact. */
export const FAST_SECONDS = 5 * 60;
export const HOUR_SECONDS = 60 * 60;

// ── Cohorts ──────────────────────────────────────────────────────────────────

/**
 * Threads where the customer reached IN — a lead. That's an inbound message we
 * captured (text, call, chat, email) OR the search index showing the customer
 * initiated (a form or paid-ad lead whose inbound GHL never exposed as a message
 * — see inboundSeen / map.ts searchInbound). Pure outbound-only drips and blasts
 * are still excluded: including them answers "how fast do we reply to ourselves?"
 * and drags every average toward zero.
 */
export function leadThreads(rows: ConversationRow[]): ConversationRow[] {
  return rows.filter((r) => r.inboundCount > 0 || r.inboundSeen);
}

// ── Local time ───────────────────────────────────────────────────────────────

/** Local wall-clock parts for an instant, in the client's timezone. */
export function localParts(iso: string): { day: number; hour: number; minute: number } {
  const d = new Date(Date.parse(iso) + UTC_OFFSET_HOURS * 3_600_000);
  return { day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** Did this land while the showroom was open? */
export function isBusinessHours(iso: string): boolean {
  const { day, hour, minute } = localParts(iso);
  const window = BUSINESS_HOURS[day];
  if (!window) return false;
  const h = hour + minute / 60;
  return h >= window.open && h < window.close;
}

/**
 * Seconds of OPEN time between two instants.
 *
 * Why this exists: a lead who texts at 9pm and gets a call at 8:05am the next
 * morning shows an 11-hour raw response time, and no coaching conversation
 * should start from that number — the rep did nothing wrong. Business-hours
 * elapsed is the number you can actually hold someone to, and the raw one is
 * kept alongside it because it's still what the customer experienced.
 *
 * Walks day by day and intersects each day's open window with the interval.
 * Capped at 30 days: past that the thread is a dead lead, not a slow reply, and
 * an unbounded walk on a bad timestamp would be a hang.
 */
export function businessSecondsBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;

  const DAY = 86_400_000;
  if (end - start > 30 * DAY) return businessSecondsBetween(startIso, new Date(start + 30 * DAY).toISOString());

  let total = 0;
  // Step in local days: shift into local time, floor to midnight, shift back.
  const offsetMs = UTC_OFFSET_HOURS * 3_600_000;
  let cursor = Math.floor((start + offsetMs) / DAY) * DAY - offsetMs;

  for (let i = 0; i < 32 && cursor < end; i++, cursor += DAY) {
    const day = new Date(cursor + offsetMs).getUTCDay();
    const window = BUSINESS_HOURS[day];
    if (!window) continue;

    const openAt = cursor + window.open * 3_600_000;
    const closeAt = cursor + window.close * 3_600_000;
    const from = Math.max(start, openAt);
    const to = Math.min(end, closeAt);
    if (to > from) total += (to - from) / 1000;
  }
  return Math.round(total);
}

// ── Distribution helpers ─────────────────────────────────────────────────────

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/** Nearest-rank percentile. Null on an empty set rather than 0 — "no data" and
 *  "instant" must never render as the same number. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

// ── Summary ──────────────────────────────────────────────────────────────────

export type Summary = {
  threads: number;
  leads: number;
  answered: number;
  unanswered: number;
  autoRepliedOnly: number;
  messages: number;
  medianResponse: number | null;
  p90Response: number | null;
  medianBusinessResponse: number | null;
  withinFive: number;
  withinHour: number;
  afterHoursLeads: number;
  /** Share of leads a person answered at all, 0–1. */
  answerRate: number;
  /** Share of answered leads hit inside five minutes, 0–1. */
  fastRate: number;
};

export function summarize(rows: ConversationRow[]): Summary {
  const leads = leadThreads(rows);
  const answered = leads.filter((r) => r.responseSeconds !== null);
  const raw = answered.map((r) => r.responseSeconds as number);
  const business = answered
    .filter((r) => r.firstInboundAt && r.firstResponseAt)
    .map((r) => businessSecondsBetween(r.firstInboundAt as string, r.firstResponseAt as string));

  return {
    threads: rows.length,
    leads: leads.length,
    answered: answered.length,
    unanswered: leads.filter((r) => r.unanswered).length,
    autoRepliedOnly: leads.filter((r) => r.autoRepliedOnly).length,
    messages: rows.reduce((n, r) => n + r.messageCount, 0),
    medianResponse: median(raw),
    p90Response: percentile(raw, 90),
    medianBusinessResponse: median(business),
    withinFive: raw.filter((s) => s <= FAST_SECONDS).length,
    withinHour: raw.filter((s) => s <= HOUR_SECONDS).length,
    afterHoursLeads: leads.filter((r) => r.firstInboundAt && !isBusinessHours(r.firstInboundAt)).length,
    answerRate: leads.length === 0 ? 0 : answered.length / leads.length,
    fastRate: raw.length === 0 ? 0 : raw.filter((s) => s <= FAST_SECONDS).length / raw.length,
  };
}

// ── Breakdowns ───────────────────────────────────────────────────────────────

export type RepStats = {
  rep: string;
  leads: number;
  answered: number;
  unanswered: number;
  medianResponse: number | null;
  medianBusinessResponse: number | null;
  withinFive: number;
  fastRate: number;
  answerRate: number;
  messagesSent: number;
};

/**
 * Per-rep scorecard.
 *
 * Threads with no owner are grouped under "Unassigned" rather than dropped:
 * they are usually the WORST threads (nobody picked them up, so nobody got
 * credited), and hiding them would remove the finding from the report.
 */
export function byRep(rows: ConversationRow[]): RepStats[] {
  const groups = new Map<string, ConversationRow[]>();
  for (const r of leadThreads(rows)) {
    const key = r.assignedUserName?.trim() || "Unassigned";
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out: RepStats[] = [];
  for (const [rep, list] of groups) {
    const answered = list.filter((r) => r.responseSeconds !== null);
    const raw = answered.map((r) => r.responseSeconds as number);
    const business = answered
      .filter((r) => r.firstInboundAt && r.firstResponseAt)
      .map((r) => businessSecondsBetween(r.firstInboundAt as string, r.firstResponseAt as string));

    out.push({
      rep,
      leads: list.length,
      answered: answered.length,
      unanswered: list.filter((r) => r.unanswered).length,
      medianResponse: median(raw),
      medianBusinessResponse: median(business),
      withinFive: raw.filter((s) => s <= FAST_SECONDS).length,
      fastRate: raw.length === 0 ? 0 : raw.filter((s) => s <= FAST_SECONDS).length / raw.length,
      answerRate: list.length === 0 ? 0 : answered.length / list.length,
      messagesSent: list.reduce((n, r) => n + r.outboundCount, 0),
    });
  }

  // Busiest first: the rep handling 400 leads is the one worth coaching, even
  // if a colleague with 3 leads has a prettier median.
  return out.sort((a, b) => b.leads - a.leads);
}

export type ChannelStats = {
  channel: Channel;
  leads: number;
  unanswered: number;
  medianResponse: number | null;
};

export function byChannel(rows: ConversationRow[]): ChannelStats[] {
  const groups = new Map<Channel, ConversationRow[]>();
  for (const r of leadThreads(rows)) {
    const list = groups.get(r.channel) ?? [];
    list.push(r);
    groups.set(r.channel, list);
  }
  return [...groups.entries()]
    .map(([channel, list]) => ({
      channel,
      leads: list.length,
      unanswered: list.filter((r) => r.unanswered).length,
      medianResponse: median(
        list.filter((r) => r.responseSeconds !== null).map((r) => r.responseSeconds as number)
      ),
    }))
    .sort((a, b) => b.leads - a.leads);
}

export type MonthStats = {
  /** 'YYYY-MM' */
  month: string;
  leads: number;
  answered: number;
  unanswered: number;
  medianResponse: number | null;
};

/** Month-by-month trend, keyed on when the LEAD arrived, not when it closed. */
export function byMonth(rows: ConversationRow[]): MonthStats[] {
  const groups = new Map<string, ConversationRow[]>();
  for (const r of leadThreads(rows)) {
    const at = r.firstInboundAt ?? r.dateAdded;
    if (!at) continue;
    // Bucket on local time: a 6pm Phoenix lead on the 31st is that month's, not
    // the next month's, which is what UTC slicing would say.
    const local = new Date(Date.parse(at) + UTC_OFFSET_HOURS * 3_600_000);
    const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .map(([month, list]) => ({
      month,
      leads: list.length,
      answered: list.filter((r) => r.responseSeconds !== null).length,
      unanswered: list.filter((r) => r.unanswered).length,
      medianResponse: median(
        list.filter((r) => r.responseSeconds !== null).map((r) => r.responseSeconds as number)
      ),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

export type HourStats = { hour: number; leads: number; unanswered: number };

/**
 * When leads arrive, by local hour. Read against BUSINESS_HOURS this answers
 * the staffing question directly: if a fifth of the year's leads land after
 * close and most of those go unanswered, that's a coverage decision, not a
 * coaching one.
 */
export function byHour(rows: ConversationRow[]): HourStats[] {
  const leads = leadThreads(rows);
  const buckets: HourStats[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    leads: 0,
    unanswered: 0,
  }));
  for (const r of leads) {
    if (!r.firstInboundAt) continue;
    const { hour } = localParts(r.firstInboundAt);
    buckets[hour].leads++;
    if (r.unanswered) buckets[hour].unanswered++;
  }
  return buckets;
}

/**
 * The threads worth reading. Ranked by how much they'd change if handled
 * differently: silent leads first, then auto-reply-only, then the slowest
 * answered ones. This is what the AI coaching pass gets fed, and what a manager
 * should open on a Monday.
 */
export function worstThreads(rows: ConversationRow[], limit = 25): ConversationRow[] {
  const score = (r: ConversationRow): number => {
    if (r.autoRepliedOnly) return 1_000_000 + r.inboundCount;
    if (r.unanswered) return 900_000 + r.inboundCount;
    return r.responseSeconds ?? 0;
  };
  return [...leadThreads(rows)].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/** Threads that went well — the coaching pass needs both, or its advice is
 *  generic scolding rather than "do what you did on this one". */
export function bestThreads(rows: ConversationRow[], limit = 10): ConversationRow[] {
  return leadThreads(rows)
    .filter((r) => r.responseSeconds !== null && r.inboundCount >= 2 && r.outboundCount >= 2)
    .sort((a, b) => (a.responseSeconds as number) - (b.responseSeconds as number))
    .slice(0, limit);
}
