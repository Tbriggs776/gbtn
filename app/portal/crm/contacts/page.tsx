import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell, EmptyState } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { ContactsToolbar } from "@/components/portal/crm/contacts-client";
import { listContacts, listCompanies } from "@/lib/crm/service";
import { contactName, contactInitials, LIFECYCLE_LABEL, type LifecycleStage } from "@/lib/crm/types";
import { relativeTime } from "@/lib/format";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const db = await createClient();
  const pageNum = Math.max(1, Number(sp.page ?? "1") || 1);
  const limit = 50;

  const [{ rows, count }, companies] = await Promise.all([
    listContacts(db, {
      search: sp.q,
      stage: (sp.stage as LifecycleStage) || undefined,
      limit,
      offset: (pageNum - 1) * limit,
    }),
    listCompanies(db),
  ]);

  const totalPages = Math.max(1, Math.ceil(count / limit));

  return (
    <PortalShell wide>
      <PortalHeader
        title="Contacts"
        subtitle={`${count} contact${count === 1 ? "" : "s"} in your pipeline.`}
      />
      <CrmNav />
      <ContactsToolbar companies={companies.map((c) => ({ id: c.id, name: c.name }))} />

      {rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No contacts found"
            body={sp.q || sp.stage ? "Try clearing your filters." : "Add your first contact or import a CSV to get started."}
          />
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-line bg-white ring-soft">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted-soft">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Company</th>
                <th className="px-5 py-3 font-medium">Stage</th>
                <th className="px-5 py-3 font-medium">Last contacted</th>
                <th className="px-5 py-3 font-medium">Next follow-up</th>
                <th className="px-5 py-3 font-medium">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => (
                <tr key={c.id} className="group hover:bg-paper-soft">
                  <td className="px-5 py-3">
                    <Link href={`/portal/crm/contacts/${c.id}`} className="flex items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-brand text-[11px] font-bold text-white">
                        {contactInitials(c)}
                      </span>
                      <span>
                        <span className="block font-semibold text-ink group-hover:text-brand-700">
                          {contactName(c)}
                        </span>
                        {c.email ? <span className="block text-xs text-muted-soft">{c.email}</span> : null}
                      </span>
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-muted">{c.company?.name ?? "—"}</td>
                  <td className="px-5 py-3">
                    <span className="rounded-full bg-paper-soft px-2.5 py-0.5 text-xs font-medium text-muted">
                      {LIFECYCLE_LABEL[c.lifecycle_stage] ?? c.lifecycle_stage}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-muted">{c.last_contacted_at ? relativeTime(c.last_contacted_at) : "—"}</td>
                  <td className="px-5 py-3">
                    {c.next_follow_up_at ? (
                      <span className={new Date(c.next_follow_up_at) < new Date() ? "text-brand-700" : "text-muted"}>
                        {relativeTime(c.next_follow_up_at)}
                      </span>
                    ) : (
                      <span className="text-muted-soft">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-semibold text-ink">{c.lead_score || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          {pageNum > 1 ? (
            <Link
              href={`/portal/crm/contacts?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.stage ? { stage: sp.stage } : {}), page: String(pageNum - 1) }).toString()}`}
              className="rounded-lg border border-line px-3 py-1.5 text-muted hover:bg-paper-soft"
            >
              ← Prev
            </Link>
          ) : null}
          <span className="text-muted-soft">
            Page {pageNum} of {totalPages}
          </span>
          {pageNum < totalPages ? (
            <Link
              href={`/portal/crm/contacts?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.stage ? { stage: sp.stage } : {}), page: String(pageNum + 1) }).toString()}`}
              className="rounded-lg border border-line px-3 py-1.5 text-muted hover:bg-paper-soft"
            >
              Next →
            </Link>
          ) : null}
        </div>
      ) : null}
    </PortalShell>
  );
}
