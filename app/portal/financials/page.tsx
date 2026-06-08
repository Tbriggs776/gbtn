import { getSession, getActiveClient } from "@/lib/auth";
import {
  PortalHeader,
  PortalShell,
  EmptyState,
  NoClientState,
} from "@/components/portal/ui";

export default async function FinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);

  return (
    <PortalShell>
      <PortalHeader
        title="Financials"
        subtitle={
          activeClient
            ? `${activeClient.name} · P&L and Balance Sheet analysis`
            : undefined
        }
      />
      <div className="mt-8">
        {!activeClient ? (
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        ) : (
          <EmptyState
            title="Financial dashboards are coming next"
            body="Soon you'll upload your P&L and Balance Sheet here and get live dashboards that surface your top areas for improvement."
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
                <path
                  d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
        )}
      </div>
    </PortalShell>
  );
}
