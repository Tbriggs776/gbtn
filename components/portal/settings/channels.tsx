"use client";

import { useActionState } from "react";
import type { ConnectionRow, Provider } from "@/lib/marketing/service";
import {
  connectCallRailAction,
  disconnectConnectionAction,
  type SettingsState,
} from "@/app/portal/settings/actions";

const initial: SettingsState = {};

type ChannelDef = {
  provider: Provider;
  name: string;
  desc: string;
  available: boolean;
};

const CHANNELS: ChannelDef[] = [
  { provider: "callrail", name: "CallRail", desc: "Call tracking — phone calls & qualified leads.", available: true },
  { provider: "ga4", name: "Google Analytics 4", desc: "Sessions, engagement, and conversions.", available: false },
  { provider: "google_ads", name: "Google Ads", desc: "Spend, clicks, and conversions.", available: false },
  { provider: "meta_ads", name: "Meta Ads", desc: "Facebook & Instagram ad performance.", available: false },
  { provider: "gbp", name: "Google Business Profile", desc: "Profile views, website clicks, and calls.", available: false },
];

export function ChannelSettings({
  clientId,
  connections,
}: {
  clientId: string;
  connections: ConnectionRow[];
}) {
  const byProvider = new Map(connections.map((c) => [c.provider, c]));

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted">
        Connect the tools you already use. Your keys are encrypted and stored
        securely — they&apos;re never shown again or exposed to your browser. We
        only ever read your performance numbers, never change anything in your
        accounts.
      </p>

      <div className="grid gap-4">
        {CHANNELS.map((ch) => (
          <ChannelCard
            key={ch.provider}
            channel={ch}
            clientId={clientId}
            connection={byProvider.get(ch.provider) ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function ChannelCard({
  channel,
  clientId,
  connection,
}: {
  channel: ChannelDef;
  clientId: string;
  connection: ConnectionRow | null;
}) {
  const connected = connection?.status === "connected";

  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-ink">{channel.name}</h3>
            {connected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Connected
              </span>
            ) : channel.available ? (
              <span className="rounded-full bg-paper-soft px-2 py-0.5 text-[11px] font-semibold text-muted-soft">
                Not connected
              </span>
            ) : (
              <span className="rounded-full bg-paper-soft px-2 py-0.5 text-[11px] font-semibold text-muted-soft">
                Coming soon
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">{channel.desc}</p>
          {connected && connection?.display_name ? (
            <p className="mt-1 text-xs text-muted-soft">
              Account: {connection.display_name}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        {channel.provider === "callrail" ? (
          connected ? (
            <DisconnectForm clientId={clientId} connectionId={connection!.id} />
          ) : (
            <CallRailConnectForm clientId={clientId} />
          )
        ) : (
          <button
            disabled
            className="font-label cursor-not-allowed rounded-md border border-line px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-soft"
          >
            Connect (soon)
          </button>
        )}
      </div>
    </div>
  );
}

function CallRailConnectForm({ clientId }: { clientId: string }) {
  const [state, action, pending] = useActionState(connectCallRailAction, initial);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="clientId" value={clientId} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="cr-key" className="mb-1 block text-xs font-medium text-ink">
            CallRail API key
          </label>
          <input
            id="cr-key"
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            placeholder="Paste your API key"
            className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:opacity-60"
        >
          {pending ? "Connecting…" : "Connect"}
        </button>
      </div>
      <p className="text-xs text-muted-soft">
        Find this in CallRail under Account → API Keys.
      </p>
      {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
      {state.ok && state.message ? (
        <p className="text-sm text-brand-700">{state.message}</p>
      ) : null}
    </form>
  );
}

function DisconnectForm({
  clientId,
  connectionId,
}: {
  clientId: string;
  connectionId: string;
}) {
  const [state, action, pending] = useActionState(disconnectConnectionAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-line px-4 py-2 text-xs font-semibold text-muted transition-colors hover:border-red-200 hover:text-red-600 disabled:opacity-60"
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      {state.error ? <p className="mt-2 text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
