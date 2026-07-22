import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { OpsShell } from "@/components/portal/ops/shell";
import { SpeedToInstall } from "@/components/portal/ops/speed-to-install";
import { NoOrdersState } from "@/components/portal/ops/empty";
import { listOrderLines, lastImportedAt } from "@/lib/ops/service";
import { buildCycleReport } from "@/lib/ops/cycle";
import { asOfFrom } from "@/lib/ops/pipeline";
import { fmtDate, fmtImported } from "@/lib/ops/format";

export default async function SpeedToInstallPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  // Gate before any data fetch: dashboards read via the service role,
  // which bypasses RLS, so this is the real enforcement point.
  if (activeClient) await requireCapability(activeClient.id, "ops");

  if (!activeClient) {
    return (
      <PortalShell wide>
        <PortalHeader title="Speed to Install" />
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
        subtitle="How long customers wait, measure to install"
      >
        <NoOrdersState />
      </OpsShell>
    );
  }

  const asOf = asOfFrom(lines);
  const report = buildCycleReport(lines, asOf);

  return (
    <OpsShell
      client={activeClient.name}
      clientId={activeClient.id}
      subtitle={`speed to install · ${report.jobs.length.toLocaleString()} jobs · as of ${fmtDate(asOf)}${
        importedAt ? ` · imported ${fmtImported(importedAt)}` : ""
      }`}
    >
      <SpeedToInstall report={report} asOf={asOf} />

      <div className="mt-6 max-w-[74ch] space-y-2 text-[11.5px] leading-relaxed text-muted-soft">
        <p>
          <span className="font-semibold text-muted">Measured at the CG, not the line.</span> A customer
          waits for one job. The clock starts at the earliest{" "}
          <span className="font-medium text-ink">&amp;Measure Date</span> on the order and stops at the
          earliest install date — for a phased job, the wait ends when the first crew arrives.
        </p>
        <p>
          <span className="font-semibold text-muted">Medians, not averages.</span> The distribution has a
          long right tail, so a mean reports a wait no customer ever had. Canceled orders are excluded;
          jobs with no measure or no install date can&apos;t be timed and sit out entirely.
        </p>
        <p>
          <span className="font-semibold text-muted">Completed installs only.</span>{" "}
          {report.scheduledAhead > 0 ? (
            <>
              {report.scheduledAhead} timeable job{report.scheduledAhead === 1 ? " is" : "s are"} still
              scheduled ahead and sit out of every number here —{" "}
            </>
          ) : null}
          a wait nobody has finished waiting is a plan, not an observation. Upcoming work belongs to the{" "}
          <span className="font-medium text-ink">Install Pipeline</span>.
        </p>
      </div>
    </OpsShell>
  );
}
