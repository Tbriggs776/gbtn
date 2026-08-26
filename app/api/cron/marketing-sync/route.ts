import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron-auth";
import { syncAllCallRail } from "@/lib/marketing/sync";

// Daily marketing sync (Vercel Cron). Protected by CRON_SECRET: Vercel sends it
// as `Authorization: Bearer <CRON_SECRET>` when the env var is set.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // Fail CLOSED: only a matching Vercel env or DB-held cron secret authorizes;
  // without either, nothing can trigger outbound calls or service-role writes.
  if (!(await authorizeCron(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncAllCallRail();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 }
    );
  }
}
