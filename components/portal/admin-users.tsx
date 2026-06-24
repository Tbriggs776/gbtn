"use client";

import { useState, useActionState } from "react";
import type { Client } from "@/lib/types";
import {
  setUserClientsAction,
  resetUserPasswordAction,
  updateUserAction,
  deleteUserAction,
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

const field =
  "w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100";

export function AdminUsers({
  users,
  clients,
  currentUserId,
  lastActive = {},
}: {
  users: AdminUser[];
  clients: Client[];
  currentUserId: string;
  lastActive?: Record<string, string>;
}) {
  if (users.length === 0) {
    return <p className="px-6 py-8 text-center text-sm text-muted">No users yet.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {users.map((u) => (
        <UserRow
          key={u.id}
          user={u}
          clients={clients}
          isSelf={u.id === currentUserId}
          activeAt={lastActive[u.id] ?? null}
        />
      ))}
    </ul>
  );
}

function UserRow({
  user,
  clients,
  isSelf,
  activeAt,
}: {
  user: AdminUser;
  clients: Client[];
  isSelf: boolean;
  activeAt: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [uState, uAction, uPending] = useActionState(updateUserAction, initial);
  const [mState, mAction, mPending] = useActionState(setUserClientsAction, initial);
  const [rState, rAction, rPending] = useActionState(resetUserPasswordAction, initial);
  const [dState, dAction, dPending] = useActionState(deleteUserAction, initial);

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
            {isSelf ? (
              <span className="rounded-full bg-paper-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-soft">
                You
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-soft">
            {user.email} · last login {last}
            {activeAt ? ` · last active ${new Date(activeAt).toLocaleString()}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:text-ink"
          >
            {editing ? "Close" : "Edit"}
          </button>
          <form action={rAction}>
            <input type="hidden" name="email" value={user.email} />
            <button
              type="submit"
              disabled={rPending}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-brand-200 hover:text-brand-700 disabled:opacity-60"
            >
              {rPending ? "Sending…" : "Send reset link"}
            </button>
          </form>
          {!isSelf &&
            (confirming ? (
              <form action={dAction} className="flex items-center gap-1">
                <input type="hidden" name="userId" value={user.id} />
                <button
                  type="submit"
                  disabled={dPending}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                >
                  {dPending ? "Removing…" : "Confirm remove"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-red-200 hover:text-red-600"
              >
                Remove
              </button>
            ))}
        </div>
      </div>

      {rState.error ? (
        <p className="mt-2 text-xs text-red-600">{rState.error}</p>
      ) : rState.ok && rState.message ? (
        <p className="mt-2 text-xs text-brand-700">{rState.message}</p>
      ) : null}
      {dState.error ? <p className="mt-2 text-xs text-red-600">{dState.error}</p> : null}

      {/* Edit name / email / role */}
      {editing ? (
        <form action={uAction} className="mt-3 rounded-xl border border-line bg-paper-soft/50 p-4">
          <input type="hidden" name="userId" value={user.id} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink">Full name</label>
              <input name="fullName" defaultValue={user.name} className={field} placeholder="Jane Owner" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink">Email</label>
              <input name="email" type="email" defaultValue={user.email} className={field} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink">Role</label>
              <select
                name="role"
                defaultValue={user.role}
                disabled={isSelf}
                className={`${field} disabled:opacity-60`}
              >
                <option value="client">Client</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="submit"
              disabled={uPending}
              className="rounded-md bg-gradient-brand px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-cream ring-soft transition-all hover:brightness-110 disabled:opacity-60"
            >
              {uPending ? "Saving…" : "Save changes"}
            </button>
            {uState.error ? (
              <span className="text-xs text-red-600">{uState.error}</span>
            ) : uState.ok && uState.message ? (
              <span className="text-xs text-brand-700">{uState.message}</span>
            ) : null}
          </div>
          {isSelf ? (
            <p className="mt-2 text-[11px] text-muted-soft">
              You can&apos;t change your own role (prevents an admin lockout).
            </p>
          ) : null}
        </form>
      ) : null}

      {/* Client access */}
      {isAdmin ? (
        <p className="mt-3 text-xs text-muted">Admins can access every client automatically.</p>
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
