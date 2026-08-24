# Growth by the Numbers

The web platform for **Growth by the Numbers (GBTN)** — Tyler Briggs' fractional
CFO & value-creation practice. It's three things in one Next.js app:

1. **Marketing site** — the public `growthbythenumbers.com` (home, about, services, results, contact).
2. **Client portal** — an authenticated, multi-tenant workspace where each client sees
   their own documents, financials, and dashboards.
3. **Agency CRM** — GBTN's internal sales + customer engine (contacts, deals, campaigns,
   a unified inbox), used only by GBTN staff.

Built with Next.js (App Router) + Tailwind CSS v4 + Supabase, deployed on Vercel.

## Stack

- **Next.js 15** (App Router, React 19) · **TypeScript**
- **Tailwind CSS v4** (CSS-first config in `app/globals.css`)
- **Supabase** — Postgres + Auth + Row Level Security + Storage + Vault (for secrets)
- **Resend** (email), **Twilio** (SMS/voice), **CallRail** (call logging), **Anthropic** (AI)
- **Vercel** — hosting + Cron

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npm run lint
```

The marketing site runs with zero config. The portal + CRM need Supabase and the other
integrations wired up — see [SETUP.md](SETUP.md).

## Access model

Three platform roles (`profiles.role`):

| Role | Signs in at | Sees |
|---|---|---|
| **client** | `/login` | Only their own company's portal (documents, financials, dashboards) |
| **employee** | `/team` | The CRM only — no client data, no provisioning/user management |
| **admin** (GBTN) | `/team` | Everything: every client's portal **and** the full CRM + admin |

The two login doors are strict: the wrong role is signed out and pointed at the correct
door, and the server-side layout guards enforce it regardless. "Staff" means admin ∪
employee (SQL helper `is_staff()`); client-data tables stay gated on `is_admin()`, so an
employee can never reach a client's books.

## Project structure

```
app/
  (marketing)/        Public site — home, about, services, results, contact, metrics
  login/              Client login door
  team/               Staff (admin + employee) login door
  auth/               Supabase email-link handlers (confirm / callback / signout)
  portal/             Authenticated client portal
    page.tsx            Overview (employees are redirected to the CRM)
    documents/ financials/ fpa/ briefing/ ops-reports/ marketing/ ...
    admin/              Client + user provisioning, staff creation, analytics
    crm/                ── GBTN-internal CRM (staff only) ──
      page.tsx            Pipeline dashboard
      conversations/      Unified SMS inbox (list + thread + reply)
      contacts/ companies/ deals/ tasks/ cases/ campaigns/
      settings/           Twilio + CallRail credentials (admin only)
  api/
    twilio/             Inbound SMS + status + voice webhooks (signature-verified)
    resend/webhook/     Email delivery/open/click events
    cron/               Vercel Cron: crm-engine, callrail-sync, marketing-sync, …
    unsubscribe/        HMAC-signed one-click email opt-out
components/             UI primitives + portal/CRM components
lib/
  site.ts             ★ Marketing-site copy & data (single source of truth)
  auth.ts             Session, role gates (requireAdmin / requireStaff / requireCapability)
  permissions.ts      Capability matrix (client roles: admin/finance/ops/marketing)
  supabase/           Server, browser, and service-role clients
  crm/                CRM domain: service, actions, comms, twilio, campaigns, ai, conversations
  financials/ ops/ marketing/   Portal domains
  integrations/       Vault-backed platform secrets (Anthropic, Twilio, CallRail)
supabase/
  migrations/         Ordered SQL migrations (see SETUP.md — apply all in order)
  email-templates/    Branded Supabase auth email HTML
```

## Editing marketing content

Almost all public-site copy — services, stats, track record, results, contact details —
lives in [`lib/site.ts`](lib/site.ts). Edit there; it propagates across pages.

## Secrets

Two tiers:

- **Environment variables** (Supabase, Resend, `CRON_SECRET`, etc.) — see [SETUP.md](SETUP.md).
- **Vault-stored platform secrets** — the Anthropic key, Twilio credentials, and CallRail
  credentials are stored encrypted in Supabase Vault and set through the app UI (Admin →
  Integrations, and CRM → Settings), never in env or the browser.

## Deploy

Push to `main`; Vercel builds and deploys automatically. Add the environment variables
from [SETUP.md](SETUP.md) in **Vercel → Project → Settings → Environment Variables**, and
configure the Cron secret + Twilio webhooks as described there.
