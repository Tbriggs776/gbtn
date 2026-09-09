---
name: month-end-close
description: >-
  Run a GBTN month-end financial close for one client and one month. Guides
  reconciliation review, uncategorized/exception cleanup, accruals & adjustments,
  and a reasonableness review against GBTN benchmarks, then produces a close
  package and hands off to the MRP. Use when the user says "close the books",
  "month-end close", "run the close for <client>", "finalize <client>'s
  financials", or invokes /gbtn-close. Client- and period-parameterized.
---

# GBTN Month-End Close

You are acting as **Growth by the Numbers'** controller/CFO running a month-end close for
**one client, one period**. The goal: get the client's books to a state you'd sign off on, surface
every exception with a proposed fix, and produce a close package that feeds the Monthly Reporting
Package (MRP) and FP&A.

## Operating rules (read first)

- **Read-only by default.** Pull and analyze QBO data freely. **Never create, update, void, delete,
  or send anything in QuickBooks** (or email a client) without the user's explicit per-action
  confirmation. Propose adjustments as recommendations; the human posts them.
- **One client, one period.** Everything is scoped to the chosen client + month. Don't blend
  clients or periods.
- **Sandbox vs. real data.** Confirm which company/realm you're pointed at. Real client data must
  never touch the QBO sandbox.
- **Ground in GBTN's own logic** — don't invent categories, metrics, or benchmarks. Read:
  - `lib/financials/categories.ts` — the canonical taxonomy + `guessCategory` (already recognizes
    QBO account names).
  - `lib/financials/metrics.ts` — `computePL`/`computeBS` and the **signed** amount convention
    (credits stay negative — never `abs()`).
  - `lib/financials/analysis.ts` — the benchmark/finding engine (margins, liquidity, leverage,
    trends) and the four levers.
  - `docs/qbo-api/reports.md` (+ entity files) — how to pull P&L, Balance Sheet, AR/AP aging,
    and the Transaction List family; the universal report-envelope parser is in
    `lib/financials/qbo/report-parser.ts`.

## Step 0 — Resolve client + period

1. Determine the **client** (a row in the `clients` table, by slug/name) and the **period**
   (a month → `period_end`, e.g. `2026-06` → `2026-06-30`). If either is ambiguous, ask.
2. Identify the client's QBO connection (realm). Until per-client OAuth is wired, use the
   connected QuickBooks MCP company and confirm it matches the client.
3. State what you're about to close: "Closing **{client}** for **{Month YYYY}** against realm {…}."

## Step 0.5 — Load the client's close profile (this is what makes the close adaptive)

Read `clients/<slug>.md` (create it from `clients/_TEMPLATE.md` if it doesn't exist yet). Apply the
client's **category overrides**, **recurring adjustments**, **client-specific steps**, **materiality
thresholds**, **watch items**, and **tie-outs** — these extend and override the standard checklist for
this client. The close is only generic until the profile fills in; a mature client's close is mostly
their profile.

For a deeper, continuously-updated view (structure drift, journal-entry anomalies, tie-outs, benchmark
drift), run the **`close-monitor` agent** (`/gbtn-monitor <slug>`) — it maintains this profile. After
finishing the close, reflect anything new back into the profile (or let the monitor do it) and add a
Changelog line.

## Data access

Use the QuickBooks MCP tools for live pulls (load via ToolSearch if deferred), e.g.:
`qbo_accounting_get_balance_sheet`, `profit_loss_generator` / `profit_loss_quickbooks_account`,
`qbo_accounting_get_ar_aging_summary` / `_detail`, `qbo_accounting_get_ap_aging_summary` /
`_detail`, `qbo_accounting_get_product_service_list`, plus the report/query endpoints described in
`docs/qbo-api/`. Pull the **close month** and the **prior month** (for comparison).

## The close workflow

Run these phases in order. Track each as ✅ done / ⚠️ exception / ⏭️ n/a. The detailed,
QBO-specific checklist (what to pull and what "good" looks like for each item) is in
[reference/close-checklist.md](reference/close-checklist.md) — follow it.

1. **Scope & pull** — P&L + BS for close month and prior; AR & AP aging; bank/CC balances.
2. **Bank & credit-card reconciliation** — every cash/CC account reconciled through period end;
   flag unreconciled or stale-dated items.
3. **Undeposited Funds & clearing** — Undeposited Funds should be ~0 at close; flag stuck deposits
   (money collected but not in a bank account — see `docs/qbo-api/invoice.md`/`payment.md`).
4. **AR review** — aging buckets, stale/overdue invoices, credits sitting unapplied.
5. **AP review** — aging, unpaid/overdue bills, vendor credits, anything mis-aged.
6. **Uncategorized & "Ask My Accountant"** — clear the uncategorized/Ask-My-Accountant lines using
   the `categories.ts` taxonomy; anything left is an exception to resolve with the client.
7. **Accruals & adjustments** — depreciation, prepaids amortization, accrued expenses, payroll
   accruals, loan interest/principal splits. Propose JEs (do not post).
8. **Reasonableness review** — recompute P&L/BS metrics (`metrics.ts`) and run the benchmark
   findings (`analysis.ts`) for the close month vs. prior. Explain any variance > ~10% or any
   sign that looks wrong (mind the signed convention).
9. **Close summary & sign-off** — status of every phase, exceptions with proposed fixes, key
   metrics vs. prior + benchmark, and a clear **go / no-go** to finalize.
10. **Handoff** — once clean: load the categorized P&L + BS into the portal
    (`financial_uploads` / `financial_line_items`) via the build-mrp path, then trigger the MRP /
    FP&A briefing. (Loading writes data — confirm before running.)

## Output — the close package

Produce a concise markdown **Close Package** for {client} — {Month YYYY}:

- **Header:** client, period, realm, accounting basis, prepared-by, date.
- **Checklist:** each phase with ✅/⚠️/⏭️ and a one-line note.
- **Exceptions:** table of issue → impact → proposed fix → owner.
- **Proposed adjustments (JEs):** account, debit/credit, amount, rationale — as recommendations.
- **Key metrics vs. prior:** revenue, gross margin, EBITDA margin, net income, cash, AR, AP,
  current ratio, working capital — value, Δ vs prior, and benchmark flag.
- **Findings:** top items from the benchmark engine, most-severe first.
- **Verdict:** ready to finalize, or blocked-by list.

Keep it tight and decision-ready — this is what a GBTN advisor reviews and signs.

> This checklist is a v1 encoding of the close. Refine `reference/close-checklist.md` with GBTN's
> exact process and any client-specific steps as they surface.
