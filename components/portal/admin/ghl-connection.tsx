"use client";

import { useActionState, useState } from "react";
import {
  connectGhlAction,
  disconnectGhlAction,
  testGhlAction,
  type IntegrationState,
} from "@/app/portal/admin/integrations-actions";

export type GhlClientStatus = {
  clientId: string;
  clientName: string;
  connected: boolean;
  locationId: string | null;
  hint: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
};

/**
 * Per-client GoHighLevel connection.
 *
 * Sits in the admin area rather than the client-facing Settings tab: it takes a
 * credential, and the marketing-channel Settings page is explicitly built so a
 * client can see connection status without ever handling one.
 */
export function GhlConnection({ clients }: { clients: GhlClientStatus[] }) {
  const [selected, setSelected] = useState(clients[0]?.clientId ?? "");
  const [connectState, connect, connecting] = useActionState<IntegrationState, FormData>(
    connectGhlAction,
    {}
  );
  const [testState, test, testing] = useActionState<IntegrationState, FormData>(testGhlAction, {});
  const [disconnectState, disconnectAction, disconnecting] = useActionState<
    IntegrationState,
    FormData
  >(disconnectGhlAction, {});

  const current = clients.find((c) => c.clientId === selected) ?? null;

  return (
    <section className="rounded-2xl border border-line bg-white p-6 ring-card">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold text-ink">GoHighLevel</h2>
        <span className="text-xs text-muted-soft">Per client · conversation sync</span>
      </div>

      <p className="mt-2 max-w-2xl text-sm text-muted">
        Powers the Conversations tab. The token is verified before it&apos;s saved, encrypted in the
        vault, and never shown again — paste a new one to rotate it.
      </p>

      {clients.length === 0 ? (
        <p className="mt-4 text-sm text-muted-soft">Create a client first.</p>
      ) : (
        <>
          <div className="mt-5 rounded-xl border border-line p-4">
            <label className="font-label block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
              Client
            </label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1.5 w-72 rounded-md border border-line px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            >
              {clients.map((c) => (
                <option key={c.clientId} value={c.clientId}>
                  {c.clientName}
                  {c.connected ? " — connected" : ""}
                </option>
              ))}
            </select>

            {current ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                {current.connected ? (
                  <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
                    Connected · ····{current.hint}
                  </span>
                ) : (
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-600">
                    Not connected
                  </span>
                )}
                {current.locationId ? (
                  <span className="text-muted-soft">Location {current.locationId}</span>
                ) : null}
                {current.lastSyncedAt ? (
                  <span className="text-muted-soft">
                    Last sync {new Date(current.lastSyncedAt).toLocaleDateString("en-US")}
                  </span>
                ) : null}
              </div>
            ) : null}

            {current?.lastSyncError ? (
              <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                Last sync failed: {current.lastSyncError}
              </p>
            ) : null}

            <form action={connect} className="mt-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="clientId" value={selected} />
              <div>
                <label className="font-label block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                  Location ID
                </label>
                <input
                  name="locationId"
                  defaultValue={current?.locationId ?? ""}
                  autoComplete="off"
                  placeholder="ve9EPM428h8vShlRW1KT"
                  className="mt-1.5 w-56 rounded-md border border-line px-3 py-2 text-sm text-ink placeholder:text-muted-soft focus:border-ink focus:outline-none"
                />
              </div>
              <div>
                <label className="font-label block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                  Private Integration token
                </label>
                <input
                  type="password"
                  name="token"
                  autoComplete="off"
                  placeholder="pit-…"
                  className="mt-1.5 w-72 rounded-md border border-line px-3 py-2 text-sm text-ink placeholder:text-muted-soft focus:border-ink focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={connecting}
                className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-cream transition-colors hover:bg-ink-soft disabled:opacity-60"
              >
                {connecting ? "Verifying…" : current?.connected ? "Replace token" : "Connect"}
              </button>
            </form>

            <div className="mt-2 flex flex-wrap gap-2">
              <form action={test}>
                <input type="hidden" name="clientId" value={selected} />
                <button
                  type="submit"
                  disabled={testing || !current?.connected}
                  className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-paper-soft disabled:opacity-50"
                >
                  {testing ? "Testing…" : "Test"}
                </button>
              </form>
              <form action={disconnectAction}>
                <input type="hidden" name="clientId" value={selected} />
                <button
                  type="submit"
                  disabled={disconnecting || !current?.connected}
                  className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-muted transition-colors hover:border-red-300 hover:text-red-700 disabled:opacity-50"
                >
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </button>
              </form>
            </div>

            {[connectState, testState, disconnectState].map((s, i) =>
              s.error ? (
                <p key={i} className="mt-2 text-sm text-red-600">
                  {s.error}
                </p>
              ) : s.ok && s.message ? (
                <p key={i} className="mt-2 text-sm text-brand-700">
                  {s.message}
                </p>
              ) : null
            )}
          </div>

          <div className="mt-3 max-w-2xl space-y-1.5 text-xs text-muted-soft">
            <p>
              In the client&apos;s GHL sub-account: Settings → Private Integrations → Create, with
              scopes <span className="font-medium text-muted">conversations.readonly</span>,{" "}
              <span className="font-medium text-muted">conversations/message.readonly</span> and{" "}
              <span className="font-medium text-muted">users.readonly</span>. Nothing here ever
              writes to GoHighLevel, so don&apos;t grant write scopes.
            </p>
            <p>
              The Location ID is in Settings → Business Profile, or the{" "}
              <span className="font-mono text-[11px]">/location/&lt;id&gt;/</span> segment of the
              GHL URL.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
