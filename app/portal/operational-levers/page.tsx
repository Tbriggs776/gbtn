import { getSession, getActiveClient } from "@/lib/auth";
import {
  PortalHeader,
  PortalShell,
  EmptyState,
  NoClientState,
} from "@/components/portal/ui";
import { OperatingModel } from "@/components/portal/levers/operating-model";

// Client-specific interactive tool. Currently scoped to Floor Daddy.
const ENABLED_SLUGS = new Set(["floor-daddy"]);

export default async function OperationalLeversPage({
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
        <PortalHeader title="Operational Levers" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  if (!ENABLED_SLUGS.has(activeClient.slug)) {
    return (
      <PortalShell>
        <PortalHeader title="Operational Levers" subtitle={activeClient.name} />
        <div className="mt-8">
          <EmptyState
            title="Not set up for this client"
            body="This interactive operating model is tailored per client. Ask Tyler to build one for your business."
          />
        </div>
      </PortalShell>
    );
  }

  return (
    <PortalShell>
      <PortalHeader
        title="Operational Levers"
        subtitle={`${activeClient.name} · daily operating model`}
      />
      <div className="mt-8">
        <OperatingModel />
      </div>
    </PortalShell>
  );
}
