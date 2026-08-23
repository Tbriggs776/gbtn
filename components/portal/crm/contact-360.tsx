import { formatDate, formatCurrency } from "@/lib/format";
import type { CrmContactWithCompany, CrmDeal, CrmEnrollmentWithCampaign } from "@/lib/crm/types";

export function Contact360({
  contact,
  deals,
  lastEnrollment,
}: {
  contact: CrmContactWithCompany;
  deals: CrmDeal[];
  lastEnrollment: CrmEnrollmentWithCampaign | null;
}) {
  const openDeal = deals.find((d) => d.status === "open") ?? null;
  const arr = Number(contact.mrr || 0) * 12;
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h2 className="text-sm font-bold text-ink">Contact 360</h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Won deals" value={String(contact.won_deal_count ?? 0)} />
        <Stat label="Lifetime value" value={formatCurrency(Number(contact.lifetime_value || 0))} />
        <Stat label="MRR" value={formatCurrency(Number(contact.mrr || 0))} />
        <Stat label="ARR" value={formatCurrency(arr)} />
        <Stat label="First won" value={contact.first_won_at ? formatDate(contact.first_won_at) : "—"} />
        <Stat label="Last won" value={contact.last_won_at ? formatDate(contact.last_won_at) : "—"} />
      </dl>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-paper-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-muted">Open deal</p>
          {openDeal ? (
            <p className="mt-1 truncate text-sm font-semibold text-ink">
              {openDeal.title}
              <span className="ml-2 font-normal text-muted">{formatCurrency(Number(openDeal.value))}</span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-soft">No open deal</p>
          )}
        </div>
        <div className="rounded-xl bg-paper-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-muted">Last campaign</p>
          {lastEnrollment?.campaign ? (
            <p className="mt-1 truncate text-sm font-semibold text-ink">
              {lastEnrollment.campaign.name}
              <span className="ml-2 font-normal text-muted">
                {lastEnrollment.status}
                {lastEnrollment.enrolled_at ? ` · ${formatDate(lastEnrollment.enrolled_at)}` : ""}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-soft">No enrollments</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-soft">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}
