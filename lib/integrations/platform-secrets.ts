import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Thin wrappers over the service-role-only Vault helpers (migration 0017).
// The underlying SQL functions are revoked from anon/authenticated, so a
// platform secret (e.g. the Anthropic key) can never reach the browser — these
// only run server-side, behind an admin check.

export type PlatformProvider = "anthropic";

export async function storePlatformSecret(
  provider: PlatformProvider,
  secret: string
): Promise<void> {
  const admin = createAdminClient();
  const hint = secret.length >= 4 ? secret.slice(-4) : "****";
  const { error } = await admin.rpc("store_platform_secret", {
    p_provider: provider,
    p_secret: secret,
    p_hint: hint,
  });
  if (error) throw new Error(error.message);
}

export async function readPlatformSecret(provider: PlatformProvider): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("read_platform_secret", { p_provider: provider });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

/** Metadata for the admin UI — configured state and the last-4 hint, never the secret. */
export async function platformIntegrationInfo(
  provider: PlatformProvider
): Promise<{ configured: boolean; hint: string | null; updatedAt: string | null }> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("platform_integrations")
    .select("hint, updated_at")
    .eq("provider", provider)
    .maybeSingle();
  return {
    configured: Boolean(data),
    hint: data?.hint ?? null,
    updatedAt: data?.updated_at ?? null,
  };
}
