"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDate } from "@/lib/format";
import { deleteUploadAction } from "@/app/portal/financials/actions";

export type StatementRow = {
  id: string;
  statement_type: string;
  period_label: string;
  created_at: string;
};

export function StatementsList({ statements }: { statements: StatementRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (statements.length === 0) return null;

  function remove(id: string) {
    if (!confirm("Delete this statement and its data? This can't be undone.")) return;
    start(async () => {
      await deleteUploadAction(id);
      router.refresh();
    });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white ring-soft">
      <div className="border-b border-line px-5 py-3.5">
        <h3 className="text-sm font-bold text-ink">Uploaded statements</h3>
      </div>
      <ul className="divide-y divide-line">
        {statements.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-paper-soft px-2.5 py-0.5 text-xs font-semibold uppercase text-muted">
                {s.statement_type === "pl" ? "P&L" : "Balance Sheet"}
              </span>
              <span className="text-sm font-medium text-ink">{s.period_label}</span>
              <span className="text-xs text-muted-soft">{formatDate(s.created_at)}</span>
            </div>
            <button
              onClick={() => remove(s.id)}
              disabled={pending}
              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
