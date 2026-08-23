"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sendContactEmail, sendContactSms, applyEmailUnsubscribe } from "./comms";
import { placeCall, toE164, getTwilioConfig } from "./twilio";
import { getContact } from "./service";
import { appBaseUrl } from "./comms";
import type { ActionResult, CasePriority, CaseStatus, LifecycleStage, ValueType } from "./types";
import { STAGE_NEXT_STEP_PREFIX } from "./types";
import { addWeekdays, completeOpenStageNextSteps, createStageNextStepTask } from "./stage-automation";
import type { SupabaseClient } from "@supabase/supabase-js";

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
}

const CRM = "/portal/crm";

function pickAllowed(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

const CONTACT_PATCH_KEYS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "title",
  "company_id",
  "lifecycle_stage",
  "source",
  "notes",
  "tags",
  "custom",
  "next_follow_up_at",
] as const;

const COMPANY_PATCH_KEYS = [
  "name",
  "domain",
  "website",
  "phone",
  "industry",
  "size",
  "address",
  "notes",
  "tags",
  "custom",
] as const;

const DEAL_PATCH_KEYS = [
  "title",
  "value",
  "value_type",
  "stage_id",
  "contact_id",
  "company_id",
  "expected_close",
  "notes",
  "currency",
  "lost_reason",
  "custom",
] as const;

const CASE_PATCH_KEYS = [
  "title",
  "status",
  "priority",
  "assignee",
  "due_at",
  "notes",
  "company_id",
  "deal_id",
] as const;

/**
 * Recompute contact lifetime columns from every won deal on that contact.
 *   lifetime_value = sum of one_time values
 *   mrr            = monthly values + annual / 12
 *   ARR            = mrr * 12 (not stored)
 * Recalc also runs when a deal leaves won. If any won deals remain, lifecycle
 * is set to customer; we do not auto-churn when the last won deal is reversed.
 */
export async function recalcContactLifetime(
  db: SupabaseClient,
  contactId: string | null | undefined
): Promise<void> {
  if (!contactId) return;
  const { data: deals } = await db
    .from("crm_deals")
    .select("value, value_type, closed_at, created_at")
    .eq("contact_id", contactId)
    .eq("status", "won");

  let lifetime_value = 0;
  let mrr = 0;
  const wonMs: number[] = [];
  for (const d of deals ?? []) {
    const v = Number(d.value) || 0;
    const vt = (d.value_type as ValueType) ?? "one_time";
    if (vt === "monthly") mrr += v;
    else if (vt === "annual") mrr += v / 12;
    else lifetime_value += v;
    const stamp = (d.closed_at as string | null) ?? (d.created_at as string | null);
    if (stamp) wonMs.push(new Date(stamp).getTime());
  }
  const count = deals?.length ?? 0;
  const patch: Record<string, unknown> = {
    won_deal_count: count,
    lifetime_value,
    mrr,
    first_won_at: count && wonMs.length ? new Date(Math.min(...wonMs)).toISOString() : null,
    last_won_at: count && wonMs.length ? new Date(Math.max(...wonMs)).toISOString() : null,
  };
  if (count > 0) patch.lifecycle_stage = "customer";
  const { error } = await db.from("crm_contacts").update(patch).eq("id", contactId);
  if (error) throw error;
}

async function logCaseActivity(
  db: SupabaseClient,
  input: {
    contactId: string;
    companyId?: string | null;
    dealId?: string | null;
    caseId: string;
    subject: string;
    createdBy: string;
  }
): Promise<void> {
  const { error } = await db.from("crm_activities").insert({
    contact_id: input.contactId,
    company_id: input.companyId ?? null,
    deal_id: input.dealId ?? null,
    type: "system",
    subject: input.subject,
    created_by: input.createdBy,
    meta: { case_id: input.caseId },
  });
  if (error) throw error;
}

async function maybeCreateOnboardingCase(
  db: SupabaseClient,
  deal: {
    id: string;
    title: string;
    contact_id: string | null;
    company_id: string | null;
    owner: string | null;
  },
  createdBy: string
): Promise<void> {
  if (!deal.contact_id) return;
  const { data: existing } = await db
    .from("crm_cases")
    .select("id")
    .eq("deal_id", deal.id)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (existing?.id) return;
  const title = `Onboarding — ${deal.title}`;
  const { data, error } = await db
    .from("crm_cases")
    .insert({
      contact_id: deal.contact_id,
      company_id: deal.company_id ?? null,
      deal_id: deal.id,
      title,
      status: "open",
      priority: "normal",
      assignee: deal.owner ?? createdBy,
      due_at: addWeekdays(new Date(), 5).toISOString(),
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (error) throw error;
  await logCaseActivity(db, {
    contactId: deal.contact_id,
    companyId: deal.company_id,
    dealId: deal.id,
    caseId: data.id as string,
    subject: `Case opened: ${title}`,
    createdBy,
  });
}

// ── Contacts ─────────────────────────────────────────────────────────────────
export async function createContact(input: {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  title?: string;
  company_id?: string | null;
  lifecycle_stage?: LifecycleStage;
  source?: string;
  notes?: string;
  tags?: string[];
}): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const email = input.email?.trim().toLowerCase() || null;
    const { data, error } = await db
      .from("crm_contacts")
      .insert({
        first_name: input.first_name?.trim() || null,
        last_name: input.last_name?.trim() || null,
        email,
        phone: toE164(input.phone) ?? input.phone?.trim() ?? null,
        title: input.title?.trim() || null,
        company_id: input.company_id || null,
        lifecycle_stage: input.lifecycle_stage ?? "lead",
        source: input.source ?? "manual",
        notes: input.notes?.trim() || null,
        tags: input.tags ?? [],
        owner: session.user.id,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") return { ok: false, error: "A contact with that email already exists." };
      throw error;
    }
    revalidatePath(`${CRM}/contacts`);
    return { ok: true, data: { id: data.id as string } };
  } catch (e) {
    return fail(e);
  }
}

export async function updateContact(
  id: string,
  patch: Record<string, unknown>
): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const clean = pickAllowed(patch, CONTACT_PATCH_KEYS);
    if (typeof clean.email === "string") clean.email = clean.email.trim().toLowerCase() || null;
    if (typeof clean.phone === "string") clean.phone = toE164(clean.phone) ?? clean.phone;
    const { error } = await db.from("crm_contacts").update(clean).eq("id", id);
    if (error) throw error;
    revalidatePath(`${CRM}/contacts/${id}`);
    revalidatePath(`${CRM}/contacts`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function optOutContact(
  id: string,
  channels: { email?: boolean; sms?: boolean } = { email: true }
): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    if (channels.email) await applyEmailUnsubscribe(db, id);
    if (channels.sms) {
      const { error } = await db.from("crm_contacts").update({ do_not_sms: true }).eq("id", id);
      if (error) throw error;
    }
    revalidatePath(`${CRM}/contacts/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteContact(id: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const { error } = await db.from("crm_contacts").delete().eq("id", id);
    if (error) throw error;
    revalidatePath(`${CRM}/contacts`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Companies ────────────────────────────────────────────────────────────────
export async function createCompany(input: {
  name: string;
  domain?: string;
  website?: string;
  phone?: string;
  industry?: string;
  notes?: string;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    if (!input.name?.trim()) return { ok: false, error: "Company name is required." };
    const { data, error } = await db
      .from("crm_companies")
      .insert({
        name: input.name.trim(),
        domain: input.domain?.trim() || null,
        website: input.website?.trim() || null,
        phone: input.phone?.trim() || null,
        industry: input.industry?.trim() || null,
        notes: input.notes?.trim() || null,
        source: "manual",
        owner: session.user.id,
      })
      .select("id")
      .single();
    if (error) throw error;
    revalidatePath(`${CRM}/companies`);
    return { ok: true, data: { id: data.id as string } };
  } catch (e) {
    return fail(e);
  }
}

export async function updateCompany(id: string, patch: Record<string, unknown>): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const clean = pickAllowed(patch, COMPANY_PATCH_KEYS);
    const { error } = await db.from("crm_companies").update(clean).eq("id", id);
    if (error) throw error;
    revalidatePath(`${CRM}/companies/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Deals ────────────────────────────────────────────────────────────────────
export async function createDeal(input: {
  title: string;
  value?: number;
  value_type?: string;
  stage_id?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  expected_close?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    if (!input.title?.trim()) return { ok: false, error: "Deal title is required." };
    let stageId = input.stage_id ?? null;
    if (!stageId) {
      const { data: first } = await db
        .from("crm_stages")
        .select("id")
        .order("position")
        .limit(1)
        .maybeSingle();
      stageId = (first?.id as string) ?? null;
    }
    const { data, error } = await db
      .from("crm_deals")
      .insert({
        title: input.title.trim(),
        value: input.value ?? 0,
        value_type: input.value_type ?? "one_time",
        stage_id: stageId,
        contact_id: input.contact_id || null,
        company_id: input.company_id || null,
        expected_close: input.expected_close || null,
        owner: session.user.id,
      })
      .select("id")
      .single();
    if (error) throw error;
    revalidatePath(`${CRM}/deals`);
    return { ok: true, data: { id: data.id as string } };
  } catch (e) {
    return fail(e);
  }
}

export async function moveDealStage(
  dealId: string,
  stageId: string,
  lost_reason?: string
): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const { data: deal } = await db
      .from("crm_deals")
      .select("stage_id, contact_id, company_id, title, owner")
      .eq("id", dealId)
      .maybeSingle();
    if (!deal) return { ok: false, error: "Deal not found." };
    if (deal.stage_id === stageId) return { ok: true };

    const [{ data: toStage }, fromStage] = await Promise.all([
      db.from("crm_stages").select("name, is_won, is_lost").eq("id", stageId).maybeSingle(),
      deal.stage_id
        ? db.from("crm_stages").select("name").eq("id", deal.stage_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (!toStage) return { ok: false, error: "Stage not found." };

    const reason = lost_reason?.trim() ?? "";
    if (toStage.is_lost && !reason) {
      return { ok: false, error: "Lost reason is required." };
    }

    const patch: Record<string, unknown> = { stage_id: stageId };
    if (toStage.is_won) {
      patch.status = "won";
      patch.closed_at = new Date().toISOString();
    } else if (toStage.is_lost) {
      patch.status = "lost";
      patch.closed_at = new Date().toISOString();
      patch.lost_reason = reason;
    } else {
      patch.status = "open";
      patch.closed_at = null;
    }
    const { error } = await db.from("crm_deals").update(patch).eq("id", dealId);
    if (error) throw error;

    await recalcContactLifetime(db, deal.contact_id as string | null);

    await completeOpenStageNextSteps(db, dealId);
    if (toStage.is_won) {
      await maybeCreateOnboardingCase(
        db,
        {
          id: dealId,
          title: deal.title as string,
          contact_id: (deal.contact_id as string | null) ?? null,
          company_id: (deal.company_id as string | null) ?? null,
          owner: (deal.owner as string | null) ?? null,
        },
        session.user.id
      );
    } else if (!toStage.is_lost) {
      let assignee = (deal.owner as string | null) ?? session.user.id;
      if (!deal.owner && deal.contact_id) {
        const { data: contact } = await db
          .from("crm_contacts")
          .select("owner")
          .eq("id", deal.contact_id)
          .maybeSingle();
        if (contact?.owner) assignee = contact.owner as string;
      }
      await createStageNextStepTask(db, {
        dealId,
        title: `${STAGE_NEXT_STEP_PREFIX} ${toStage.name} — ${deal.title as string}`,
        contactId: (deal.contact_id as string | null) ?? null,
        companyId: (deal.company_id as string | null) ?? null,
        assignee,
        createdBy: session.user.id,
      });
    }

    await db.from("crm_activities").insert({
      contact_id: deal.contact_id ?? null,
      company_id: deal.company_id ?? null,
      deal_id: dealId,
      type: "stage_change",
      subject: `Moved to ${toStage.name ?? "stage"}`,
      created_by: session.user.id,
      meta: { from: (fromStage?.data as { name?: string } | null)?.name ?? null, to: toStage.name ?? null },
    });
    revalidatePath(`${CRM}/deals`);
    revalidatePath(`${CRM}/tasks`);
    revalidatePath(`${CRM}/cases`);
    if (deal.contact_id) revalidatePath(`${CRM}/contacts/${deal.contact_id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function markDealWon(id: string): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const { data: won } = await db.from("crm_stages").select("id").eq("is_won", true).limit(1).maybeSingle();
    if (won?.id) return moveDealStage(id, won.id as string);
    const { data: deal } = await db
      .from("crm_deals")
      .select("id, title, contact_id, company_id, owner")
      .eq("id", id)
      .maybeSingle();
    const { error } = await db
      .from("crm_deals")
      .update({ status: "won", closed_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    await recalcContactLifetime(db, deal?.contact_id as string | null);
    if (deal) {
      await maybeCreateOnboardingCase(
        db,
        {
          id: deal.id as string,
          title: deal.title as string,
          contact_id: (deal.contact_id as string | null) ?? null,
          company_id: (deal.company_id as string | null) ?? null,
          owner: (deal.owner as string | null) ?? null,
        },
        session.user.id
      );
    }
    revalidatePath(`${CRM}/deals`);
    revalidatePath(`${CRM}/cases`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function markDealLost(id: string, lost_reason?: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    if (!lost_reason?.trim()) return { ok: false, error: "Lost reason is required." };
    const { data: lost } = await db.from("crm_stages").select("id").eq("is_lost", true).limit(1).maybeSingle();
    if (lost?.id) {
      return moveDealStage(id, lost.id as string, lost_reason);
    }
    const { data: deal } = await db.from("crm_deals").select("contact_id").eq("id", id).maybeSingle();
    const { error } = await db
      .from("crm_deals")
      .update({ status: "lost", closed_at: new Date().toISOString(), lost_reason: lost_reason ?? null })
      .eq("id", id);
    if (error) throw error;
    await recalcContactLifetime(db, deal?.contact_id as string | null);
    revalidatePath(`${CRM}/deals`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateDeal(id: string, patch: Record<string, unknown>): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const stageId = typeof patch.stage_id === "string" ? patch.stage_id : null;
    const clean = pickAllowed(patch, DEAL_PATCH_KEYS);
    delete clean.stage_id;
    if (Object.keys(clean).length) {
      const { data: before } = await db.from("crm_deals").select("contact_id").eq("id", id).maybeSingle();
      const { error } = await db.from("crm_deals").update(clean).eq("id", id);
      if (error) throw error;
      const contactId = (clean.contact_id as string | null | undefined) ?? (before?.contact_id as string | null);
      await recalcContactLifetime(db, contactId);
      if (before?.contact_id && before.contact_id !== clean.contact_id) {
        await recalcContactLifetime(db, before.contact_id as string);
      }
    }
    if (stageId) return moveDealStage(id, stageId);
    revalidatePath(`${CRM}/deals`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Activities (manual log) ──────────────────────────────────────────────────
export async function logActivity(input: {
  contact_id?: string | null;
  company_id?: string | null;
  deal_id?: string | null;
  type: "note" | "call" | "meeting";
  direction?: "inbound" | "outbound";
  subject?: string;
  body?: string;
  connected?: boolean;
  occurred_at?: string;
}): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const meta: Record<string, unknown> = {};
    if (input.type === "call") meta.connected = input.connected ? "true" : "false";
    const { error } = await db.from("crm_activities").insert({
      contact_id: input.contact_id ?? null,
      company_id: input.company_id ?? null,
      deal_id: input.deal_id ?? null,
      type: input.type,
      direction: input.direction ?? (input.type === "note" ? null : "outbound"),
      subject: input.subject ?? null,
      body: input.body ?? null,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      created_by: session.user.id,
      meta,
    });
    if (error) throw error;
    if (input.contact_id) revalidatePath(`${CRM}/contacts/${input.contact_id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────────
export async function createTask(input: {
  title: string;
  contact_id?: string | null;
  deal_id?: string | null;
  due_at?: string | null;
  reminder_at?: string | null;
  remind_channel?: "none" | "email" | "sms";
  priority?: "low" | "normal" | "high";
  notes?: string;
}): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    if (!input.title?.trim()) return { ok: false, error: "Task title is required." };
    const { error } = await db.from("crm_tasks").insert({
      title: input.title.trim(),
      contact_id: input.contact_id || null,
      deal_id: input.deal_id || null,
      due_at: input.due_at || null,
      reminder_at: input.reminder_at || null,
      remind_channel: input.remind_channel ?? "none",
      priority: input.priority ?? "normal",
      notes: input.notes?.trim() || null,
      assignee: session.user.id,
      created_by: session.user.id,
    });
    if (error) throw error;
    revalidatePath(`${CRM}/tasks`);
    if (input.contact_id) revalidatePath(`${CRM}/contacts/${input.contact_id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setTaskStatus(
  id: string,
  status: "open" | "done" | "cancelled"
): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const { error } = await db
      .from("crm_tasks")
      .update({ status, completed_at: status === "done" ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) throw error;
    revalidatePath(`${CRM}/tasks`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Cases ────────────────────────────────────────────────────────────────────
export async function createCase(input: {
  title: string;
  contact_id: string;
  company_id?: string | null;
  deal_id?: string | null;
  priority?: CasePriority;
  due_at?: string | null;
  notes?: string;
  assignee?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    if (!input.title?.trim()) return { ok: false, error: "Case title is required." };
    if (!input.contact_id) return { ok: false, error: "A contact is required." };
    let companyId = input.company_id || null;
    if (!companyId) {
      const contact = await getContact(db, input.contact_id);
      companyId = contact?.company_id ?? null;
    }
    const { data, error } = await db
      .from("crm_cases")
      .insert({
        title: input.title.trim(),
        contact_id: input.contact_id,
        company_id: companyId,
        deal_id: input.deal_id || null,
        priority: input.priority ?? "normal",
        due_at: input.due_at || null,
        notes: input.notes?.trim() || null,
        assignee: input.assignee || session.user.id,
        created_by: session.user.id,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logCaseActivity(db, {
      contactId: input.contact_id,
      companyId,
      dealId: input.deal_id || null,
      caseId: data.id as string,
      subject: `Case opened: ${input.title.trim()}`,
      createdBy: session.user.id,
    });
    revalidatePath(`${CRM}/cases`);
    revalidatePath(`${CRM}/contacts/${input.contact_id}`);
    return { ok: true, data: { id: data.id as string } };
  } catch (e) {
    return fail(e);
  }
}

export async function updateCase(id: string, patch: Record<string, unknown>): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const clean = pickAllowed(patch, CASE_PATCH_KEYS);
    if (clean.status === "closed") clean.closed_at = new Date().toISOString();
    if (clean.status && clean.status !== "closed") clean.closed_at = null;
    const { data: before } = await db
      .from("crm_cases")
      .select("contact_id, company_id, deal_id, status, title")
      .eq("id", id)
      .maybeSingle();
    if (!before) return { ok: false, error: "Case not found." };
    const { error } = await db.from("crm_cases").update(clean).eq("id", id);
    if (error) throw error;
    if (clean.status === "closed" && before.status !== "closed") {
      await logCaseActivity(db, {
        contactId: before.contact_id as string,
        companyId: before.company_id as string | null,
        dealId: before.deal_id as string | null,
        caseId: id,
        subject: `Case closed: ${before.title as string}`,
        createdBy: session.user.id,
      });
    }
    revalidatePath(`${CRM}/cases`);
    if (before.contact_id) revalidatePath(`${CRM}/contacts/${before.contact_id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function closeCase(id: string): Promise<ActionResult> {
  return updateCase(id, { status: "closed" as CaseStatus });
}

// ── Comms (from a contact record) ────────────────────────────────────────────
export async function emailContact(input: {
  contact_id: string;
  subject: string;
  body: string;
}): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const contact = await getContact(db, input.contact_id);
    if (!contact?.email) return { ok: false, error: "This contact has no email address." };
    if (contact.do_not_email) return { ok: false, error: "This contact is marked do-not-email." };
    const html = input.body.replace(/\n/g, "<br>");
    const res = await sendContactEmail(
      db,
      { contactId: input.contact_id, createdBy: session.user.id },
      { to: contact.email, subject: input.subject, html }
    );
    if (!res.ok) return { ok: false, error: res.error ?? "Email failed." };
    revalidatePath(`${CRM}/contacts/${input.contact_id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function smsContact(input: {
  contact_id: string;
  body: string;
}): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const contact = await getContact(db, input.contact_id);
    if (!contact?.phone) return { ok: false, error: "This contact has no phone number." };
    if (contact.do_not_sms) return { ok: false, error: "This contact is marked do-not-SMS." };
    const res = await sendContactSms(
      db,
      { contactId: input.contact_id, createdBy: session.user.id },
      { to: contact.phone, body: input.body }
    );
    if (!res.ok) return { ok: false, error: res.error ?? "SMS failed." };
    revalidatePath(`${CRM}/contacts/${input.contact_id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// Click-to-call: rings the agent's phone, then bridges to the contact.
export async function callContact(input: {
  contact_id: string;
  agent_number: string;
}): Promise<ActionResult> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const contact = await getContact(db, input.contact_id);
    if (!contact?.phone) return { ok: false, error: "This contact has no phone number." };
    const agent = toE164(input.agent_number);
    if (!agent) return { ok: false, error: "Enter a valid number to call you on." };
    const contactE164 = toE164(contact.phone);
    const cfg = await getTwilioConfig();
    if (!cfg?.fromNumber) return { ok: false, error: "No Twilio caller-ID number configured." };
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting your Growth by the Numbers call.</Say><Dial callerId="${cfg.fromNumber}">${contactE164}</Dial></Response>`;
    const res = await placeCall({
      to: agent,
      twiml,
      statusCallback: `${appBaseUrl()}/api/twilio/status`,
    });
    if (!res.ok) return { ok: false, error: res.error ?? "Call failed." };
    await db.from("crm_activities").insert({
      contact_id: input.contact_id,
      type: "call",
      direction: "outbound",
      subject: "Outbound call placed",
      created_by: session.user.id,
      meta: { sid: res.sid ?? null, connected: "false" },
    });
    revalidatePath(`${CRM}/contacts/${input.contact_id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
