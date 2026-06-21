import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readConnectionSecret } from "./secrets";
import { fetchCallRailDailyCalls } from "./callrail";

// Runs marketing channel syncs (service-role). Reads vaulted secrets, pulls
// metrics, upserts into marketing_metrics_daily, and records marketing_sync_log.

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

type ConnRow = {
  id: string;
  client_id: string;
  external_account_id: string;
};

// Trailing window so late-attributed calls get picked up on later runs.
const LOOKBACK_DAYS = 7;

export async function syncCallRailConnection(conn: ConnRow): Promise<number> {
  const admin = createAdminClient();
  const { data: log } = await admin
    .from("marketing_sync_log")
    .insert({ client_id: conn.client_id, connection_id: conn.id, provider: "callrail" })
    .select("id")
    .single();

  try {
    const apiKey = await readConnectionSecret(conn.id, "api_key");
    if (!apiKey) throw new Error("No stored API key for this connection.");

    const days = await fetchCallRailDailyCalls(
      apiKey,
      conn.external_account_id,
      isoDaysAgo(LOOKBACK_DAYS),
      isoDaysAgo(0)
    );

    const rows = days.map((d) => ({
      client_id: conn.client_id,
      connection_id: conn.id,
      provider: "callrail" as const,
      metric_date: d.date,
      campaign_id: null,
      phone_calls: d.calls,
      leads: d.leads,
    }));

    let upserted = 0;
    if (rows.length > 0) {
      const { error } = await admin
        .from("marketing_metrics_daily")
        .upsert(rows, { onConflict: "connection_id,metric_date,campaign_id" });
      if (error) throw new Error(error.message);
      upserted = rows.length;
    }

    await admin
      .from("marketing_connections")
      .update({ last_synced_at: new Date().toISOString(), status: "connected" })
      .eq("id", conn.id);

    if (log) {
      await admin
        .from("marketing_sync_log")
        .update({ finished_at: new Date().toISOString(), status: "success", rows_upserted: upserted })
        .eq("id", log.id);
    }
    return upserted;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "sync failed";
    if (log) {
      await admin
        .from("marketing_sync_log")
        .update({ finished_at: new Date().toISOString(), status: "error", error: msg })
        .eq("id", log.id);
    }
    throw new Error(msg);
  }
}

// Sync every connected CallRail account (the daily cron entrypoint).
export async function syncAllCallRail(): Promise<{
  connections: number;
  rows: number;
  errors: number;
}> {
  const admin = createAdminClient();
  const { data: conns } = await admin
    .from("marketing_connections")
    .select("id, client_id, external_account_id")
    .eq("provider", "callrail")
    .eq("status", "connected");

  let rows = 0;
  let errors = 0;
  for (const c of (conns ?? []) as ConnRow[]) {
    try {
      rows += await syncCallRailConnection(c);
    } catch {
      errors += 1;
    }
  }
  return { connections: (conns ?? []).length, rows, errors };
}

// Sync just one client's connections (the manual "Sync now" button).
export async function syncClientConnections(
  clientId: string
): Promise<{ rows: number; errors: number }> {
  const admin = createAdminClient();
  const { data: conns } = await admin
    .from("marketing_connections")
    .select("id, client_id, external_account_id, provider")
    .eq("client_id", clientId)
    .eq("status", "connected");

  let rows = 0;
  let errors = 0;
  for (const c of conns ?? []) {
    if (c.provider !== "callrail") continue; // OAuth providers added later
    try {
      rows += await syncCallRailConnection(c as ConnRow);
    } catch {
      errors += 1;
    }
  }
  return { rows, errors };
}
