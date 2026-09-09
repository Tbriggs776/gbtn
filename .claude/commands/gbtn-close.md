---
description: Run a GBTN month-end close for a client and period
argument-hint: <client-slug> [YYYY-MM]
---

Run a **GBTN month-end close** using the `month-end-close` skill.

- Client: **$1**
- Period: **$2** (if omitted, use the most recent complete month and confirm)

Follow the skill exactly: resolve the client + period, pull the close month and prior month from
QuickBooks, work the checklist in `reference/close-checklist.md`, ground all categories/metrics/
benchmarks in `lib/financials/` (categories.ts, metrics.ts, analysis.ts), and produce the
**Close Package** with checklist status, exceptions + proposed fixes, proposed JEs, key metrics vs.
prior with benchmark flags, and a go/no-go verdict.

Stay **read-only** in QuickBooks — propose adjustments, never post them, and confirm before any
step that writes data (loading to the portal, generating the MRP) or contacts a client.
