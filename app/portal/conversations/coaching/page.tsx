import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { ConversationsShell as Shell } from "@/components/portal/ghl/shell";
import { Coaching } from "@/components/portal/ghl/coaching";
import { NoConversationsState, NotConnectedState } from "@/components/portal/ghl/empty";
import { getConnection, latestNotes, listConversations } from "@/lib/ghl/service";
import { windowStart } from "@/lib/ghl/sync";
import { byRep, summarize } from "@/lib/ghl/metrics";
import { MIN_LEADS_FOR_REP_COACHING } from "@/lib/ghl/coaching";
import { dateStamp } from "@/lib/ghl/format";

export default async function CoachingPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
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

  const from = windowStart();
  const to = new Date();
  const [rows, notes] = await Promise.all([
    listConversations(activeClient.id, from.toISOString(), to.toISOString()),
    latestNotes(activeClient.id),
  ]);

  const summary = summarize(rows);
  const subtitle = `${summary.leads.toLocaleString()} leads in the last 90 days${
    connection.lastSyncedAt ? ` · synced ${dateStamp(connection.lastSyncedAt)}` : ""
  }`;

  return (
    <Shell client={activeClient.name} clientId={activeClient.id} subtitle={subtitle}>
      {rows.length === 0 ? (
        <NoConversationsState />
      ) : (
        <>
          <Coaching
            clientId={activeClient.id}
            reps={byRep(rows)}
            notes={notes}
            minLeads={MIN_LEADS_FOR_REP_COACHING}
          />

          <div className="mt-6 max-w-[74ch] space-y-2 text-[11.5px] leading-relaxed text-muted-soft">
            <p>
              <span className="font-semibold text-muted">The AI never counts.</span> Every statistic
              in a generated review is computed here and handed to the model as fact — it is asked
              to explain the transcripts and say what to do, not to tally them. That&apos;s
              deliberate: an LLM asked to count several hundred threads will produce a confident
              wrong number.
            </p>
            <p>
              <span className="font-semibold text-muted">Customer contact details are stripped</span>{" "}
              from transcripts before they&apos;re sent for analysis — phone numbers, email
              addresses and street addresses are replaced with placeholders. Names stay, because
              removing them makes the dialogue unreadable. The message text itself does leave our
              servers and go to Anthropic when you press Generate.
            </p>
            <p>
              <span className="font-semibold text-muted">
                Open-hours medians are the fairer comparison.
              </span>{" "}
              A rep who covers Saturdays will look slower on wall time and shouldn&apos;t. Read the
              two columns together before drawing a conclusion about anybody.
            </p>
          </div>
        </>
      )}
    </Shell>
  );
}
