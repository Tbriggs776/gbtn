import { redirect } from "next/navigation";
import { requireSession, getAccessibleClients } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CreateClientForm, InviteUserForm } from "@/components/portal/admin-forms";
import { AdminUsers, type AdminUser } from "@/components/portal/admin-users";
import { AdminAnalytics, type ActivityEvent } from "@/components/portal/admin-analytics";
import { normalizeRole, type ClientRole } from "@/lib/permissions";

export default async function AdminPage() {
  const session = await requireSession();
  const allClients = await getAccessibleClients();

  // Two audiences share this page:
  //   • platform admin (Tyler) — every client, plus the platform-only sections
  //   • client admin        — ONLY the companies where their role is 'admin'
  const isPlatformAdmin = session.isAdmin;
  const clients = isPlatformAdmin
    ? allClients
    : allClients.filter((c) => session.roles[c.id] === "admin");
  if (clients.length === 0) redirect("/portal");
  const scopeIds = new Set(clients.map((c) => c.id));

  // Memberships → per-client counts + per-user list, narrowed to this admin's
  // companies so a client admin never learns about users outside them.
  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("memberships")
    .select("user_id, client_id, role");
  const counts = new Map<string, number>();
  const clientsByUser = new Map<string, string[]>();
  const rolesByUser = new Map<string, Record<string, ClientRole>>();
  for (const m of memberships ?? []) {
    if (!scopeIds.has(m.client_id)) continue;
    counts.set(m.client_id, (counts.get(m.client_id) ?? 0) + 1);
    const arr = clientsByUser.get(m.user_id) ?? [];
    arr.push(m.client_id);
    clientsByUser.set(m.user_id, arr);
    const r = rolesByUser.get(m.user_id) ?? {};
    r[m.client_id] = normalizeRole(m.role);
    rolesByUser.set(m.user_id, r);
  }

  // All auth users (service role) + their profiles, for the user manager.
  const admin = createAdminClient();
  const [{ data: userList }, { data: profiles }] = await Promise.all([
    admin.auth.admin.listUsers({ perPage: 200 }),
    supabase.from("profiles").select("id, full_name, role"),
  ]);
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const users: AdminUser[] = (userList?.users ?? [])
    .map((u) => ({
      id: u.id,
      email: u.email ?? "",
      name:
        profileById.get(u.id)?.full_name ??
        (u.user_metadata?.full_name as string | undefined) ??
        "",
      role: profileById.get(u.id)?.role ?? "client",
      lastSignIn: u.last_sign_in_at ?? null,
      clientIds: clientsByUser.get(u.id) ?? [],
      clientRoles: rolesByUser.get(u.id) ?? {},
    }))
    // listUsers() is a service-role call and returns EVERY auth user, so a
    // client admin must be narrowed to people in their own companies.
    .filter((u) => isPlatformAdmin || u.clientIds.length > 0)
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  // Usage analytics: page-view events for the last 31 days (admin reads all).
  const since = new Date();
  since.setDate(since.getDate() - 31);
  const { data: activity } = await supabase
    .from("activity_events")
    .select("user_id, path, client_id, created_at")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(10000);
  const names: Record<string, string> = {};
  for (const u of users) names[u.id] = u.name || u.email;
  const clientNames: Record<string, string> = {};
  for (const c of clients) clientNames[c.id] = c.name;
  const events: ActivityEvent[] = (activity ?? []).map((a) => ({
    userId: a.user_id as string,
    path: a.path as string,
    clientId: (a.client_id as string | null) ?? null,
    at: a.created_at as string,
  }));
  // Most-recent event per user (events are ordered newest-first).
  const lastActive: Record<string, string> = {};
  for (const e of events) if (!lastActive[e.userId]) lastActive[e.userId] = e.at;

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
        subtitle={
          isPlatformAdmin
            ? "Provision clients and invite their team to the portal."
            : `Manage users for ${clients.map((c) => c.name).join(", ")}.`
        }
      />

      <div className={`mt-8 grid gap-6 ${isPlatformAdmin ? "lg:grid-cols-2" : ""}`}>
        {/* Creating a workspace is a platform operation, not a client one. */}
        {isPlatformAdmin ? (
          <section className="rounded-2xl border border-line bg-white p-6 ring-soft">
            <h2 className="text-base font-bold text-ink">Create a client</h2>
            <p className="mt-1 mb-5 text-sm text-muted">
              Each client is an isolated workspace with its own documents and
              financials.
            </p>
            <CreateClientForm />
          </section>
        ) : null}

        <section className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h2 className="text-base font-bold text-ink">Create a user</h2>
          <p className="mt-1 mb-5 text-sm text-muted">
            Set a starter password and link them to a client. They change it
            after first sign-in.
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
            Users{" "}
            <span className="text-sm font-normal text-muted-soft">
              ({users.length})
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-soft">
            Manage client access (a user can belong to several clients), see last
            login, and send password resets.
          </p>
        </div>
        <AdminUsers
          users={users}
          clients={clients}
          currentUserId={session.user.id}
          lastActive={lastActive}
        />
      </section>

      {/* Analytics and inbound inquiries are GBTN-wide, not per-client. */}
      {isPlatformAdmin ? (
      <>
      <section className="mt-6 rounded-2xl border border-line bg-white ring-soft">
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-base font-bold text-ink">Usage analytics</h2>
          <p className="mt-0.5 text-xs text-muted-soft">
            Who&apos;s using the portal and what they use most. Pick a range.
          </p>
        </div>
        <AdminAnalytics events={events} names={names} clientNames={clientNames} />
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
      </>
      ) : null}
    </PortalShell>
  );
}
