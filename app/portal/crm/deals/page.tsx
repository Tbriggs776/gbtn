import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { DealBoard } from "@/components/portal/crm/deal-board";
import { getStages, listDeals, listContacts, listCompanies } from "@/lib/crm/service";
import { getEngagementsByDeal, listLinkableClients } from "@/lib/crm/engagements";
import type { OfferRung } from "@/lib/crm/types";
import { formatCurrency } from "@/lib/format";

export default async function DealsPage() {
  const db = await createClient();
  const [stages, deals, contactsRes, companies] = await Promise.all([
    getStages(db),
    listDeals(db, "all"),
    listContacts(db, { limit: 500 }),
    listCompanies(db),
  ]);

  // Engagements + client list drive the Advantage OS convert widget. Read via
  // the service role: this page is already staff-gated by app/portal/crm/layout
  // (requireStaff), and neither `engagements` nor `clients` has a staff-scoped
  // RLS select policy — an RLS read here would come back empty.
  const admin = createAdminClient();
  const [engagementsMap, clients] = await Promise.all([
    getEngagementsByDeal(admin, deals.map((d) => d.id)),
    listLinkableClients(admin),
  ]);
  const engagementsByDeal: Record<string, { rung: OfferRung | null; name: string }> = {};
  for (const [dealId, e] of engagementsMap) {
    engagementsByDeal[dealId] = { rung: e.offer_rung, name: e.name };
  }

  const open = deals.filter((d) => d.status === "open");
  const pipeline = open.reduce((a, d) => a + (Number(d.value) || 0), 0);

  return (
    <PortalShell wide>
      <PortalHeader
        title="Deals"
        subtitle={`${open.length} open · ${formatCurrency(pipeline)} in pipeline. Drag cards to advance stages.`}
      />
      <CrmNav />
      <DealBoard
        stages={stages}
        deals={deals}
        contacts={contactsRes.rows.map((c) => ({
          id: c.id,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
        }))}
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
        engagementsByDeal={engagementsByDeal}
        clients={clients}
      />
    </PortalShell>
  );
}
