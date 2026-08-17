import type { FpaReport } from "@/lib/financials/fpa";
import type { BridgeReport } from "@/lib/briefing/bridge";
import { money, percent } from "@/lib/financials/metrics";

// Builds the grounded prompt for the AI CFO briefing. The model writes the
// narrative, but every number it's allowed to use is computed here and handed
// to it as facts — it is told, explicitly, not to invent figures. That's what
// keeps an "AI summary" from drifting away from the books.

const pct = (v: number | null) => (v == null ? "n/a" : percent(v));
const m = (v: number | null | undefined) => (v == null ? "n/a" : money(v));

export const BRIEFING_SYSTEM = `
You are the operator-CFO for a client of Growth by the Numbers, writing a short briefing for the client's owner. You are pragmatic, direct, and numerate — you sound like a CFO who has run the P&L of a growing trades business, not like a chatbot.

Hard rules:
- Use ONLY the figures in the FACTS block. Never invent, estimate, or extrapolate a number that isn't given. If you want to make a point that needs a number you don't have, make the point qualitatively instead.
- Round money the way the facts present it. Don't imply more precision than you're given.
- No preamble, no sign-off, no "as an AI". Start with the single most important thing.
- Plain text only — no markdown headers, no tables, no bullet characters. Short paragraphs a person can read on their phone.

Write three short sections, each 2-4 sentences, separated by a blank line:
1. Where the business stands this month (profitability and the one number that matters most).
2. What's moving and why (the biggest driver behind the trend, from the facts).
3. The one or two things to do next to scale profitably — concrete, tied to the levers in the facts (overhead lines, install throughput/backlog, cash).

Total length: under 220 words. Be specific and useful, not generic.
`.trim();

export function buildBriefingPrompt(fpa: FpaReport, bridge: BridgeReport): string {
  const latest = fpa.kpis[fpa.kpis.length - 1];
  const monthLabel = latest?.label ?? "the latest month";

  // Top SG&A lines by latest-month % of revenue, and the biggest movers.
  const lastIdx = fpa.months.length - 1;
  const sgaLatest = [...fpa.sga]
    .map((l) => ({ label: l.label, pct: l.pctByMonth[lastIdx] }))
    .filter((l) => l.pct != null)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
    .slice(0, 6)
    .map((l) => `  - ${l.label}: ${pct(l.pct)} of revenue`)
    .join("\n");

  const movers = fpa.movers
    .slice(0, 5)
    .map(
      (mv) =>
        `  - ${mv.label} (${mv.group}): ${mv.deltaDollars >= 0 ? "+" : "-"}${m(Math.abs(mv.deltaDollars))} vs prior month` +
        (mv.deltaBps == null ? "" : ` (${mv.deltaBps >= 0 ? "+" : "-"}${Math.abs(Math.round(mv.deltaBps))} bps of revenue)`)
    )
    .join("\n");

  const bridgeFacts = bridge.hasOps
    ? [
        `Ops as of ${bridge.asOf ?? "n/a"} (runs ahead of the closed books).`,
        `Latest month booked (sold) ${m(bridge.latest?.booked)}, installed ${m(bridge.latest?.installed)}; book-to-bill ${bridge.bookToBill?.toFixed(2) ?? "n/a"}.`,
        `Backlog (sold, not yet installed): ${m(bridge.backlog)} — about ${bridge.coverageMonths?.toFixed(1) ?? "n/a"} months of revenue.`,
        `Customer deposits ${m(bridge.latest?.deposits)} cover ${bridge.depositCoverage == null ? "n/a" : percent(bridge.depositCoverage * 100, 0)} of the backlog. CWIP ${m(bridge.latest?.cwip)}.`,
      ].join("\n")
    : "No operations (RFMS) data is linked for this client.";

  return `
FACTS — ${monthLabel}

Profitability (this month):
  - Revenue: ${m(latest?.revenue)}
  - Gross margin: ${pct(latest?.grossMargin)}
  - EBITDA margin: ${pct(latest?.ebitdaMargin)}
  - Operating expense as % of revenue: ${pct(latest?.opexRatio)}
  - Revenue growth vs prior month: ${pct(latest?.revenueGrowth)}

Overhead (SG&A) as % of revenue this month, largest first:
${sgaLatest || "  (none)"}

Biggest month-over-month spend movers:
${movers || "  (none)"}

Operations ↔ financials:
${bridgeFacts}

Write the briefing now, following the rules exactly.
`.trim();
}
