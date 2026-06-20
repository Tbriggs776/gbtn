import { getSession, getActiveClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  PortalHeader,
  PortalShell,
  EmptyState,
  NoClientState,
} from "@/components/portal/ui";
import { FinancialUploader } from "@/components/portal/financials/uploader";
import { MrpUploader } from "@/components/portal/financials/mrp-uploader";
import { FinancialDashboard } from "@/components/portal/financials/dashboard";
import {
  StatementsList,
  type StatementRow,
} from "@/components/portal/financials/statements-list";
import { buildPeriods } from "@/lib/financials/build";

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
      .select("statement_type, category, amount, upload_id")
      .eq("client_id", activeClient.id),
  ]);

  // period_label / period_end live on the upload; map them onto line items.
  const uploadMeta = new Map(
    (uploads ?? []).map((u) => [
      u.id,
      { label: u.period_label, end: u.period_end as string | null },
    ])
  );

  const periodEndByLabel: Record<string, string | null> = {};
  for (const u of uploads ?? []) {
    if (!(u.period_label in periodEndByLabel)) {
      periodEndByLabel[u.period_label] = u.period_end ?? null;
    }
  }

  const periods = buildPeriods(
    (items ?? []).map((i) => ({
      statement_type: i.statement_type,
      period_label: uploadMeta.get(i.upload_id)?.label ?? "Unknown",
      category: i.category,
      amount: Number(i.amount),
    })),
    periodEndByLabel
  );
  const hasData = periods.length > 0;
  const isAdmin = Boolean(session?.isAdmin);

  // Default the MRP year to the most recent loaded period, else the current year.
  const latestEnd = (uploads ?? [])
    .map((u) => u.period_end)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);
  const defaultYear = latestEnd
    ? Number(latestEnd.slice(0, 4))
    : new Date().getFullYear();

  return (
    <PortalShell>
      <PortalHeader
        title="Financials"
        subtitle={
          isAdmin
            ? `${activeClient.name} · load the month-end workbook to refresh the dashboard`
            : `${activeClient.name} · your numbers at a glance`
        }
        actions={
          isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <MrpUploader clientId={activeClient.id} defaultYear={defaultYear} />
              <FinancialUploader clientId={activeClient.id} />
            </div>
          ) : undefined
        }
      />

      <div className="mt-8 space-y-8">
        {hasData ? (
          <FinancialDashboard periods={periods} />
        ) : (
          <EmptyState
            title="No financials yet"
            body={
              isAdmin
                ? "Load the month-end (MRP) workbook to build live dashboards, or upload a single P&L / Balance Sheet and map the line items once."
                : "Your financial dashboards will appear here once your advisor loads your month-end numbers."
            }
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

        {isAdmin && (
          <StatementsList statements={(uploads ?? []) as StatementRow[]} />
        )}
      </div>
    </PortalShell>
  );
}
