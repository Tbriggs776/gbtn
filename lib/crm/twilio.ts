import "server-only";
import crypto from "node:crypto";
import { readPlatformJson } from "@/lib/integrations/platform-secrets";

// Minimal Twilio wrapper over the REST API (no SDK dependency), mirroring the
// Resend wrapper in lib/email.ts. Credentials live in Vault under the "twilio"
// platform integration (JSON blob), never in the browser or an env var.

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  fromNumber?: string;         // E.164, e.g. +18885551234
  messagingServiceSid?: string; // optional; preferred over fromNumber if set
  twimlAppSid?: string;         // for browser click-to-call (Voice SDK)
  apiKeySid?: string;          // for Voice access tokens
  apiKeySecret?: string;
};

export async function getTwilioConfig(): Promise<TwilioConfig | null> {
  const c = await readPlatformJson<TwilioConfig>("twilio");
  if (!c?.accountSid || !c?.authToken) return null;
  return c;
}

export async function isTwilioConfigured(): Promise<boolean> {
  return (await getTwilioConfig()) !== null;
}

/** Normalize a US-ish phone to E.164. Returns null if it can't. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : null;
}

type SmsResult = { ok: boolean; sid?: string; status?: string; error?: string };

export async function sendSms({
  to,
  body,
  statusCallback,
}: {
  to: string;
  body: string;
  statusCallback?: string;
}): Promise<SmsResult> {
  const cfg = await getTwilioConfig();
  if (!cfg) return { ok: false, error: "Twilio is not configured." };
  const e164 = toE164(to);
  if (!e164) return { ok: false, error: `Invalid phone number: ${to}` };

  const form = new URLSearchParams();
  form.set("To", e164);
  form.set("Body", body);
  if (cfg.messagingServiceSid) form.set("MessagingServiceSid", cfg.messagingServiceSid);
  else if (cfg.fromNumber) form.set("From", cfg.fromNumber);
  else return { ok: false, error: "No Twilio From number or Messaging Service configured." };
  if (statusCallback) form.set("StatusCallback", statusCallback);

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );
    const json = (await res.json()) as { sid?: string; status?: string; message?: string };
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${json.message ?? "send failed"}` };
    return { ok: true, sid: json.sid, status: json.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Twilio request failed." };
  }
}

/** Place an outbound call that connects the agent's phone to the contact. */
export async function placeCall({
  to,
  twiml,
  url,
  statusCallback,
}: {
  to: string;
  twiml?: string;
  url?: string;
  statusCallback?: string;
}): Promise<SmsResult> {
  const cfg = await getTwilioConfig();
  if (!cfg) return { ok: false, error: "Twilio is not configured." };
  if (!cfg.fromNumber) return { ok: false, error: "No Twilio From number configured." };
  const e164 = toE164(to);
  if (!e164) return { ok: false, error: `Invalid phone number: ${to}` };

  const form = new URLSearchParams();
  form.set("To", e164);
  form.set("From", cfg.fromNumber);
  if (twiml) form.set("Twiml", twiml);
  if (url) form.set("Url", url);
  if (statusCallback) form.set("StatusCallback", statusCallback);

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );
    const json = (await res.json()) as { sid?: string; status?: string; message?: string };
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${json.message ?? "call failed"}` };
    return { ok: true, sid: json.sid, status: json.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Twilio request failed." };
  }
}

/**
 * Validate an inbound Twilio webhook. Twilio signs requests as
 * base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value)...)). Compare in
 * constant time. Returns false if Twilio isn't configured.
 */
export async function validateTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  signature: string | null
): Promise<boolean> {
  const cfg = await getTwilioConfig();
  if (!cfg || !signature) return false;
  const sorted = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of sorted) data += k + params[k];
  const expected = crypto
    .createHmac("sha1", cfg.authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
