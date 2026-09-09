# GBTN Month-End Close — Detailed Checklist

Per client, per period. For each item: what to pull from QBO, what "good" looks like, and the
exception to raise otherwise. Pull the **close month** and the **prior month** for comparison.
Amounts follow the signed convention in `lib/financials/metrics.ts` (credits negative — never abs).

## 1. Scope & pull
- [ ] Confirm client + `period_end` + realm + accounting basis (Cash vs Accrual — match the books).
- [ ] P&L (close month) and P&L (prior month) — `profit_loss_generator` or the `ProfitAndLoss`
      report; for the full year use `summarize_column_by=Month`.
- [ ] Balance Sheet (as of `period_end`) and prior month-end — `qbo_accounting_get_balance_sheet`.
- [ ] AR aging (`AgedReceivables`) and AP aging (`AgedPayables`) as of `period_end`.
- [ ] Bank/CC account balances (Balance Sheet `BankAccounts` group + credit-card accounts).

## 2. Bank & credit-card reconciliation
- [ ] Every `Bank` and `CreditCard` account reconciled through `period_end`.
- [ ] Book balance ties to the reconciled/statement balance.
- ⚠️ Unreconciled accounts, stale uncleared transactions, or a book-vs-statement gap.

## 3. Undeposited Funds & clearing accounts
- [ ] Undeposited Funds ≈ $0 at close (all collected payments deposited to a bank account).
- [ ] Other clearing/suspense accounts near zero.
- ⚠️ Money stuck in Undeposited Funds = collected but not in the bank; distorts cash position.

## 4. Accounts Receivable
- [ ] AR aging reviewed; total ties to the BS AR control account.
- [ ] Overdue/stale invoices (61-90, 90+) flagged for collections.
- [ ] Unapplied customer payments / credits reviewed (`payments.UnappliedAmt`).
- ⚠️ Large or growing 90+ bucket; credits that should be applied; AR that doesn't tie to the BS.

## 5. Accounts Payable
- [ ] AP aging reviewed; total ties to the BS AP control account.
- [ ] Overdue bills flagged; vendor credits reviewed.
- [ ] Credit-card-funded bills understood (defer real cash outflow — see `docs/qbo-api/billpayment.md`).
- ⚠️ Mis-aged bills; AP that doesn't tie to the BS; duplicate bills.

## 6. Uncategorized & "Ask My Accountant"
- [ ] Uncategorized Income/Expense/Asset accounts cleared to real categories.
- [ ] "Ask My Accountant" resolved (maps to `other_below` — kept out of EBITDA; still hits net
      income). Anything unresolved becomes a client question.
- [ ] Spot-check auto-categorization against `guessCategory` (`lib/financials/categories.ts`).
- ⚠️ Non-trivial balances left in uncategorized/Ask-My-Accountant at close.

## 7. Accruals & adjustments (propose JEs — do not post)
- [ ] Depreciation / amortization for the month.
- [ ] Prepaid expenses amortized (insurance, subscriptions).
- [ ] Accrued expenses (unbilled vendor costs, payroll straddling month-end).
- [ ] Loan payments split into interest vs. principal.
- [ ] Recurring/standard JEs for this client applied.
- Output each as: account · debit/credit · amount · rationale.

## 8. Reasonableness review (vs. prior month + GBTN benchmarks)
Recompute with `computePL`/`computeBS` (`lib/financials/metrics.ts`); run `analyze()`
(`lib/financials/analysis.ts`). Investigate:
- [ ] Revenue Δ vs prior (benchmark trend flags at ±5%).
- [ ] Gross margin (target 50%+, trades 55-70%) and Δ (slip < -2 pts is a flag).
- [ ] EBITDA margin (target 12-18%) and opex ratio (trim toward 25-35% if overhead-heavy).
- [ ] Liquidity: current ratio (target 1.5×+), working capital (must be positive).
- [ ] Leverage: debt-to-equity (below 2×).
- [ ] Any P&L/BS line with a sign that looks wrong, or a swing > ~10% without a known cause.
- [ ] Balance Sheet balances (Assets = Liabilities + Equity).

## 9. Close summary & sign-off
- [ ] Every phase marked ✅ / ⚠️ / ⏭️.
- [ ] Exceptions listed with proposed fix + owner.
- [ ] Key metrics vs prior + benchmark flags.
- [ ] Clear go / no-go to finalize.

## 10. Handoff (writes data — confirm first)
- [ ] Load categorized P&L + BS into `financial_uploads` / `financial_line_items` (build-mrp path).
- [ ] Generate the MRP and/or FP&A briefing for the period.
- [ ] Mark the period closed for the client.
