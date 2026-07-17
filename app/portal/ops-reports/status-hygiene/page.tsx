import { getSession, getActiveClient } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { OpsShell } from "@/components/portal/ops/shell";
import { StatusHygiene } from "@/components/portal/ops/status-hygiene";
import { NoOrdersState } from "@/components/portal/ops/empty";
import { listOrderLines, lastImportedAt } from "@/lib/ops/service";
import { buildHygieneReport } from "@/lib/ops/hygiene";
import { asOfFrom } from "@/lib/ops/pipeline";
import { fmtDate } from "@/lib/ops/format";

export default async function StatusHygienePage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);

  if (!activeClient) {
    return (
      <PortalShell wide>
        <PortalHeader title="Status Hygiene" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const [lines, importedAt] = await Promise.all([
    listOrderLines(activeClient.id),
    lastImportedAt(activeClient.id),
  ]);

  if (lines.length === 0) {
    return (
      <OpsShell
        client={activeClient.name}
        clientId={activeClient.id}
        subtitle="Material installed but never marked received"
      >
        <NoOrdersState />
      </OpsShell>
    );
  }

  const asOf = asOfFrom(lines);
  const report = buildHygieneReport(lines, asOf);

  return (
    <OpsShell
      client={activeClient.name}
      clientId={activeClient.id}
      subtitle={`status hygiene · ${report.staleCGs.length.toLocaleString()} CGs to clear · as of ${fmtDate(asOf)}${
        importedAt ? ` · imported ${new Date(importedAt).toLocaleDateString("en-US")}` : ""
      }`}
    >
      <StatusHygiene report={report} asOf={asOf} />

      <div className="mt-6 max-w-[74ch] space-y-2 text-[11.5px] leading-relaxed text-muted-soft">
        <p>
          <span className="font-semibold text-muted">Material only.</span> Labor lines are never purchased,
          so a labor line sitting at <em>None</em> forever is correct, not stale — including them would turn
          this into a list of thousands and make it worthless. Lines are classed by RFMS product code
          (01–25 material, 70–89 labor, 90–98 promo/fees).
        </p>
        <p>
          <span className="font-semibold text-muted">&ldquo;Installed&rdquo; means the install date has
          passed</span> relative to the export&apos;s snapshot date, not that anyone confirmed the crew
          finished. A job scheduled for last month that got pushed will show here; that&apos;s a scheduling
          record to fix rather than a receipt to post — either way it&apos;s worth knowing.
        </p>
        <p>
          <span className="font-semibold text-muted">Clearing this unlocks the rest.</span> Tab 3 (aged Gen
          PO, On Order past due), Tab 4 (Staging), and Tab 6 (unbilled Delivered) all key off line status.
          Until material moves through receipt, those reports can&apos;t distinguish a late vendor from an
          unposted receipt.
        </p>
      </div>
    </OpsShell>
  );
}
