import "server-only";
import * as XLSX from "xlsx";

// Parses a marketing revenue workbook into dated, per-channel revenue rows.
// Accepts either one-row-per-job or pre-aggregated sheets; either way we sum
// revenue and count rows ("jobs") per (date, channel).

export type RevenueRow = { date: string; channel: string; revenue: number; jobs: number };
export type RevenueImport = {
  rows: RevenueRow[];
  channels: string[];
  minDate: string;
  maxDate: string;
  warnings: string[];
};

const DATE_RE = /\b(date|day|closed|close|sold|booked|completed|invoice|job\s*date)\b/i;
const CHANNEL_RE = /\b(channel|source|lead\s*source|marketing|campaign|referr|origin)\b/i;
const REVENUE_RE = /\b(revenue|amount|total|sales|price|job\s*value|ticket|invoice\s*total|collected)\b/i;

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,%\s]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

function toISODate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number") {
    // Excel serial date.
    const parsed = XLSX.SSF?.parse_date_code?.(v);
    if (parsed) {
      const m = String(parsed.m).padStart(2, "0");
      const d = String(parsed.d).padStart(2, "0");
      return `${parsed.y}-${m}-${d}`;
    }
    return null;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const dt = new Date(t);
    if (!Number.isNaN(dt.getTime())) {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  return null;
}

function findColumns(header: unknown[]): {
  date: number;
  channel: number;
  revenue: number;
} {
  let date = -1, channel = -1, revenue = -1;
  header.forEach((cell, i) => {
    if (typeof cell !== "string") return;
    const h = cell.trim();
    if (date < 0 && DATE_RE.test(h)) date = i;
    if (channel < 0 && CHANNEL_RE.test(h)) channel = i;
    if (revenue < 0 && REVENUE_RE.test(h)) revenue = i;
  });
  return { date, channel, revenue };
}

export function parseRevenueWorkbook(buffer: Buffer): RevenueImport {
  const wb = XLSX.read(buffer, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("The workbook has no sheets.");

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  if (aoa.length === 0) throw new Error("The sheet is empty.");

  // Header row = the one whose cells match the most of our target columns.
  let headerIdx = -1;
  let best = { date: -1, channel: -1, revenue: -1 };
  let bestScore = 0;
  aoa.slice(0, 15).forEach((row, i) => {
    const cols = findColumns(row);
    const score =
      (cols.date >= 0 ? 1 : 0) +
      (cols.channel >= 0 ? 1 : 0) +
      (cols.revenue >= 0 ? 1 : 0);
    if (score > bestScore) { bestScore = score; headerIdx = i; best = cols; }
  });

  if (best.channel < 0 || best.revenue < 0) {
    throw new Error(
      "Couldn't find the Channel and Revenue columns. Name your columns something like \"Channel/Source\" and \"Revenue/Amount\" (a \"Date\" column is recommended)."
    );
  }

  const warnings: string[] = [];
  if (best.date < 0)
    warnings.push("No date column found — add a Date column so revenue can be placed in time. Rows without a date are skipped.");

  // Aggregate by (date, channel).
  const acc = new Map<string, RevenueRow>();
  let skippedNoDate = 0;
  let skippedNoRevenue = 0;

  for (const row of aoa.slice(headerIdx + 1)) {
    const channelRaw = row[best.channel];
    const channel =
      channelRaw == null || String(channelRaw).trim() === ""
        ? "Unattributed"
        : String(channelRaw).trim();

    const revenue = toNumber(row[best.revenue]);
    if (revenue == null) { skippedNoRevenue++; continue; }

    const date = best.date >= 0 ? toISODate(row[best.date]) : null;
    if (!date) { skippedNoDate++; continue; }

    const key = `${date}|${channel.toLowerCase()}`;
    const existing = acc.get(key);
    if (existing) {
      existing.revenue += revenue;
      existing.jobs += 1;
    } else {
      acc.set(key, { date, channel, revenue, jobs: 1 });
    }
  }

  const rows = [...acc.values()];
  if (rows.length === 0)
    throw new Error("No usable rows found (need a date, a channel, and a numeric revenue per row).");

  if (skippedNoDate > 0) warnings.push(`Skipped ${skippedNoDate} row(s) with no readable date.`);
  if (skippedNoRevenue > 0) warnings.push(`Skipped ${skippedNoRevenue} row(s) with no numeric revenue.`);

  const dates = rows.map((r) => r.date).sort();
  const channels = [...new Set(rows.map((r) => r.channel))].sort();

  return {
    rows,
    channels,
    minDate: dates[0],
    maxDate: dates[dates.length - 1],
    warnings,
  };
}
