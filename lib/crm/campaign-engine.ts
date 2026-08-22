import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendContactEmail, sendContactSms, renderTemplate } from "./comms";
import type { CrmCampaign, CrmCampaignStep, CrmContact } from "./types";

// Campaign engine: enrollment + step processing. Pure server module (takes a
// Supabase client) so both server actions (RLS client) and cron (service role)
// can drive it.

type DB = SupabaseClient;

function mergeVars(c: Pick<CrmContact, "first_name" | "last_name" | "email" | "company_id">) {
  return {
    first_name: c.first_name ?? "there",
    last_name: c.last_name ?? "",
    email: c.email ?? "",
  };
}

/** Resolve an audience filter to contact rows eligible for a channel. */
export async function resolveAudience(
  db: DB,
  audience: Record<string, unknown>,
  channel: "email" | "sms"
): Promise<CrmContact[]> {
  let q = db.from("crm_contacts").select("*");
  if (typeof audience.stage === "string") q = q.eq("lifecycle_stage", audience.stage);
  if (typeof audience.tag === "string") q = q.contains("tags", [audience.tag]);
  if (typeof audience.source === "string") q = q.eq("source", audience.source);
  if (channel === "email") q = q.eq("do_not_email", false).not("email", "is", null);
  else q = q.eq("do_not_sms", false).not("phone", "is", null);
  const { data } = await q.limit(5000);
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
  const rows = contactIds.map((id) => ({
    campaign_id: campaignId,
    contact_id: id,
    status: "active" as const,
    current_step: 0,
    next_run_at: now,
  }));
  const { data, error } = await db
    .from("crm_enrollments")
    .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** Send a one-shot blast to the whole audience, logging each message. */
export async function sendBlast(db: DB, campaign: CrmCampaign): Promise<{ sent: number; failed: number }> {
  const contacts = await resolveAudience(db, campaign.audience, campaign.channel);
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
  await db.from("crm_campaigns").update({ status: "done" }).eq("id", campaign.id);
  return { sent, failed };
}

/**
 * Process one active drip enrollment: send the current step, then schedule the
 * next (or complete). Returns whether it did anything.
 */
async function runEnrollmentStep(
  db: DB,
  enrollment: { id: string; campaign_id: string; contact_id: string; current_step: number },
  steps: CrmCampaignStep[]
): Promise<boolean> {
  const step = steps[enrollment.current_step];
  const { data: contact } = await db
    .from("crm_contacts")
    .select("*")
    .eq("id", enrollment.contact_id)
    .maybeSingle();
  const c = contact as CrmContact | null;

  // Contact gone or opted out → stop.
  if (!c || (step?.channel === "email" && (c.do_not_email || !c.email)) ||
      (step?.channel === "sms" && (c.do_not_sms || !c.phone))) {
    await db.from("crm_enrollments").update({ status: "unsubscribed" }).eq("id", enrollment.id);
    return true;
  }
  if (!step) {
    await db
      .from("crm_enrollments")
      .update({ status: "completed", completed_at: new Date().toISOString(), next_run_at: null })
      .eq("id", enrollment.id);
    return true;
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

  const nextIndex = enrollment.current_step + 1;
  const nextStep = steps[nextIndex];
  if (!nextStep) {
    await db
      .from("crm_enrollments")
      .update({ status: "completed", completed_at: new Date().toISOString(), current_step: nextIndex, next_run_at: null })
      .eq("id", enrollment.id);
  } else {
    const nextRun = new Date(Date.now() + nextStep.delay_minutes * 60_000).toISOString();
    await db
      .from("crm_enrollments")
      .update({ current_step: nextIndex, next_run_at: nextRun })
      .eq("id", enrollment.id);
  }
  return true;
}

/** Cron entrypoint: process all due drip enrollments (bounded per run). */
export async function processDrips(db: DB, limit = 200): Promise<{ processed: number }> {
  const now = new Date().toISOString();
  const { data: due } = await db
    .from("crm_enrollments")
    .select("id, campaign_id, contact_id, current_step")
    .eq("status", "active")
    .not("next_run_at", "is", null)
    .lte("next_run_at", now)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  const enrollments = (due as { id: string; campaign_id: string; contact_id: string; current_step: number }[]) ?? [];
  // Cache steps per campaign.
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
    if (await runEnrollmentStep(db, e, steps)) processed++;
  }
  return { processed };
}

/** Cron entrypoint: fire scheduled blasts whose time has come. */
export async function processScheduledBlasts(db: DB): Promise<{ fired: number }> {
  const now = new Date().toISOString();
  const { data: campaigns } = await db
    .from("crm_campaigns")
    .select("*")
    .eq("type", "blast")
    .eq("status", "scheduled")
    .lte("scheduled_at", now)
    .limit(20);
  let fired = 0;
  for (const c of (campaigns as CrmCampaign[]) ?? []) {
    await db.from("crm_campaigns").update({ status: "sending" }).eq("id", c.id);
    await sendBlast(db, c);
    fired++;
  }
  return { fired };
}
