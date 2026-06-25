import { getSession, getActiveClient } from "@/lib/auth";
import {
  PortalHeader,
  PortalShell,
  EmptyState,
  NoClientState,
} from "@/components/portal/ui";
import { getAssumptions } from "@/lib/pricing/assumptions";
import { PricingEstimator } from "@/components/portal/pricing/estimator";

const ENABLED_SLUGS = new Set(["floor-daddy"]);

export default async function PricingPage({
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
        <PortalHeader title="Pricing" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  if (!ENABLED_SLUGS.has(activeClient.slug)) {
    return (
      <PortalShell>
        <PortalHeader title="Pricing" subtitle={activeClient.name} />
        <div className="mt-8">
          <EmptyState
            title="Not set up for this client"
            body="The pricing estimator is tailored per client's catalog. Ask Tyler to build one for your business."
          />
        </div>
      </PortalShell>
    );
  }

  const assumptions = await getAssumptions(activeClient.id);

  return (
    <PortalShell>
      <PortalHeader
        title="Pricing"
        subtitle={`${activeClient.name} · estimate builder`}
      />
      <div className="mt-8">
        <PricingEstimator
          clientId={activeClient.id}
          assumptions={assumptions}
          isAdmin={Boolean(session?.isAdmin)}
        />
      </div>
    </PortalShell>
  );
}
