import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { getDashboard, getStages } from "@/lib/crm/service";
import { getOpenEngagementRungCounts } from "@/lib/crm/engagements";
import { formatCurrency, relativeTime } from "@/lib/format";
import {
  contactName,
  LIFECYCLE_LABEL,
  OFFER_RUNGS,
  RUNG_LABEL,
  type LifecycleStage,
} from "@/lib/crm/types";

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-soft">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-ink">{value}</p>
      {sub ? <p className="mt-1 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function CountRow({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </li>
  );
}

export default async function CrmDashboard() {
  const db = await createClient();
  const [d, stages, rungs] = await Promise.all([
    getDashboard(db),
    getStages(db),
    getOpenEngagementRungCounts(db),
  ]);

  // Open deals by stage. Every stage holding an open deal is listed — including
  // won/lost stages, since a deal can be created open in one — and anything left
  // over (no stage, or a stage that no longer exists) lands in "No stage", so the
  // rows always add up to the open-deal count beside them.
  const stageRows = stages
    .map((s) => ({
      id: s.id,
      label: s.is_won ? `${s.name} (won stage)` : s.is_lost ? `${s.name} (lost stage)` : s.name,
      count: d.openDealsByStage[s.id] ?? 0,
    }))
    .filter((r) => r.count > 0);
  const unstaged = d.openDeals - stageRows.reduce((a, r) => a + r.count, 0);

  return (
    <PortalShell wide>
      <PortalHeader
        title="Acquire"
        subtitle="The firm pipeline (CRM): contacts, deals, outreach and follow-ups. Won deals become engagements."
        actions={
          <Link
            href="/portal/crm/contacts"
            className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90"
          >
            View contacts
          </Link>
        }
      />
      <CrmNav />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open pipeline" value={formatCurrency(d.pipelineValue)} sub={`${d.openDeals} open deals`} />
        <Stat label="Weighted pipeline" value={formatCurrency(d.weightedPipeline)} sub="probability-adjusted" />
        <Stat
          label="Won this month"
          value={formatCurrency(d.wonValueThisMonth)}
          sub={`${d.wonThisMonth} deal${d.wonThisMonth === 1 ? "" : "s"}`}
        />
        <Stat label="Contacts" value={String(d.contactsTotal)} sub={`${d.msgsSent30d} messages sent · 30d`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h2 className="text-base font-bold text-ink">Acquire · open deals by stage</h2>
          {d.openDeals === 0 ? (
            <p className="mt-4 text-sm text-muted">No open deals yet.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {stageRows.map((r) => (
                <CountRow key={r.id} label={r.label} value={r.count} />
              ))}
              {unstaged > 0 ? <CountRow label="No stage" value={unstaged} /> : null}
            </ul>
          )}
          <Link href="/portal/crm/deals" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">
            Go to deals →
          </Link>
        </div>

        <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h2 className="text-base font-bold text-ink">Engage · engagements by rung</h2>
          {rungs === null ? (
            <p className="mt-4 text-sm text-muted">Engagement counts aren&apos;t available right now.</p>
          ) : rungs.total === 0 ? (
            <p className="mt-4 text-sm text-muted">No open engagements.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {OFFER_RUNGS.map((r) => (
                <CountRow key={r} label={RUNG_LABEL[r]} value={rungs[r]} />
              ))}
              <CountRow label="Unset" value={rungs.unset} />
            </ul>
          )}
          <p className="mt-4 text-xs text-muted-soft">
            Open engagements only; drafts excluded. A platform admin sets a client&apos;s rung from that client&apos;s
            portal home, which edits their lead engagement.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Pipeline by lifecycle */}
        <div className="rounded-2xl border border-line bg-white p-6 ring-soft lg:col-span-2">
          <h2 className="text-base font-bold text-ink">Contacts by stage</h2>
          <div className="mt-4 flex flex-col gap-2">
            {(Object.keys(LIFECYCLE_LABEL) as LifecycleStage[]).map((s) => {
              const n = d.contactsByStage[s] ?? 0;
              const pct = d.contactsTotal ? Math.round((n / d.contactsTotal) * 100) : 0;
              return (
                <div key={s} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-sm text-muted">{LIFECYCLE_LABEL[s]}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-paper-soft">
                    <div className="h-full rounded-full bg-gradient-brand" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-sm font-semibold text-ink">{n}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-muted-soft">
            {stages.length} pipeline stages configured for deals.
          </p>
        </div>

        {/* Tasks */}
        <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h2 className="text-base font-bold text-ink">Follow-ups</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-paper-soft p-4">
              <p className="text-2xl font-bold text-ink">{d.tasksOpen}</p>
              <p className="text-xs text-muted">open tasks</p>
            </div>
            <div className="rounded-xl bg-paper-soft p-4">
              <p className={`text-2xl font-bold ${d.tasksOverdue > 0 ? "text-brand-700" : "text-ink"}`}>
                {d.tasksOverdue}
              </p>
              <p className="text-xs text-muted">overdue</p>
            </div>
          </div>
          <Link href="/portal/crm/tasks" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">
            Go to tasks →
          </Link>
        </div>
      </div>

      {/* Needs attention */}
      <div className="mt-4 rounded-2xl border border-line bg-white ring-soft">
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-base font-bold text-ink">Needs attention</h2>
          <p className="mt-0.5 text-xs text-muted-soft">Contacts with a follow-up now due or overdue.</p>
        </div>
        {d.needsAttention.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted">Nothing due. You&apos;re caught up.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.needsAttention.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-6 py-3">
                <Link href={`/portal/crm/contacts/${c.id}`} className="text-sm font-semibold text-ink hover:text-brand-700">
                  {contactName(c)}
                  {c.company?.name ? <span className="ml-2 font-normal text-muted-soft">{c.company.name}</span> : null}
                </Link>
                <span className="text-xs text-brand-700">due {relativeTime(c.next_follow_up_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PortalShell>
  );
}
