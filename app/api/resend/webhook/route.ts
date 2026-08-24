import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MessageStatus } from "@/lib/crm/types";

// Resend (Svix) delivery events → crm_messages.status by provider_id.
// Fail-closed: missing RESEND_WEBHOOK_SECRET or bad signature is 401/403.
export const dynamic = "force-dynamic";

const EVENT_STATUS: Record<string, MessageStatus> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
};

function verifyResendSignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigHeader = headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;

  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  const expectedBuf = Buffer.from(expected);

  for (const part of sigHeader.split(" ")) {
    const candidate = part.includes(",") ? part.split(",").slice(1).join(",") : part;
    try {
      const a = Buffer.from(candidate);
      if (a.length === expectedBuf.length && timingSafeEqual(a, expectedBuf)) return true;
    } catch {
      /* ignore malformed */
    }
  }
  return false;
}

export async function POST(req: Request) {
  if (!process.env.RESEND_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }

  const raw = await req.text();
  if (!verifyResendSignature(raw, req.headers)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 403 });
  }

  let payload: { type?: string; data?: { email_id?: string } };
  try {
    payload = JSON.parse(raw) as { type?: string; data?: { email_id?: string } };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const status = payload.type ? EVENT_STATUS[payload.type] : undefined;
  const emailId = payload.data?.email_id;
  if (!status || !emailId) return NextResponse.json({ ok: true, ignored: true });

  const db = createAdminClient();
  await db.from("crm_messages").update({ status }).eq("provider", "resend").eq("provider_id", emailId);

  return NextResponse.json({ ok: true });
}
