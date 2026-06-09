"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { categoriesFor, type StatementType } from "@/lib/financials/categories";
import { money } from "@/lib/financials/metrics";
import {
  parseUploadAction,
  confirmUploadAction,
  type ParsedRowOut,
} from "@/app/portal/financials/actions";

const BUCKET = "client-files";
const safeName = (n: string) => n.replace(/[^a-zA-Z0-9.\-_]+/g, "_").slice(0, 180);

type Step = "form" | "parsing" | "mapping" | "saving";
type MapRow = ParsedRowOut & { category: string };

export function FinancialUploader({ clientId }: { clientId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [error, setError] = useState<string | null>(null);

  const [statementType, setStatementType] = useState<StatementType>("pl");
  const [periodLabel, setPeriodLabel] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  const [uploadId, setUploadId] = useState("");
  const [columns, setColumns] = useState<{ index: number; header: string }[]>([]);
  const [amountCol, setAmountCol] = useState(0);
  const [rows, setRows] = useState<MapRow[]>([]);

  const cats = categoriesFor(statementType);

  function reset() {
    setStep("form");
    setError(null);
    setPeriodLabel("");
    setPeriodEnd("");
    setUploadId("");
    setColumns([]);
    setRows([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleParse(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const file = inputRef.current?.files?.[0];
    if (!file) return setError("Choose a file to upload.");
    if (!periodLabel.trim()) return setError("Enter a period label (e.g. “Q1 2026”).");

    setStep("parsing");
    const supabase = createClient();
    const path = `${clientId}/financials/${crypto.randomUUID()}-${safeName(file.name)}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (upErr) {
      setStep("form");
      return setError(`Upload failed: ${upErr.message}`);
    }

    const res = await parseUploadAction({
      clientId,
      statementType,
      periodLabel: periodLabel.trim(),
      periodEnd: periodEnd || undefined,
      storagePath: path,
      fileName: file.name,
    });
    if (res.error) {
      setStep("form");
      return setError(res.error);
    }
    setUploadId(res.uploadId);
    setColumns(res.columns);
    setAmountCol(res.suggestedColumn);
    setRows(res.rows.map((r) => ({ ...r, category: r.suggestedCategory })));
    setStep("mapping");
  }

  async function handleConfirm() {
    setError(null);
    setStep("saving");
    const items = rows.map((r) => ({
      rawLabel: r.rawLabel,
      category: r.category,
      amount: r.values[amountCol] ?? 0,
    }));
    const res = await confirmUploadAction({ uploadId, items });
    if (res.error) {
      setStep("mapping");
      return setError(res.error);
    }
    setOpen(false);
    reset();
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-gradient-brand inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Upload statement
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-white p-6 ring-card">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-ink">
          {step === "mapping" || step === "saving"
            ? "Review & map line items"
            : "Upload a financial statement"}
        </h3>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-sm text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {/* Step 1 — upload form */}
      {(step === "form" || step === "parsing") && (
        <form onSubmit={handleParse} className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Statement</label>
              <select
                value={statementType}
                onChange={(e) => setStatementType(e.target.value as StatementType)}
                className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
              >
                <option value="pl">Profit &amp; Loss</option>
                <option value="bs">Balance Sheet</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Period label</label>
              <input
                value={periodLabel}
                onChange={(e) => setPeriodLabel(e.target.value)}
                placeholder="Q1 2026"
                className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">
                Period end <span className="text-muted-soft">(optional)</span>
              </label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">
              File <span className="text-muted-soft">(.xlsx, .xls, or .csv export)</span>
            </label>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-ink-soft"
            />
          </div>
          <button
            type="submit"
            disabled={step === "parsing"}
            className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
          >
            {step === "parsing" ? "Reading file…" : "Parse & review"}
          </button>
        </form>
      )}

      {/* Step 2 — mapping review */}
      {(step === "mapping" || step === "saving") && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              Confirm the category for each line. We&apos;ll remember these for next
              time. Rows marked <span className="font-medium text-ink">Exclude</span>{" "}
              (subtotals) are skipped.
            </p>
            {columns.length > 1 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">Amount column:</span>
                <select
                  value={amountCol}
                  onChange={(e) => setAmountCol(Number(e.target.value))}
                  className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm focus:border-brand-400 focus:outline-none"
                >
                  {columns.map((c, i) => (
                    <option key={c.index} value={i}>
                      {c.header}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="mt-4 max-h-[28rem] overflow-auto rounded-xl border border-line">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-paper-soft text-xs uppercase tracking-wide text-muted-soft">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Line item</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Category</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r, i) => {
                  const amt = r.values[amountCol];
                  const excluded = r.category === "exclude";
                  return (
                    <tr key={i} className={excluded ? "opacity-50" : ""}>
                      <td className="max-w-[18rem] truncate px-4 py-2 font-medium text-ink">
                        {r.rawLabel}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-ink/80">
                        {amt == null ? "—" : money(amt)}
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={r.category}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRows((prev) =>
                              prev.map((row, j) =>
                                j === i ? { ...row, category: v } : row
                              )
                            );
                          }}
                          className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm focus:border-brand-400 focus:outline-none"
                        >
                          {cats.map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={handleConfirm}
              disabled={step === "saving"}
              className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
            >
              {step === "saving" ? "Saving…" : "Confirm & save"}
            </button>
            <button
              onClick={() => setStep("form")}
              className="text-sm font-medium text-muted hover:text-ink"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
