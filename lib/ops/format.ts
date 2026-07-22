// Pure formatters for the Ops reports. Deliberately NOT in components/portal/ops/shared.tsx:
// that file is "use client", and importing a client-marked function into a server
// component throws at runtime ("attempted to call fmtDate() from the server").
// These are plain functions with no React, so both sides can use them.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 'YYYY-MM-DD' -> 'Jul 16 26'. String surgery: no Date, so no timezone shift. */
export function fmtDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${MONTHS[+m - 1]} ${+day} ${y.slice(2)}`;
}

/** 'YYYY-MM-01' -> 'Jul 2026'. */
export function fmtMonth(d: string): string {
  const [y, m] = d.split("-");
  return `${MONTHS[+m - 1]} ${y}`;
}

export function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * imported_at is a real instant, not a date string, so it has to be rendered in
 * a stated timezone. These pages render on the server, and Vercel runs in UTC —
 * so an import done at 4pm in Arizona came back stamped the following day.
 * Pinned to Phoenix (the client's timezone, and no DST to reason about) rather
 * than the server's, so the header agrees with the person who clicked import.
 */
export function fmtImported(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Phoenix" });
}
