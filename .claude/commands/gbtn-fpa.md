---
description: Produce a GBTN FP&A review for a client and period
argument-hint: <client-slug> [YYYY-MM]
---

Produce a **GBTN FP&A review** using the `fpa-review` skill.

- Client: **$1**
- Period: **$2** (if omitted, use the most recent loaded/complete month and confirm)

Follow the skill: resolve the client + period (+ prior), read the client's close profile for context,
build metrics from the synced portal financials (or live QuickBooks), run the benchmark engine, and
produce the **FP&A Review** — KPI scorecard vs prior with benchmark flags, variance drivers tied to
specific line items, findings ranked across the four levers, written CFO commentary with the top 2–3
actions, and any open watch items.

Read-only. Never fabricate figures — if something isn't available, say so.
