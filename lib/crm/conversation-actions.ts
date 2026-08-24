"use server";

import { revalidatePath } from "next/cache";
import { assertStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getContact } from "./service";
import { sendContactEmail, sendContactSms } from "./comms";
import type { ActionResult, Channel, ConversationStatus } from "./types";

const CONV = "/portal/crm/conversations";

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
}

export async function markConversationRead(
  contactId: string,
  channel: Channel
): Promise<ActionResult> {
  try {
    await assertStaff();
    const db = await createClient();
    const { error } = await db
      .from("crm_conversations")
      .update({ unread: false })
      .eq("contact_id", contactId)
      .eq("channel", channel);
    if (error) throw error;
    revalidatePath(CONV);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setConversationStatus(
  contactId: string,
  channel: Channel,
  status: ConversationStatus
): Promise<ActionResult> {
  try {
    await assertStaff();
    const db = await createClient();
    const { error } = await db
      .from("crm_conversations")
      .update({ status })
      .eq("contact_id", contactId)
      .eq("channel", channel);
    if (error) throw error;
    revalidatePath(CONV);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function assignConversation(
  contactId: string,
  channel: Channel,
  assignee: string | null
): Promise<ActionResult> {
  try {
    await assertStaff();
    const db = await createClient();
    const { error } = await db
      .from("crm_conversations")
      .update({ assignee })
      .eq("contact_id", contactId)
      .eq("channel", channel);
    if (error) throw error;
    revalidatePath(CONV);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// Reply in a thread. Sends via the channel's provider (which also logs the
// message + activity and fires the conversation-sync trigger).
export async function replyToConversation(input: {
  contact_id: string;
  channel: Channel;
  body: string;
  subject?: string;
}): Promise<ActionResult> {
  try {
    const session = await assertStaff();
    const db = await createClient();
    const contact = await getContact(db, input.contact_id);
    if (!contact) return { ok: false, error: "Contact not found." };
    if (!input.body.trim()) return { ok: false, error: "Message is empty." };

    if (input.channel === "sms") {
      if (!contact.phone) return { ok: false, error: "This contact has no phone number." };
      if (contact.do_not_sms) return { ok: false, error: "This contact is marked do-not-SMS." };
      const res = await sendContactSms(
        db,
        { contactId: contact.id, createdBy: session.user.id },
        { to: contact.phone, body: input.body }
      );
      if (!res.ok) return { ok: false, error: res.error ?? "SMS failed." };
    } else {
      if (!contact.email) return { ok: false, error: "This contact has no email address." };
      if (contact.do_not_email) return { ok: false, error: "This contact is marked do-not-email." };
      const res = await sendContactEmail(
        db,
        { contactId: contact.id, createdBy: session.user.id },
        { to: contact.email, subject: input.subject?.trim() || "Re: your message", html: input.body.replace(/\n/g, "<br>") }
      );
      if (!res.ok) return { ok: false, error: res.error ?? "Email failed." };
    }
    // Sending is outbound, so the thread is handled — clear unread.
    await db
      .from("crm_conversations")
      .update({ unread: false })
      .eq("contact_id", input.contact_id)
      .eq("channel", input.channel);
    revalidatePath(CONV);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
