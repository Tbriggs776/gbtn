import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCallRailConfig, syncCallRailCalls } from "@/lib/crm/callrail";

// Daily CallRail → CRM sync. Vercel Cron; protected by CRON_SECRET. No-ops
// quietly if CallRail isn't configured yet.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!(await authorizeCron(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cfg = await getCallRailConfig();
  if (!cfg) return NextResponse.json({ ok: true, skipped: "callrail not configured" });

  const db = createAdminClient();
  try {
    const result = await syncCallRailCalls(db, { sinceDays: 2 });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 }
    );
  }
}
