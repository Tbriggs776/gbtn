import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, EmptyState, NoClientState } from "@/components/portal/ui";
import { Briefing } from "@/components/portal/briefing/briefing";
import { buildBridge } from "@/lib/briefing/bridge";
import type { FpaRawItem } from "@/lib/financials/fpa";
import { listOrderLines } from "@/lib/ops/service";
import { fmtDate } from "@/lib/ops/format";

export default async function BriefingPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  // Same gate as Financials — this joins the P&L to operations.
  if (activeClient) await requireCapability(activeClient.id, "financials");

  if (!activeClient) {
    return (
      <PortalShell wide>
        <PortalHeader title="CFO Briefing" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const supabase = await createClient();
  const [{ data: uploads }, { data: items }, ops] = await Promise.all([
    supabase
      .from("financial_uploads")
      .select("id, period_label, period_end")
      .eq("client_id", activeClient.id)
      .eq("status", "confirmed"),
    supabase
      .from("financial_line_items")
      .select("statement_type, category, raw_label, amount, upload_id")
      .eq("client_id", activeClient.id),
    listOrderLines(activeClient.id),
  ]);

  const meta = new Map(
    (uploads ?? []).map((u) => [u.id, { label: u.period_label, end: u.period_end as string | null }])
  );
  const fin: FpaRawItem[] = (items ?? []).map((i) => {
    const m = meta.get(i.upload_id);
    return {
      periodLabel: m?.label ?? "Unknown",
      periodEnd: m?.end ?? null,
      statementType: i.statement_type,
      category: i.category,
      rawLabel: i.raw_label,
      amount: Number(i.amount),
    };
  });

  const report = buildBridge(ops, fin);

  // The financials' most recent close, for the "two clocks" caption.
  const finThroughEnd = (uploads ?? [])
    .map((u) => u.period_end)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);
  const finThrough =
    (uploads ?? []).find((u) => u.period_end === finThroughEnd)?.period_label ?? null;

  return (
    <PortalShell wide>
      <PortalHeader
        title="CFO Briefing"
        subtitle={`${activeClient.name} · operations and financials, joined`}
      />
      <div className="mt-8">
        {report.hasFin && report.hasOps ? (
          <Briefing report={report} opsAsOf={report.asOf ? fmtDate(report.asOf) : null} finThrough={finThrough} />
        ) : (
          <EmptyState
            title={report.hasFin ? "No operations data yet" : "No financials yet"}
            body={
              report.hasFin
                ? "The briefing joins your P&L to the RFMS orders pipeline. Import an Orders export on Ops Reports to light up the operations side."
                : "Load the month-end (MRP) workbook on the Financials tab, and import the RFMS orders on Ops Reports, to build the briefing."
            }
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
                <path d="M4 19V5m0 14h16M8 13l3 3 3-6 3 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
        )}
      </div>
    </PortalShell>
  );
}
