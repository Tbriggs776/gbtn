import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncClient } from "./sync";
import { latestActivity, listConversations } from "./service";
import { generateTeamCoaching } from "./coaching";

// The morning review: for every connected client, refresh the sync and generate
// a team coaching write-up for the DAY PRIOR, cached to ghl_coaching_notes so
// it's waiting on the Coaching tab first thing. Run by the ghl-daily-review cron.
//
// "Day prior" is anchored to the latest activity we hold, not wall-clock now:
// when the server clock runs ahead of the account's real activity, "yesterday"
// would be empty. In a normal deployment latest ≈ now, so this is simply
// yesterday.

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_LOOKBACK_MS = 2 * DAY_MS;

export type DailyReviewResult = {
  clientId: string;
  ok: boolean;
  detail: string;
};

export async function runDailyReviews(): Promise<{
  reviewed: number;
  skipped: number;
  failed: number;
  results: DailyReviewResult[];
}> {
  const admin = createAdminClient();
  const { data: conns } = await admin
    .from("ghl_connections")
    .select("client_id, status");
  const clientIds = (conns ?? [])
    .filter((c) => c.status !== "disconnected")
    .map((c) => c.client_id as string);

  const results: DailyReviewResult[] = [];
  let reviewed = 0;
  let skipped = 0;
  let failed = 0;

  for (const clientId of clientIds) {
    try {
      // 1. Refresh just the last couple of days so the review sees the newest
      //    activity (and any backdated messages). The nightly ghl-sync cron
      //    maintains the full 30-day window; this only needs recency.
      await syncClient(clientId, { since: new Date(Date.now() - SYNC_LOOKBACK_MS) });

      // 2. The prior-day window, anchored to the latest activity we now hold.
      const latest = (await latestActivity(clientId)) ?? new Date();
      const to = latest;
      const from = new Date(to.getTime() - DAY_MS);

      const rows = await listConversations(clientId, from.toISOString(), to.toISOString());
      if (rows.length === 0) {
        skipped++;
        results.push({ clientId, ok: true, detail: "no conversations in the prior day" });
        continue;
      }

      const { data: client } = await admin
        .from("clients")
        .select("name")
        .eq("id", clientId)
        .maybeSingle();

      const result = await generateTeamCoaching({
        clientId,
        clientName: (client?.name as string | undefined) ?? "This client",
        rows,
        periodStart: from.toISOString().slice(0, 10),
        periodEnd: to.toISOString().slice(0, 10),
        generatedBy: null,
      });

      if (result.ok) {
        reviewed++;
        results.push({ clientId, ok: true, detail: `${rows.length} conversations reviewed` });
      } else {
        failed++;
        results.push({ clientId, ok: false, detail: result.message });
      }
    } catch (e) {
      failed++;
      results.push({
        clientId,
        ok: false,
        detail: e instanceof Error ? e.message : "daily review failed",
      });
    }
  }

  return { reviewed, skipped, failed, results };
}
