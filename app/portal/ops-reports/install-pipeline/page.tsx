import { getSession, getActiveClient } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { OpsShell as Shell } from "@/components/portal/ops/shell";
import { InstallPipeline } from "@/components/portal/ops/install-pipeline";
import { NoOrdersState } from "@/components/portal/ops/empty";
import { listOrderLines, lastImportedAt } from "@/lib/ops/service";
import { asOfFrom, mixOf, rollUpCGs, summarize, toSummary } from "@/lib/ops/pipeline";
import { fmtDate } from "@/lib/ops/format";

export default async function InstallPipelinePage({
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
        <PortalHeader title="Install Pipeline" />
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
      <Shell client={activeClient.name} clientId={activeClient.id} subtitle="What's scheduled and whether the material is ready">
        <NoOrdersState />
      </Shell>
    );
  }

  // The snapshot's "today" is the newest order date in the export, not the
  // wall clock: a board read three weeks after the import must still say what
  // was future *as of the data*, or every number silently rots.
  const asOf = asOfFrom(lines);
  const cgs = rollUpCGs(lines, asOf);
  const summary = summarize(cgs, asOf);
  const mix = mixOf(lines);
  // Ship CG rows + a per-day schedule rollup, not the lines themselves: a full
  // export is ~16k lines (~6MB serialized). Row detail comes from /api/ops/lines.
  const rows = cgs.map(toSummary);

  return (
    <Shell
      client={activeClient.name}
      clientId={activeClient.id}
      subtitle={`${summary.cgTotal.toLocaleString()} CGs · ${summary.lineTotal.toLocaleString()} lines (${mix.material.toLocaleString()} material · ${mix.labor.toLocaleString()} labor · ${mix.other.toLocaleString()} promo/fees) · as of ${fmtDate(asOf)}${
        importedAt ? ` · imported ${new Date(importedAt).toLocaleDateString("en-US")}` : ""
      }`}
    >
      <InstallPipeline cgs={rows} summary={summary} asOf={asOf} clientId={activeClient.id} />

      <div className="mt-6 max-w-[74ch] space-y-2 text-[11.5px] leading-relaxed text-muted-soft">
        <p>
          <span className="font-semibold text-muted">One row per CG.</span> Status columns count{" "}
          <em>line items</em>, so a CG with 8 lines spreads across several columns.{" "}
          <span className="font-semibold text-muted">Install Date</span> shows the earliest line install
          date — phased jobs install over several days and are marked{" "}
          <span className="font-medium text-ink">+n more</span>. Click a row for the line detail.
        </p>
        <p>
          <span className="font-semibold text-muted">Completed?</span> isn&apos;t a field in the export —
          RFMS tracks status per line, not per order. It&apos;s derived: <em>Yes</em> = every line
          delivered, <em>Partial</em> = some, <em>No</em> = none.
        </p>
        <p>
          <span className="font-semibold text-muted">Material installs only</span> hides CGs with nothing
          but promo, fee, or paperwork lines still dated ahead — the floor is already down. Lines are
          classed by RFMS product code: <span className="font-medium text-ink">01–25</span> material,{" "}
          <span className="font-medium text-ink">70–89</span> labor,{" "}
          <span className="font-medium text-ink">90–98</span> promo/fees. Re-code products and that
          mapping needs updating.
        </p>
        <p>
          <span className="font-semibold text-muted">Material w/o a PO</span> counts material lines only.
          Labor and promo lines sit at status <em>None</em> permanently by design — nothing is ever
          purchased for them — so they aren&apos;t a PO gap.
        </p>
      </div>
    </Shell>
  );
}
