"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { listOrderLines } from "@/lib/ops/service";
import { buildFpaReport, type FpaRawItem } from "@/lib/financials/fpa";
import { buildBridge } from "@/lib/briefing/bridge";
import { BRIEFING_SYSTEM, buildBriefingPrompt } from "@/lib/ai/briefing-prompt";
import { generateBriefing } from "@/lib/ai/anthropic";

export type GenerateState = { ok?: boolean; error?: string; message?: string };

// Platform-admin only: generating hits GBTN's paid Anthropic key, so a client
// viewing the tab never triggers a charge — they read the last stored summary.
export async function generateBriefingAction(
  _prev: GenerateState,
  formData: FormData
): Promise<GenerateState> {
  let session;
  try {
    session = await requireAdmin();
  } catch {
    return { error: "Admins only." };
  }

  const clientId = String(formData.get("clientId") ?? "");
  if (!z.string().uuid().safeParse(clientId).success) return { error: "Bad client." };

  const admin = createAdminClient();
  const [{ data: uploads }, { data: items }, ops] = await Promise.all([
    admin.from("financial_uploads").select("id, period_label, period_end").eq("client_id", clientId).eq("status", "confirmed"),
    admin.from("financial_line_items").select("statement_type, category, raw_label, amount, upload_id").eq("client_id", clientId),
    listOrderLines(clientId),
  ]);

  const meta = new Map((uploads ?? []).map((u) => [u.id, { label: u.period_label, end: u.period_end as string | null }]));
  const fin: FpaRawItem[] = (items ?? []).map((i) => {
    const m = meta.get(i.upload_id);
    return {
      periodLabel: m?.label ?? "Unknown",
      periodEnd: m?.end ?? null,
      statementType: i.statement_type,
      category: i.category,
      rawLabel: i.raw_label,
      amount: Number(i.amount),
    };
  });

  const fpa = buildFpaReport(fin);
  if (fpa.months.length === 0) return { error: "No financials loaded for this client yet." };
  const bridge = buildBridge(ops, fin);

  const result = await generateBriefing(BRIEFING_SYSTEM, buildBriefingPrompt(fpa, bridge));
  if (!result.ok) {
    if (result.reason === "no_key") {
      return { error: "No Anthropic key is configured. Add it under Admin → Integrations." };
    }
    return { error: result.message };
  }

  const { error } = await admin.from("ai_summaries").insert({
    client_id: clientId,
    kind: "cfo_briefing",
    content: result.text,
    model: result.model,
    generated_by: session.user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/portal/briefing");
  return { ok: true, message: "Briefing generated." };
}
