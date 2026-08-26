"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HourStats, MonthStats, RepStats, SourceStats, Summary } from "@/lib/ghl/metrics";
import { SOURCE_COLOR, SOURCE_LABEL, duration, hourLabel, monthLabel, percent, share } from "@/lib/ghl/format";
import { Panel, Td, Th, Tile } from "./shared";

export function Overview({
  summary,
  months,
  hours,
  sources,
  reps,
  businessHours,
}: {
  summary: Summary;
  months: MonthStats[];
  hours: HourStats[];
  sources: SourceStats[];
  reps: RepStats[];
  /** Local open/close per weekday, for shading the arrival chart. */
  businessHours: { open: number; close: number };
}) {
  const monthData = months.map((m) => ({
    ...m,
    label: monthLabel(m.month),
    // Charted in minutes: seconds makes the axis unreadable, and hours flattens
    // every month onto the same value.
    medianMinutes: m.medianResponse === null ? null : Math.round(m.medianResponse / 60),
  }));

  const hourData = hours.map((h) => ({ ...h, label: hourLabel(h.hour) }));
  const peakAfterHours = hourData
    .filter((h) => h.hour < businessHours.open || h.hour >= businessHours.close)
    .reduce((best, h) => (h.leads > best.leads ? h : best), { hour: -1, leads: 0, unanswered: 0, label: "" });

  return (
    <div className="space-y-5">
      {/* ── Headline ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label="Leads" value={summary.leads.toLocaleString()} sub="Someone wrote in" />
        <Tile
          label="Answered"
          value={percent(summary.answerRate)}
          sub={`${summary.answered.toLocaleString()} by a person`}
        />
        <Tile
          label="Never answered"
          value={summary.unanswered.toLocaleString()}
          sub={share(summary.unanswered, summary.leads) + " of leads"}
          flag={summary.unanswered > 0}
        />
        <Tile
          label="Auto-reply only"
          value={summary.autoRepliedOnly.toLocaleString()}
          sub="Look handled in GHL; aren't"
          flag={summary.autoRepliedOnly > 0}
        />
        <Tile
          label="Median reply"
          value={duration(summary.medianResponse)}
          sub={`${duration(summary.medianBusinessResponse)} in open hours`}
        />
        <Tile
          label="Inside 5 min"
          value={percent(summary.fastRate)}
          sub={`${summary.withinFive.toLocaleString()} of ${summary.answered.toLocaleString()} answered`}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* ── Trend ── */}
        <Panel
          title="Month by month"
          hint="Bars are leads that arrived; the line is the median time to a human reply, in minutes."
        >
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={monthData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#eceae6" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="l" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={38} />
                <YAxis
                  yAxisId="r"
                  orientation="right"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  unit="m"
                />
                <Tooltip
                  formatter={(value, name) =>
                    name === "Median reply" ? [`${value} min`, name] : [value, name]
                  }
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e2dd" }}
                />
                <Bar yAxisId="l" dataKey="leads" name="Leads" fill="#2f6ea8" radius={[3, 3, 0, 0]} />
                <Bar
                  yAxisId="l"
                  dataKey="unanswered"
                  name="Never answered"
                  fill="#b3313f"
                  radius={[3, 3, 0, 0]}
                />
                <Line
                  yAxisId="r"
                  type="monotone"
                  dataKey="medianMinutes"
                  name="Median reply"
                  stroke="#1f2937"
                  strokeWidth={2}
                  dot={{ r: 2.5 }}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* ── Arrival clock ── */}
        <Panel
          title="When leads arrive"
          hint={`Local time. The shaded band is the showroom's weekday opening hours — anything outside it needs a rota answer, not a coaching one.`}
        >
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#eceae6" vertical={false} />
                <ReferenceArea
                  x1={hourLabel(businessHours.open)}
                  x2={hourLabel(businessHours.close - 1)}
                  fill="#2f7d57"
                  fillOpacity={0.07}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval={1}
                />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={34} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e2dd" }} />
                <Bar dataKey="leads" name="Leads" radius={[3, 3, 0, 0]}>
                  {hourData.map((h) => (
                    <Cell
                      key={h.hour}
                      fill={
                        h.hour < businessHours.open || h.hour >= businessHours.close
                          ? "#b3761e"
                          : "#2f6ea8"
                      }
                    />
                  ))}
                </Bar>
                <Bar dataKey="unanswered" name="Never answered" fill="#b3313f" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-soft">
            <span className="font-semibold text-muted">
              {summary.afterHoursLeads.toLocaleString()} leads
            </span>{" "}
            ({share(summary.afterHoursLeads, summary.leads)}) landed outside opening hours
            {peakAfterHours.hour >= 0 && peakAfterHours.leads > 0 ? (
              <>
                , the busiest closed hour being{" "}
                <span className="font-semibold text-muted">{peakAfterHours.label}</span>
              </>
            ) : null}
            .
          </p>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* ── Sources ── */}
        <Panel
          title="By source"
          hint="Which door each lead came in — text, call, chat, email, or a form/ad lead with no message. Where they come in, and where they go quiet."
        >
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Source</Th>
                <Th right>Leads</Th>
                <Th right>Never answered</Th>
                <Th right>Median reply</Th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source}>
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-sm"
                        style={{ backgroundColor: SOURCE_COLOR[s.source] }}
                      />
                      {SOURCE_LABEL[s.source]}
                    </span>
                  </Td>
                  <Td right>{s.leads.toLocaleString()}</Td>
                  <Td right flag={s.unanswered > 0}>
                    {s.unanswered.toLocaleString()}{" "}
                    <span className="text-muted-soft">({share(s.unanswered, s.leads)})</span>
                  </Td>
                  {/* Form/ad leads carry no transcript, so there's no reply clock. */}
                  <Td right>{s.source === "form" ? "—" : duration(s.medianResponse)}</Td>
                </tr>
              ))}
              {sources.length === 0 ? (
                <tr>
                  <Td>No leads in this period.</Td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>

        {/* ── Rep leaderboard ── */}
        <Panel
          title="By salesperson"
          hint="Busiest first. Unassigned threads are shown, not hidden — they're usually the worst ones."
        >
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Salesperson</Th>
                <Th right>Leads</Th>
                <Th right>Answered</Th>
                <Th right>Median</Th>
                <Th right>&lt;5 min</Th>
              </tr>
            </thead>
            <tbody>
              {reps.slice(0, 10).map((r) => (
                <tr key={r.rep}>
                  <Td>{r.rep}</Td>
                  <Td right>{r.leads.toLocaleString()}</Td>
                  <Td right flag={r.answerRate < 0.8}>
                    {percent(r.answerRate)}
                  </Td>
                  <Td right>{duration(r.medianResponse)}</Td>
                  <Td right>{percent(r.fastRate)}</Td>
                </tr>
              ))}
              {reps.length === 0 ? (
                <tr>
                  <Td>No leads in this period.</Td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
