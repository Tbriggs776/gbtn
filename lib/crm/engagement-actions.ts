"use server";

import { revalidatePath } from "next/cache";
import { assertStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createEngagementForDeal, type OfferRung } from "./engagements";
import type { ActionResult } from "./types";

// Staff-only: convert a CRM deal into a client engagement on the offer ladder.
// Uses the service role (createAdminClient) because provisioning a `clients`
// row has no INSERT RLS policy — writes go through the service role, behind
// this assertStaff() gate (same posture as lib/financials/qbo/provision.ts).

export async function createEngagementAction(input: {
  dealId: string;
  offerRung: OfferRung;
  clientId?: string;
  newClientName?: string;
  dealTitle?: string;
}): Promise<ActionResult<{ engagementId: string }>> {
  try {
    await assertStaff();
    if (!input.dealId) return { ok: false, error: "Missing deal." };
    const db = createAdminClient();
    const { id } = await createEngagementForDeal(db, input);
    revalidatePath("/portal/crm/deals");
    return { ok: true, data: { engagementId: id } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}
