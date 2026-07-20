import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { OpsShell as Shell } from "@/components/portal/ops/shell";
import { OrdersPipeline } from "@/components/portal/ops/orders-pipeline";
import { NoOrdersState } from "@/components/portal/ops/empty";
import { listOrderLines, lastImportedAt } from "@/lib/ops/service";
import {
  applyWindow,
  asOfFrom,
  bucketOrders,
  clipBuckets,
  DATE_BASES,
  mixOf,
  parseDateParam,
  type Bucket,
  type DateBasis,
  type DateWindow,
  type Grain,
} from "@/lib/ops/pipeline";
import { LINE_SCOPES, SCOPE_FILTER, type LineScope } from "@/lib/ops/drill";
import { fmtDate } from "@/lib/ops/format";

const GRAINS: Grain[] = ["day", "week", "month"];

// Which lines count as a "line". Lives in the URL rather than client state so
// bucketing stays on the server: CG counts aren't additive across classes (a CG
// with both material and labor lines would be counted twice), so the buckets
// can't be summed client-side from per-class sets. The scope vocabulary itself
// lives in lib/ops/drill so the drill-down API applies the identical filter.

export default async function OrdersPipelinePage({
  searchParams,
}: {
  searchParams: Promise<{
    client?: string;
    lines?: string;
    from?: string;
    to?: string;
    basis?: string;
  }>;
}) {
  const {
    client: clientParam,
    lines: linesParam,
    from: fromParam,
    to: toParam,
    basis: basisParam,
  } = await searchParams;
  const scope: LineScope = (LINE_SCOPES as readonly string[]).includes(linesParam ?? "")
    ? (linesParam as LineScope)
    : "all";
  const window: DateWindow = {
    from: parseDateParam(fromParam),
    to: parseDateParam(toParam),
    basis: (DATE_BASES as readonly string[]).includes(basisParam ?? "")
      ? (basisParam as DateBasis)
      : "either",
  };
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  // Gate before any data fetch: dashboards read via the service role,
  // which bypasses RLS, so this is the real enforcement point.
  if (activeClient) await requireCapability(activeClient.id, "ops");

  if (!activeClient) {
    return (
      <PortalShell wide>
        <PortalHeader title="Orders Pipeline" />
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
      <Shell
        client={activeClient.name}
        clientId={activeClient.id}
        subtitle="Order volume by day, week, and month"
      >
        <NoOrdersState />
      </Shell>
    );
  }

  // asOf comes from the FULL set: narrowing by class OR date must not move the
  // snapshot date, or "scheduled ahead" would shift with the filter and a
  // window ending last month would report everything as future.
  const asOf = asOfFrom(lines);
  const mix = mixOf(lines);
  const scopedAll = lines.filter((l) => SCOPE_FILTER[scope](l.lineClass));
  const scoped = applyWindow(scopedAll, window);

  // Forward schedule is a property of the SNAPSHOT, not of whatever period the
  // user is looking at — filtering to Q2 must not report the backlog as zero.
  // Computed from the unwindowed set, at day grain so it never shifts.
  const aheadDays = bucketOrders(scopedAll, "day").filter((b) => b.key > asOf);
  const ahead = {
    lines: aheadDays.reduce((a, b) => a + b.installing, 0),
    noPO: aheadDays.reduce((a, b) => a + b.installingNoPO, 0),
  };
  // Full span of the data, so the picker can bound its inputs to real dates.
  const allDates = lines
    .flatMap((l) => [l.orderDate, l.installDate])
    .filter((d): d is string => Boolean(d))
    .sort();
  const bounds = { min: allDates[0] ?? asOf, max: allDates[allDates.length - 1] ?? asOf };

  // All three grains are cheap over ~17k rows, so bucket them once on the server
  // and let the grain toggle switch without a round trip.
  const buckets = Object.fromEntries(
    GRAINS.map((g) => [g, clipBuckets(bucketOrders(scoped, g), g, window)])
  ) as Record<Grain, Bucket[]>;

  return (
    <Shell
      client={activeClient.name}
      clientId={activeClient.id}
      subtitle={`capacity planning · ${scoped.length.toLocaleString()} of ${lines.length.toLocaleString()} lines · as of ${fmtDate(asOf)}${
        importedAt ? ` · imported ${new Date(importedAt).toLocaleDateString("en-US")}` : ""
      }`}
    >
      <OrdersPipeline
        buckets={buckets}
        asOf={asOf}
        scope={scope}
        mix={mix}
        clientId={activeClient.id}
        window={window}
        bounds={bounds}
        ahead={ahead}
      />

      <div className="mt-6 max-w-[74ch] space-y-2 text-[11.5px] leading-relaxed text-muted-soft">
        <p>
          <span className="font-semibold text-muted">Two clocks, one chart.</span> A line is counted in{" "}
          <em>Ordered</em> on its order date and in <em>Installing</em> on its install date — so the same
          line appears in both series, weeks apart. That gap is the planning window.
        </p>
        <p>
          <span className="font-semibold text-muted">Date range applies to one clock at a time.</span>{" "}
          <em>Either</em> keeps any line touching the window. <em>Ordered</em> gives a cohort — what was
          sold in the window and when it installs, so the install line can run past the end date.{" "}
          <em>Installing</em> is the reverse: the crew load in the window and when that work was sold.
          The snapshot date ({fmtDate(asOf)}) never moves with the filter, so &ldquo;scheduled
          ahead&rdquo; keeps its meaning.
        </p>
        <p>
          <span className="font-semibold text-muted">Canceled orders are excluded</span> from every
          bucket. Empty periods are kept rather than skipped, so a quiet week reads as a quiet week
          instead of vanishing from the axis.
        </p>
      </div>
    </Shell>
  );
}
