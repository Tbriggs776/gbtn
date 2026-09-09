# GBTN FP&A Framework

The lenses and benchmarks the FP&A review uses. Mirrors `lib/financials/analysis.ts` and
`lib/financials/metrics.ts` — if those change, change this.

## KPIs (from metrics.ts)
**P&L:** revenue · COGS · gross profit · **gross margin %** · opex · **opex ratio %** · D&A ·
**EBITDA** (= gross profit − opex + other income − other expense) · **EBITDA %** · interest · taxes ·
other-below (e.g. "Ask My Accountant") · **net income** · net margin.
**Balance sheet:** cash · AR · inventory · current assets · fixed/non-current assets · AP ·
current liabilities · long-term liabilities · equity · **working capital** · **current ratio** ·
quick ratio · **debt-to-equity**.
Signed convention: expenses/liabilities positive, credits negative — **sum signed, never abs**.

## Benchmarks (trades / home-services playbook)
| Metric | Target | Flag |
|---|---|---|
| Gross margin | 50%+ (trades 55–70%) | < 40% critical · < 50% warn |
| EBITDA margin | 12–18% | < 5% critical · < 12% warn |
| Opex ratio | 25–35% | > 40% w/ EBITDA < 12% warn |
| Current ratio | 1.5×+ | < 1 critical · < 1.5 warn |
| Working capital | positive | negative critical |
| Debt-to-equity | < 2× | > 4 critical · > 2 warn |
| Revenue trend (MoM) | stable/growing | < −5% warn · > +5% good |
| Gross-margin trend | stable/rising | drop > 2 pts warn |

Business-model nuance (from the client's close profile): normalize where the model distorts a
metric — e.g. deposit-heavy contractors carry large customer deposits that depress the current
ratio; note it rather than alarming the owner.

## The four levers
- **Revenue Growth** — pipeline, pricing, mix, retention.
- **Margin Expansion** — pricing discipline, job costing, direct-cost control, overhead.
- **Team Leverage** — output per labor dollar, overhead efficiency.
- **Cash & Capital** — cash conversion cycle, collections, liquidity, leverage, the 13-week.

## Variance discipline
- Investigate any metric past the client's materiality threshold (else ±10% or >2 margin pts).
- Attribute each move to specific line items/categories (which revenue stream, which cost).
- Separate one-offs from trend; separate volume from rate (price/mix vs quantity).
- Distinguish operating from below-the-line (interest, taxes, other-below don't hit EBITDA).

## Commentary principles
Owner-readable, specific, honest. Lead with the story, not the numbers. End with the 2–3
highest-impact actions, each tied to a lever. No jargon, no hedging, no fabricated figures.
