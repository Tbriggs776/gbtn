import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "./supabase/server";
import { createAdminClient } from "./supabase/admin";
import type { Client, Profile } from "./types";
import {
  normalizeRole,
  roleCan,
  type Capability,
  type ClientRole,
} from "./permissions";

export type SessionContext = {
  user: User;
  profile: Profile | null;
  /** GBTN platform admin (profiles.role = 'admin') — every client, every capability. */
  isAdmin: boolean;
  /** clientId -> this user's role in that client. Empty for platform admins. */
  roles: Record<string, ClientRole>;
};

// Returns the signed-in user + their profile and per-client roles, or null.
export async function getSession(): Promise<SessionContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: profile }, { data: memberships }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).maybeSingle<Profile>(),
    supabase.from("memberships").select("client_id, role").eq("user_id", user.id),
  ]);

  const roles: Record<string, ClientRole> = {};
  for (const m of memberships ?? []) {
    roles[m.client_id as string] = normalizeRole(m.role);
  }

  return { user, profile, isAdmin: profile?.role === "admin", roles };
}

// Require a signed-in user (redirects to /login otherwise).
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

// Require a GBTN platform admin. Others are bounced to their portal home.
export async function requireAdmin(): Promise<SessionContext> {
  const session = await requireSession();
  if (!session.isAdmin) redirect("/portal");
  return session;
}

// All clients the current user may access: platform admins see every client;
// client users see only the clients they belong to. RLS enforces this too.
export async function getAccessibleClients(): Promise<Client[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("*")
    .order("name", { ascending: true });
  return data ?? [];
}

// Resolve the "active" client for a portal view. Client users default to their
// first (usually only) client. Admins can target one via ?client=<id>.
export async function getActiveClient(
  preferredClientId?: string
): Promise<Client | null> {
  const clients = await getAccessibleClients();
  if (clients.length === 0) return null;
  if (preferredClientId) {
    const match = clients.find((c) => c.id === preferredClientId);
    if (match) return match;
  }
  return clients[0];
}

// ── Capability gates ─────────────────────────────────────────────────────────

/** This user's role in one client (null for platform admins — they bypass roles). */
export function clientRole(session: SessionContext, clientId: string): ClientRole | null {
  return session.roles[clientId] ?? null;
}

export function sessionCan(
  session: SessionContext,
  clientId: string,
  cap: Capability
): boolean {
  if (session.isAdmin) return true;
  return roleCan(session.roles[clientId], cap);
}

/**
 * Gate a page on a capability for the active client.
 *
 * This is the PRIMARY enforcement point: the dashboards read their data through
 * the service role, which bypasses RLS by design, so a missing guard here is a
 * real hole even though the DB policies exist. Every capability-restricted page
 * must call this before it fetches anything.
 *
 * Redirects rather than throwing — a user who lost access mid-session lands on
 * their portal home instead of an error page.
 */
export async function requireCapability(
  clientId: string,
  cap: Capability
): Promise<SessionContext> {
  const session = await requireSession();
  if (!sessionCan(session, clientId, cap)) redirect("/portal");
  return session;
}

/** Same check without redirecting — for server actions and route handlers. */
export async function assertCapability(clientId: string, cap: Capability): Promise<SessionContext> {
  const session = await requireSession();
  if (!sessionCan(session, clientId, cap)) {
    throw new Error("You don't have access to this.");
  }
  return session;
}

/** Manages users for this client: platform admin, or 'admin' in that client. */
export async function requireClientAdmin(clientId: string): Promise<SessionContext> {
  return requireCapability(clientId, "manage_users");
}

/**
 * The clients whose users this session may administer. "all" means platform
 * admin — every client, including ones that don't exist yet.
 *
 * User-management actions operate on a USER, who may belong to companies this
 * admin has nothing to do with. Every such action must intersect its writes
 * with this set, or a client admin could revoke access at a company they can't
 * even see.
 */
export async function manageableClientIds(): Promise<string[] | "all"> {
  const session = await requireSession();
  if (session.isAdmin) return "all";
  return Object.entries(session.roles)
    .filter(([, role]) => role === "admin")
    .map(([clientId]) => clientId);
}

/** Throws unless the session administers this client. */
export async function assertManages(clientId: string): Promise<void> {
  const scope = await manageableClientIds();
  if (scope === "all") return;
  if (!scope.includes(clientId)) throw new Error("You don't manage that client.");
}

/** Throws unless the target user belongs to at least one client this session administers. */
export async function assertManagesUser(userId: string): Promise<void> {
  const scope = await manageableClientIds();
  if (scope === "all") return;
  if (scope.length === 0) throw new Error("You don't manage any clients.");
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("client_id")
    .eq("user_id", userId)
    .in("client_id", scope);
  if (!data || data.length === 0) throw new Error("That user isn't in your companies.");
}

/**
 * Gate for changing a user's EMAIL or PASSWORD.
 *
 * Sharing one company is enough to *manage* someone, but not to seize their
 * login: email and password belong to the global auth account, so resetting
 * them hands over every company that user belongs to. A client admin at
 * company A could otherwise take over a user who also sits in company B — or,
 * worse, a GBTN staff account that happens to hold a membership — and inherit
 * their access wholesale.
 *
 * Rule: platform admins may do it to anyone. A client admin may do it only to
 * a non-platform-admin whose memberships are entirely inside their own scope,
 * so there is no other access to steal.
 */
export async function assertCanChangeCredentials(userId: string): Promise<void> {
  const session = await requireSession();
  if (session.isAdmin) return;

  const scope = await manageableClientIds();
  if (scope === "all") return;
  if (scope.length === 0) throw new Error("You don't manage any clients.");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.role === "admin") {
    throw new Error("You can't change credentials for a GBTN staff account.");
  }

  // Read every membership with the service role: the caller cannot see rows
  // for companies outside their scope, so an RLS-filtered read would make an
  // outside membership look like none at all.
  const { data: rows } = await admin
    .from("memberships")
    .select("client_id")
    .eq("user_id", userId);
  const memberOf = (rows ?? []).map((r) => r.client_id as string);
  if (memberOf.length === 0) throw new Error("That user isn't in your companies.");
  const outside = memberOf.filter((id) => !scope.includes(id));
  if (outside.length > 0) {
    throw new Error(
      "That user also belongs to companies you don't manage — ask GBTN to reset their sign-in."
    );
  }
}
