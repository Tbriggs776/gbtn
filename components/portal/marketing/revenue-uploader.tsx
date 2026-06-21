"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loadRevenueAction, type MarketingState } from "@/app/portal/marketing/actions";

const initial: MarketingState = {};

export function RevenueUploader({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(loadRevenueAction, initial);
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
        Import revenue
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-line bg-white p-6 ring-card sm:w-[30rem]">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-ink">Import marketing revenue</h3>
        <button onClick={() => setOpen(false)} className="text-sm text-muted hover:text-ink">
          Cancel
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">
        Upload an <span className="font-medium text-ink">.xlsx</span> or{" "}
        <span className="font-medium text-ink">.csv</span> with{" "}
        <span className="font-medium text-ink">Date</span>,{" "}
        <span className="font-medium text-ink">Channel</span>, and{" "}
        <span className="font-medium text-ink">Revenue</span> columns. Re-uploading a
        date range replaces it.
      </p>

      <form ref={formRef} action={action} className="mt-4 space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <input
          type="file"
          name="file"
          accept=".xlsx,.xls,.csv"
          required
          className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-ink file:px-4 file:py-2 file:text-sm file:font-semibold file:text-cream hover:file:bg-ink-soft"
        />

        {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-brand-700">{state.message}</p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import & refresh"}
        </button>
      </form>
    </div>
  );
}
