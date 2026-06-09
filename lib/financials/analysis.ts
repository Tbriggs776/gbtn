// Deterministic "top areas for improvement" engine. Benchmarks are drawn from
// the Growth by the Numbers playbook (home-services / trades operating ranges).
// Pure + testable; later swappable for an LLM narrative layer.

import type { Period } from "./metrics";
import { money, percent, ratio } from "./metrics";

export type Severity = "critical" | "warn" | "good";
export type Lever =
  | "Revenue Growth"
  | "Margin Expansion"
  | "Team Leverage"
  | "Cash & Capital";

export type Finding = {
  id: string;
  severity: Severity;
  title: string;
  current: string;
  target: string;
  body: string;
  lever: Lever;
};

const RANK: Record<Severity, number> = { critical: 0, warn: 1, good: 2 };

export function analyze(periods: Period[]): Finding[] {
  const findings: Finding[] = [];
  if (periods.length === 0) return findings;

  const latest = periods[periods.length - 1];
  const prev = periods.length > 1 ? periods[periods.length - 2] : null;
  const pl = latest.pl;
  const bs = latest.bs;

  // ── Margin: gross ──────────────────────────────────────────────────────────
  if (pl && pl.grossMargin != null && pl.revenue > 0) {
    const gm = pl.grossMargin;
    if (gm < 40) {
      findings.push({
        id: "gross-margin",
        severity: "critical",
        title: "Gross margin is well below a healthy range",
        current: percent(gm),
        target: "50%+ (trades 55–70%)",
        body: "Direct costs are eating too much of every dollar. Audit pricing, job costing, labor utilization, and material waste — this is usually the single biggest margin lever.",
        lever: "Margin Expansion",
      });
    } else if (gm < 50) {
      findings.push({
        id: "gross-margin",
        severity: "warn",
        title: "Gross margin has room to expand",
        current: percent(gm),
        target: "50%+ (trades 55–70%)",
        body: "A few points of gross margin drop straight to EBITDA. Tighten pricing discipline and direct-cost control before adding overhead.",
        lever: "Margin Expansion",
      });
    } else {
      findings.push({
        id: "gross-margin",
        severity: "good",
        title: "Gross margin is in a healthy range",
        current: percent(gm),
        target: "50%+",
        body: "Direct-cost discipline is working. Protect it as you scale.",
        lever: "Margin Expansion",
      });
    }
  }

  // ── Margin: EBITDA ─────────────────────────────────────────────────────────
  if (pl && pl.ebitdaMargin != null && pl.revenue > 0) {
    const em = pl.ebitdaMargin;
    if (em < 5) {
      findings.push({
        id: "ebitda-margin",
        severity: "critical",
        title: "EBITDA margin is critically thin",
        current: percent(em),
        target: "12–18%",
        body: "There's little cushion for reinvestment, debt service, or a downturn. Attack overhead and pricing together — small moves compound fast at this level.",
        lever: "Margin Expansion",
      });
    } else if (em < 12) {
      findings.push({
        id: "ebitda-margin",
        severity: "warn",
        title: "EBITDA margin is below target",
        current: percent(em),
        target: "12–18%",
        body: "You're profitable but under-earning for the revenue. Map the gap between gross margin and EBITDA — the leak is in overhead.",
        lever: "Margin Expansion",
      });
    } else {
      findings.push({
        id: "ebitda-margin",
        severity: "good",
        title: "EBITDA margin is healthy",
        current: percent(em),
        target: "12–18%",
        body: "Strong operating profitability. Reinvest deliberately and keep the discipline.",
        lever: "Margin Expansion",
      });
    }
  }

  // ── Overhead load ──────────────────────────────────────────────────────────
  if (
    pl &&
    pl.opexRatio != null &&
    pl.ebitdaMargin != null &&
    pl.opexRatio > 40 &&
    pl.ebitdaMargin < 12
  ) {
    findings.push({
      id: "opex-ratio",
      severity: "warn",
      title: "Overhead is carrying too much of revenue",
      current: `${percent(pl.opexRatio)} of revenue`,
      target: "Trim toward 25–35%",
      body: "Operating expense is outpacing the value it creates. Zero-base the overhead line and tie each cost to an outcome.",
      lever: "Team Leverage",
    });
  }

  // ── Liquidity ──────────────────────────────────────────────────────────────
  if (bs && bs.currentRatio != null && bs.currentLiabilities > 0) {
    const cr = bs.currentRatio;
    if (cr < 1) {
      findings.push({
        id: "current-ratio",
        severity: "critical",
        title: "Current liabilities exceed current assets",
        current: ratio(cr),
        target: "1.5×+",
        body: "Short-term obligations outweigh short-term assets — a cash crunch risk. Build a 13-week cash forecast and prioritize collections and payment terms.",
        lever: "Cash & Capital",
      });
    } else if (cr < 1.5) {
      findings.push({
        id: "current-ratio",
        severity: "warn",
        title: "Liquidity cushion is thin",
        current: ratio(cr),
        target: "1.5×+",
        body: "There's limited buffer if revenue dips or a big payable lands. Tighten the cash conversion cycle.",
        lever: "Cash & Capital",
      });
    }
  }

  if (bs && bs.workingCapital < 0) {
    findings.push({
      id: "working-capital",
      severity: "critical",
      title: "Working capital is negative",
      current: money(bs.workingCapital),
      target: "Positive",
      body: "You're funding operations on the backs of suppliers and short-term debt. A cash war-room cadence stabilizes this fast.",
      lever: "Cash & Capital",
    });
  }

  // ── Leverage ───────────────────────────────────────────────────────────────
  if (bs && bs.debtToEquity != null && bs.equity > 0) {
    const de = bs.debtToEquity;
    if (de > 4) {
      findings.push({
        id: "debt-equity",
        severity: "critical",
        title: "Leverage is very high",
        current: ratio(de),
        target: "Below 2×",
        body: "Debt dwarfs equity. Covenant and refinancing risk is real — model the runway and build a deleveraging plan.",
        lever: "Cash & Capital",
      });
    } else if (de > 2) {
      findings.push({
        id: "debt-equity",
        severity: "warn",
        title: "Leverage is elevated",
        current: ratio(de),
        target: "Below 2×",
        body: "Manageable but worth watching. Keep covenant headroom and a cash forecast in view.",
        lever: "Cash & Capital",
      });
    }
  }

  // ── Revenue trend ──────────────────────────────────────────────────────────
  if (pl && prev?.pl && prev.pl.revenue > 0) {
    const change = ((pl.revenue - prev.pl.revenue) / prev.pl.revenue) * 100;
    if (change < -5) {
      findings.push({
        id: "revenue-trend",
        severity: "warn",
        title: "Revenue declined versus the prior period",
        current: `${change.toFixed(1)}%`,
        target: "Stable or growing",
        body: "Check pipeline and booked work 4–6 weeks out — revenue softness shows up there first. Confirm it's not a mix or seasonality artifact.",
        lever: "Revenue Growth",
      });
    } else if (change > 5) {
      findings.push({
        id: "revenue-trend",
        severity: "good",
        title: "Revenue is growing",
        current: `+${change.toFixed(1)}%`,
        target: "Stable or growing",
        body: "Momentum is real. Make sure the growth is profitable and your systems can carry it without breaking margin.",
        lever: "Revenue Growth",
      });
    }
  }

  // ── Gross-margin trend ─────────────────────────────────────────────────────
  if (
    pl?.grossMargin != null &&
    prev?.pl?.grossMargin != null &&
    pl.grossMargin - prev.pl.grossMargin < -2
  ) {
    findings.push({
      id: "gm-trend",
      severity: "warn",
      title: "Gross margin is slipping",
      current: `${(pl.grossMargin - prev.pl.grossMargin).toFixed(1)} pts`,
      target: "Stable or rising",
      body: "Margin erosion usually means labor, materials, mix, or pricing moved against you. Find which one before it compounds.",
      lever: "Margin Expansion",
    });
  }

  return findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
