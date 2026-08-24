import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendContactEmail, sendContactSms, renderTemplate } from "./comms";
import type {
  CrmCampaign,
  CrmCampaignStep,
  CrmContact,
  EnrollmentContext,
  WaitEvent,
} from "./types";

// Campaign engine: enrollment + step processing. Pure server module (takes a
// Supabase client) so both server actions (RLS client) and cron (service role)
// can drive it.

type DB = SupabaseClient;

/** Contacts processed per cron/send tick so a blast cannot hold one request. */
export const BLAST_BATCH_SIZE = 75;

type DueEnrollment = {
  id: string;
  campaign_id: string;
  contact_id: string;
  current_step: number;
  next_run_at: string | null;
  enrolled_at: string;
  context: EnrollmentContext;
};

function mergeVars(c: Pick<CrmContact, "first_name" | "last_name" | "email" | "company_id">) {
  return {
    first_name: c.first_name ?? "there",
    last_name: c.last_name ?? "",
    email: c.email ?? "",
  };
}

function audienceFilter(audience: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof audience.stage === "string") out.stage = audience.stage;
  if (typeof audience.tag === "string") out.tag = audience.tag;
  if (typeof audience.source === "string") out.source = audience.source;
  return out;
}

export function blastOffset(audience: Record<string, unknown>): number {
  const n = Number(audience._blast_offset);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Load saved-segment filter when audience.segment_id is set; else ad-hoc keys. */
export async function resolveAudienceFilter(
  db: DB,
  audience: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (typeof audience.segment_id === "string" && audience.segment_id) {
    const { data } = await db
      .from("crm_segments")
      .select("filter")
      .eq("id", audience.segment_id)
      .maybeSingle();
    const filter = (data?.filter as Record<string, unknown> | undefined) ?? {};
    return audienceFilter(filter);
  }
  return audienceFilter(audience);
}

/** Resolve an audience filter to contact rows eligible for a channel. */
export async function resolveAudience(
  db: DB,
  audience: Record<string, unknown>,
  channel: "email" | "sms",
  opts: { offset?: number; limit?: number } = {}
): Promise<CrmContact[]> {
  const filter = await resolveAudienceFilter(db, audience);
  const limit = opts.limit ?? 5000;
  const offset = opts.offset ?? 0;
  let q = db.from("crm_contacts").select("*").order("id", { ascending: true });
  if (typeof filter.stage === "string") q = q.eq("lifecycle_stage", filter.stage);
  if (typeof filter.tag === "string") q = q.contains("tags", [filter.tag]);
  if (typeof filter.source === "string") q = q.eq("source", filter.source);
  if (channel === "email") q = q.eq("do_not_email", false).not("email", "is", null);
  else q = q.eq("do_not_sms", false).not("phone", "is", null);
  const { data } = await q.range(offset, offset + limit - 1);
  return (data as CrmContact[]) ?? [];
}

/** Enroll specific contacts into a campaign. next_run_at = now (first step is due). */
export async function enrollContacts(
  db: DB,
  campaignId: string,
  contactIds: string[]
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const now = new Date().toISOString();
  const { data: contacts } = await db
    .from("crm_contacts")
    .select("id, lifecycle_stage")
    .in("id", contactIds);
  const stageById = new Map(
    ((contacts as { id: string; lifecycle_stage: string }[]) ?? []).map((c) => [c.id, c.lifecycle_stage])
  );
  const rows = contactIds.map((id) => ({
    campaign_id: campaignId,
    contact_id: id,
    status: "active" as const,
    current_step: 0,
    next_run_at: now,
    context: { enrolled_stage: stageById.get(id) ?? null } satisfies EnrollmentContext,
  }));
  const { data, error } = await db
    .from("crm_enrollments")
    .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

async function persistBlastProgress(
  db: DB,
  campaign: CrmCampaign,
  nextOffset: number,
  done: boolean
): Promise<void> {
  await db
    .from("crm_campaigns")
    .update({
      status: done ? "done" : "sending",
      audience: { ...campaign.audience, _blast_offset: nextOffset },
    })
    .eq("id", campaign.id);
}

/** Send one blast chunk (BLAST_BATCH_SIZE). Leaves status `sending` until the audience is exhausted. */
export async function sendBlast(
  db: DB,
  campaign: CrmCampaign
): Promise<{ sent: number; failed: number; done: boolean; offset: number }> {
  const offset = blastOffset(campaign.audience);
  const contacts = await resolveAudience(db, campaign.audience, campaign.channel, {
    offset,
    limit: BLAST_BATCH_SIZE,
  });
  let sent = 0;
  let failed = 0;
  for (const c of contacts) {
    const vars = mergeVars(c);
    const body = renderTemplate(campaign.body ?? "", vars);
    const ctx = { contactId: c.id, campaignId: campaign.id };
    let ok = false;
    if (campaign.channel === "email" && c.email) {
      const subject = renderTemplate(campaign.subject ?? "", vars);
      ok = (await sendContactEmail(db, ctx, { to: c.email, subject, html: body.replace(/\n/g, "<br>") })).ok;
    } else if (campaign.channel === "sms" && c.phone) {
      ok = (await sendContactSms(db, ctx, { to: c.phone, body })).ok;
    }
    if (ok) sent++;
    else failed++;
  }
  const nextOffset = offset + contacts.length;
  const done = contacts.length < BLAST_BATCH_SIZE;
  await persistBlastProgress(db, campaign, nextOffset, done);
  return { sent, failed, done, offset: nextOffset };
}

function findStep(steps: CrmCampaignStep[], position: number): CrmCampaignStep | undefined {
  return steps.find((s) => s.position === position) ?? steps[position];
}

async function completeEnrollment(db: DB, enrollmentId: string, currentStep?: number): Promise<void> {
  await db
    .from("crm_enrollments")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      next_run_at: null,
      ...(currentStep != null ? { current_step: currentStep } : {}),
    })
    .eq("id", enrollmentId);
}

/** Move to a step position; missing step completes the journey. */
async function advanceTo(
  db: DB,
  enrollmentId: string,
  steps: CrmCampaignStep[],
  position: number
): Promise<void> {
  const next = findStep(steps, position);
  if (!next) {
    await completeEnrollment(db, enrollmentId, position);
    return;
  }
  const nextRun = new Date(Date.now() + (next.delay_minutes || 0) * 60_000).toISOString();
  await db
    .from("crm_enrollments")
    .update({ current_step: position, next_run_at: nextRun })
    .eq("id", enrollmentId);
}

async function waitEventHappened(
  db: DB,
  enrollment: DueEnrollment,
  contact: CrmContact,
  event: WaitEvent | null
): Promise<boolean> {
  if (!event) return false;
  if (event === "stage_changed") {
    const enrolled = enrollment.context?.enrolled_stage;
    return enrolled != null && contact.lifecycle_stage !== enrolled;
  }
  if (event === "replied") {
    let q = db
      .from("crm_messages")
      .select("id")
      .eq("contact_id", enrollment.contact_id)
      .eq("direction", "inbound")
      .limit(1);
    if (enrollment.enrolled_at) q = q.gte("created_at", enrollment.enrolled_at);
    const { data } = await q;
    return (data ?? []).length > 0;
  }
  const statuses = event === "clicked" ? ["clicked"] : ["opened", "clicked"];
  const { data } = await db
    .from("crm_messages")
    .select("id")
    .eq("campaign_id", enrollment.campaign_id)
    .eq("contact_id", enrollment.contact_id)
    .in("status", statuses)
    .limit(1);
  return (data ?? []).length > 0;
}

function waitTimedOut(enrollment: DueEnrollment, step: CrmCampaignStep): boolean {
  if (step.wait_hours == null) return false;
  const until = enrollment.context?.wait_until;
  if (until) return Date.now() > new Date(until).getTime();
  if (!enrollment.next_run_at) return false;
  return Date.now() > new Date(enrollment.next_run_at).getTime() + step.wait_hours * 3_600_000;
}

/**
 * Process one active drip enrollment: send / wait / exit the current step.
 * Returns whether it did anything (false = still waiting on an event).
 */
async function runEnrollmentStep(
  db: DB,
  enrollment: DueEnrollment,
  steps: CrmCampaignStep[]
): Promise<boolean> {
  const step = findStep(steps, enrollment.current_step);
  const { data: contact } = await db
    .from("crm_contacts")
    .select("*")
    .eq("id", enrollment.contact_id)
    .maybeSingle();
  const c = contact as CrmContact | null;
  const kind = step?.kind ?? "send";

  if (!c) {
    await db.from("crm_enrollments").update({ status: "unsubscribed" }).eq("id", enrollment.id);
    return true;
  }
  if (!step) {
    await completeEnrollment(db, enrollment.id);
    return true;
  }

  // Contact opted out of the send channel → stop (same as linear drips).
  if (
    kind === "send" &&
    ((step.channel === "email" && (c.do_not_email || !c.email)) ||
      (step.channel === "sms" && (c.do_not_sms || !c.phone)))
  ) {
    await db.from("crm_enrollments").update({ status: "unsubscribed" }).eq("id", enrollment.id);
    return true;
  }

  if (kind === "exit") {
    await completeEnrollment(db, enrollment.id, step.position);
    return true;
  }

  if (kind === "wait_event") {
    let context = enrollment.context ?? {};
    if (!context.wait_until && step.wait_hours != null && enrollment.next_run_at) {
      const waitUntil = new Date(
        new Date(enrollment.next_run_at).getTime() + step.wait_hours * 3_600_000
      ).toISOString();
      context = { ...context, wait_until: waitUntil };
      await db.from("crm_enrollments").update({ context }).eq("id", enrollment.id);
      enrollment.context = context;
    }
    if (await waitEventHappened(db, enrollment, c, step.wait_event)) {
      const dest = step.next_yes ?? step.position + 1;
      await advanceTo(db, enrollment.id, steps, dest);
      return true;
    }
    if (waitTimedOut(enrollment, step)) {
      const dest = step.next_no ?? step.position + 1;
      await advanceTo(db, enrollment.id, steps, dest);
      return true;
    }
    return false;
  }

  const vars = mergeVars(c);
  const body = renderTemplate(step.body, vars);
  const ctx = { contactId: c.id, campaignId: enrollment.campaign_id };
  if (step.channel === "email" && c.email) {
    await sendContactEmail(db, ctx, {
      to: c.email,
      subject: renderTemplate(step.subject ?? "", vars),
      html: body.replace(/\n/g, "<br>"),
    });
  } else if (step.channel === "sms" && c.phone) {
    await sendContactSms(db, ctx, { to: c.phone, body });
  }

  const nextPos = step.next_yes != null ? step.next_yes : step.position + 1;
  await advanceTo(db, enrollment.id, steps, nextPos);
  return true;
}

/** Cron entrypoint: process all due drip enrollments (bounded per run). */
export async function processDrips(db: DB, limit = 200): Promise<{ processed: number }> {
  const now = new Date().toISOString();
  const { data: due } = await db
    .from("crm_enrollments")
    .select("id, campaign_id, contact_id, current_step, next_run_at, enrolled_at, context")
    .eq("status", "active")
    .not("next_run_at", "is", null)
    .lte("next_run_at", now)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  const enrollments = (due as DueEnrollment[]) ?? [];
  const stepCache = new Map<string, CrmCampaignStep[]>();
  let processed = 0;
  for (const e of enrollments) {
    let steps = stepCache.get(e.campaign_id);
    if (!steps) {
      const { data } = await db
        .from("crm_campaign_steps")
        .select("*")
        .eq("campaign_id", e.campaign_id)
        .order("position");
      steps = (data as CrmCampaignStep[]) ?? [];
      stepCache.set(e.campaign_id, steps);
    }
    if (await runEnrollmentStep(db, { ...e, context: e.context ?? {} }, steps)) processed++;
  }
  return { processed };
}

/** Cron entrypoint: start due scheduled blasts and continue in-progress batches. */
export async function processScheduledBlasts(db: DB): Promise<{ fired: number; chunks: number }> {
  const now = new Date().toISOString();
  const { data: due } = await db
    .from("crm_campaigns")
    .select("*")
    .eq("type", "blast")
    .eq("status", "scheduled")
    .lte("scheduled_at", now)
    .limit(20);

  let fired = 0;
  for (const c of (due as CrmCampaign[]) ?? []) {
    const audience = { ...c.audience, _blast_offset: 0 };
    await db.from("crm_campaigns").update({ status: "sending", audience }).eq("id", c.id);
    await sendBlast(db, { ...c, audience, status: "sending" });
    fired++;
  }

  const { data: sending } = await db
    .from("crm_campaigns")
    .select("*")
    .eq("type", "blast")
    .eq("status", "sending")
    .limit(20);

  let chunks = 0;
  for (const c of (sending as CrmCampaign[]) ?? []) {
    await sendBlast(db, c);
    chunks++;
  }
  return { fired, chunks };
}
