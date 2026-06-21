import { NextResponse } from "next/server";
import { syncAllCallRail } from "@/lib/marketing/sync";

// Daily marketing sync (Vercel Cron). Protected by CRON_SECRET: Vercel sends it
// as `Authorization: Bearer <CRON_SECRET>` when the env var is set.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
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
