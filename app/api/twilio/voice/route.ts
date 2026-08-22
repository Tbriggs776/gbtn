import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTwilioSignature, toE164 } from "@/lib/crm/twilio";
import { findContactByPhone } from "@/lib/crm/service";
import { logInboundCall as recordInboundCall } from "@/lib/crm/comms";
import { site } from "@/lib/site";

// Inbound voice webhook: log the call on the caller's timeline, then forward to
// the founder's phone with recording. Returns TwiML.
export const dynamic = "force-dynamic";

function fullUrl(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const { pathname, search } = new URL(req.url);
  return `${proto}://${host}${pathname}${search}`;
}

export async function POST(req: Request) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const valid = await validateTwilioSignature(
    fullUrl(req),
    params,
    req.headers.get("x-twilio-signature")
  );
  if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 403 });

  const from = params.From ?? "";
  const db = createAdminClient();
  const contact = from ? await findContactByPhone(db, from) : null;
  if (contact) {
    await recordInboundCall(db, {
      contactId: contact.id,
      from,
      connected: false,
      provider: "twilio",
      sid: params.CallSid,
    });
  }

  const forwardTo = toE164(site.founder.phone) ?? site.founder.phoneHref.replace("tel:", "");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="polly.Joanna">Thank you for calling Growth by the Numbers. Connecting you now.</Say><Dial record="record-from-answer-dual" timeout="25"><Number>${forwardTo}</Number></Dial></Response>`;

  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
