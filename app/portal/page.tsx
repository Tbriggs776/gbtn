import Link from "next/link";
import { getSession, getActiveClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";

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

  // Quick counts for the overview.
  const supabase = await createClient();
  const { count: docCount } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true })
    .eq("client_id", activeClient.id);

  const firstName = session?.profile?.full_name?.split(" ")[0] ?? "there";

  const tiles = [
    {
      href: `/portal/documents?client=${activeClient.id}`,
      title: "Documents",
      stat: `${docCount ?? 0}`,
      label: docCount === 1 ? "file shared" : "files shared",
      body: "Securely exchange statements, contracts, and reports.",
    },
    {
      href: `/portal/financials?client=${activeClient.id}`,
      title: "Financials",
      stat: "Soon",
      label: "dashboards",
      body: "Upload your P&L and Balance Sheet to unlock dashboards.",
    },
  ];

  return (
    <PortalShell>
      <PortalHeader
        title={`Hi ${firstName}`}
        subtitle={`${activeClient.name} · your financial command center`}
      />

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        {tiles.map((t) => (
          <Link
            key={t.title}
            href={t.href}
            className="group rounded-2xl border border-line bg-white p-6 ring-soft transition-all hover:-translate-y-0.5 hover:ring-card"
          >
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-soft">
                {t.title}
              </h3>
              <span className="text-brand-600 transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </div>
            <p className="mt-3 text-3xl font-bold tracking-tight text-ink">
              <span className="text-gradient">{t.stat}</span>{" "}
              <span className="text-base font-medium text-muted">{t.label}</span>
            </p>
            <p className="mt-2 text-sm text-muted">{t.body}</p>
          </Link>
        ))}
      </div>
    </PortalShell>
  );
}
