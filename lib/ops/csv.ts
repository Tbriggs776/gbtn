// Client-side CSV building + download. No server round trip — everything the
// Ops tables show is already in the browser, so exporting is just a Blob.

export type CSVValue = string | number | null | undefined;

function esc(v: CSVValue): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Formula-injection guard: a STRING field starting with = + - @ (or tab/CR)
  // executes as a formula when the file opens in Excel, and customer names come
  // from third-party RFMS imports. OWASP mitigation: prefix with a quote.
  // Numbers are exempt so negative values stay numeric.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(headers: string[], rows: CSVValue[][]): string {
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

export function downloadCSV(filename: string, headers: string[], rows: CSVValue[][]): void {
  // BOM so Excel opens it as UTF-8 instead of mangling accented names.
  const blob = new Blob(["﻿" + toCSV(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
