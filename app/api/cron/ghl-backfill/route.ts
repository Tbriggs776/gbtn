import { NextResponse } from "next/server";
import { runBackfillSweep } from "@/lib/ghl/sync";

// High-frequency GoHighLevel backfill sweep (Vercel Cron, every 10 minutes).
//
// Builds the rolling window to completion without anyone clicking Sync: each
// tick advances the resumable backfill for any client that isn't fully built
// yet, then goes idle once every client's window is complete (the nightly
// ghl-sync cron maintains it from there). Protected by CRON_SECRET, same as the
// other cron routes.
export const dynamic = "force-dynamic";
// A single sweep is budgeted to ~270s internally (SWEEP_BUDGET_MS); give the
// function the full 300s so it can finish the in-flight write before returning.
export const maxDuration = 300;

export async function GET(req: Request) {
  // Fail CLOSED: a missing secret must not become "no auth required", or anyone
  // could trigger outbound GHL calls and service-role writes on demand.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBackfillSweep();
    // 200 even when individual clients failed: the job ran. Per-client failures
    // are in the body and on each connection's last_sync_error.
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "backfill sweep failed" },
      { status: 500 }
    );
  }
}
