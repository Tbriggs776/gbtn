import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { getDashboard, getStages } from "@/lib/crm/service";
import { formatCurrency, relativeTime } from "@/lib/format";
import { contactName, LIFECYCLE_LABEL, type LifecycleStage } from "@/lib/crm/types";

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

export default async function CrmDashboard() {
  const db = await createClient();
  const [d, stages] = await Promise.all([getDashboard(db), getStages(db)]);

  return (
    <PortalShell wide>
      <PortalHeader
        title="CRM"
        subtitle="Your agency sales pipeline — contacts, deals, outreach, and follow-ups."
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
