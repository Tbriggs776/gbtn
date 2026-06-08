# GBTN Portal — Setup Guide

The marketing site runs with zero config. The **client portal** (login, documents,
financials) needs your Supabase project wired up. This is a one-time setup, ~15 minutes.

---

## 1. Add environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local` from **Supabase → Project Settings → API**:

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | Safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / publishable key | Safe to expose |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key | **Secret.** Server-only — never expose |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` locally; your domain in prod | Used for invite links |

> Paste keys directly into the file. Never commit `.env.local` (it's git-ignored).

When you deploy, add the same four variables in **Vercel → Project → Settings →
Environment Variables**.

---

## 2. Run the database migrations

In **Supabase → SQL Editor**, run these two files (in order). Paste the contents of each:

1. `supabase/migrations/0001_init.sql` — tables, RLS policies, helper functions, the
   auto-profile trigger.
2. `supabase/migrations/0002_storage.sql` — the private `client-files` bucket + storage
   policies.

(Or, with the Supabase CLI linked to your project: `supabase db push`.)

---

## 3. Configure Auth

In **Supabase → Authentication**:

1. **Providers → Email:** enabled. Turn **"Allow new users to sign up" OFF** — access is
   invite-only.
2. **URL Configuration:**
   - **Site URL:** `http://localhost:3000` (and your production domain when live).
   - **Redirect URLs:** add `http://localhost:3000/auth/confirm` and
     `http://localhost:3000/auth/callback` (plus the production equivalents).
3. *(Recommended, cross-device-safe links)* **Email Templates → Magic Link** and
   **Invite User:** set the link to use the token-hash form so it lands on our handler:
   ```
   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type={{ .Type }}&next=/portal
   ```
   If you skip this, the default `code`-based links still work for same-device sign-ins.

---

## 4. Make yourself the admin

1. Start the app (`npm run dev`) and have Tyler get into the system once. Easiest path:
   in **Supabase → Authentication → Users → Add user**, create `tyler.briggs@outlook.com`
   (or use "Invite"). This creates your auth user + profile row.
2. In **SQL Editor**, run `supabase/seed_admin.sql` (edit the email if needed). This flips
   your profile to `role = 'admin'`.
3. Sign in at `/login`. You'll now see the **Admin** tab.

---

## 5. Use it

- **Admin → Create a client** (e.g. a customer company).
- **Admin → Invite a user** — sends them a magic-link invite and links them to that client.
- They sign in and land in their isolated portal: **Documents** works now; **Financials**
  dashboards land in the next phase.

---

## How isolation works (peace of mind)

Every table has Row Level Security. A client user can only ever read/write rows for the
client they belong to; you (admin) can see all. The document bucket is **private** —
downloads go through short-lived signed URLs, and the storage policies enforce the same
per-client boundary. Even a crafted request can't reach another client's data.
