"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { syncAction, type ActionState } from "@/app/portal/conversations/actions";

const initial: ActionState = {};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-ink px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink/90 disabled:opacity-60"
    >
      {/* A YTD backfill is a few hundred API calls — long enough that a silent
          button reads as broken. */}
      {pending ? "Syncing…" : "Sync from GoHighLevel"}
    </button>
  );
}

export function SyncButton({ clientId }: { clientId: string }) {
  const [state, action] = useActionState(syncAction, initial);

  return (
    <form action={action} className="flex flex-col items-end gap-1.5">
      <input type="hidden" name="clientId" value={clientId} />
      <Submit />
      {state.error ? (
        <p className="max-w-sm text-right text-[11.5px] leading-snug text-crimson">{state.error}</p>
      ) : state.message ? (
        <p className="max-w-sm text-right text-[11.5px] leading-snug text-muted">{state.message}</p>
      ) : null}
    </form>
  );
}
