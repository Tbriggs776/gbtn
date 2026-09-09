# Close Profile — {Client Name} (`{slug}`)

> How **this client** closes. Read by the `month-end-close` skill; maintained by the
> `close-monitor` agent. Keep entries specific and actionable. Every change gets a Changelog line.

- **QBO realm:** {realmId}
- **Accounting basis:** {Cash|Accrual}
- **Fiscal year end:** {MM-DD}
- **Profile owner:** {advisor} · **Last reviewed:** {YYYY-MM-DD}

## Business model & context
{1–3 lines: what they do, revenue model, anything that shapes the books — deposit-heavy,
project-based, multi-entity, etc.}

## Category overrides
Client-specific account → GBTN category mappings that differ from `guessCategory`. Only list
exceptions; everything else uses the default heuristic.
| QBO account | GBTN category | Note |
|---|---|---|
| {account} | {category} | {why} |

## Recurring adjustments (expected every close)
| Item | Type | Cadence | Est. amount | Source |
|---|---|---|---|---|
| {e.g. Depreciation} | JE | monthly | {amt} | {fixed-asset schedule} |

## Client-specific close steps (beyond the standard checklist)
1. {extra step unique to this client}

## Materiality & thresholds
- Variance to investigate: {default ±10% MoM or $X}
- Benchmark overrides (if any): {e.g. GM target, otherwise GBTN playbook}

## Watch items (recurring exceptions / known issues)
| Item | Why it matters | Last observed | Status |
|---|---|---|---|
| {issue} | {impact} | {YYYY-MM-DD: value} | {open/monitoring/resolved} |

## Tie-outs (must reconcile each close)
- AP aging ↔ BS Accounts Payable
- AR aging ↔ BS Accounts Receivable
- {client-specific tie-outs, e.g. Customer Deposits ↔ open jobs / CWIP}

## Changelog
- {YYYY-MM-DD} — {what changed} — {by: human|close-monitor}
