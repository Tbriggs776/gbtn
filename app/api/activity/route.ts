import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Records a portal page view for the signed-in user (RLS: insert-self only).
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  let body: { path?: unknown; clientId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const path = typeof body.path === "string" ? body.path.slice(0, 200) : "";
  const clientId =
    typeof body.clientId === "string" && body.clientId ? body.clientId : null;
  if (!path.startsWith("/portal")) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  await supabase.from("activity_events").insert({
    user_id: user.id,
    path,
    client_id: clientId,
  });
  return NextResponse.json({ ok: true });
}
