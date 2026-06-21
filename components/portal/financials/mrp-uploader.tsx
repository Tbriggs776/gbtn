"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loadMrpAction, type MrpState } from "@/app/portal/financials/actions";

const initial: MrpState = {};

export function MrpUploader({
  clientId,
  defaultYear,
}: {
  clientId: string;
  defaultYear: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(loadMrpAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state.ok, router]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="font-label inline-flex items-center gap-2 rounded-md bg-gradient-brand px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
          <path d="M12 16V4m0 0L8 8m4-4l4 4M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Load month-end (MRP)
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-line bg-white p-6 ring-card sm:w-[30rem]">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-ink">Load month-end (MRP)</h3>
        <button onClick={() => setOpen(false)} className="text-sm text-muted hover:text-ink">
          Cancel
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">
        Upload the MRP workbook (with the <span className="font-medium text-ink">DATA-PL</span> and{" "}
        <span className="font-medium text-ink">DATA-BS</span> tabs). This replaces
        the dashboard with every month found.
      </p>

      <form ref={formRef} action={action} className="mt-4 space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Workbook</label>
            <input
              type="file"
              name="file"
              accept=".xlsx,.xls"
              required
              className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-ink file:px-4 file:py-2 file:text-sm file:font-semibold file:text-cream hover:file:bg-ink-soft"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Year</label>
            <input
              type="number"
              name="year"
              defaultValue={defaultYear}
              min={2000}
              max={2100}
              required
              className="w-24 rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            name="notify"
            defaultChecked
            className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-100"
          />
          Email the client that new financials are ready
        </label>

        {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-brand-700">{state.message}</p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:opacity-60"
        >
          {pending ? "Loading…" : "Load & refresh dashboard"}
        </button>
      </form>
    </div>
  );
}
