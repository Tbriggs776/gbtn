import "server-only";
import * as XLSX from "xlsx";

export type ParsedColumn = { index: number; header: string; numericCount: number };
export type ParsedRow = { rawLabel: string; values: (number | null)[] };
export type ParseResult = {
  columns: ParsedColumn[]; // numeric columns only, in sheet order
  rows: ParsedRow[]; // values aligned to columns[]
  suggestedColumn: number; // index into columns[]
};

// Parse "$1,234.50", "(1,234)", "1234", numbers → number | null.
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,%\s]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function isProbablyNumber(v: unknown): boolean {
  return toNumber(v) != null;
}

export function parseWorkbook(buffer: Buffer): ParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  if (aoa.length === 0) return { columns: [], rows: [], suggestedColumn: 0 };

  const colCount = Math.max(...aoa.map((r) => (Array.isArray(r) ? r.length : 0)));

  // Score each column: numeric vs text cells.
  const numericCount: number[] = new Array(colCount).fill(0);
  const textCount: number[] = new Array(colCount).fill(0);
  for (const row of aoa) {
    for (let c = 0; c < colCount; c++) {
      const cell = (row as unknown[])[c];
      if (cell == null || cell === "") continue;
      if (isProbablyNumber(cell)) numericCount[c]++;
      else textCount[c]++;
    }
  }

  // Label column = the text-heaviest column (usually col 0).
  let labelCol = 0;
  for (let c = 1; c < colCount; c++) {
    if (textCount[c] > textCount[labelCol]) labelCol = c;
  }

  // Numeric columns = columns with at least 2 numbers, excluding the label col.
  const numericCols = [];
  for (let c = 0; c < colCount; c++) {
    if (c === labelCol) continue;
    if (numericCount[c] >= 2) numericCols.push(c);
  }

  // Try to read a header row (first row that is mostly text in numeric cols).
  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(aoa.length, 5); r++) {
    const row = aoa[r] as unknown[];
    const textInNumericCols = numericCols.filter(
      (c) => row[c] != null && row[c] !== "" && !isProbablyNumber(row[c])
    ).length;
    if (textInNumericCols >= Math.ceil(numericCols.length / 2) && numericCols.length > 0) {
      headerRowIdx = r;
      break;
    }
  }

  const columns: ParsedColumn[] = numericCols.map((c, i) => {
    const header =
      headerRowIdx >= 0 && (aoa[headerRowIdx] as unknown[])[c]
        ? String((aoa[headerRowIdx] as unknown[])[c]).trim()
        : `Column ${i + 1}`;
    return { index: c, header, numericCount: numericCount[c] };
  });

  const rows: ParsedRow[] = [];
  for (let r = 0; r < aoa.length; r++) {
    if (r === headerRowIdx) continue;
    const row = aoa[r] as unknown[];
    const labelRaw = row[labelCol];
    const rawLabel = labelRaw == null ? "" : String(labelRaw).trim();
    const values = numericCols.map((c) => toNumber(row[c]));
    const hasValue = values.some((v) => v != null);
    if (!rawLabel && !hasValue) continue;
    if (!rawLabel) continue; // skip number-only rows (spacers/totals w/o label)
    rows.push({ rawLabel, values });
  }

  // Suggested amount column: the numeric column with the most values
  // (usually the period/total column). Falls back to the last column.
  let suggestedColumn = columns.length - 1;
  let best = -1;
  columns.forEach((col, i) => {
    if (col.numericCount > best) {
      best = col.numericCount;
      suggestedColumn = i;
    }
  });

  return { columns, rows, suggestedColumn: Math.max(0, suggestedColumn) };
}
