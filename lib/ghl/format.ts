// Pure formatters for the Conversations reports. Deliberately NOT in a
// "use client" file — server components render most of these, and importing a
// client-marked function from the server throws at runtime. Same reasoning as
// lib/ops/format.ts.

import type { Channel } from "./types";

/**
 * A duration a person can read at a glance. Deliberately coarse above an hour:
 * the difference between 4.2h and 4.4h never changes a decision, and the extra
 * precision just makes a table harder to scan.
 */
export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) {
    const h = seconds / 3600;
    return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
  }
  const d = seconds / 86_400;
  return d < 10 ? `${d.toFixed(1)}d` : `${Math.round(d)}d`;
}

export function percent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Share of a total, guarding the empty case — 0/0 is "—", never "0%". */
export function share(n: number, total: number): string {
  if (total === 0) return "—";
  return percent(n / total);
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  sms: "Text",
  email: "Email",
  call: "Call",
  chat: "Chat / DM",
  other: "Other",
};

/**
 * Channel colours. Their own scale rather than the brand palette, for the same
 * reason the ops status colours are: these encode a category, and reusing brand
 * navy/crimson here would imply a judgement the channel doesn't carry.
 */
export const CHANNEL_COLOR: Record<Channel, string> = {
  sms: "#2f6ea8",
  email: "#6a5aa8",
  call: "#2f7d57",
  chat: "#b3761e",
  other: "#8a8a8a",
};

/**
 * Lead source = the channel a lead came in on, PLUS "form" for the form/ad leads
 * that GHL records without a message we can pull (see metrics.ts sourceOf). It's
 * the channel breakdown with the form/ad leads split out of "Other", so you can
 * see where the newly-counted leads actually come from.
 */
export const SOURCE_LABEL: Record<string, string> = {
  sms: "Text",
  email: "Email",
  call: "Call",
  chat: "Chat / DM",
  form: "Form / Ad",
  other: "Other",
};

export const SOURCE_COLOR: Record<string, string> = {
  sms: "#2f6ea8",
  email: "#6a5aa8",
  call: "#2f7d57",
  chat: "#b3761e",
  form: "#b3313f",
  other: "#8a8a8a",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 'YYYY-MM' -> 'Jul 26'. String surgery: no Date, so no timezone shift. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[+m - 1]} ${y.slice(2)}`;
}

/** Local hour (0–23) -> '9a' / '2p'. */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

/**
 * An instant, rendered in the client's timezone.
 *
 * These pages render on the server and Vercel runs in UTC, so an unqualified
 * toLocaleString would date a 6pm Phoenix message to the next day. Pinned for
 * the same reason lib/ops/format.ts is.
 */
export function stamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function dateStamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
