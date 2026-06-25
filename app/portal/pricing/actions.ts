"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export type PricingState = { ok?: boolean; error?: string; message?: string };

const rate = z.coerce.number().min(0).max(0.99);
const schema = z.object({
  clientId: z.string().uuid(),
  commission: rate,
  warranty: rate,
  gm: rate,
  financeFee: rate,
  tiers: z.array(rate).min(1).max(8),
});

export async function updateAssumptionsAction(
  _prev: PricingState,
  formData: FormData
): Promise<PricingState> {
  await requireAdmin();

  const tiers = formData
    .getAll("tiers")
    .map(String)
    .filter((s) => s !== "")
    .map(Number);

  const parsed = schema.safeParse({
    clientId: String(formData.get("clientId") ?? ""),
    commission: formData.get("commission"),
    warranty: formData.get("warranty"),
    gm: formData.get("gm"),
    financeFee: formData.get("financeFee"),
    tiers,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const d = parsed.data;
  // Guard the closed-form denominator so prices stay defined/positive.
  const k = (1 - d.gm) * (1 - d.warranty);
  if (k - d.commission <= 0) {
    return { error: "That commission/GM/warranty combination makes price undefined. Raise GM or lower commission." };
  }

  const admin = createAdminClient();
  const { error } = await admin.from("pricing_assumptions").upsert({
    client_id: d.clientId,
    commission: d.commission,
    warranty: d.warranty,
    gm: d.gm,
    finance_fee: d.financeFee,
    tiers: d.tiers,
    updated_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };

  revalidatePath("/portal/pricing");
  return { ok: true, message: "Assumptions saved." };
}
