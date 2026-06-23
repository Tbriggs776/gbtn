"use client";

import { useActionState } from "react";
import type { Client } from "@/lib/types";
import {
  setUserClientsAction,
  resetUserPasswordAction,
  type ActionState,
} from "@/app/portal/admin/actions";

const initial: ActionState = {};

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  lastSignIn: string | null;
  clientIds: string[];
};

export function AdminUsers({
  users,
  clients,
}: {
  users: AdminUser[];
  clients: Client[];
}) {
  if (users.length === 0) {
    return <p className="px-6 py-8 text-center text-sm text-muted">No users yet.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {users.map((u) => (
        <UserRow key={u.id} user={u} clients={clients} />
      ))}
    </ul>
  );
}

function UserRow({ user, clients }: { user: AdminUser; clients: Client[] }) {
  const [mState, mAction, mPending] = useActionState(setUserClientsAction, initial);
  const [rState, rAction, rPending] = useActionState(resetUserPasswordAction, initial);

  const isAdmin = user.role === "admin";
  const last = user.lastSignIn
    ? new Date(user.lastSignIn).toLocaleString()
    : "Never signed in";

  return (
    <li className="px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-ink">{user.name || user.email}</p>
            {isAdmin ? (
              <span className="rounded-full bg-navy-2/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-navy-2">
                Admin
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-soft">
            {user.email} · last login {last}
          </p>
        </div>

        <form action={rAction} className="flex items-center gap-2">
          <input type="hidden" name="email" value={user.email} />
          <button
            type="submit"
            disabled={rPending}
            className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-brand-200 hover:text-brand-700 disabled:opacity-60"
          >
            {rPending ? "Sending…" : "Send reset link"}
          </button>
        </form>
      </div>

      {rState.error ? (
        <p className="mt-2 text-xs text-red-600">{rState.error}</p>
      ) : rState.ok && rState.message ? (
        <p className="mt-2 text-xs text-brand-700">{rState.message}</p>
      ) : null}

      {isAdmin ? (
        <p className="mt-3 text-xs text-muted">
          Admins can access every client automatically.
        </p>
      ) : (
        <form action={mAction} className="mt-3">
          <input type="hidden" name="userId" value={user.id} />
          <p className="mb-1.5 text-xs font-medium text-ink">Client access</p>
          {clients.length === 0 ? (
            <p className="text-xs text-muted-soft">No clients yet.</p>
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {clients.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="clientIds"
                    value={c.id}
                    defaultChecked={user.clientIds.includes(c.id)}
                    className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-100"
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="submit"
              disabled={mPending}
              className="rounded-md bg-ink px-4 py-2 text-xs font-semibold text-cream transition-colors hover:bg-ink-soft disabled:opacity-60"
            >
              {mPending ? "Saving…" : "Save access"}
            </button>
            {mState.error ? (
              <span className="text-xs text-red-600">{mState.error}</span>
            ) : mState.ok && mState.message ? (
              <span className="text-xs text-brand-700">{mState.message}</span>
            ) : null}
          </div>
        </form>
      )}
    </li>
  );
}
