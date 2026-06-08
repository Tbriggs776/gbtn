"use client";

import { useActionState, useEffect, useRef } from "react";
import type { Client } from "@/lib/types";
import {
  createClientAction,
  inviteUserAction,
  type ActionState,
} from "@/app/portal/admin/actions";

const initial: ActionState = {};

const fieldClass =
  "w-full rounded-xl border border-line bg-white px-4 py-2.5 text-sm text-ink placeholder:text-muted-soft focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
const labelClass = "mb-1.5 block text-sm font-medium text-ink";

function Feedback({ state }: { state: ActionState }) {
  if (state.error)
    return <p className="text-sm text-red-600">{state.error}</p>;
  if (state.ok && state.message)
    return <p className="text-sm text-brand-700">{state.message}</p>;
  return null;
}

function SubmitButton({ label, pending }: { label: string; pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function CreateClientForm() {
  const [state, action, pending] = useActionState(createClientAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <div>
        <label htmlFor="name" className={labelClass}>
          Company name
        </label>
        <input id="name" name="name" required className={fieldClass} placeholder="Acme Home Services" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Feedback state={state} />
        <SubmitButton label="Create client" pending={pending} />
      </div>
    </form>
  );
}

export function InviteUserForm({ clients }: { clients: Client[] }) {
  const [state, action, pending] = useActionState(inviteUserAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  if (clients.length === 0) {
    return (
      <p className="text-sm text-muted">
        Create a client first, then you can invite their team.
      </p>
    );
  }

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="fullName" className={labelClass}>
            Full name <span className="text-muted-soft">(optional)</span>
          </label>
          <input id="fullName" name="fullName" className={fieldClass} placeholder="Jane Owner" />
        </div>
        <div>
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <input id="email" name="email" type="email" required className={fieldClass} placeholder="jane@acme.com" />
        </div>
      </div>
      <div>
        <label htmlFor="clientId" className={labelClass}>
          Client
        </label>
        <select id="clientId" name="clientId" required className={fieldClass} defaultValue="">
          <option value="" disabled>
            Select a client…
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Feedback state={state} />
        <SubmitButton label="Send invite" pending={pending} />
      </div>
    </form>
  );
}
