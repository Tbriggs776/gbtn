import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyEmailUnsubscribe, verifyUnsubscribeToken } from "@/lib/crm/comms";

// Public unsubscribe. GET never mutates — a valid HMAC token shows a confirm
// form. POST with the same token sets do_not_email / unsubscribed_at and pauses
// active enrollments. Token is HMAC-SHA256 over contactId + expiry.
export const dynamic = "force-dynamic";

function page(message: string, extraHtml = ""): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:Arial,Helvetica,sans-serif;background:#f6f2ea;color:#11294a;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:420px;background:#fff;border:1px solid #e7e0d3;border-radius:14px;padding:32px;text-align:center"><h1 style="font-family:Georgia,serif;font-size:20px;margin:0 0 10px">Growth by the Numbers</h1><p style="font-size:15px;line-height:1.6;color:#3a4252;margin:0">${message}</p>${extraHtml}</div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}

function tokenFrom(req: Request, searchParams: URLSearchParams, form?: FormData | null): string | null {
  return (
    searchParams.get("t") ??
    searchParams.get("token") ??
    (form?.get("t") as string | null) ??
    (form?.get("token") as string | null) ??
    null
  );
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = tokenFrom(req, searchParams);
  const verified = raw ? verifyUnsubscribeToken(raw) : null;
  if (!verified) {
    return page("This unsubscribe link is invalid or has expired. Reply to any email and we will remove you.");
  }
  const confirm = `<form method="post" action="/api/unsubscribe" style="margin-top:22px"><input type="hidden" name="t" value="${raw!.replace(/"/g, "")}"><button type="submit" style="background:#9e2335;color:#f6f2ea;border:0;border-radius:8px;padding:12px 22px;font-size:14px;font-weight:700;cursor:pointer">Confirm unsubscribe</button></form>`;
  return page("Click below to confirm you want to stop receiving marketing emails from us.", confirm);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  let form: FormData | null = null;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("form")) form = await req.formData();
  const raw = tokenFrom(req, url.searchParams, form);
  const verified = raw ? verifyUnsubscribeToken(raw) : null;
  if (!verified) {
    return page("This unsubscribe link is invalid or has expired. Reply to any email and we will remove you.");
  }

  try {
    const db = createAdminClient();
    await applyEmailUnsubscribe(db, verified.contactId);
  } catch {
    return page("We couldn't process your request. Please email us to be removed.");
  }

  return page("You've been unsubscribed. You won't receive further marketing emails from us.");
}
