import Link from "next/link";
import { getSession, getActiveClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { buildPeriods } from "@/lib/financials/build";
import { aggregatePL, money, percent, ratio } from "@/lib/financials/metrics";
import { analyze } from "@/lib/financials/analysis";
import type { ReactNode } from "react";

// ── Small presentational helpers (server components) ─────────────────────────

function DeltaBadge({
  value,
  unit,
  goodUp = true,
}: {
  value: number | null;
  unit: "%" | "pts" | "$";
  goodUp?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < (unit === "pts" ? 0.1 : unit === "$" ? 1 : 0.5);
  const up = value > 0;
  const good = flat ? null : up === goodUp;
  const color =
    good == null
      ? "bg-paper-soft text-muted-soft"
      : good
        ? "bg-emerald-50 text-emerald-700"
        : "bg-red-50 text-red-700";
  const arrow = flat ? "→" : up ? "▲" : "▼";
  const text =
    unit === "$"
      ? money(Math.abs(value))
      : `${Math.abs(value).toFixed(1)}${unit === "pts" ? " pts" : "%"}`;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${color}`}
    >
      {arrow} {text}
    </span>
  );
}

function StatCard({
  label,
  value,
  delta,
  sub,
}: {
  label: string;
  value: string;
  delta?: ReactNode;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">
        {label}
      </p>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <p className="text-2xl font-bold tracking-tight text-ink">
          <span className="text-gradient">{value}</span>
        </p>
        {delta}
      </div>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 240;
  const h = 48;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / span) * (h - 2 * pad);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-12 w-full" aria-hidden="true">
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9e2335" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#9e2335" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark)" />
      <path
        d={line}
        fill="none"
        stroke="#9e2335"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const SEV_DOT: Record<string, string> = {
  critical: "bg-red-500",
  warn: "bg-amber-500",
  good: "bg-brand-500",
};

export default async function PortalHome({
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
        <PortalHeader title="Welcome" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const supabase = await createClient();
  const [{ count: docCount }, { data: uploads }, { data: items }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("*", { count: "exact", head: true })
        .eq("client_id", activeClient.id),
      supabase
        .from("financial_uploads")
        .select("id, period_label, period_end, status")
        .eq("client_id", activeClient.id)
        .eq("status", "confirmed"),
      supabase
        .from("financial_line_items")
        .select("statement_type, category, amount, upload_id")
        .eq("client_id", activeClient.id),
    ]);

  const uploadLabel = new Map(
    (uploads ?? []).map((u) => [u.id, u.period_label as string])
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
      period_label: uploadLabel.get(i.upload_id) ?? "Unknown",
      category: i.category,
      amount: Number(i.amount),
    })),
    periodEndByLabel
  );

  const firstName = session?.profile?.full_name?.split(" ")[0] ?? "there";
  const hasData = periods.length > 0;

  const latest = periods[periods.length - 1];
  const prev = periods.length > 1 ? periods[periods.length - 2] : null;
  const pl = latest?.pl ?? null;
  const bs = latest?.bs ?? null;

  // YTD: aggregate P&L across periods in the latest period's calendar year.
  const latestYear = latest?.periodEnd?.slice(0, 4) ?? null;
  const ytdPls = periods
    .filter((p) => (latestYear ? (p.periodEnd ?? "").slice(0, 4) === latestYear : true))
    .map((p) => p.pl)
    .filter((p): p is NonNullable<typeof p> => p != null);
  const ytd = aggregatePL(ytdPls);

  // Top focus areas straight from the analysis engine.
  const focus = analyze(periods)
    .filter((f) => f.severity !== "good")
    .slice(0, 3);

  // Latest-month deltas vs the prior month.
  const revDelta =
    pl && prev?.pl && prev.pl.revenue
      ? ((pl.revenue - prev.pl.revenue) / prev.pl.revenue) * 100
      : null;
  const gmDelta =
    pl?.grossMargin != null && prev?.pl?.grossMargin != null
      ? pl.grossMargin - prev.pl.grossMargin
      : null;
  const emDelta =
    pl?.ebitdaMargin != null && prev?.pl?.ebitdaMargin != null
      ? pl.ebitdaMargin - prev.pl.ebitdaMargin
      : null;
  const cashDelta =
    bs && prev?.bs ? bs.cash - prev.bs.cash : null;

  const finHref = `/portal/financials?client=${activeClient.id}`;
  const docHref = `/portal/documents?client=${activeClient.id}`;
  const vsPrev = prev ? `vs ${prev.label}` : undefined;

  return (
    <PortalShell>
      <PortalHeader
        title={`Hi ${firstName}`}
        subtitle={
          hasData
            ? `${activeClient.name} · snapshot through ${latest.label}`
            : `${activeClient.name} · your financial command center`
        }
      />

      {hasData ? (
        <div className="mt-8 space-y-8">
          {/* This month at a glance */}
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-soft">
                This month · {latest.label}
              </h2>
              <Link href={finHref} className="text-xs font-semibold text-brand-700 hover:underline">
                Full dashboard →
              </Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {pl && (
                <>
                  <StatCard
                    label="Revenue"
                    value={money(pl.revenue)}
                    delta={<DeltaBadge value={revDelta} unit="%" />}
                    sub={vsPrev}
                  />
                  <StatCard
                    label="Gross Margin"
                    value={percent(pl.grossMargin)}
                    delta={<DeltaBadge value={gmDelta} unit="pts" />}
                    sub={`Gross profit ${money(pl.grossProfit)}`}
                  />
                  <StatCard
                    label="EBITDA Margin"
                    value={percent(pl.ebitdaMargin)}
                    delta={<DeltaBadge value={emDelta} unit="pts" />}
                    sub={`EBITDA ${money(pl.ebitda)}`}
                  />
                </>
              )}
              {bs ? (
                <StatCard
                  label="Cash"
                  value={money(bs.cash)}
                  delta={<DeltaBadge value={cashDelta} unit="$" />}
                  sub={`Current ratio ${ratio(bs.currentRatio)}`}
                />
              ) : (
                pl && (
                  <StatCard
                    label="Net Income"
                    value={money(pl.netIncome)}
                    sub={vsPrev}
                  />
                )
              )}
            </div>
          </section>

          {/* Trend + YTD */}
          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-line bg-white p-6 ring-soft lg:col-span-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-bold text-ink">Revenue trend</h3>
                <span className="text-xs text-muted-soft">
                  {periods[0].label} – {latest.label}
                </span>
              </div>
              <div className="mt-4">
                <Sparkline values={periods.map((p) => p.pl?.revenue ?? 0)} />
              </div>
              {ytd && (
                <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-line pt-4">
                  <div>
                    <dt className="text-xs text-muted-soft">YTD revenue</dt>
                    <dd className="mt-0.5 text-lg font-bold text-ink">{money(ytd.revenue)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-soft">YTD gross margin</dt>
                    <dd className="mt-0.5 text-lg font-bold text-ink">{percent(ytd.grossMargin)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-soft">YTD EBITDA</dt>
                    <dd className="mt-0.5 text-lg font-bold text-ink">{money(ytd.ebitda)}</dd>
                  </div>
                </dl>
              )}
            </div>

            {/* Top focus area */}
            <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
              <h3 className="text-sm font-bold text-ink">Where to focus</h3>
              {focus.length === 0 ? (
                <p className="mt-3 text-sm text-muted">
                  Nothing flagged against our benchmarks — the numbers look healthy.
                </p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {focus.map((f) => (
                    <li key={f.id} className="flex items-start gap-2.5">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV_DOT[f.severity]}`} />
                      <div>
                        <p className="text-sm font-semibold text-ink">{f.title}</p>
                        <p className="text-xs text-muted">
                          {f.current} <span className="text-muted-soft">vs {f.target}</span>
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Link href={finHref} className="mt-4 inline-block text-xs font-semibold text-brand-700 hover:underline">
                See the full breakdown →
              </Link>
            </div>
          </section>

          {/* Quick links */}
          <section className="grid gap-4 sm:grid-cols-2">
            <QuickLink
              href={docHref}
              title="Documents"
              stat={`${docCount ?? 0}`}
              label={docCount === 1 ? "file shared" : "files shared"}
              body="Securely exchange statements, contracts, and reports."
            />
            <QuickLink
              href={finHref}
              title="Financials"
              stat={`${periods.length}`}
              label={periods.length === 1 ? "month tracked" : "months tracked"}
              body="Dashboards, date ranges, and your top areas for improvement."
            />
          </section>
        </div>
      ) : (
        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <QuickLink
            href={docHref}
            title="Documents"
            stat={`${docCount ?? 0}`}
            label={docCount === 1 ? "file shared" : "files shared"}
            body="Securely exchange statements, contracts, and reports."
          />
          <QuickLink
            href={finHref}
            title="Financials"
            stat="0"
            label="months tracked"
            body="Your dashboards will appear here once your month-end numbers are loaded."
          />
        </div>
      )}
    </PortalShell>
  );
}

function QuickLink({
  href,
  title,
  stat,
  label,
  body,
}: {
  href: string;
  title: string;
  stat: string;
  label: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-line bg-white p-6 ring-soft transition-all hover:-translate-y-0.5 hover:ring-card"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-soft">
          {title}
        </h3>
        <span className="text-brand-600 transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </div>
      <p className="mt-3 text-3xl font-bold tracking-tight text-ink">
        <span className="text-gradient">{stat}</span>{" "}
        <span className="text-base font-medium text-muted">{label}</span>
      </p>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </Link>
  );
}
