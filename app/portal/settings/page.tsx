import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { listConnections } from "@/lib/marketing/service";
import { ChannelSettings } from "@/components/portal/settings/channels";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  // Gate before any data fetch: dashboards read via the service role,
  // which bypasses RLS, so this is the real enforcement point.
  if (activeClient) await requireCapability(activeClient.id, "marketing");

  if (!activeClient) {
    return (
      <PortalShell>
        <PortalHeader title="Settings" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const connections = await listConnections(activeClient.id);

  return (
    <PortalShell>
      <PortalHeader
        title="Settings"
        subtitle={`${activeClient.name} · connect your marketing channels`}
      />
      <div className="mt-8">
        <ChannelSettings clientId={activeClient.id} connections={connections} />
      </div>
    </PortalShell>
  );
}
