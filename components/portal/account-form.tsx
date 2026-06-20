"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  updateNameAction,
  updatePasswordAction,
  type AccountState,
} from "@/app/portal/account/actions";

const initial: AccountState = {};

const field =
  "w-full rounded-md border border-line bg-white px-4 py-2.5 text-sm text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100";
const labelCls = "mb-1.5 block text-sm font-medium text-ink";

function Feedback({ state }: { state: AccountState }) {
  if (state.error) return <p className="text-sm text-red-600">{state.error}</p>;
  if (state.ok && state.message)
    return <p className="text-sm text-brand-700">{state.message}</p>;
  return null;
}

function Submit({ label, pending }: { label: string; pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

export function AccountForms({
  email,
  fullName,
}: {
  email: string;
  fullName: string;
}) {
  const [nameState, nameAction, namePending] = useActionState(updateNameAction, initial);
  const [pwState, pwAction, pwPending] = useActionState(updatePasswordAction, initial);
  const pwRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (pwState.ok) pwRef.current?.reset();
  }, [pwState.ok]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Profile */}
      <section className="rounded-lg border border-line bg-white p-6 ring-soft">
        <h2 className="text-base font-bold text-ink">Your details</h2>
        <p className="mt-1 mb-5 text-sm text-muted">
          Your sign-in email is{" "}
          <span className="font-medium text-ink">{email}</span>.
        </p>
        <form action={nameAction} className="space-y-4">
          <div>
            <label htmlFor="fullName" className={labelCls}>
              Full name
            </label>
            <input
              id="fullName"
              name="fullName"
              defaultValue={fullName}
              required
              className={field}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Feedback state={nameState} />
            <Submit label="Save name" pending={namePending} />
          </div>
        </form>
      </section>

      {/* Password */}
      <section className="rounded-lg border border-line bg-white p-6 ring-soft">
        <h2 className="text-base font-bold text-ink">Change password</h2>
        <p className="mt-1 mb-5 text-sm text-muted">
          Pick something only you know. Takes effect immediately.
        </p>
        <form ref={pwRef} action={pwAction} className="space-y-4">
          <div>
            <label htmlFor="password" className={labelCls}>
              New password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              placeholder="••••••••"
              className={field}
            />
          </div>
          <div>
            <label htmlFor="confirm" className={labelCls}>
              Confirm password
            </label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
              placeholder="••••••••"
              className={field}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Feedback state={pwState} />
            <Submit label="Update password" pending={pwPending} />
          </div>
        </form>
      </section>
    </div>
  );
}
