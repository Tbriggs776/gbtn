import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, EmptyState } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { NewCampaignButton } from "@/components/portal/crm/campaigns-client";
import { Badge } from "@/components/portal/crm/ui";
import { listCampaigns } from "@/lib/crm/service";
import { formatDate } from "@/lib/format";

const STATUS_TONE: Record<string, "neutral" | "green" | "amber" | "blue" | "red"> = {
  draft: "neutral",
  scheduled: "amber",
  sending: "blue",
  active: "green",
  paused: "amber",
  done: "neutral",
  archived: "neutral",
};

export default async function CampaignsPage() {
  const db = await createClient();
  const campaigns = await listCampaigns(db);

  return (
    <PortalShell wide>
      <PortalHeader
        title="Campaigns"
        subtitle="Email & SMS blasts and drip sequences."
        actions={<NewCampaignButton />}
      />
      <CrmNav />

      {campaigns.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No campaigns yet" body="Create a blast or a multi-step drip sequence to nurture your pipeline." />
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-line bg-white ring-soft">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted-soft">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Channel</th>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-paper-soft">
                  <td className="px-5 py-3">
                    <Link href={`/portal/crm/campaigns/${c.id}`} className="font-semibold text-ink hover:text-brand-700">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3 capitalize text-muted">{c.channel}</td>
                  <td className="px-5 py-3 capitalize text-muted">{c.type}</td>
                  <td className="px-5 py-3">
                    <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status}</Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-soft">{formatDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PortalShell>
  );
}
