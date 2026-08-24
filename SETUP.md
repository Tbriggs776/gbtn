# GBTN Platform — Setup Guide

The marketing site runs with zero config. The **client portal** and **CRM** need Supabase
and a few integrations wired up. Core setup is ~15 minutes; the CRM comms integrations
(Twilio/CallRail/AI) are optional and can be added later from the app UI.

---

## 1. Environment variables

```bash
cp .env.example .env.local
```

### Core (required for the portal)

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | Safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / publishable key | Safe to expose |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key | **Secret** — server-only, never expose |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` locally; your domain in prod | Invite/auth links |

### Email (Resend)

| Variable | Notes |
|---|---|
| `RESEND_API_KEY` | Sends app email + (optionally) Supabase auth email via SMTP |
| `EMAIL_FROM` | e.g. `Growth by the Numbers <noreply@growthbythenumbers.com>` (must be a Resend-verified domain) |
| `CONTACT_NOTIFY_TO` | Where website contact-form leads are emailed |
| `RESEND_WEBHOOK_SECRET` | Verifies the Resend event webhook (email open/click/bounce tracking) |

### CRM comms & automation

| Variable | Notes |
|---|---|
| `CRON_SECRET` | Required for the Vercel Cron routes (they 401 without it). Vercel sends it automatically once set |
| `NEXT_PUBLIC_APP_URL` | Public base URL for Twilio/Resend webhook callbacks. Falls back to `NEXT_PUBLIC_SITE_URL`, then the site domain |
| `UNSUBSCRIBE_SECRET` | HMAC key for one-click email unsubscribe links. Falls back to `CRON_SECRET` if unset |
| `CRM_SMS_AUTORESPONDER` | Set to `1` to enable the AI SMS auto-responder on inbound texts (off by default) |

> Twilio, CallRail, and the Anthropic AI key are **not** env vars — they live in Supabase
> Vault and are set from the app UI (see step 5). Paste keys directly into `.env.local`
> (git-ignored); never commit it. Add the same variables in **Vercel → Settings →
> Environment Variables** for production.

---

## 2. Run the database migrations

Apply **every** file in [`supabase/migrations/`](supabase/migrations) in ascending order.
With the Supabase CLI linked to your project:

```bash
supabase db push
```

…or paste each file's contents into **Supabase → SQL Editor** in order. Migrations are
written to be re-runnable (`create ... if not exists`, `drop policy if exists`).

> **Numbering note:** a few migration files share a number prefix (parallel work streams
> created e.g. two `0018_*` and two `0022_*`). Apply them in filename order; if you use
> `supabase db push`, confirm the applied set matches the folder. Production is the source
> of truth — verify tables exist (`crm_*`, `financial_*`, `ops_order_lines`, etc.) after
> pushing.

This creates: tenancy + RLS (`clients`, `profiles`, `memberships`), documents + storage,
financials, ops, marketing, the platform-secrets Vault helpers, and the full CRM
(`crm_contacts`, `crm_deals`, `crm_campaigns`, `crm_conversations`, `crm_cases`, …).

---

## 3. Configure Auth

In **Supabase → Authentication**:

1. **Providers → Email:** enabled. Turn **"Allow new users to sign up" OFF** — access is invite-only.
2. **URL Configuration → Redirect URLs:** add `<site>/auth/confirm` and `<site>/auth/callback`
   for both localhost and production.
3. *(Recommended)* **Email Templates → Magic Link / Invite:** use the token-hash form so
   links land on our handler:
   ```
   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type={{ .Type }}&next=/portal
   ```
4. *(Recommended)* Route auth email through Resend (Custom SMTP: `smtp.resend.com`, port
   `465`, user `resend`, password = `RESEND_API_KEY`, sender = your verified domain).
5. *(Recommended)* Paste the branded templates from `supabase/email-templates/`.

---

## 4. Make yourself the admin

1. In **Supabase → Authentication → Users → Add user**, create your account
   (`tyler.briggs@outlook.com`). This creates the auth user + a `profiles` row.
2. In **SQL Editor**, run `supabase/seed_admin.sql` (edit the email if needed) to set
   `role = 'admin'`.
3. Sign in at **`/team`** (the staff door). You'll see the **Admin** and **CRM** tabs.

Then, from **Admin**:
- **Create a client** — an isolated company workspace.
- **Invite a user** — a client user, linked to that company with a role.
- **Add a GBTN team member** — an `employee` (CRM only) or `admin` staff account; they sign
  in at `/team`.

---

## 5. CRM integrations (optional, via the app UI)

These power CRM comms; add them when ready. All are stored encrypted in Vault.

- **AI (Anthropic):** Admin → Integrations → paste the platform Anthropic key. Powers the
  CFO briefing and the CRM assistant (summaries, lead scoring, draft replies, SMS bot).
- **Twilio (SMS/voice):** CRM → Settings → enter Account SID, Auth Token, From number (or
  Messaging Service SID). Then point your Twilio number's webhooks at the URLs shown on
  that page:
  - Messaging (inbound SMS): `<app>/api/twilio/sms`
  - Status callback: `<app>/api/twilio/status`
  - Voice (inbound): `<app>/api/twilio/voice`
- **CallRail (call logging):** CRM → Settings → API key + account ID. A daily cron threads
  calls onto matching contacts.

---

## 6. Cron

`vercel.json` registers the scheduled routes (marketing sync, QBO sync, close monitor,
`crm-engine` — drips/blasts/task reminders, and `callrail-sync`). They're gated by
`CRON_SECRET`; set it in Vercel and the platform supplies it on each run. Locally you can
hit them with `Authorization: Bearer $CRON_SECRET`.

---

## How isolation works

Every table has Row Level Security. Client users can only read/write rows for the client
they belong to; admins see all. CRM tables are gated on `is_staff()` (admin ∪ employee),
and client-data tables on `is_admin()`, so employees never reach client books. The
`documents` bucket is private (short-lived signed URLs). A `profiles` trigger blocks any
non-admin from changing their own `role`, so the auth model can't be escalated from the
browser.
