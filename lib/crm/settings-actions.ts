"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth";
import { readPlatformJson, storePlatformJson } from "@/lib/integrations/platform-secrets";
import type { TwilioConfig } from "./twilio";
import type { ActionResult } from "./types";

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : "Could not save." };
}

// Merge-save: blank fields keep their prior value, so you can update just the
// From number without re-entering the auth token.
export async function saveTwilioConfig(input: Partial<TwilioConfig>): Promise<ActionResult> {
  try {
    await assertAdmin();
    const prev = (await readPlatformJson<TwilioConfig>("twilio")) ?? ({} as TwilioConfig);
    const merged: Record<string, string> = { ...prev };
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === "string" && v.trim()) merged[k] = v.trim();
    }
    if (!merged.accountSid || !merged.authToken) {
      return { ok: false, error: "Account SID and Auth Token are required." };
    }
    await storePlatformJson("twilio", merged);
    revalidatePath("/portal/crm/settings");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveCallRailConfig(input: { apiKey?: string; accountId?: string }): Promise<ActionResult> {
  try {
    await assertAdmin();
    const prev = (await readPlatformJson<{ apiKey: string; accountId: string }>("callrail")) ?? {
      apiKey: "",
      accountId: "",
    };
    const merged: Record<string, string> = { ...prev };
    if (input.apiKey?.trim()) merged.apiKey = input.apiKey.trim();
    if (input.accountId?.trim()) merged.accountId = input.accountId.trim();
    if (!merged.apiKey) return { ok: false, error: "CallRail API key is required." };
    await storePlatformJson("callrail", merged);
    revalidatePath("/portal/crm/settings");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
