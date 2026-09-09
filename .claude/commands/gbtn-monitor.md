---
description: Run the close-monitor agent for a client (analyze books, update close profile, report readiness)
argument-hint: <client-slug>
---

Run the **close-monitor** agent for client **$1**.

Launch the `close-monitor` agent (via the Agent tool, `subagent_type: "close-monitor"`) scoped to
this one client. It should:
1. Load the client's close profile (`.claude/skills/month-end-close/clients/$1.md`; create from
   `_TEMPLATE.md` if missing).
2. Pull recent QuickBooks data — current + prior P&L/BS, AR/AP aging, and recent journal entries /
   transactions — read-only.
3. Analyze for structure drift, JE/transaction anomalies, tie-out breaks, missing recurring
   adjustments, and every watch item in the profile; run benchmark reasonableness.
4. Apply additive low-risk profile updates (new accounts, refreshed "last observed" values, new watch
   items) and append a dated Changelog line; **propose** (don't apply) any policy/judgment changes.
5. Report a **close-readiness summary**: per-area status, new exceptions with proposed fixes, and an
   overall on-track / at-risk / blocked call.

Stay read-only in QuickBooks. Confirm the connected realm matches client $1 before pulling.
