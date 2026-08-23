import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail, emailLayout } from "@/lib/email";
import { sendSms } from "./twilio";
import { site } from "@/lib/site";

// Orchestrates outbound/inbound communication: send via the provider (Resend or
// Twilio), then log BOTH a crm_messages row (delivery record) and a
// crm_activities row (timeline entry). The activity insert fires the DB trigger
// that maintains last_attempt_at / last_contacted_at on the contact.

type DB = SupabaseClient;

/** Public base URL for provider webhooks/callbacks. */
export function appBaseUrl(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "");
  return (fromEnv || site.url).replace(/\/$/, "");
}

/** Very small mustache-ish merge: {{first_name}} etc. Missing keys → "". */
export function renderTemplate(tpl: string, vars: Record<string, string | null | undefined>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => vars[k]?.toString() ?? "");
}

const UNSUB_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function unsubscribeSecret(): string | null {
  return process.env.UNSUBSCRIBE_SECRET || process.env.CRON_SECRET || null;
}

/** HMAC-SHA256 token: contactId.expiryMs.sig — covers id + expiry. */
export function signUnsubscribeToken(contactId: string, expiresAt = Date.now() + UNSUB_TTL_MS): string {
  const secret = unsubscribeSecret();
  if (!secret) {
    throw new Error("UNSUBSCRIBE_SECRET (or CRON_SECRET) is required to sign unsubscribe links.");
  }
  const payload = `${contactId}.${expiresAt}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): { contactId: string } | null {
  const secret = unsubscribeSecret();
  if (!secret || !token) return null;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expDot = payload.lastIndexOf(".");
  if (expDot <= 0) return null;
  const contactId = payload.slice(0, expDot);
  const expiresAt = Number(payload.slice(expDot + 1));
  if (!contactId || !Number.isFinite(expiresAt)) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (expiresAt < Date.now()) return null;
  return { contactId };
}

export function unsubscribeUrl(contactId: string): string {
  return `${appBaseUrl()}/api/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(contactId))}`;
}

/** Persist email opt-out + pause active enrollments. Service-role or admin client. */
export async function applyEmailUnsubscribe(db: DB, contactId: string): Promise<void> {
  const { error } = await db
    .from("crm_contacts")
    .update({ do_not_email: true, unsubscribed_at: new Date().toISOString() })
    .eq("id", contactId);
  if (error) throw error;
  await db
    .from("crm_enrollments")
    .update({ status: "unsubscribed" })
    .eq("contact_id", contactId)
    .eq("status", "active");
}

type SendCtx = {
  contactId: string | null;
  campaignId?: string | null;
  createdBy?: string | null;
  dealId?: string | null;
};

function withUnsubFooter(html: string, url: string): string {
  return `${html}<p style="margin-top:28px;font-size:12px;color:#9a958c;line-height:1.5;">You received this because you are in our CRM. <a href="${url}" style="color:#9a958c;">Unsubscribe</a>.</p>`;
}

export async function sendContactEmail(
  db: DB,
  ctx: SendCtx,
  {
    to,
    subject,
    html,
    text,
    replyTo,
    wrap = true,
  }: { to: string; subject: string; html: string; text?: string; replyTo?: string; wrap?: boolean }
): Promise<{ ok: boolean; error?: string }> {
  let bodyHtml = html;
  if (ctx.contactId) {
    const secret = unsubscribeSecret();
    if (!secret) {
      if (process.env.NODE_ENV === "production") {
        return { ok: false, error: "Unsubscribe signing secret is not configured." };
      }
    } else {
      try {
        bodyHtml = withUnsubFooter(html, unsubscribeUrl(ctx.contactId));
      } catch (e) {
        if (process.env.NODE_ENV === "production") {
          return { ok: false, error: e instanceof Error ? e.message : "Unsubscribe link failed." };
        }
      }
    }
  }

  const finalHtml = wrap ? emailLayout({ heading: subject, bodyHtml }) : bodyHtml;
  const res = await sendEmail({ to, subject, html: finalHtml, replyTo });

  await db.from("crm_messages").insert({
    contact_id: ctx.contactId,
    campaign_id: ctx.campaignId ?? null,
    channel: "email",
    direction: "outbound",
    from_addr: process.env.EMAIL_FROM ?? "noreply",
    to_addr: to,
    subject,
    body: text ?? html,
    status: res.ok ? "sent" : "failed",
    provider: "resend",
    error: res.ok ? null : res.error ?? null,
  });

  if (ctx.contactId) {
    await db.from("crm_activities").insert({
      contact_id: ctx.contactId,
      deal_id: ctx.dealId ?? null,
      type: "email",
      direction: "outbound",
      subject,
      body: text ?? html,
      created_by: ctx.createdBy ?? null,
      meta: { campaign_id: ctx.campaignId ?? null, delivered: res.ok },
    });
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function sendContactSms(
  db: DB,
  ctx: SendCtx,
  { to, body }: { to: string; body: string }
): Promise<{ ok: boolean; error?: string }> {
  const statusCallback = `${appBaseUrl()}/api/twilio/status`;
  const res = await sendSms({ to, body, statusCallback });

  await db.from("crm_messages").insert({
    contact_id: ctx.contactId,
    campaign_id: ctx.campaignId ?? null,
    channel: "sms",
    direction: "outbound",
    to_addr: to,
    body,
    status: res.ok ? res.status ?? "sent" : "failed",
    provider: "twilio",
    provider_id: res.sid ?? null,
    error: res.ok ? null : res.error ?? null,
  });

  if (ctx.contactId) {
    await db.from("crm_activities").insert({
      contact_id: ctx.contactId,
      deal_id: ctx.dealId ?? null,
      type: "sms",
      direction: "outbound",
      body,
      created_by: ctx.createdBy ?? null,
      meta: { campaign_id: ctx.campaignId ?? null, sid: res.sid ?? null, delivered: res.ok },
    });
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Due CRM task reminders.
 * email → assignee only (never the contact).
 * sms → related contact, honoring do_not_sms.
 * Stamp reminded_at only after a successful send, or when there is nobody to
 * notify (so we do not retry forever). A failed provider send is left unstamped.
 */
export async function processTaskReminders(db: DB, limit = 200): Promise<number> {
  const now = new Date().toISOString();
  const { data: tasks } = await db
    .from("crm_tasks")
    .select("id, title, due_at, assignee, contact_id, remind_channel")
    .eq("status", "open")
    .in("remind_channel", ["email", "sms"])
    .not("reminder_at", "is", null)
    .lte("reminder_at", now)
    .is("reminded_at", null)
    .limit(limit);

  let sent = 0;
  for (const t of tasks ?? []) {
    const due = t.due_at ? new Date(t.due_at as string).toLocaleString("en-US") : "no due date";
    const channel = t.remind_channel as string;
    let outcome: "sent" | "failed" | "skip" = "skip";

    if (channel === "email") {
      if (t.assignee) {
        const { data } = await db.auth.admin.getUserById(t.assignee as string);
        const email = data?.user?.email ?? null;
        if (email) {
          const link = t.contact_id
            ? `${appBaseUrl()}/portal/crm/contacts/${t.contact_id}`
            : `${appBaseUrl()}/portal/crm/tasks`;
          const res = await sendEmail({
            to: email,
            subject: `Reminder: ${t.title}`,
            html: emailLayout({
              heading: "Task reminder",
              bodyHtml: `<p><strong>${t.title}</strong></p><p>Due: ${due}</p>`,
              ctaLabel: "Open in CRM",
              ctaUrl: link,
            }),
          });
          outcome = res.ok ? "sent" : "failed";
        }
      }
    } else if (channel === "sms" && t.contact_id) {
      const { data: contact } = await db
        .from("crm_contacts")
        .select("phone, do_not_sms")
        .eq("id", t.contact_id)
        .maybeSingle();
      if (contact?.phone && !contact.do_not_sms) {
        const res = await sendContactSms(db, { contactId: t.contact_id as string }, {
          to: contact.phone as string,
          body: `Reminder: ${t.title} (due ${due})`,
        });
        outcome = res.ok ? "sent" : "failed";
      }
    }

    if (outcome === "failed") continue;
    await db.from("crm_tasks").update({ reminded_at: now }).eq("id", t.id);
    if (outcome === "sent") sent++;
  }
  return sent;
}

/** Record an inbound SMS (from the Twilio webhook). Service-role db. */
export async function logInboundSms(
  db: DB,
  { contactId, from, body, sid }: { contactId: string | null; from: string; body: string; sid: string }
): Promise<void> {
  await db.from("crm_messages").insert({
    contact_id: contactId,
    channel: "sms",
    direction: "inbound",
    from_addr: from,
    body,
    status: "received",
    provider: "twilio",
    provider_id: sid,
  });
  if (contactId) {
    await db.from("crm_activities").insert({
      contact_id: contactId,
      type: "sms",
      direction: "inbound",
      body,
      meta: { sid, from },
    });
  }
}

/** Record an inbound call (from the Twilio voice webhook or CallRail). */
export async function logInboundCall(
  db: DB,
  {
    contactId,
    from,
    durationSec,
    recordingUrl,
    connected,
    provider,
    sid,
    occurredAt,
  }: {
    contactId: string | null;
    from: string;
    durationSec?: number;
    recordingUrl?: string | null;
    connected?: boolean;
    provider: string;
    sid?: string;
    occurredAt?: string;
  }
): Promise<void> {
  if (!contactId) return;
  await db.from("crm_activities").insert({
    contact_id: contactId,
    type: "call",
    direction: "inbound",
    subject: connected ? "Inbound call" : "Missed call",
    occurred_at: occurredAt ?? new Date().toISOString(),
    meta: {
      from,
      duration_sec: durationSec ?? null,
      recording_url: recordingUrl ?? null,
      connected: connected ? "true" : "false",
      provider,
      sid: sid ?? null,
    },
  });
}
