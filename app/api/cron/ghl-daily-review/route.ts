import { NextResponse } from "next/server";
import { runDailyReviews } from "@/lib/ghl/daily-review";

// Morning GoHighLevel review (Vercel Cron). Scheduled for 8am America/Phoenix
// (MST = UTC−7, no DST) → 15:00 UTC. Syncs each connected client and generates
// a team coaching write-up for the day prior, cached to the Coaching tab.
// Protected by CRON_SECRET.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runDailyReviews();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "daily review failed" },
      { status: 500 }
    );
  }
}
