import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { DocumentManager } from "@/components/portal/document-manager";
import type { ClientDocument } from "@/lib/types";
import { visibleDocumentCategories } from "@/lib/permissions";

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  // Gate before any data fetch: dashboards read via the service role,
  // which bypasses RLS, so this is the real enforcement point.
  if (activeClient) await requireCapability(activeClient.id, "documents");

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
  // RLS already withholds Financials-category rows from ops/marketing, but the
  // filter is repeated here so the page does not depend on that alone — every
  // other dashboard reads through the service role, and this one is one
  // refactor away from doing the same.
  const { all: allCategories, hidden } = visibleDocumentCategories(
    session ? session.roles[activeClient.id] : null,
    Boolean(session?.isAdmin)
  );
  let query = supabase
    .from("documents")
    .select("*")
    .eq("client_id", activeClient.id);
  if (!allCategories) query = query.not("category", "in", `(${hidden.join(",")})`);
  const { data: documents } = await query
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
          canUploadFinancials={allCategories}
        />
      </div>
    </PortalShell>
  );
}
