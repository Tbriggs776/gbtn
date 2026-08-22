import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, EmptyState } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { NewCompanyButton } from "@/components/portal/crm/company-client";
import { listCompanies } from "@/lib/crm/service";

export default async function CompaniesPage() {
  const db = await createClient();
  const companies = await listCompanies(db);

  return (
    <PortalShell wide>
      <PortalHeader
        title="Companies"
        subtitle={`${companies.length} organization${companies.length === 1 ? "" : "s"}.`}
        actions={<NewCompanyButton />}
      />
      <CrmNav />

      {companies.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No companies yet" body="Add a company or they'll be created automatically when you import contacts." />
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {companies.map((c) => (
            <Link
              key={c.id}
              href={`/portal/crm/companies/${c.id}`}
              className="rounded-2xl border border-line bg-white p-5 ring-soft transition-colors hover:border-brand-700"
            >
              <p className="text-base font-bold text-ink">{c.name}</p>
              <p className="mt-1 text-sm text-muted">{c.industry || c.domain || "—"}</p>
              {c.phone ? <p className="mt-2 text-xs text-muted-soft">{c.phone}</p> : null}
            </Link>
          ))}
        </div>
      )}
    </PortalShell>
  );
}
