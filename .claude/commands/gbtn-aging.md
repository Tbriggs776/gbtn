---
description: Produce a GBTN AR collections + cash-aware AP payment plan for a client
argument-hint: <client-slug>
---

Produce a **GBTN aging review** using the `aging-review` skill for client **$1**.

Follow the skill: pull AR + AP aging (summary + detail) from QuickBooks, check data hygiene first
(negatives = credits; flag distorted/offsetting buckets), then produce a **prioritized AR
collections list** and a **cash-aware AP payment plan** (respecting the client's cash / 13-week
headroom), plus credits to apply and the 2–3 highest-impact moves this week.

Read-only — recommend actions, never send emails, apply payments, or pay bills. Never fabricate
figures; if a report is empty or distorted, say so and recommend the fix.
