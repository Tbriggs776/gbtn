import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PortalShell } from "@/components/portal/ui";
import { CampaignEditor } from "@/components/portal/crm/campaign-editor";
import { getCampaign, getCampaignSteps, getCampaignStats } from "@/lib/crm/service";

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createClient();
  const campaign = await getCampaign(db, id);
  if (!campaign) notFound();
  const [steps, stats] = await Promise.all([getCampaignSteps(db, id), getCampaignStats(db, id)]);

  return (
    <PortalShell wide>
      <Link href="/portal/crm/campaigns" className="text-sm text-muted hover:text-ink">
        ← All campaigns
      </Link>
      <div className="mt-4 border-b border-line pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{campaign.name}</h1>
        <p className="mt-1 text-sm capitalize text-muted">
          {campaign.channel} · {campaign.type}
        </p>
      </div>
      <CampaignEditor campaign={campaign} steps={steps} stats={stats} />
    </PortalShell>
  );
}
