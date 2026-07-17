"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadOrdersAction, type OrdersUploadState } from "@/app/portal/ops-reports/actions";

const initial: OrdersUploadState = {};

export function OrdersUploader({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(uploadOrdersAction, initial);
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
        Import orders
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-line bg-white p-6 ring-card sm:w-[34rem]">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-ink">Import RFMS orders</h3>
        <button onClick={() => setOpen(false)} className="text-sm text-muted hover:text-ink">
          Cancel
        </button>
      </div>

      <p className="mt-2 text-sm text-muted">
        Upload the <span className="font-medium text-ink">Orders</span> export from RFMS (CSV or
        XLSX). It&apos;s a full snapshot, so importing <span className="font-medium text-ink">replaces</span>{" "}
        every order line for this client — lines deleted in RFMS disappear here too.
      </p>

      <form ref={formRef} action={action} className="mt-4 space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <input
          type="file"
          name="file"
          accept=".csv,.xlsx,.xls"
          required
          className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-ink file:px-4 file:py-2 file:text-sm file:font-semibold file:text-cream hover:file:bg-ink-soft"
        />

        {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
        {state.ok && state.message ? <p className="text-sm text-brand-700">{state.message}</p> : null}
        {state.warnings?.length ? (
          <ul className="space-y-1">
            {state.warnings.map((w) => (
              <li key={w} className="text-xs text-amber-700">
                {w}
              </li>
            ))}
          </ul>
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
