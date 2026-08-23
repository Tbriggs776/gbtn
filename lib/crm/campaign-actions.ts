"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getCampaign } from "./service";
import {
  enrollContacts,
  resolveAudience,
  sendBlast,
} from "./campaign-engine";
import type { ActionResult, Channel } from "./types";

const CRM = "/portal/crm";

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
}

function audienceFilter(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof a.stage === "string" && a.stage) out.stage = a.stage;
  if (typeof a.tag === "string" && a.tag) out.tag = a.tag;
  if (typeof a.source === "string" && a.source) out.source = a.source;
  return out;
}

export async function createCampaign(input: {
  name: string;
  channel: "email" | "sms";
  type: "blast" | "drip";
  subject?: string;
  from_name?: string;
  body?: string;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    if (!input.name?.trim()) return { ok: false, error: "Campaign name is required." };
    const { data, error } = await db
      .from("crm_campaigns")
      .insert({
        name: input.name.trim(),
        channel: input.channel,
        type: input.type,
        subject: input.subject?.trim() || null,
        from_name: input.from_name?.trim() || null,
        body: input.body ?? null,
        created_by: session.user.id,
      })
      .select("id")
      .single();
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns`);
    return { ok: true, data: { id: data.id as string } };
  } catch (e) {
    return fail(e);
  }
}

export async function updateCampaign(id: string, patch: Record<string, unknown>): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const { error } = await db.from("crm_campaigns").update(patch).eq("id", id);
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns/${id}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveCampaignSteps(
  campaignId: string,
  steps: { position: number; delay_minutes: number; channel: "email" | "sms"; subject?: string; body: string }[]
): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    await db.from("crm_campaign_steps").delete().eq("campaign_id", campaignId);
    if (steps.length > 0) {
      const rows = steps.map((s, i) => ({
        campaign_id: campaignId,
        position: i,
        delay_minutes: Math.max(0, s.delay_minutes || 0),
        channel: s.channel,
        subject: s.subject?.trim() || null,
        body: s.body ?? "",
      }));
      const { error } = await db.from("crm_campaign_steps").insert(rows);
      if (error) throw error;
    }
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function enrollSelected(
  campaignId: string,
  contactIds: string[]
): Promise<ActionResult<{ enrolled: number }>> {
  try {
    await assertAdmin();
    const db = await createClient();
    const n = await enrollContacts(db, campaignId, contactIds);
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true, data: { enrolled: n } };
  } catch (e) {
    return fail(e);
  }
}

export async function enrollAudience(
  campaignId: string,
  audience: Record<string, unknown>
): Promise<ActionResult<{ enrolled: number }>> {
  try {
    await assertAdmin();
    const db = await createClient();
    const campaign = await getCampaign(db, campaignId);
    if (!campaign) return { ok: false, error: "Campaign not found." };
    await db.from("crm_campaigns").update({ audience }).eq("id", campaignId);
    const contacts = await resolveAudience(db, audience, campaign.channel);
    const n = await enrollContacts(db, campaignId, contacts.map((c) => c.id));
    if (campaign.type === "drip") {
      await db.from("crm_campaigns").update({ status: "active" }).eq("id", campaignId);
    }
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true, data: { enrolled: n } };
  } catch (e) {
    return fail(e);
  }
}

/** Queue a blast: first chunk now, remaining chunks on crm-engine cron. */
export async function sendCampaignNow(
  campaignId: string
): Promise<ActionResult<{ sent: number; failed: number; done: boolean }>> {
  try {
    await assertAdmin();
    const db = await createClient();
    const campaign = await getCampaign(db, campaignId);
    if (!campaign) return { ok: false, error: "Campaign not found." };
    if (campaign.type !== "blast") return { ok: false, error: "Only blast campaigns send immediately. Use Activate for drips." };
    const audience = { ...campaign.audience, _blast_offset: 0 };
    await db.from("crm_campaigns").update({ status: "sending", audience }).eq("id", campaignId);
    const res = await sendBlast(db, { ...campaign, audience, status: "sending" });
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true, data: { sent: res.sent, failed: res.failed, done: res.done } };
  } catch (e) {
    return fail(e);
  }
}

export async function scheduleCampaign(campaignId: string, whenIso: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const campaign = await getCampaign(db, campaignId);
    const audience = { ...(campaign?.audience ?? {}), _blast_offset: 0 };
    const { error } = await db
      .from("crm_campaigns")
      .update({ status: "scheduled", scheduled_at: whenIso, audience })
      .eq("id", campaignId);
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setCampaignStatus(
  campaignId: string,
  status: "draft" | "active" | "paused" | "archived"
): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const { error } = await db.from("crm_campaigns").update({ status }).eq("id", campaignId);
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveSegment(input: {
  id?: string;
  name: string;
  filter: Record<string, unknown>;
}): Promise<ActionResult<{ id: string }>> {
  try {
    await assertAdmin();
    const db = await createClient();
    if (!input.name?.trim()) return { ok: false, error: "Segment name is required." };
    const row = { name: input.name.trim(), filter: audienceFilter(input.filter) };
    if (input.id) {
      const { error } = await db.from("crm_segments").update(row).eq("id", input.id);
      if (error) throw error;
      revalidatePath(`${CRM}/campaigns`);
      return { ok: true, data: { id: input.id } };
    }
    const { data, error } = await db.from("crm_segments").insert(row).select("id").single();
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns`);
    return { ok: true, data: { id: data.id as string } };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSegment(id: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const { error } = await db.from("crm_segments").delete().eq("id", id);
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function saveTemplate(input: {
  id?: string;
  name: string;
  channel: Channel;
  subject?: string;
  body: string;
}): Promise<ActionResult<{ id: string }>> {
  try {
    await assertAdmin();
    const db = await createClient();
    if (!input.name?.trim()) return { ok: false, error: "Template name is required." };
    const row = {
      name: input.name.trim(),
      channel: input.channel,
      subject: input.subject?.trim() || null,
      body: input.body ?? "",
    };
    if (input.id) {
      const { error } = await db.from("crm_templates").update(row).eq("id", input.id);
      if (error) throw error;
      revalidatePath(`${CRM}/campaigns`);
      return { ok: true, data: { id: input.id } };
    }
    const { data, error } = await db.from("crm_templates").insert(row).select("id").single();
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns`);
    return { ok: true, data: { id: data.id as string } };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTemplate(id: string): Promise<ActionResult> {
  try {
    await assertAdmin();
    const db = await createClient();
    const { error } = await db.from("crm_templates").delete().eq("id", id);
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
