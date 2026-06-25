import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_ASSUMPTIONS, type Assumptions } from "./engine";

export async function getAssumptions(clientId: string): Promise<Assumptions> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("pricing_assumptions")
    .select("commission, warranty, gm, finance_fee, tiers")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!data) return DEFAULT_ASSUMPTIONS;
  return {
    commission: Number(data.commission),
    warranty: Number(data.warranty),
    gm: Number(data.gm),
    financeFee: Number(data.finance_fee),
    tiers: (data.tiers ?? DEFAULT_ASSUMPTIONS.tiers).map(Number),
  };
}
