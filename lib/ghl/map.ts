// The single source of the GHL → our-vocabulary mapping rule, referenced by
// migration 0021. Deliberately dependency-free so both the sync (server) and
// any future client-side filter can share it.

import type { Channel, Direction, GhlMessageApi } from "./types";

/**
 * GHL message types, folded into the five channels that change how you'd coach
 * a rep. The distinctions GHL draws that we drop (TYPE_SMS_REVIEW_REQUEST vs
 * TYPE_SMS, TYPE_FACEBOOK vs TYPE_INSTAGRAM) don't change the advice: a text is
 * a text and a social DM is a chat.
 *
 * Unknown types land on 'other' rather than throwing — GHL ships new channels
 * without notice, and an unrecognised one should show up in the numbers as
 * "other", not take the sync down.
 */
export function channelOf(messageType: string | null | undefined): Channel {
  const t = (messageType ?? "").toUpperCase();
  if (!t) return "other";
  if (t.includes("CALL") || t.includes("VOICEMAIL")) return "call";
  if (t.includes("EMAIL")) return "email";
  if (t.includes("SMS")) return "sms";
  if (
    t.includes("CHAT") ||
    t.includes("FACEBOOK") ||
    t.includes("INSTAGRAM") ||
    t.includes("GMB") ||
    t.includes("WHATSAPP") ||
    t.includes("WEBCHAT")
  ) {
    return "chat";
  }
  return "other";
}

/**
 * Was this sent by automation rather than by a person?
 *
 * This is the most consequential rule in the module. GHL fires an auto-reply on
 * inbound texts, and the naive read of the data ("something outbound followed
 * the lead's message, so we answered in 8 seconds") makes every rep look
 * superhuman while leads sit untouched. `source` is GHL's own answer:
 *
 *   workflow | campaign | bulk_actions   automation — never a rep
 *   app                                  a person, typing in GHL
 *   api                                  a program calling the API
 *
 * `api` counts as automated: it is by definition not somebody typing, and the
 * conservative call is the one that makes response times look WORSE rather than
 * better. A missing source is treated as human — most manual sends predate the
 * field, and inventing automation where there is none would erase real replies.
 */
export function isAutomated(source: string | null | undefined): boolean {
  const s = (source ?? "").toLowerCase();
  if (!s) return false;
  return s === "workflow" || s === "campaign" || s === "bulk_actions" || s === "api";
}

/**
 * Message types that are CRM bookkeeping, not conversation: appointment and
 * invoice logs, opportunity moves, internal comments, the "chat started"
 * banner, form submissions.
 *
 * They live in the same GHL inbox as real messages, which is why the export
 * endpoint warns about them. Left in, they inflate every volume number and —
 * worse — an internal note would count as "we replied to the customer" when the
 * customer never saw a thing.
 */
export function isActivity(messageType: string | null | undefined): boolean {
  const t = (messageType ?? "").toUpperCase();
  if (!t) return false;
  return (
    t.startsWith("TYPE_ACTIVITY") ||
    t === "TYPE_INTERNAL_COMMENT" ||
    t === "TYPE_LIVE_CHAT_INFO_MESSAGE" ||
    t === "TYPE_FORM_SUBMISSION"
  );
}

/**
 * Did the customer reach IN, per the conversation search record?
 *
 * The message export only carries text/call/chat/email transcripts. A form fill
 * or paid-ad lead is created as a contact and shows up ONLY in the search index
 * — often with no pullable message at all. But the search record still tells us
 * the customer initiated: the last message on the thread was inbound, or there's
 * an unread inbound waiting. Either is enough to count the thread as a lead even
 * when we hold no inbound message for it. Kept conservative on purpose — it does
 * NOT treat a bare outbound-only contact (a blast target) as a lead.
 */
export function searchInbound(c: {
  lastMessageDirection?: unknown;
  unreadCount?: unknown;
}): boolean {
  const dir = String(c.lastMessageDirection ?? "").toLowerCase();
  if (dir === "inbound") return true;
  const unread = typeof c.unreadCount === "number" ? c.unreadCount : Number(c.unreadCount ?? 0);
  return Number.isFinite(unread) && unread > 0;
}

/**
 * Which way the message went.
 *
 * GHL is inconsistent here: the conversations API returns the string
 * "inbound"/"outbound", while some message payloads carry a numeric 1/2. Both
 * are handled. When the field is missing entirely we assume INBOUND, because
 * the expensive mistake runs the other way — a misread outbound would silently
 * become a "reply" and make speed-to-lead look better than it is.
 */
export function directionOf(raw: string | number | null | undefined): Direction {
  if (typeof raw === "number") return raw === 2 ? "outbound" : "inbound";
  const s = String(raw ?? "").toLowerCase();
  if (s === "outbound" || s === "2") return "outbound";
  return "inbound";
}

/**
 * GHL timestamps arrive as ISO strings on some endpoints and epoch millis on
 * others. Returns an ISO string, or null if it isn't a usable date — a bad
 * timestamp must not become 1970 and poison every average.
 */
export function toIso(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  const ms = d.getTime();
  if (Number.isNaN(ms)) return null;
  // GHL has been seen returning 0 for "never". Treat anything pre-2000 as absent.
  if (ms < 946_684_800_000) return null;
  return d.toISOString();
}

/** Plain-text body for a message, whatever field GHL chose to put it in. */
export function bodyOf(m: GhlMessageApi): string | null {
  const raw =
    (typeof m.body === "string" && m.body) ||
    (typeof m.html === "string" && stripHtml(m.html)) ||
    "";
  const subject = typeof m.subject === "string" ? m.subject.trim() : "";
  const text = raw.trim();
  if (!text && !subject) return null;
  // Emails carry their point in the subject as often as the body; keeping both
  // means the coaching pass sees what the rep actually led with.
  return subject && text ? `${subject}\n\n${text}` : subject || text;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip contact details from a message body.
 *
 * Lives here, with the other pure rules, because it is the single most
 * security-relevant transformation in the module — it runs on every transcript
 * before it leaves our servers for Anthropic (see coaching.ts) — and a rule
 * that important should sit somewhere it can be imported and tested on its own,
 * not behind a module that pulls in the AI SDK.
 *
 * Not a general-purpose PII scrubber: it targets the three things a flooring
 * conversation reliably contains and coaching never needs. Names are left
 * alone — they're woven through the dialogue, and removing them would make the
 * coaching unreadable.
 */
/**
 * Street address: a house number, one to four name words, then a suffix.
 *
 * Every part of this is deliberately narrow, because the loose version was
 * actively destructive. "Install is 2 days. We can do it either way, glue or
 * float." matched end-to-end — `\d+` took the 2, a whitespace-and-period
 * character class ran straight through the sentence boundary, and a
 * case-insensitive "Way" closed it — so a rep's actual words were replaced with
 * "[address]" in the transcript the coaching pass then quotes as evidence.
 *
 * The three guards that prevent it:
 *   • name words are [A-Za-z0-9]+ separated by single spaces, so the match can
 *     never cross a period, comma or newline;
 *   • the number must look like a street number (1–6 digits, optional unit
 *     letter), not any integer in a sentence;
 *   • suffixes are matched case-SENSITIVELY in Title case (Way, Dr, St), so the
 *     lowercase English words "way", "st" and "dr" don't anchor a match.
 *     An address typed in lower case is missed; that is the right way to be
 *     wrong, since over-redaction silently corrupts the evidence.
 */
const ADDRESS =
  /\b\d{1,6}[A-Za-z]?\s(?:[NSEW]\.?\s)?(?:[A-Za-z0-9]+\s){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Cir|Circle|Pl|Place|Hwy|Highway|Pkwy|Parkway|Ter|Terrace|Trl|Trail)\b\.?/g;

export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    // Phone shapes seen in the wild: (602) 555-0134, 602-555-0134, 602.555.0134,
    // +1 602 555 0134, 6025550134. The leading (?<!\d) and trailing (?!\d) stop
    // a 10-digit run inside a longer number (an order or invoice reference)
    // from being half-eaten and left looking like a phone number.
    .replace(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g, "[phone]")
    .replace(ADDRESS, "[address]")
    .trim();
}

/** A person's display name from a GHL user record, however it's populated. */
export function userName(u: {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}): string {
  const full = (u.name ?? "").trim();
  if (full) return full;
  const parts = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (parts) return parts;
  return (u.email ?? "").trim() || "Unknown";
}
