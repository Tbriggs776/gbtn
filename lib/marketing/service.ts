import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { storeConnectionSecret } from "./secrets";

// Service-role helpers for managing a client's marketing connections. Always
// called from server actions that have already verified the caller's
// membership of the client.

export type Provider = "ga4" | "meta_ads" | "google_ads" | "gbp" | "callrail";
export type ConnectionStatus =
  | "pending"
  | "connected"
  | "needs_reauth"
  | "disconnected";

export type ConnectionRow = {
  id: string;
  client_id: string;
  provider: Provider;
  status: ConnectionStatus;
  external_account_id: string;
  display_name: string | null;
  last_synced_at: string | null;
};

export async function listConnections(clientId: string): Promise<ConnectionRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("marketing_connections")
    .select(
      "id, client_id, provider, status, external_account_id, display_name, last_synced_at"
    )
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  return (data ?? []) as ConnectionRow[];
}

export async function upsertCallRailConnection(opts: {
  clientId: string;
  accountId: string;
  displayName: string;
  apiKey: string;
}): Promise<string> {
  const admin = createAdminClient();
  const { data: conn, error } = await admin
    .from("marketing_connections")
    .upsert(
      {
        client_id: opts.clientId,
        provider: "callrail",
        external_account_id: opts.accountId,
        display_name: opts.displayName,
        status: "connected",
      },
      { onConflict: "client_id,provider,external_account_id" }
    )
    .select("id")
    .single();
  if (error || !conn) throw new Error(error?.message ?? "Could not save the connection.");

  await storeConnectionSecret(conn.id, "api_key", opts.apiKey);
  return conn.id;
}

export async function disconnectConnection(
  connectionId: string,
  clientId: string
): Promise<void> {
  const admin = createAdminClient();
  // Deleting the connection cascades the secrets row. (The Vault entry is
  // orphaned but unreadable; a periodic cleanup can sweep these later.)
  await admin
    .from("marketing_connections")
    .delete()
    .eq("id", connectionId)
    .eq("client_id", clientId);
}
