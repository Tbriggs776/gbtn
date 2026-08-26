import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { ConversationsShell as Shell } from "@/components/portal/ghl/shell";
import { Threads } from "@/components/portal/ghl/threads";
import { Transcript } from "@/components/portal/ghl/transcript";
import {
  EmptyRangeState,
  NoConversationsState,
  NotConnectedState,
} from "@/components/portal/ghl/empty";
import { getConnection, getThread, listConversations } from "@/lib/ghl/service";
import { summarize } from "@/lib/ghl/metrics";
import { dateStamp } from "@/lib/ghl/format";
import { DEFAULT_RANGE, resolveRange, type RangeKey } from "@/lib/ghl/ranges";
import { DateRange } from "@/components/portal/ghl/date-range";

export default async function ThreadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    client?: string;
    thread?: string;
    range?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const {
    client: clientParam,
    thread: threadParam,
    range,
    from: fromParam,
    to: toParam,
  } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  if (activeClient) await requireCapability(activeClient.id, "marketing");

  if (!activeClient) {
    return (
      <PortalShell wide>
        <PortalHeader title="Conversations" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const connection = await getConnection(activeClient.id);
  if (!connection || connection.status === "disconnected") {
    return (
      <PortalShell wide>
        <PortalHeader title="Conversations" subtitle={activeClient.name} />
        <div className="mt-8">
          <NotConnectedState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const window = resolveRange(range, new Date(), fromParam, toParam);
  const rows = await listConversations(
    activeClient.id,
    window.from.toISOString(),
    window.to.toISOString()
  );

  // getThread is scoped to the client, so a guessed id from another tenant
  // resolves to null rather than leaking a transcript.
  const selected = threadParam ? await getThread(activeClient.id, threadParam) : null;

  const summary = summarize(rows);
  const subtitle = `${summary.leads.toLocaleString()} leads · ${window.label.toLowerCase()}${
    connection.lastSyncedAt ? ` · synced ${dateStamp(connection.lastSyncedAt)}` : ""
  }`;

  return (
    <Shell client={activeClient.name} clientId={activeClient.id} subtitle={subtitle}>
      <div className="mb-5">
        <DateRange
          current={(window.key as RangeKey) ?? DEFAULT_RANGE}
          from={fromParam}
          to={toParam}
        />
      </div>

      {rows.length === 0 ? (
        connection.lastSyncedAt ? (
          <EmptyRangeState label={window.label} />
        ) : (
          <NoConversationsState />
        )
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <Threads rows={rows} selectedId={selected?.id ?? null} />
          {selected ? (
            <Transcript thread={selected} />
          ) : (
            <div className="grid place-items-center rounded-xl border border-dashed border-line bg-white px-6 py-16 text-center">
              <div>
                <p className="text-base font-semibold text-ink">Pick a thread</p>
                <p className="mt-1.5 max-w-xs text-sm text-muted">
                  Start with “Needs attention” — the silent leads are at the top.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
