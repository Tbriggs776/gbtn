"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { storePlatformSecret } from "@/lib/integrations/platform-secrets";
import { testAnthropicKey } from "@/lib/ai/anthropic";
import { ping } from "@/lib/ghl/client";
import { disconnect, readToken, getConnection, storeToken } from "@/lib/ghl/service";

export type IntegrationState = { ok?: boolean; error?: string; message?: string };

// Platform-admin only: store GBTN's Anthropic key in Vault. One key serves the
// AI briefing for every client, so this lives in the admin area, not per-client.
export async function setAnthropicKeyAction(
  _prev: IntegrationState,
  formData: FormData
): Promise<IntegrationState> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Admins only." };
  }

  const key = String(formData.get("key") ?? "").trim();
  if (!key) return { error: "Paste an Anthropic API key." };
  // Anthropic keys start with sk-ant-. Guard against pasting the wrong thing.
  if (!key.startsWith("sk-ant-")) {
    return { error: "That doesn't look like an Anthropic key (they start with sk-ant-)." };
  }

  try {
    await storePlatformSecret("anthropic", key);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not store the key." };
  }

  revalidatePath("/portal/admin");
  revalidatePath("/portal/briefing");
  return { ok: true, message: "Anthropic key saved. Test it to confirm it works." };
}

export async function testAnthropicKeyAction(): Promise<IntegrationState> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Admins only." };
  }
  const res = await testAnthropicKey();
  if (res.ok) return { ok: true, message: `Working — responded on ${res.model}.` };
  if (res.reason === "no_key") return { error: "No key stored yet." };
  return { error: res.message };
}

// ── GoHighLevel ──────────────────────────────────────────────────────────────
//
// Unlike Anthropic, this one is PER CLIENT: each client authorises its own GHL
// sub-account, and one client's token must never read another's conversations.
// Admin-only because it takes a credential — the client-facing Settings tab
// deliberately has no path to this.

export async function connectGhlAction(
  _prev: IntegrationState,
  formData: FormData
): Promise<IntegrationState> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Admins only." };
  }

  const clientId = String(formData.get("clientId") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();

  if (!clientId) return { error: "Pick a client." };
  if (!locationId) return { error: "Paste the GoHighLevel Location ID." };
  if (!token) return { error: "Paste a Private Integration token." };
  // GHL private integration tokens are prefixed pit-. The old v1 API keys are
  // JWTs and will 401 on every v2 endpoint, so catching that here saves a
  // confusing round trip.
  if (token.startsWith("eyJ")) {
    return {
      error:
        "That looks like a v1 API key (a JWT). This needs a v2 Private Integration token — Settings → Private Integrations in the sub-account.",
    };
  }

  // Verify BEFORE storing: a token that can't read is worse than no token,
  // because the portal would then show "connected" and sync nothing.
  try {
    await ping({ token, locationId });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "GoHighLevel rejected that token." };
  }

  try {
    await storeToken(clientId, locationId, token);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not store the token." };
  }

  revalidatePath("/portal/admin");
  revalidatePath("/portal/conversations");
  return { ok: true, message: "GoHighLevel connected. Run a sync from the Conversations tab." };
}

export async function testGhlAction(
  _prev: IntegrationState,
  formData: FormData
): Promise<IntegrationState> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Admins only." };
  }

  const clientId = String(formData.get("clientId") ?? "").trim();
  if (!clientId) return { error: "Pick a client." };

  const connection = await getConnection(clientId);
  if (!connection) return { error: "No GoHighLevel connection for that client yet." };

  const token = await readToken(clientId);
  if (!token) return { error: "No token stored for that client." };

  try {
    const { users } = await ping({ token, locationId: connection.locationId });
    return { ok: true, message: `Working — ${users} users visible in that location.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "GoHighLevel rejected the stored token." };
  }
}

export async function disconnectGhlAction(
  _prev: IntegrationState,
  formData: FormData
): Promise<IntegrationState> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Admins only." };
  }

  const clientId = String(formData.get("clientId") ?? "").trim();
  if (!clientId) return { error: "Pick a client." };

  try {
    await disconnect(clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not disconnect." };
  }

  revalidatePath("/portal/admin");
  revalidatePath("/portal/conversations");
  // Synced conversations are left in place on purpose: disconnecting stops the
  // sync, it doesn't retract history the client has already been reading.
  return { ok: true, message: "Disconnected. Already-synced conversations are kept." };
}
