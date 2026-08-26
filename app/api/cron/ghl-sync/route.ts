import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron-auth";
import { syncAllClients } from "@/lib/ghl/sync";

// Nightly GoHighLevel conversation sync (Vercel Cron). Protected by CRON_SECRET:
// Vercel sends it as `Authorization: Bearer <CRON_SECRET>` when the env var set.
export const dynamic = "force-dynamic";
// A rolling 14-day window across a handful of clients — comfortably inside 60s
// for normal volumes. The first YEAR-to-date backfill is run by hand from the
// Conversations tab, precisely because it wouldn't fit here.
export const maxDuration = 300;

export async function GET(req: Request) {
  // Fail CLOSED: only a matching Vercel env or DB-held cron secret authorizes;
  // without either, nothing can trigger outbound GHL calls or service-role writes.
  if (!(await authorizeCron(req))) {
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
