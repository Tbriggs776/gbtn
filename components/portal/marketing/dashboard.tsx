"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import type { RevenueAgg } from "@/lib/marketing/aggregate";

const COLORS = ["#16335b", "#9e2335", "#9a958c", "#c0b7a6", "#3b6d11", "#b5853a", "#5f5e5a"];

function money(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtDate(s: string): string {
  const [y, m, d] = s.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[Number(m) - 1]} ${Number(d)}, ${y}`;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
        <span className="text-gradient">{value}</span>
      </p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

export function MarketingDashboard({ agg }: { agg: RevenueAgg }) {
  const top = agg.byChannel[0];
  const maxChannelRev = Math.max(...agg.byChannel.map((c) => c.revenue), 1);
  const colorFor = (channel: string) => COLORS[agg.channels.indexOf(channel) % COLORS.length];

  return (
    <div className="space-y-8">
      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Total Revenue" value={money(agg.totalRevenue)} sub={`${agg.byChannel.length} channels`} />
        <Kpi label="Jobs" value={agg.totalJobs.toLocaleString()} sub="attributed rows" />
        <Kpi
          label="Top Channel"
          value={top?.channel ?? "—"}
          sub={top ? `${money(top.revenue)} · ${top.share.toFixed(0)}%` : undefined}
        />
        <Kpi label="Period" value={`${fmtDate(agg.minDate)}`} sub={`through ${fmtDate(agg.maxDate)}`} />
      </div>

      {/* Revenue by channel */}
      <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
        <h3 className="text-base font-bold text-ink">Revenue by channel</h3>
        <div className="mt-4 space-y-3">
          {agg.byChannel.map((c) => (
            <div key={c.channel}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-ink">{c.channel}</span>
                <span className="text-muted">
                  {money(c.revenue)} <span className="text-muted-soft">· {c.share.toFixed(1)}%</span>
                </span>
              </div>
              <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-paper-soft">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(c.revenue / maxChannelRev) * 100}%`,
                    backgroundColor: agg.channels.includes(c.channel)
                      ? colorFor(c.channel)
                      : colorFor("Other"),
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Monthly trend (stacked by channel) */}
      {agg.monthly.length > 1 && (
        <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
          <h3 className="text-base font-bold text-ink">Monthly revenue by channel</h3>
          <div className="mt-4 h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={agg.monthly} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e7e0d3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#5a606b" }} tickLine={false} axisLine={{ stroke: "#e7e0d3" }} />
                <YAxis tick={{ fontSize: 12, fill: "#5a606b" }} tickLine={false} axisLine={false} tickFormatter={(v) => money(Number(v))} width={60} />
                <Tooltip
                  formatter={(value: unknown, name: unknown) => [money(Number(value)), String(name)]}
                  contentStyle={{ borderRadius: 6, border: "1px solid #e7e0d3", fontSize: 13 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {agg.channels.map((ch) => (
                  <Bar key={ch} dataKey={ch} name={ch} stackId="rev" fill={colorFor(ch)} maxBarSize={56} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
