import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processDrips, processScheduledBlasts } from "@/lib/crm/campaign-engine";
import { processTaskReminders } from "@/lib/crm/comms";

// CRM background engine: advance drip sequences, fire scheduled blasts, and send
// due task reminders. Vercel Cron; protected by CRON_SECRET (fail-closed).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const [drips, blasts, reminders] = await Promise.all([
    processDrips(db).catch((e) => ({ processed: -1, error: String(e) })),
    processScheduledBlasts(db).catch((e) => ({ fired: -1, error: String(e) })),
    processTaskReminders(db).catch(() => -1),
  ]);

  return NextResponse.json({ ok: true, drips, blasts, reminders });
}
