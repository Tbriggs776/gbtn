import { getSession, getActiveClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  PortalHeader,
  PortalShell,
  EmptyState,
  NoClientState,
} from "@/components/portal/ui";
import { FinancialUploader } from "@/components/portal/financials/uploader";
import { FinancialDashboard } from "@/components/portal/financials/dashboard";
import {
  StatementsList,
  type StatementRow,
} from "@/components/portal/financials/statements-list";
import { buildPeriods } from "@/lib/financials/build";
import { analyze } from "@/lib/financials/analysis";

export default async function FinancialsPage({
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
        <PortalHeader title="Financials" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const supabase = await createClient();

  const [{ data: uploads }, { data: items }] = await Promise.all([
    supabase
      .from("financial_uploads")
      .select("id, statement_type, period_label, period_end, created_at, status")
      .eq("client_id", activeClient.id)
      .eq("status", "confirmed")
      .order("created_at", { ascending: false }),
    supabase
      .from("financial_line_items")
      .select("statement_type, period_label, category, amount")
      .eq("client_id", activeClient.id),
  ]);

  const periodEndByLabel: Record<string, string | null> = {};
  for (const u of uploads ?? []) {
    if (!(u.period_label in periodEndByLabel)) {
      periodEndByLabel[u.period_label] = u.period_end ?? null;
    }
  }

  const periods = buildPeriods(
    (items ?? []).map((i) => ({
      statement_type: i.statement_type,
      period_label: i.period_label,
      category: i.category,
      amount: Number(i.amount),
    })),
    periodEndByLabel
  );
  const findings = analyze(periods);
  const hasData = periods.length > 0;

  return (
    <PortalShell>
      <PortalHeader
        title="Financials"
        subtitle={`${activeClient.name} · upload your P&L and Balance Sheet to see your numbers`}
        actions={<FinancialUploader clientId={activeClient.id} />}
      />

      <div className="mt-8 space-y-8">
        {hasData ? (
          <FinancialDashboard periods={periods} findings={findings} />
        ) : (
          <EmptyState
            title="No financials yet"
            body="Upload a P&L or Balance Sheet export (.xlsx or .csv) and map the line items once. We'll turn it into live dashboards and flag your top areas for improvement."
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

        <StatementsList statements={(uploads ?? []) as StatementRow[]} />
      </div>
    </PortalShell>
  );
}
