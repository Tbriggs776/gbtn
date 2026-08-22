"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getContact, getContactTimeline } from "./service";
import {
  summarizeContact,
  nextBestAction,
  draftReply,
  scoreLead,
  draftCampaign,
} from "./ai";
import type { ActionResult } from "./types";

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : "AI request failed." };
}

async function ctx(contactId: string) {
  const db = await createClient();
  const [contact, timeline] = await Promise.all([
    getContact(db, contactId),
    getContactTimeline(db, contactId),
  ]);
  return { db, contact, timeline };
}

export async function aiSummarize(contactId: string): Promise<ActionResult<{ text: string }>> {
  try {
    await assertAdmin();
    const { contact, timeline } = await ctx(contactId);
    if (!contact) return { ok: false, error: "Contact not found." };
    const res = await summarizeContact(contact, timeline);
    if (!res.ok) return { ok: false, error: res.message };
    return { ok: true, data: { text: res.text } };
  } catch (e) {
    return fail(e);
  }
}

export async function aiNextAction(contactId: string): Promise<ActionResult<{ text: string }>> {
  try {
    await assertAdmin();
    const { contact, timeline } = await ctx(contactId);
    if (!contact) return { ok: false, error: "Contact not found." };
    const res = await nextBestAction(contact, timeline);
    if (!res.ok) return { ok: false, error: res.message };
    return { ok: true, data: { text: res.text } };
  } catch (e) {
    return fail(e);
  }
}

export async function aiDraft(
  contactId: string,
  channel: "email" | "sms",
  instruction?: string
): Promise<ActionResult<{ text: string }>> {
  try {
    await assertAdmin();
    const { contact, timeline } = await ctx(contactId);
    if (!contact) return { ok: false, error: "Contact not found." };
    const res = await draftReply(contact, timeline, { channel, instruction });
    if (!res.ok) return { ok: false, error: res.message };
    return { ok: true, data: { text: res.text } };
  } catch (e) {
    return fail(e);
  }
}

export async function aiScore(contactId: string): Promise<ActionResult<{ score: number; rationale: string }>> {
  try {
    await assertAdmin();
    const { db, contact, timeline } = await ctx(contactId);
    if (!contact) return { ok: false, error: "Contact not found." };
    const res = await scoreLead(contact, timeline);
    if (!res) return { ok: false, error: "Could not score this lead (is the AI key configured?)." };
    await db.from("crm_contacts").update({ lead_score: res.score }).eq("id", contactId);
    revalidatePath(`/portal/crm/contacts/${contactId}`);
    return { ok: true, data: res };
  } catch (e) {
    return fail(e);
  }
}

export async function aiDraftCampaign(input: {
  goal: string;
  channel: "email" | "sms";
  audience?: string;
}): Promise<ActionResult<{ text: string }>> {
  try {
    await assertAdmin();
    const res = await draftCampaign(input);
    if (!res.ok) return { ok: false, error: res.message };
    return { ok: true, data: { text: res.text } };
  } catch (e) {
    return fail(e);
  }
}
