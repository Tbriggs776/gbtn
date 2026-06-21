import "server-only";

// Minimal Resend wrapper over the REST API (no SDK dependency). Returns
// { ok: true } on success, { ok: false, error } otherwise. If RESEND_API_KEY is
// not configured we report a clear, non-throwing failure so callers can still
// persist the underlying record and degrade gracefully.

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

// System sender for all app-originated email. "Growth by the Numbers
// <noreply@yourdomain.com>" — must be a Resend-verified domain to deliver to
// arbitrary recipients. Falls back to Resend's shared testing sender (which
// only reaches your own Resend signup address). EMAIL_FROM is the canonical
// var; CONTACT_FROM_EMAIL is kept as a backward-compatible alias.
const FROM =
  process.env.EMAIL_FROM ??
  process.env.CONTACT_FROM_EMAIL ??
  "Growth by the Numbers <onboarding@resend.dev>";

// Where lead/admin notifications land. Defaults to Tyler's address.
const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO ?? "tyler@tylermbriggs.com";

export const isEmailConfigured = Boolean(RESEND_API_KEY);

type SendResult = { ok: boolean; error?: string };

export async function sendEmail({
  to,
  subject,
  html,
  replyTo,
}: {
  to?: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<SendResult> {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY is not configured." };
  }
  const recipients = Array.isArray(to) ? to : [to ?? NOTIFY_TO];
  if (recipients.length === 0) {
    return { ok: false, error: "No recipients." };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: recipients,
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Send failed." };
  }
}

export const CONTACT_NOTIFY_TO = NOTIFY_TO;

// Wraps body HTML in a consistent, on-brand shell (navy header, cream paper).
export function emailLayout({
  heading,
  bodyHtml,
  ctaLabel,
  ctaUrl,
}: {
  heading: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
}): string {
  const button =
    ctaLabel && ctaUrl
      ? `<a href="${ctaUrl}" style="display:inline-block;margin-top:20px;background:#9e2335;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px">${ctaLabel}</a>`
      : "";
  return `
  <div style="background:#f6f2ea;padding:28px 0;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e0d3;border-radius:14px;overflow:hidden">
      <div style="background:#11294a;padding:18px 28px">
        <span style="color:#f6f2ea;font-weight:700;letter-spacing:0.04em;font-size:15px">GROWTH BY THE NUMBERS</span>
      </div>
      <div style="padding:28px">
        <h1 style="margin:0 0 14px;font-size:20px;color:#11294a">${heading}</h1>
        <div style="font-size:15px;line-height:1.6;color:#3a4252">${bodyHtml}</div>
        ${button}
      </div>
      <div style="padding:16px 28px;border-top:1px solid #e7e0d3;font-size:12px;color:#9a958c">
        Growth by the Numbers · Fractional CFO &amp; Value Creation
      </div>
    </div>
  </div>`;
}
