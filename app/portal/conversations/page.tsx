import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { ConversationsShell as Shell } from "@/components/portal/ghl/shell";
import { Overview } from "@/components/portal/ghl/overview";
import {
  EmptyRangeState,
  NoConversationsState,
  NotConnectedState,
  SyncErrorState,
} from "@/components/portal/ghl/empty";
import { getConnection, listConversations } from "@/lib/ghl/service";
import { BUSINESS_HOURS, byChannel, byHour, byMonth, byRep, summarize } from "@/lib/ghl/metrics";
import { dateStamp } from "@/lib/ghl/format";
import { DEFAULT_RANGE, resolveRange, type RangeKey } from "@/lib/ghl/ranges";
import { DateRange } from "@/components/portal/ghl/date-range";

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; range?: string; from?: string; to?: string }>;
}) {
  const { client: clientParam, range, from: fromParam, to: toParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  // Gate before any data fetch: this page reads via the service role, which
  // bypasses RLS, so this is the real enforcement point.
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

      {connection.lastSyncError ? (
        <div className="mb-5">
          <SyncErrorState message={connection.lastSyncError} />
        </div>
      ) : null}

      {rows.length === 0 ? (
        connection.lastSyncedAt ? (
          <EmptyRangeState label={window.label} />
        ) : (
          <NoConversationsState />
        )
      ) : (
        <>
          <Overview
            summary={summary}
            months={byMonth(rows)}
            hours={byHour(rows)}
            channels={byChannel(rows)}
            reps={byRep(rows)}
            // Weekday hours drive the shading; Saturday is shorter and Sunday
            // closed, but shading three different bands on one 24-hour axis
            // reads as noise. The footnote below carries the nuance.
            businessHours={BUSINESS_HOURS[1] ?? { open: 8, close: 17 }}
          />

          <div className="mt-6 max-w-[74ch] space-y-2 text-[11.5px] leading-relaxed text-muted-soft">
            <p>
              <span className="font-semibold text-muted">A “lead” is a thread someone wrote
              into.</span>{" "}
              Outbound-only threads — drip campaigns, blasts, review requests nobody answered — are
              excluded from every number here. Counting them would answer a question nobody asked
              and drag every average toward zero.
            </p>
            <p>
              <span className="font-semibold text-muted">“Answered” means a person replied.</span>{" "}
              GoHighLevel&apos;s workflow auto-responder fires within seconds of an inbound text, so
              scoring it as an answer would report a superb response time on leads nobody ever
              called back. Sends marked <em>workflow</em>, <em>campaign</em>, <em>bulk action</em>{" "}
              or <em>API</em> don&apos;t count; the <span className="font-medium text-ink">
              Auto-reply only</span> tile is exactly those threads.
            </p>
            <p>
              <span className="font-semibold text-muted">Two clocks.</span> The median reply is wall
              time — what the customer actually waited. The open-hours figure counts only time the
              showroom was open (weekdays{" "}
              {BUSINESS_HOURS[1]?.open}:00–{BUSINESS_HOURS[1]?.close}:00, Saturday{" "}
              {BUSINESS_HOURS[6]?.open}:00–{BUSINESS_HOURS[6]?.close}:00, closed Sunday), so a lead
              that arrives at 9pm isn&apos;t held against the rep who called at opening. Those hours
              are an assumption — if they&apos;re wrong, tell Tyler and the numbers follow.
            </p>
            <p>
              <span className="font-semibold text-muted">CRM activity isn&apos;t conversation.</span>{" "}
              Appointment, invoice and opportunity log entries share the GHL inbox with real
              messages; they&apos;re dropped at import. Internal comments are dropped too — the
              customer never saw them, so they can&apos;t count as a reply.
            </p>
          </div>
        </>
      )}
    </Shell>
  );
}
