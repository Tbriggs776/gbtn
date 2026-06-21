import { requireAdmin, getAccessibleClients } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CreateClientForm, InviteUserForm } from "@/components/portal/admin-forms";

export default async function AdminPage() {
  await requireAdmin();
  const clients = await getAccessibleClients();

  // Member counts per client (admin can read all memberships via RLS).
  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("memberships")
    .select("client_id");
  const counts = new Map<string, number>();
  for (const m of memberships ?? []) {
    counts.set(m.client_id, (counts.get(m.client_id) ?? 0) + 1);
  }

  // Recent contact-form inquiries (admin-only via RLS).
  const { data: inquiries } = await supabase
    .from("contact_submissions")
    .select("id, name, email, company, revenue_stage, message, notified, created_at")
    .order("created_at", { ascending: false })
    .limit(15);

  const fmtDate = (s: string) =>
    new Date(s).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  return (
    <PortalShell>
      <PortalHeader
        title="Admin"
        subtitle="Provision clients and invite their team to the portal."
      />

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h2 className="text-base font-bold text-ink">Create a client</h2>
          <p className="mt-1 mb-5 text-sm text-muted">
            Each client is an isolated workspace with its own documents and
            financials.
          </p>
          <CreateClientForm />
        </section>

        <section className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h2 className="text-base font-bold text-ink">Invite a user</h2>
          <p className="mt-1 mb-5 text-sm text-muted">
            Sends a secure magic-link invite and links them to the client.
          </p>
          <InviteUserForm clients={clients} />
        </section>
      </div>

      <section className="mt-6 rounded-2xl border border-line bg-white ring-soft">
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-base font-bold text-ink">
            Clients{" "}
            <span className="text-sm font-normal text-muted-soft">
              ({clients.length})
            </span>
          </h2>
        </div>
        {clients.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            No clients yet. Create your first one above.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {clients.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between px-6 py-4"
              >
                <div>
                  <p className="text-sm font-semibold text-ink">{c.name}</p>
                  <p className="text-xs text-muted-soft">/{c.slug}</p>
                </div>
                <span className="rounded-full bg-paper-soft px-3 py-1 text-xs font-medium text-muted">
                  {counts.get(c.id) ?? 0}{" "}
                  {(counts.get(c.id) ?? 0) === 1 ? "member" : "members"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-line bg-white ring-soft">
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-base font-bold text-ink">
            Contact inquiries{" "}
            <span className="text-sm font-normal text-muted-soft">
              ({inquiries?.length ?? 0})
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-soft">
            Submissions from the website contact form. Most recent first.
          </p>
        </div>
        {!inquiries || inquiries.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            No inquiries yet.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {inquiries.map((q) => (
              <li key={q.id} className="px-6 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-semibold text-ink">{q.name}</p>
                    <a
                      href={`mailto:${q.email}?subject=${encodeURIComponent(
                        "Re: your inquiry to Growth by the Numbers"
                      )}`}
                      className="text-xs font-medium text-brand-700 hover:underline"
                    >
                      {q.email}
                    </a>
                    {!q.notified ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        email not sent
                      </span>
                    ) : null}
                  </div>
                  <span className="text-xs text-muted-soft">
                    {fmtDate(q.created_at)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-soft">
                  {[q.company, q.revenue_stage].filter(Boolean).join(" · ") ||
                    "—"}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                  {q.message}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
