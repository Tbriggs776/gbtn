import "server-only";
import * as XLSX from "xlsx";
import { guessCategory, normalizeLabel, type StatementType } from "./categories";

// Parses the GBTN "MRP" workbook's DATA-PL / DATA-BS tabs (one column per month)
// into per-month P&L + Balance Sheet line items, ready to load into the portal.

export type MrpItem = { rawLabel: string; category: string; amount: number };
export type MrpPeriod = {
  label: string; // e.g. "May 2026"
  end: string; // e.g. "2026-05-31"
  pl: MrpItem[];
  bs: MrpItem[];
};
export type MrpResult = { periods: MrpPeriod[]; warnings: string[] };

// Known GBTN/MRP line labels → canonical categories (exact, normalized).
const PL_MAP: Record<string, string> = {
  "net revenue": "revenue",
  "cost of labor - installers": "cogs",
  "supplies & materials": "cogs",
  "dc commissions": "cogs",
  "finance costs": "cogs",
  subcontractors: "cogs",
  "product storage": "cogs",
  "freight in": "cogs",
  "referral fees": "cogs",
  "claims (house/installer/material)": "cogs",
  "advertising & marketing": "opex",
  "payroll expense": "opex",
  "office & software": "opex",
  "vehicle expense": "opex",
  "legal & accounting": "opex",
  "rent & occupancy": "opex",
  "guaranteed payments": "opex",
  utilities: "opex",
  insurance: "opex",
  "other operating": "opex",
  depreciation: "depreciation_amortization",
  "interest expense": "interest",
};
const BS_MAP: Record<string, string> = {
  "cash & bank": "cash",
  "accounts receivable": "accounts_receivable",
  cwip: "other_current_asset",
  "claims receivable": "other_current_asset",
  "other current assets (draws/adv)": "other_current_asset",
  "fixed assets, net": "non_current_asset",
  "other assets": "non_current_asset",
  "accounts payable": "accounts_payable",
  "credit cards": "other_current_liability",
  "customer deposits": "other_current_liability",
  "accrued & other current liab": "other_current_liability",
  "shareholder loans": "non_current_liability",
  "notes payable (current)": "other_current_liability",
  "long-term debt": "non_current_liability",
  "total equity (members' deficit)": "equity",
};

const MONTHS: Record<string, { idx: number; label: string }> = {
  jan: { idx: 0, label: "Jan" }, feb: { idx: 1, label: "Feb" },
  mar: { idx: 2, label: "Mar" }, apr: { idx: 3, label: "Apr" },
  may: { idx: 4, label: "May" }, jun: { idx: 5, label: "Jun" },
  jul: { idx: 6, label: "Jul" }, aug: { idx: 7, label: "Aug" },
  sep: { idx: 8, label: "Sep" }, oct: { idx: 9, label: "Oct" },
  nov: { idx: 10, label: "Nov" }, dec: { idx: 11, label: "Dec" },
};

function monthEnd(year: number, monthIdx: number): string {
  const last = new Date(year, monthIdx + 1, 0).getDate();
  const m = String(monthIdx + 1).padStart(2, "0");
  return `${year}-${m}-${String(last).padStart(2, "0")}`;
}

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

function categorize(type: StatementType, label: string): string | null {
  const norm = normalizeLabel(label);
  if (
    /^(total|subtotal|gross profit|net (income|profit|loss)|operating expenses|cost of (goods|sales)|check|balance sheet|p&l|line item|year open)/.test(
      norm
    )
  )
    return null;
  const map = type === "pl" ? PL_MAP : BS_MAP;
  if (map[norm]) return map[norm];
  const guess = guessCategory(type, label);
  return guess === "exclude" ? null : guess;
}

type Parsed = { colMonth: Map<number, string>; rows: unknown[][] };
function parseSheet(ws: XLSX.WorkSheet | undefined): Parsed | null {
  if (!ws) return null;
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1, raw: true, blankrows: false,
  });
  if (aoa.length === 0) return null;
  // header row = the one with the most month-name cells
  let headerIdx = -1, best = 0;
  aoa.forEach((row, i) => {
    const hits = (row as unknown[]).filter(
      (c) => typeof c === "string" && MONTHS[c.trim().slice(0, 3).toLowerCase()]
    ).length;
    if (hits > best) { best = hits; headerIdx = i; }
  });
  if (headerIdx < 0) return null;
  const colMonth = new Map<number, string>();
  (aoa[headerIdx] as unknown[]).forEach((c, col) => {
    if (typeof c === "string") {
      const key = c.trim().slice(0, 3).toLowerCase();
      if (MONTHS[key]) colMonth.set(col, key);
    }
  });
  return { colMonth, rows: aoa.slice(headerIdx + 1) as unknown[][] };
}

function itemsForMonth(
  parsed: Parsed, type: StatementType, col: number
): MrpItem[] {
  const out: MrpItem[] = [];
  for (const row of parsed.rows) {
    const label = row[0];
    if (label == null || String(label).trim() === "") continue;
    const cat = categorize(type, String(label));
    if (!cat) continue;
    const amt = toNumber(row[col]);
    if (amt == null) continue;
    out.push({ rawLabel: String(label).trim(), category: cat, amount: amt });
  }
  return out;
}

export function parseMrp(buffer: Buffer, year: number): MrpResult {
  const warnings: string[] = [];
  const wb = XLSX.read(buffer);
  const plParsed = parseSheet(wb.Sheets["DATA-PL"]);
  const bsParsed = parseSheet(wb.Sheets["DATA-BS"]);
  if (!plParsed && !bsParsed) {
    throw new Error(
      "Couldn't find DATA-PL or DATA-BS tabs. Upload the MRP Template workbook (the one with the DATA tabs)."
    );
  }
  if (!plParsed) warnings.push("No DATA-PL tab found; loaded balance sheet only.");
  if (!bsParsed) warnings.push("No DATA-BS tab found; loaded P&L only.");

  // union of month keys present, ordered Jan..Dec
  const keys = new Set<string>([
    ...(plParsed ? plParsed.colMonth.values() : []),
    ...(bsParsed ? bsParsed.colMonth.values() : []),
  ]);
  const ordered = Object.keys(MONTHS).filter((k) => keys.has(k));

  const periods: MrpPeriod[] = [];
  for (const key of ordered) {
    const m = MONTHS[key];
    const plCol = plParsed
      ? [...plParsed.colMonth.entries()].find(([, v]) => v === key)?.[0]
      : undefined;
    const bsCol = bsParsed
      ? [...bsParsed.colMonth.entries()].find(([, v]) => v === key)?.[0]
      : undefined;
    const pl = plCol != null ? itemsForMonth(plParsed!, "pl", plCol) : [];
    const bs = bsCol != null ? itemsForMonth(bsParsed!, "bs", bsCol) : [];
    // skip empty months (all zero / nothing)
    const hasData =
      pl.some((i) => i.amount !== 0) || bs.some((i) => i.amount !== 0);
    if (!hasData) continue;
    periods.push({ label: `${m.label} ${year}`, end: monthEnd(year, m.idx), pl, bs });
  }

  if (periods.length === 0) {
    throw new Error("No populated month columns found in the DATA tabs.");
  }
  return { periods, warnings };
}
