import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PortalShell } from "@/components/portal/ui";
import { getCompany, getCompanyContacts } from "@/lib/crm/service";
import { contactName, contactInitials, LIFECYCLE_LABEL } from "@/lib/crm/types";

export default async function CompanyDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await createClient();
  const company = await getCompany(db, id);
  if (!company) notFound();
  const contacts = await getCompanyContacts(db, id);

  return (
    <PortalShell wide>
      <Link href="/portal/crm/companies" className="text-sm text-muted hover:text-ink">
        ← All companies
      </Link>
      <div className="mt-4 border-b border-line pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{company.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {[company.industry, company.domain, company.phone].filter(Boolean).join(" · ") || "—"}
        </p>
        {company.website ? (
          <a href={company.website} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm text-brand-700 hover:underline">
            {company.website}
          </a>
        ) : null}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="rounded-2xl border border-line bg-white ring-soft">
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-sm font-bold text-ink">
              People <span className="font-normal text-muted-soft">({contacts.length})</span>
            </h2>
          </div>
          {contacts.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">No contacts linked to this company.</p>
          ) : (
            <ul className="divide-y divide-line">
              {contacts.map((c) => (
                <li key={c.id}>
                  <Link href={`/portal/crm/contacts/${c.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-paper-soft">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-brand text-[11px] font-bold text-white">
                      {contactInitials(c)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{contactName(c)}</span>
                      <span className="block text-xs text-muted-soft">{c.title || c.email || ""}</span>
                    </span>
                    <span className="ml-auto rounded-full bg-paper-soft px-2.5 py-0.5 text-xs font-medium text-muted">
                      {LIFECYCLE_LABEL[c.lifecycle_stage] ?? c.lifecycle_stage}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {company.notes ? (
          <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
            <h2 className="text-sm font-bold text-ink">Notes</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{company.notes}</p>
          </div>
        ) : null}
      </div>
    </PortalShell>
  );
}
