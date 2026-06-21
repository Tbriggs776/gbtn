import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RevenueImport } from "./revenue-import";

export type RevenueRecord = {
  metric_date: string;
  channel: string;
  revenue: number;
  jobs: number;
};

export async function listRevenue(clientId: string): Promise<RevenueRecord[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("marketing_revenue_daily")
    .select("metric_date, channel, revenue, jobs")
    .eq("client_id", clientId)
    .order("metric_date", { ascending: true });
  return (data ?? []).map((r) => ({
    metric_date: r.metric_date as string,
    channel: r.channel as string,
    revenue: Number(r.revenue),
    jobs: Number(r.jobs),
  }));
}

// The uploaded file is authoritative for the date range it covers: clear that
// window, then insert the fresh rows.
export async function loadRevenueImport(
  clientId: string,
  parsed: RevenueImport
): Promise<number> {
  const admin = createAdminClient();
  await admin
    .from("marketing_revenue_daily")
    .delete()
    .eq("client_id", clientId)
    .gte("metric_date", parsed.minDate)
    .lte("metric_date", parsed.maxDate);

  const rows = parsed.rows.map((r) => ({
    client_id: clientId,
    metric_date: r.date,
    channel: r.channel,
    revenue: r.revenue,
    jobs: r.jobs,
  }));

  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await admin
      .from("marketing_revenue_daily")
      .insert(rows.slice(i, i + 1000));
    if (error) throw new Error(error.message);
  }
  return rows.length;
}
