import "server-only";
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

type SendCtx = {
  contactId: string | null;
  campaignId?: string | null;
  createdBy?: string | null;
  dealId?: string | null;
};

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
  const finalHtml = wrap ? emailLayout({ heading: subject, bodyHtml: html }) : html;
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
