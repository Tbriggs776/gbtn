import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTwilioSignature } from "@/lib/crm/twilio";
import { findContactByPhone, getContactTimeline } from "@/lib/crm/service";
import { logInboundSms, sendContactSms } from "@/lib/crm/comms";
import { botReplyToInboundSms } from "@/lib/crm/ai";

// Inbound SMS webhook (Twilio → us). Validates the X-Twilio-Signature, threads
// the message onto the matching contact's timeline, and replies with empty
// TwiML. Writes use the service-role client (no user session here).
export const dynamic = "force-dynamic";

function fullUrl(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const { pathname, search } = new URL(req.url);
  return `${proto}://${host}${pathname}${search}`;
}

const emptyTwiml = () =>
  new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

export async function POST(req: Request) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const signature = req.headers.get("x-twilio-signature");

  const valid = await validateTwilioSignature(fullUrl(req), params, signature);
  if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 403 });

  const from = params.From ?? "";
  const body = params.Body ?? "";
  const sid = params.MessageSid ?? params.SmsSid ?? "";
  if (!from) return emptyTwiml();

  const db = createAdminClient();
  const contact = await findContactByPhone(db, from);

  // STOP / unsubscribe handling (compliance).
  const normalized = body.trim().toLowerCase();
  if (contact && ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(normalized)) {
    await db
      .from("crm_contacts")
      .update({ do_not_sms: true, unsubscribed_at: new Date().toISOString() })
      .eq("id", contact.id);
  }
  if (contact && ["start", "unstop", "yes"].includes(normalized)) {
    await db.from("crm_contacts").update({ do_not_sms: false, unsubscribed_at: null }).eq("id", contact.id);
  }

  await logInboundSms(db, { contactId: contact?.id ?? null, from, body, sid });

  // AI auto-responder (opt-in via CRM_SMS_AUTORESPONDER=1). Skips opt-outs,
  // keyword commands, and unmatched numbers. The bot returns null to escalate
  // to a human, in which case we stay silent and the inbound sits in the queue.
  const isKeyword = [
    "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "start", "unstop", "yes",
  ].includes(normalized);
  if (
    process.env.CRM_SMS_AUTORESPONDER === "1" &&
    contact &&
    !contact.do_not_sms &&
    !isKeyword &&
    body.trim()
  ) {
    try {
      const timeline = await getContactTimeline(db, contact.id, 20);
      const reply = await botReplyToInboundSms(contact, timeline, body);
      if (reply && contact.phone) {
        await sendContactSms(
          db,
          { contactId: contact.id, campaignId: null },
          { to: contact.phone, body: reply }
        );
      }
    } catch {
      /* non-fatal: the inbound is already logged for a human to handle */
    }
  }

  return emptyTwiml();
}
