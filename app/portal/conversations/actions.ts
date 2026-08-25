"use server";

import { revalidatePath } from "next/cache";
import { assertCapability, getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncClient, windowStart } from "@/lib/ghl/sync";
import { listConversations } from "@/lib/ghl/service";
import {
  generateRepCoaching,
  generateTeamCoaching,
  type CoachingInput,
} from "@/lib/ghl/coaching";

// Server actions for the Conversations section.
//
// Every one of these gates on the 'marketing' capability for the target client
// BEFORE touching anything: the reads below go through the service role, which
// bypasses RLS by design, so this is the real enforcement point (same rule as
// every page in the section).

export type ActionState = { ok?: boolean; message?: string; error?: string };

/** Pull GHL into our tables. Defaults to the last 90 days. */
export async function syncAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const clientId = String(formData.get("clientId") ?? "");
  if (!clientId) return { error: "No client selected." };

  try {
    await assertCapability(clientId, "marketing");
  } catch {
    return { error: "You don't have access to this." };
  }

  const sinceRaw = String(formData.get("since") ?? "");
  const since = sinceRaw ? new Date(sinceRaw) : windowStart();
  if (Number.isNaN(since.getTime())) return { error: "That start date isn't valid." };

  try {
    const result = await syncClient(clientId, { since });
    revalidatePath("/portal/conversations");
    const skipped = result.skipped > 0 ? ` ${result.skipped} messages skipped.` : "";
    return {
      ok: true,
      message: `Synced ${result.conversations.toLocaleString()} conversations and ${result.messages.toLocaleString()} messages.${skipped}`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "The GoHighLevel sync failed." };
  }
}

/** Shared setup for both coaching actions. */
async function coachingInput(
  clientId: string
): Promise<{ input: CoachingInput } | { error: string }> {
  try {
    await assertCapability(clientId, "marketing");
  } catch {
    return { error: "You don't have access to this." };
  }

  const session = await getSession();
  const admin = createAdminClient();
  const { data: client } = await admin
    .from("clients")
    .select("name")
    .eq("id", clientId)
    .maybeSingle();

  const from = windowStart();
  const to = new Date();
  const rows = await listConversations(clientId, from.toISOString(), to.toISOString());

  return {
    input: {
      clientId,
      clientName: (client?.name as string | undefined) ?? "This client",
      rows,
      periodStart: from.toISOString().slice(0, 10),
      periodEnd: to.toISOString().slice(0, 10),
      generatedBy: session?.user.id ?? null,
    },
  };
}

export async function generateTeamCoachingAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const clientId = String(formData.get("clientId") ?? "");
  if (!clientId) return { error: "No client selected." };

  const setup = await coachingInput(clientId);
  if ("error" in setup) return { error: setup.error };

  const result = await generateTeamCoaching(setup.input);
  if (!result.ok) return { error: result.message };

  revalidatePath("/portal/conversations/coaching");
  return { ok: true, message: "Team review generated." };
}

export async function generateRepCoachingAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const clientId = String(formData.get("clientId") ?? "");
  const rep = String(formData.get("rep") ?? "");
  if (!clientId) return { error: "No client selected." };
  if (!rep) return { error: "No salesperson selected." };

  const setup = await coachingInput(clientId);
  if ("error" in setup) return { error: setup.error };

  const result = await generateRepCoaching(setup.input, rep);
  if (!result.ok) return { error: result.message };

  revalidatePath("/portal/conversations/coaching");
  return { ok: true, message: `Notes generated for ${rep}.` };
}
