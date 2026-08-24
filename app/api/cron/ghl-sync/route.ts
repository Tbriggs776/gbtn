import { NextResponse } from "next/server";
import { syncAllClients } from "@/lib/ghl/sync";

// Nightly GoHighLevel conversation sync (Vercel Cron). Protected by CRON_SECRET:
// Vercel sends it as `Authorization: Bearer <CRON_SECRET>` when the env var set.
export const dynamic = "force-dynamic";
// A rolling 14-day window across a handful of clients — comfortably inside 60s
// for normal volumes. The first YEAR-to-date backfill is run by hand from the
// Conversations tab, precisely because it wouldn't fit here.
export const maxDuration = 60;

export async function GET(req: Request) {
  // Fail CLOSED: treating a missing secret as "no auth required" would let
  // anyone trigger outbound GHL calls and service-role writes on demand.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncAllClients();
    // 200 even when individual clients failed: the job itself ran. Per-client
    // failures are in the body and on each connection's last_sync_error, where
    // the portal surfaces them.
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 }
    );
  }
}
