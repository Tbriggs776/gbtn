# Branded auth email templates

On-brand HTML for Growth by the Numbers authentication emails. The heritage
palette + the `lockup-horizontal-on-navy` logo (loaded from
`https://growthbythenumbers.com/brand/...`, so the site must be live for the
image to render).

## How to install (templates 1–6)

In **Supabase → Authentication → Emails → Templates**, pick each template, set
the **Subject**, and paste the matching file's full HTML into the body. These
map 1:1 to Supabase's editable template slots:

| Supabase template     | File                    | Suggested subject                                   |
|-----------------------|-------------------------|-----------------------------------------------------|
| Confirm signup        | `confirm-signup.html`   | Confirm your email · Growth by the Numbers          |
| Invite user           | `invite.html`           | You're invited to your client portal                |
| Magic Link            | `magic-link.html`       | Your sign-in link · Growth by the Numbers           |
| Change Email Address  | `change-email.html`     | Confirm your new email address                      |
| Reset Password        | `reset-password.html`   | Reset your password · Growth by the Numbers         |
| Reauthentication      | `reauthentication.html` | Your verification code · Growth by the Numbers       |

Links point at our own handler in the cross-device-safe token-hash form:
`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<type>&next=<path>`.
For this to work, set **Site URL** = `https://growthbythenumbers.com` under
Authentication → URL Configuration, and keep `/auth/confirm` in the allowed
redirect URLs.

## Security notifications (templates 7–9)

`password-changed.html`, `email-changed.html`, `phone-changed.html` are **not**
native Supabase dashboard templates — Supabase does not send these by default.
They're provided branded and ready. To actually send them, wire a Supabase
**"Send Email" auth hook** (an Edge Function that renders the template on the
relevant event). Until then they're reference/standby only. (The portal is
email-based; `phone-changed` is included for completeness.)

## App notification emails

Contact-form alerts and "new financials are ready" client emails are rendered in
code via `emailLayout()` in `lib/email.ts` (same look as these), sent through
Resend — they are not configured here.
