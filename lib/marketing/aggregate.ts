// Pure aggregation of imported revenue records into dashboard-ready shapes.
// Client-importable (no server-only deps).

export type RevenueRecord = {
  metric_date: string;
  channel: string;
  revenue: number;
  jobs: number;
};

export type ChannelTotal = { channel: string; revenue: number; jobs: number; share: number };
export type MonthRow = { month: string; label: string; total: number } & Record<string, number | string>;

export type RevenueAgg = {
  totalRevenue: number;
  totalJobs: number;
  minDate: string;
  maxDate: string;
  byChannel: ChannelTotal[];
  channels: string[]; // capped set used for the stacked chart (incl. "Other")
  monthly: MonthRow[];
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MAX_CHANNELS = 6;

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export function aggregateRevenue(records: RevenueRecord[]): RevenueAgg | null {
  if (records.length === 0) return null;

  let totalRevenue = 0;
  let totalJobs = 0;
  const channelMap = new Map<string, { revenue: number; jobs: number }>();
  const dates: string[] = [];

  for (const r of records) {
    totalRevenue += r.revenue;
    totalJobs += r.jobs;
    dates.push(r.metric_date);
    const c = channelMap.get(r.channel) ?? { revenue: 0, jobs: 0 };
    c.revenue += r.revenue;
    c.jobs += r.jobs;
    channelMap.set(r.channel, c);
  }

  const byChannel: ChannelTotal[] = [...channelMap.entries()]
    .map(([channel, v]) => ({
      channel,
      revenue: v.revenue,
      jobs: v.jobs,
      share: totalRevenue ? (v.revenue / totalRevenue) * 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Cap channels for the stacked chart; fold the long tail into "Other".
  const top = byChannel.slice(0, MAX_CHANNELS).map((c) => c.channel);
  const hasOther = byChannel.length > MAX_CHANNELS;
  const channels = hasOther ? [...top, "Other"] : top;
  const bucket = (ch: string) => (top.includes(ch) ? ch : "Other");

  // Monthly rows with a column per (capped) channel.
  const monthMap = new Map<string, MonthRow>();
  for (const r of records) {
    const ym = r.metric_date.slice(0, 7);
    let row = monthMap.get(ym);
    if (!row) {
      row = { month: ym, label: monthLabel(ym), total: 0 };
      for (const c of channels) row[c] = 0;
      monthMap.set(ym, row);
    }
    const key = bucket(r.channel);
    row[key] = (row[key] as number) + r.revenue;
    row.total += r.revenue;
  }
  const monthly = [...monthMap.values()].sort((a, b) =>
    a.month < b.month ? -1 : a.month > b.month ? 1 : 0
  );

  const sorted = dates.sort();
  return {
    totalRevenue,
    totalJobs,
    minDate: sorted[0],
    maxDate: sorted[sorted.length - 1],
    byChannel,
    channels,
    monthly,
  };
}
