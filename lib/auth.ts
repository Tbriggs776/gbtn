import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "./supabase/server";
import type { Client, Profile } from "./types";

export type SessionContext = {
  user: User;
  profile: Profile | null;
  isAdmin: boolean;
};

// Returns the signed-in user + their profile, or null if signed out.
export async function getSession(): Promise<SessionContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle<Profile>();

  return { user, profile, isAdmin: profile?.role === "admin" };
}

// Require a signed-in user (redirects to /login otherwise).
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

// Require an admin (Tyler). Non-admins are bounced to their portal home.
export async function requireAdmin(): Promise<SessionContext> {
  const session = await requireSession();
  if (!session.isAdmin) redirect("/portal");
  return session;
}

// All clients the current user may access: admins see every client; client
// users see only the clients they belong to (via memberships). RLS enforces
// this on the server regardless.
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
