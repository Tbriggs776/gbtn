/** Stage-move follow-up helpers. crm_tasks has no meta column; we tag via title prefix + notes. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { STAGE_NEXT_STEP_NOTE, STAGE_NEXT_STEP_PREFIX } from "./types";

export function addWeekdays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

export function isStageNextStepTask(t: { title?: string | null; notes?: string | null }): boolean {
  const title = t.title ?? "";
  return title.startsWith(STAGE_NEXT_STEP_PREFIX) || t.notes === STAGE_NEXT_STEP_NOTE;
}

export async function completeOpenStageNextSteps(db: SupabaseClient, dealId: string): Promise<void> {
  const { data } = await db
    .from("crm_tasks")
    .select("id, title, notes")
    .eq("deal_id", dealId)
    .eq("status", "open");
  const ids = ((data as { id: string; title: string | null; notes: string | null }[]) ?? [])
    .filter(isStageNextStepTask)
    .map((t) => t.id);
  if (!ids.length) return;
  const { error } = await db
    .from("crm_tasks")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

export async function createStageNextStepTask(
  db: SupabaseClient,
  input: {
    dealId: string;
    title: string;
    contactId: string | null;
    companyId: string | null;
    assignee: string;
    createdBy: string;
  }
): Promise<void> {
  const due = addWeekdays(new Date(), 2);
  const { error } = await db.from("crm_tasks").insert({
    title: input.title,
    contact_id: input.contactId,
    company_id: input.companyId,
    deal_id: input.dealId,
    due_at: due.toISOString(),
    assignee: input.assignee,
    created_by: input.createdBy,
    notes: STAGE_NEXT_STEP_NOTE,
    priority: "normal",
  });
  if (error) throw error;
}
