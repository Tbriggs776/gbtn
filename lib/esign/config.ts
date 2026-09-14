import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONTACT_NOTIFY_TO } from "@/lib/email";
import type { EsignDocType, EsignTypeSummary } from "./types";

// Per-type e-sign configuration (esign_document_type) and the consent-template
// fill. The FILLED consent and checkbox text is what gets snapshotted, hashed
// and shown, so a template with an unknown or empty placeholder refuses to send
// rather than printing a blank into a legal notice.

export type EsignDocumentTypeRow = { document_type: string; label: string; esign_enabled: boolean; require_sms_otp: boolean;
  activates_engagement: boolean; allowed_content_types: string[]; consent_text: string; checkbox_text: string;
  expiry_days: number; notify_emails: unknown };

const TYPE_COLUMNS =
  "document_type,label,esign_enabled,require_sms_otp,activates_engagement,allowed_content_types,consent_text,checkbox_text,expiry_days,notify_emails";

/** null when no row exists. Throws on a read error, so a DB outage never reads as "type disabled". */
export async function loadDocumentType(db: SupabaseClient, type: string): Promise<EsignDocumentTypeRow | null> {
  const { data, error } = await db
    .from("esign_document_type")
    .select(TYPE_COLUMNS)
    .eq("document_type", type)
    .maybeSingle<EsignDocumentTypeRow>();
  if (error) throw new Error("Could not load e-sign settings.");
  if (!data) return null;
  return {
    ...data,
    allowed_content_types: Array.isArray(data.allowed_content_types)
      ? data.allowed_content_types.filter((t): t is string => typeof t === "string")
      : [],
  };
}

export function toTypeSummary(row: EsignDocumentTypeRow): EsignTypeSummary {
  return {
    // esign_document_type_key_check mirrors ESIGN_DOC_TYPES, so the cast is DB-guaranteed.
    documentType: row.document_type as EsignDocType,
    label: row.label,
    requireSmsOtp: row.require_sms_otp,
    activatesEngagement: row.activates_engagement,
    expiryDays: row.expiry_days,
    allowedContentTypes: row.allowed_content_types,
  };
}

export const FILL_KEYS = ["provider_legal_name", "provider_name", "provider_contact_email", "client_legal_name", "document_title"] as const;
export type FillKey = (typeof FILL_KEYS)[number];

/** Accepts exactly `{{key}}` for keys in FILL_KEYS with a non-empty value; anything else is reported missing. */
export function fillTemplate(tpl: string, vars: Record<FillKey, string>): { ok: true; text: string } | { ok: false; missing: string[] } {
  const missing = new Set<string>();
  const text = tpl.replace(/\{\{([^{}]*)\}\}/g, (whole, key: string) => {
    const value = (FILL_KEYS as readonly string[]).includes(key) ? vars[key as FillKey] : undefined;
    if (typeof value !== "string" || value.trim() === "") {
      missing.add(key || whole);
      return whole;
    }
    return value.trim();
  });
  // A stray or malformed brace pair is an unfilled field too.
  if (missing.size === 0 && (text.includes("{{") || text.includes("}}"))) missing.add("{{…}}");
  return missing.size > 0 ? { ok: false, missing: [...missing] } : { ok: true, text };
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Valid addresses from notify_emails; falls back to CONTACT_NOTIFY_TO (the seed leaves the list empty in this public repo). */
export function notifyRecipients(row: EsignDocumentTypeRow): string[] {
  const list = Array.isArray(row.notify_emails) ? row.notify_emails : [];
  const emails = [
    ...new Set(
      list
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length <= 254 && EMAIL_RE.test(v))
    ),
  ];
  return emails.length > 0 ? emails : [CONTACT_NOTIFY_TO];
}
