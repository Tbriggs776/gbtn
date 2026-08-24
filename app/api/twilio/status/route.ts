import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTwilioSignature } from "@/lib/crm/twilio";
import type { MessageStatus } from "@/lib/crm/types";

// Twilio status callback for message + call delivery. Updates the crm_messages
// row keyed by provider_id (MessageSid). Service-role writes.
export const dynamic = "force-dynamic";

function fullUrl(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const { pathname, search } = new URL(req.url);
  return `${proto}://${host}${pathname}${search}`;
}

const MSG_STATUS: Record<string, MessageStatus> = {
  queued: "queued",
  sending: "sent",
  sent: "sent",
  delivered: "delivered",
  undelivered: "failed",
  failed: "failed",
  received: "received",
};

export async function POST(req: Request) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const valid = await validateTwilioSignature(
    fullUrl(req),
    params,
    req.headers.get("x-twilio-signature")
  );
  if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 403 });

  const db = createAdminClient();

  // Message status callback.
  const messageSid = params.MessageSid ?? params.SmsSid;
  const messageStatus = params.MessageStatus ?? params.SmsStatus;
  if (messageSid && messageStatus) {
    const mapped = MSG_STATUS[messageStatus.toLowerCase()] ?? "sent";
    await db
      .from("crm_messages")
      .update({
        status: mapped,
        error: params.ErrorMessage ?? params.ErrorCode ?? null,
      })
      .eq("provider_id", messageSid);
  }

  // Call status callback (for outbound click-to-call): mark connected on
  // completion with a duration.
  const callSid = params.CallSid;
  const callStatus = params.CallStatus;
  if (callSid && callStatus === "completed") {
    const duration = Number(params.CallDuration ?? "0");
    // Update the matching call activity meta (best-effort).
    const { data: act } = await db
      .from("crm_activities")
      .select("id, meta, contact_id, occurred_at")
      .eq("type", "call")
      .filter("meta->>sid", "eq", callSid)
      .limit(1)
      .maybeSingle();
    if (act) {
      const connected = duration > 0;
      const meta = { ...(act.meta as Record<string, unknown>), connected: connected ? "true" : "false", duration_sec: duration };
      await db.from("crm_activities").update({ meta }).eq("id", act.id);
      // The insert-only auditing trigger can't see this later UPDATE, so a
      // connected outbound call would never mark the contact as contacted.
      // Set last_contacted_at here (only advancing it forward).
      if (connected && act.contact_id) {
        const { data: c } = await db
          .from("crm_contacts")
          .select("last_contacted_at")
          .eq("id", act.contact_id as string)
          .maybeSingle();
        const prev = c?.last_contacted_at as string | null | undefined;
        const when = (act.occurred_at as string) ?? new Date().toISOString();
        if (!prev || new Date(prev) < new Date(when)) {
          await db.from("crm_contacts").update({ last_contacted_at: when }).eq("id", act.contact_id as string);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}
