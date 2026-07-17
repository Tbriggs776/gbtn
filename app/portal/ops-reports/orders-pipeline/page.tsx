import { getSession, getActiveClient } from "@/lib/auth";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { OpsShell as Shell } from "@/components/portal/ops/shell";
import { OrdersPipeline } from "@/components/portal/ops/orders-pipeline";
import { NoOrdersState } from "@/components/portal/ops/empty";
import { listOrderLines, lastImportedAt } from "@/lib/ops/service";
import { asOfFrom, bucketOrders, mixOf, type Bucket, type Grain } from "@/lib/ops/pipeline";
import { fmtDate } from "@/lib/ops/format";

const GRAINS: Grain[] = ["day", "week", "month"];

/**
 * Which lines count as a "line". Lives in the URL rather than client state so
 * bucketing stays on the server: CG counts aren't additive across classes (a CG
 * with both material and labor lines would be counted twice), so the buckets
 * can't be summed client-side from per-class sets.
 */
export type LineScope = "all" | "work" | "material" | "labor";
const SCOPES: Record<LineScope, (c: string) => boolean> = {
  all: () => true,
  work: (c) => c === "material" || c === "labor",
  material: (c) => c === "material",
  labor: (c) => c === "labor",
};

export default async function OrdersPipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; lines?: string }>;
}) {
  const { client: clientParam, lines: linesParam } = await searchParams;
  const scope: LineScope = (["all", "work", "material", "labor"] as const).includes(
    linesParam as LineScope
  )
    ? (linesParam as LineScope)
    : "all";
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);

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

  // asOf comes from the FULL set: narrowing to one class must not move the
  // snapshot date, or the past/future split would shift with the filter.
  const asOf = asOfFrom(lines);
  const mix = mixOf(lines);
  const scoped = lines.filter((l) => SCOPES[scope](l.lineClass));

  // All three grains are cheap over ~17k rows, so bucket them once on the server
  // and let the grain toggle switch without a round trip.
  const buckets = Object.fromEntries(GRAINS.map((g) => [g, bucketOrders(scoped, g)])) as Record<
    Grain,
    Bucket[]
  >;

  return (
    <Shell
      client={activeClient.name}
      clientId={activeClient.id}
      subtitle={`capacity planning · ${scoped.length.toLocaleString()} of ${lines.length.toLocaleString()} lines · as of ${fmtDate(asOf)}${
        importedAt ? ` · imported ${new Date(importedAt).toLocaleDateString("en-US")}` : ""
      }`}
    >
      <OrdersPipeline buckets={buckets} asOf={asOf} scope={scope} mix={mix} />

      <div className="mt-6 max-w-[74ch] space-y-2 text-[11.5px] leading-relaxed text-muted-soft">
        <p>
          <span className="font-semibold text-muted">Two clocks, one chart.</span> A line is counted in{" "}
          <em>Ordered</em> on its order date and in <em>Installing</em> on its install date — so the same
          line appears in both series, weeks apart. That gap is the planning window.
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
