"use server";

import { revalidatePath } from "next/cache";
import { assertStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getCampaign } from "./service";
import {
  enrollContacts,
  resolveAudience,
  sendBlast,
} from "./campaign-engine";
import type { ActionResult } from "./types";

const CRM = "/portal/crm";

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
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
    const session = await assertStaff();
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
    await assertStaff();
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
    await assertStaff();
    const db = await createClient();
    // Replace-all: simplest reliable editor semantics.
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
    await assertStaff();
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
    await assertStaff();
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

/** Send a blast immediately to its saved audience. */
export async function sendCampaignNow(campaignId: string): Promise<ActionResult<{ sent: number; failed: number }>> {
  try {
    await assertStaff();
    const db = await createClient();
    const campaign = await getCampaign(db, campaignId);
    if (!campaign) return { ok: false, error: "Campaign not found." };
    if (campaign.type !== "blast") return { ok: false, error: "Only blast campaigns send immediately. Use Activate for drips." };
    await db.from("crm_campaigns").update({ status: "sending" }).eq("id", campaignId);
    const res = await sendBlast(db, campaign);
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true, data: res };
  } catch (e) {
    return fail(e);
  }
}

export async function scheduleCampaign(campaignId: string, whenIso: string): Promise<ActionResult> {
  try {
    await assertStaff();
    const db = await createClient();
    const { error } = await db
      .from("crm_campaigns")
      .update({ status: "scheduled", scheduled_at: whenIso })
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
    await assertStaff();
    const db = await createClient();
    const { error } = await db.from("crm_campaigns").update({ status }).eq("id", campaignId);
    if (error) throw error;
    revalidatePath(`${CRM}/campaigns/${campaignId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
