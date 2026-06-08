import { getSession, getActiveClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { DocumentManager } from "@/components/portal/document-manager";
import type { ClientDocument } from "@/lib/types";

export default async function DocumentsPage({
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
        <PortalHeader title="Documents" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const supabase = await createClient();
  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .eq("client_id", activeClient.id)
    .order("created_at", { ascending: false })
    .returns<ClientDocument[]>();

  return (
    <PortalShell>
      <PortalHeader
        title="Documents"
        subtitle={`${activeClient.name} · share files securely with Tyler`}
      />
      <div className="mt-8">
        <DocumentManager
          clientId={activeClient.id}
          documents={documents ?? []}
        />
      </div>
    </PortalShell>
  );
}
