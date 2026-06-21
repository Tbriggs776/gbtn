import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Thin wrappers over the service-role-only Vault functions (migration 0006).
// These MUST only ever run server-side — the underlying SQL functions are
// revoked from anon/authenticated, so secrets can never reach the browser.

export type SecretKind = "api_key" | "access_token" | "refresh_token";

export async function storeConnectionSecret(
  connectionId: string,
  kind: SecretKind,
  secret: string
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("store_connection_secret", {
    p_connection_id: connectionId,
    p_kind: kind,
    p_secret: secret,
  });
  if (error) throw new Error(error.message);
}

export async function readConnectionSecret(
  connectionId: string,
  kind: SecretKind
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("read_connection_secret", {
    p_connection_id: connectionId,
    p_kind: kind,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}
