"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession, getAccessibleClients } from "@/lib/auth";
import { verifyCallRail } from "@/lib/marketing/callrail";
import {
  upsertCallRailConnection,
  disconnectConnection,
} from "@/lib/marketing/service";
import { syncClientConnections } from "@/lib/marketing/sync";

export type SettingsState = { ok?: boolean; error?: string; message?: string };

// Authorization: the caller must be signed in AND a member of the client they
// are acting on (admins are members of every client via getAccessibleClients).
async function assertMember(clientId: string): Promise<void> {
  await requireSession();
  const clients = await getAccessibleClients();
  if (!clients.some((c) => c.id === clientId)) {
    throw new Error("You don't have access to this client.");
  }
}

const callrailSchema = z.object({
  clientId: z.string().uuid(),
  apiKey: z.string().min(10, "Enter your CallRail API key."),
});

export async function connectCallRailAction(
  _prev: SettingsState,
  formData: FormData
): Promise<SettingsState> {
  const parsed = callrailSchema.safeParse({
    clientId: String(formData.get("clientId") ?? ""),
    apiKey: String(formData.get("apiKey") ?? "").trim(),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  try {
    await assertMember(parsed.data.clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }

  // Validate the key with CallRail before we store anything.
  const check = await verifyCallRail(parsed.data.apiKey);
  if (!check.ok || !check.account) return { error: check.error ?? "Could not verify the key." };

  try {
    await upsertCallRailConnection({
      clientId: parsed.data.clientId,
      accountId: check.account.id,
      displayName: check.account.name,
      apiKey: parsed.data.apiKey,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save the connection." };
  }

  revalidatePath("/portal/settings");
  return { ok: true, message: `Connected CallRail · ${check.account.name}.` };
}

export async function disconnectConnectionAction(
  _prev: SettingsState,
  formData: FormData
): Promise<SettingsState> {
  const clientId = String(formData.get("clientId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  if (!clientId || !connectionId) return { error: "Missing connection." };

  try {
    await assertMember(clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }

  await disconnectConnection(connectionId, clientId);
  revalidatePath("/portal/settings");
  return { ok: true, message: "Disconnected." };
}

export async function syncNowAction(
  _prev: SettingsState,
  formData: FormData
): Promise<SettingsState> {
  const clientId = String(formData.get("clientId") ?? "");
  try {
    await assertMember(clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }

  try {
    const r = await syncClientConnections(clientId);
    revalidatePath("/portal/settings");
    revalidatePath("/portal/marketing");
    return {
      ok: true,
      message: r.errors
        ? `Synced with ${r.errors} error(s); updated ${r.rows} day-row(s).`
        : `Synced — updated ${r.rows} day-row(s).`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sync failed." };
  }
}
