import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { CasesList } from "@/components/portal/crm/cases-list";
import { listCases, listContacts } from "@/lib/crm/service";

export default async function CasesPage() {
  const db = await createClient();
  const [cases, contacts] = await Promise.all([
    listCases(db, { status: "all", limit: 300 }),
    listContacts(db, { limit: 500 }),
  ]);
  const open = cases.filter((c) => c.status === "open").length;

  return (
    <PortalShell wide>
      <PortalHeader title="Cases" subtitle={`${open} open care case${open === 1 ? "" : "s"}.`} />
      <CrmNav />
      <CasesList cases={cases} contacts={contacts.rows} />
    </PortalShell>
  );
}
