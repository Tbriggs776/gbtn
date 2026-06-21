import { getSession, getActiveClient } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { listRevenue } from "@/lib/marketing/revenue";
import { aggregateRevenue } from "@/lib/marketing/aggregate";
import { RevenueUploader } from "@/components/portal/marketing/revenue-uploader";
import { MarketingDashboard } from "@/components/portal/marketing/dashboard";

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);

  if (!activeClient) {
    return (
      <PortalShell>
        <PortalHeader title="Marketing" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const records = await listRevenue(activeClient.id);
  const agg = aggregateRevenue(records);

  return (
    <PortalShell>
      <PortalHeader
        title="Marketing"
        subtitle={`${activeClient.name} · revenue by channel`}
        actions={<RevenueUploader clientId={activeClient.id} />}
      />
      <div className="mt-8">
        {agg ? (
          <MarketingDashboard agg={agg} />
        ) : (
          <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-14 text-center">
            <p className="text-base font-semibold text-ink">No marketing data yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
              Upload a spreadsheet with a <span className="font-medium text-ink">Date</span>,{" "}
              <span className="font-medium text-ink">Channel/Source</span>, and{" "}
              <span className="font-medium text-ink">Revenue</span> column. We&apos;ll
              attribute revenue to each channel and chart the trend. Spend and lead
              metrics will layer in once your ad platforms are connected.
            </p>
            <a
              href="/portal/marketing/template"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 underline-offset-4 hover:underline"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                <path d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Download the Excel template
            </a>
          </div>
        )}
      </div>
    </PortalShell>
  );
}
