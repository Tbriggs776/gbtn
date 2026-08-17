"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { storePlatformSecret } from "@/lib/integrations/platform-secrets";
import { testAnthropicKey } from "@/lib/ai/anthropic";

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
