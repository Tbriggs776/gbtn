# GBTN Aging Playbook

How to turn AR/AP aging into a prioritized plan. Grounded in the aging reports
(`docs/qbo-api/reports.md`).

## Read the report correctly
- Buckets: **Current · 1–30 · 31–60 · 61–90 · 91+** (days past due).
- **Negatives = credits**, not debts: unapplied customer payments/credit memos on the AR side,
  vendor credits/overpayments on the AP side. They *reduce* the balance; they are **cleanup**
  (apply them), not collection/payment targets.
- If a customer/vendor shows large offsetting positives and negatives across buckets, the aging is
  **distorted** — recommend applying open credits/payments before acting. (Seen live: heavy AR/
  customer-deposit commingling produces wild offsetting buckets.)
- Aging total should tie to the Balance Sheet AR/AP control account — note if it doesn't.

## AR — collections priority
Rank by **amount × age × risk**. Bigger + older + shakier = first.
| Bucket | Posture | Suggested action |
|---|---|---|
| 1–30 | gentle | statement / reminder email |
| 31–60 | firm | direct follow-up, confirm pay date |
| 61–90 | escalate | phone call, payment plan, hold new work |
| 91+ | recover | final notice → collections/legal → write-off review |
Also: apply unapplied credits/payments; flag disputes and broken promises; watch concentration
(one customer = a big share of AR). Context: rising DSO (from the cash-flow derive) = collections
slipping.

## AP — payment priority (cash-aware)
Never recommend paying beyond available cash / 13-week headroom. Within what cash allows:
1. **Apply vendor credits first** (free reduction).
2. **Keep critical / sole-source vendors current** (supply continuity).
3. **Avoid late fees / finance charges** and protect terms/credit standing.
4. **Capture early-pay discounts** when the discount beats the cost of cash.
5. **Stretch non-critical vendors** to the edge of terms (not beyond, to preserve relationships).
Flag overdue balances that risk disruption; flag any vendor you're inadvertently overpaying (credit
balance).

## Cash impact (next 2–4 weeks)
Expected collections (AR coming due, adjusted for DSO reality) minus AP due out = the near-term gap.
Tie it to the 13-week trough so the plan is consistent with the cash forecast.

## Bottom line
End with the 2–3 highest-impact moves: the specific accounts to collect and the specific bills to
pay/hold this week.
