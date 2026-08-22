import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Public one-click unsubscribe. Links carry ?c=<contactId>. Sets do_not_email
// (and do_not_sms) and records the opt-out time. Service-role (no session).
export const dynamic = "force-dynamic";

function page(message: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:Arial,Helvetica,sans-serif;background:#f6f2ea;color:#11294a;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:420px;background:#fff;border:1px solid #e7e0d3;border-radius:14px;padding:32px;text-align:center"><h1 style="font-family:Georgia,serif;font-size:20px;margin:0 0 10px">Growth by the Numbers</h1><p style="font-size:15px;line-height:1.6;color:#3a4252;margin:0">${message}</p></div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const contactId = searchParams.get("c");
  if (!contactId) return page("This unsubscribe link is invalid.");

  const db = createAdminClient();
  const { error } = await db
    .from("crm_contacts")
    .update({ do_not_email: true, unsubscribed_at: new Date().toISOString() })
    .eq("id", contactId);
  if (error) return page("We couldn't process your request. Please email us to be removed.");

  // Stop any active campaign enrollments too.
  await db
    .from("crm_enrollments")
    .update({ status: "unsubscribed" })
    .eq("contact_id", contactId)
    .eq("status", "active");

  return page("You've been unsubscribed. You won't receive further marketing emails from us.");
}
