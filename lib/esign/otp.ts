import "server-only";
import { createHash, createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto";
import { SUPABASE_SERVICE_ROLE_KEY } from "@/lib/supabase/config";

// SMS one-time codes. Only an HMAC of the code is stored, keyed by a value
// derived from the service-role key (no new env var, no second source of
// truth), so neither staff nor a DB dump can brute-force 10^6 codes offline.
// Attempt, send and cooldown limits are enforced atomically in SQL.
//
// A correct code mints an otpSession: a random value returned once to the
// verifying browser and stored only as a sha256. submit/decline must present
// it, so a passed code verifies that browser, not the recipient forever.
// Codes and sessions are never logged or written to event meta.

export const OTP_TTL_SECONDS = 600,
  OTP_MAX_ATTEMPTS = 5,
  OTP_RESEND_COOLDOWN_SECONDS = 60,
  OTP_MAX_SENDS = 5,
  OTP_SESSION_TTL_SECONDS = 1800;

let otpKey: Buffer | null = null;

function hmacKey(): Buffer {
  if (otpKey) return otpKey;
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  otpKey = Buffer.from(hkdfSync("sha256", SUPABASE_SERVICE_ROLE_KEY, "gbtn-esign", "otp-v1", 32));
  return otpKey;
}

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** HMAC-SHA256(hkdf key, `${recipientId}:${code}`) as hex; binds a code to one envelope recipient. */
export function hashOtp(recipientId: string, code: string): string {
  return createHmac("sha256", hmacKey()).update(`${recipientId}:${code}`, "utf8").digest("hex");
}

export function generateOtpSession(): { otpSession: string; otpSessionHash: string } {
  const otpSession = randomBytes(32).toString("base64url");
  return { otpSession, otpSessionHash: hashOtpSession(otpSession) };
}

export function hashOtpSession(otpSession: string): string {
  return createHash("sha256").update(otpSession, "utf8").digest("hex");
}

/** "•••-•••-1234" */
export function maskPhone(e164: string | null): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 4) return "•••";
  return `•••-•••-${digits.slice(-4)}`;
}

/** "t•••@outlook.com" */
export function maskEmail(email: string): string {
  const trimmed = (email ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return "•••";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const first = Array.from(local)[0] ?? "";
  return `${first}•••@${domain}`;
}
