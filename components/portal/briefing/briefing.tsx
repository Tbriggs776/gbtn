"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import type { BridgeReport } from "@/lib/briefing/bridge";
import { money, percent } from "@/lib/financials/metrics";

const BOOKED = "#11294a"; // navy — sold
const INSTALLED = "#b3761e"; // amber — delivered
const RECOG = "#9e2335"; // crimson — recognized
const MUTED = "#9a958c";

const short = (label: string) => label.split(" ")[0];
const mo = (n: number) => `$${(n / 1000).toFixed(0)}K`;

function Signal({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "good" }) {
  const color = tone === "warn" ? "#b3313f" : tone === "good" ? "#2f6b4f" : undefined;
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight" style={color ? { color } : undefined}>
        <span className={color ? "" : "text-gradient"}>{value}</span>
      </p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function Panel({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-bold text-ink">{title}</h3>
        {caption ? <p className="text-xs text-muted-soft">{caption}</p> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const tipStyle = { borderRadius: 12, border: "1px solid #e7e2d9", fontSize: 12 } as const;
// recharts' Formatter passes a broad ValueType; coerce to a number for money().
const moneyFmt = (v: unknown) => money(Number(v) || 0);

export function Briefing({
  report,
  opsAsOf,
  finThrough,
}: {
  report: BridgeReport;
  opsAsOf: string | null;
  finThrough: string | null;
}) {
  const { months, forward, latest } = report;

  // ── Deterministic headline read (the AI narrative layer will expand this) ──
  const read: string[] = [];
  if (report.bookToBill != null) {
    read.push(
      report.bookToBill >= 1.05
        ? `You're selling faster than you're installing — book-to-bill of ${report.bookToBill.toFixed(2)} means backlog is building.`
        : report.bookToBill <= 0.95
          ? `You're installing faster than you're selling — book-to-bill of ${report.bookToBill.toFixed(2)} means backlog is drawing down; watch intake.`
          : `Booked and installed are roughly in balance (book-to-bill ${report.bookToBill.toFixed(2)}).`
    );
  }
  if (report.backlog > 0 && report.coverageMonths != null) {
    read.push(
      `Scheduled installs after ${opsAsOf ?? "the snapshot"} total ${money(report.backlog)} — about ${report.coverageMonths.toFixed(1)} month${report.coverageMonths >= 1.5 ? "s" : ""} of revenue already sold.`
    );
  }
  if (report.depositCoverage != null) {
    read.push(
      report.depositCoverage >= 1
        ? `Customer deposits cover ${percent(report.depositCoverage * 100, 0)} of that backlog — the pipeline is fully cash-funded.`
        : `Customer deposits cover ${percent(report.depositCoverage * 100, 0)} of that backlog — the rest is financed until it installs.`
    );
  }

  const flowData = months.map((m) => ({
    name: short(m.label),
    booked: m.booked,
    installed: m.installed,
    recognized: m.recognized ?? 0,
  }));

  const marginData = months.map((m) => ({
    name: short(m.label),
    installed: m.installed,
    gm: m.grossMargin,
  }));

  const cashData = latest
    ? [
        { name: "Backlog", value: report.backlog, fill: INSTALLED },
        { name: "Cust. deposits", value: latest.deposits ?? 0, fill: BOOKED },
        { name: "CWIP", value: latest.cwip ?? 0, fill: MUTED },
      ]
    : [];

  return (
    <div className="space-y-8">
      {/* Two clocks */}
      <p className="text-xs text-muted-soft">
        Operations as of <span className="font-semibold text-muted">{opsAsOf ?? "—"}</span> · financials
        through <span className="font-semibold text-muted">{finThrough ?? "—"}</span>. Ops runs ahead of the
        closed books — the gap is the pipeline not yet recognized.
      </p>

      {/* Headline signals */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Signal
          label="Book-to-bill"
          value={report.bookToBill != null ? report.bookToBill.toFixed(2) : "—"}
          sub={latest ? `${short(latest.label)}: sold ${mo(latest.booked)} · installed ${mo(latest.installed)}` : undefined}
          tone={report.bookToBill != null && report.bookToBill >= 1.05 ? "good" : undefined}
        />
        <Signal
          label="Backlog (sold, not installed)"
          value={money(report.backlog)}
          sub={report.coverageMonths != null ? `${report.coverageMonths.toFixed(1)} months of revenue` : undefined}
        />
        <Signal
          label="Deposit coverage of backlog"
          value={report.depositCoverage != null ? percent(report.depositCoverage * 100, 0) : "—"}
          sub={latest?.deposits != null ? `${money(latest.deposits)} on deposit` : undefined}
          tone={report.depositCoverage != null && report.depositCoverage >= 1 ? "good" : "warn"}
        />
        <Signal
          label="Recognized revenue"
          value={latest?.recognized != null ? money(latest.recognized) : "—"}
          sub={latest ? `${short(latest.label)} · ${latest.grossMargin != null ? percent(latest.grossMargin) + " GM" : ""}` : undefined}
        />
      </div>

      {read.length > 0 ? (
        <div className="rounded-2xl border border-line bg-paper-soft/40 p-5 ring-soft">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">The read</p>
          <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink">{read.join(" ")}</p>
        </div>
      ) : null}

      {/* 1 — Booked vs installed vs recognized */}
      <Panel title="Booked → installed → recognized" caption="what was sold, delivered, and put on the books, by month">
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={flowData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee7db" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={mo} tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} width={44} />
              <Tooltip contentStyle={tipStyle} formatter={moneyFmt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="booked" name="Booked (sold)" fill={BOOKED} radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="installed" name="Installed" fill={INSTALLED} radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Line dataKey="recognized" name="Recognized (P&L)" stroke={RECOG} strokeWidth={2.2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-soft">
          Booked is RFMS order value by order date; installed is order value by install date; recognized is P&L
          revenue. Installed tracking recognized within ~10% is what makes the install schedule a usable revenue signal.
        </p>
      </Panel>

      {/* 2 — Backlog / forward coverage */}
      {forward.length > 0 ? (
        <Panel title="Backlog → forward coverage" caption={`installs scheduled after ${opsAsOf ?? "today"}`}>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={forward.map((f) => ({ name: short(f.label), installed: f.installed }))} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee7db" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={mo} tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} width={44} />
                <Tooltip contentStyle={tipStyle} formatter={moneyFmt} />
                <Bar dataKey="installed" name="Scheduled installs" fill={INSTALLED} radius={[3, 3, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-soft">
            {money(report.backlog)} of work is sold and scheduled but not yet installed —
            {report.coverageMonths != null ? ` about ${report.coverageMonths.toFixed(1)} months at your ${money(report.avgRecognized ?? 0)} average.` : ""}
            {" "}This is the leading edge of next month&apos;s revenue.
          </p>
        </Panel>
      ) : null}

      {/* 3 — Install throughput vs margin */}
      <Panel title="Install throughput vs margin" caption="does more volume convert to profit?">
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={marginData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee7db" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="d" tickFormatter={mo} tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} width={44} />
              <YAxis yAxisId="p" orientation="right" tickFormatter={(v) => `${v}%`} domain={[0, "auto"]} tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} width={40} />
              <Tooltip contentStyle={tipStyle} formatter={(v: unknown, n: unknown) => (n === "Gross margin" ? `${Number(v).toFixed(1)}%` : money(Number(v) || 0))} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="d" dataKey="installed" name="Installed $" fill={INSTALLED} radius={[3, 3, 0, 0]} maxBarSize={34} />
              <Line yAxisId="p" dataKey="gm" name="Gross margin" stroke={BOOKED} strokeWidth={2.2} dot={{ r: 3 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-soft">
          If install volume rises while the margin line holds or climbs, growth is profitable. If margin dips as
          volume climbs, you&apos;re buying revenue — the thing to catch before scaling.
        </p>
      </Panel>

      {/* 4 — Cash mechanics */}
      {cashData.length > 0 ? (
        <Panel title="Cash mechanics" caption={`backlog vs the cash already collected · ${finThrough ?? ""}`}>
          <div className="h-52 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cashData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee7db" horizontal={false} />
                <XAxis type="number" tickFormatter={mo} tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: "#33302b" }} axisLine={false} tickLine={false} width={110} />
                <Tooltip contentStyle={tipStyle} formatter={moneyFmt} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={30} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-soft">
            {report.depositCoverage != null && report.depositCoverage >= 1
              ? "Deposits exceed the backlog — customers have pre-funded the scheduled work, so growth isn't leaning on the balance sheet."
              : "Deposits are below the backlog — the uncovered portion is carried on credit and receivables until it installs and bills."}
            {" "}CWIP is work started but not yet closed to revenue.
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
