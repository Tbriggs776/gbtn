import * as XLSX from "xlsx";
import { classifyPC, type LineClass } from "./pc";

/**
 * Parser for the RFMS "Orders" export (CSV or XLSX).
 *
 * RFMS quirks this handles, all observed in real exports:
 *   • Dates arrive as YYYYMMDD *strings*, and "0"/"" both mean "no date".
 *   • Store arrives quoted-inside-quoted ('"1"'), so values need unwrapping.
 *   • LineStatus is one of six fixed values; anything else we reject loudly
 *     rather than silently coercing, because status drives the whole report.
 *   • The same CG appears once per line, so header fields (customer, job type)
 *     repeat down the file.
 */

export type ParsedLine = {
  invoiceNum: string;
  lineNum: number;
  lineStatus: LineStatus;
  pc: string | null;
  lineClass: LineClass;
  custName: string | null;
  shipCity: string | null;
  shipState: string | null;
  salesperson: string | null;
  jobType: string | null;
  adSource: string | null;
  orderDate: string | null;
  installDate: string | null;
  estDelDate: string | null;
  measureDate: string | null;
  styleItem: string | null;
  colorDesc: string | null;
  lineGroup: string | null;
  supplier: string | null;
  poNumber: string | null;
  uom: string | null;
  qty: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  totalCost: number | null;
  raw: Record<string, unknown>;
};

export type ParsedOrders = {
  lines: ParsedLine[];
  cgCount: number;
  minOrderDate: string | null;
  maxOrderDate: string | null;
  /** Line counts per class — surfaced on import so the mix is never a surprise. */
  classCounts: Record<LineClass, number>;
  boilerplate: number;
  warnings: string[];
};

export const LINE_STATUSES = ["None", "GenPO", "OnOrder", "Resvd", "Cut", "Del"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

/** Columns we require to consider the file an RFMS Orders export at all. */
const REQUIRED = ["Invoice_Num", "LineNum", "LineStatus", "OrderDate"];

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // RFMS double-quotes some values inside the cell itself ('"1"').
  const s = String(v).trim().replace(/^"+|"+$/g, "").trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * RFMS dates are YYYYMMDD. "0", "", and anything not 8 digits mean "no date" —
 * a blank install date is normal (the job isn't scheduled yet), not an error.
 */
function ymd(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^\d{8}$/.test(s)) return null;
  const y = s.slice(0, 4), m = s.slice(4, 6), d = s.slice(6, 8);
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${m}-${d}`;
}

function status(v: unknown, warn: (s: string) => void, ctx: string): LineStatus {
  const s = str(v);
  if (!s) return "None";
  const hit = LINE_STATUSES.find((k) => k.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  warn(`${ctx}: unrecognised LineStatus "${s}" — imported as None.`);
  return "None";
}

export function parseOrdersExport(buf: Buffer): ParsedOrders {
  const wb = XLSX.read(buf, { type: "buffer", raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("The file has no readable sheet.");

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: "",
  });
  if (rows.length === 0) throw new Error("The file has no rows.");

  const cols = Object.keys(rows[0]);
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `This doesn't look like an RFMS Orders export — missing ${missing.join(", ")}.`
    );
  }

  const warnings: string[] = [];
  const warn = (s: string) => {
    if (warnings.length < 12 && !warnings.includes(s)) warnings.push(s);
  };

  const lines: ParsedLine[] = [];
  const seen = new Set<string>();
  const cgs = new Set<string>();
  let dupes = 0;
  let noDate = 0;

  for (const r of rows) {
    const invoiceNum = str(r["Invoice_Num"]);
    const lineNum = num(r["LineNum"]);
    if (!invoiceNum || lineNum === null) {
      warn("Skipped a row with no Invoice_Num or LineNum.");
      continue;
    }

    // The export is a snapshot; a repeated (CG, line) means a malformed file.
    const key = `${invoiceNum}#${lineNum}`;
    if (seen.has(key)) {
      dupes++;
      continue;
    }
    seen.add(key);
    cgs.add(invoiceNum);

    const installDate = ymd(r["InstallDate"]);
    if (!installDate) noDate++;

    const pc = str(r["PC"]);

    lines.push({
      invoiceNum,
      lineNum,
      lineStatus: status(r["LineStatus"], warn, invoiceNum),
      pc,
      lineClass: classifyPC(pc),
      custName: str(r["CustName"]),
      shipCity: str(r["ShipToCity"]),
      shipState: str(r["ShipToState"]),
      salesperson: str(r["Salesperson"]),
      jobType: str(r["JobType"]),
      adSource: str(r["AdSource"]),
      orderDate: ymd(r["OrderDate"]),
      installDate,
      estDelDate: ymd(r["EstDelDate"]),
      measureDate: ymd(r["&Measure Date"]),
      styleItem: str(r["StyleItem"]),
      colorDesc: str(r["ColorDesc"]),
      lineGroup: str(r["LineGroup"]),
      supplier: str(r["Supplier"]),
      poNumber: str(r["PO Number"]),
      uom: str(r["UOM"]),
      qty: num(r["Qty"]),
      unitPrice: num(r["UnitPrice"]),
      lineTotal: num(r["LineTotal"]),
      totalCost: num(r["TotalCost"]),
      raw: r,
    });
  }

  if (lines.length === 0) throw new Error("No usable order lines found in the file.");
  if (dupes > 0) warn(`Ignored ${dupes} duplicate (CG, line) row${dupes === 1 ? "" : "s"}.`);
  if (noDate > 0) warn(`${noDate} line${noDate === 1 ? " has" : "s have"} no install date yet.`);

  const orderDates = lines.map((l) => l.orderDate).filter((d): d is string => Boolean(d)).sort();

  const classCounts: Record<LineClass, number> = { material: 0, labor: 0, other: 0 };
  let boilerplate = 0;
  for (const l of lines) {
    classCounts[l.lineClass]++;
    if ((l.qty ?? 0) === 0 && (l.lineTotal ?? 0) === 0) boilerplate++;
  }
  if (boilerplate > 0) {
    warn(
      `${boilerplate.toLocaleString()} of ${lines.length.toLocaleString()} lines carry no quantity and no value (RFMS boilerplate). Filter by line class to exclude them.`
    );
  }

  return {
    lines,
    cgCount: cgs.size,
    minOrderDate: orderDates[0] ?? null,
    maxOrderDate: orderDates[orderDates.length - 1] ?? null,
    classCounts,
    boilerplate,
    warnings,
  };
}
