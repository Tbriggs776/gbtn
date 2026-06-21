import "server-only";

// Minimal Resend wrapper over the REST API (no SDK dependency). Returns
// { ok: true } on success, { ok: false, error } otherwise. If RESEND_API_KEY is
// not configured we report a clear, non-throwing failure so callers can still
// persist the underlying record and degrade gracefully.

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

// "Growth by the Numbers <noreply@yourdomain.com>" — must be a Resend-verified
// domain in production. Falls back to Resend's shared testing sender.
const FROM =
  process.env.CONTACT_FROM_EMAIL ??
  "Growth by the Numbers <onboarding@resend.dev>";

// Where lead notifications land. Defaults to Tyler's address.
const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO ?? "tyler.briggs@outlook.com";

export const isEmailConfigured = Boolean(RESEND_API_KEY);

type SendResult = { ok: boolean; error?: string };

export async function sendEmail({
  to,
  subject,
  html,
  replyTo,
}: {
  to?: string;
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<SendResult> {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY is not configured." };
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
        to: [to ?? NOTIFY_TO],
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
