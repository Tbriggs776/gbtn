import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONTACT_NOTIFY_TO } from "@/lib/email";
import type { SniffKind } from "./sniff";
import {
  MAX_RECIPIENTS,
  type EsignDocType, type EsignTypeSummary, type RecipientKind, type SealingMode, type SourceMode,
} from "./types";

// Per-type e-sign configuration (esign_document_type) and the consent-template
// fill. The FILLED consent and checkbox text is what gets snapshotted, hashed
// and shown, so a template with an unknown or empty placeholder refuses to send
// rather than printing a blank into a legal notice.

export type EsignDocumentTypeRow = {
  document_type: string; label: string; esign_enabled: boolean; require_sms_otp: boolean;
  activates_engagement: boolean; allowed_content_types: string[]; consent_text: string; checkbox_text: string;
  expiry_days: number; notify_emails: unknown;
  sealing_mode: string; max_recipients: number; allow_typed_signature: boolean; allow_outside_signers: boolean;
  consent_text_outside: string | null; consent_text_staff: string | null;
};

const TYPE_COLUMNS =
  "document_type,label,esign_enabled,require_sms_otp,activates_engagement,allowed_content_types,consent_text,checkbox_text,expiry_days,notify_emails,sealing_mode,max_recipients,allow_typed_signature,allow_outside_signers,consent_text_outside,consent_text_staff";

const SEALING_MODES: readonly string[] = ["auto", "page", "certificate"];

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
    consent_text_outside: typeof data.consent_text_outside === "string" ? data.consent_text_outside : null,
    consent_text_staff: typeof data.consent_text_staff === "string" ? data.consent_text_staff : null,
  };
}

export function toTypeSummary(row: EsignDocumentTypeRow): EsignTypeSummary {
  const maxRecipients = Number(row.max_recipients);
  return {
    // esign_document_type_key_check mirrors ESIGN_DOC_TYPES, so the cast is DB-guaranteed.
    documentType: row.document_type as EsignDocType,
    label: row.label,
    requireSmsOtp: row.require_sms_otp,
    activatesEngagement: row.activates_engagement,
    expiryDays: row.expiry_days,
    allowedContentTypes: row.allowed_content_types,
    sealingMode: SEALING_MODES.includes(row.sealing_mode) ? (row.sealing_mode as SealingMode) : "auto",
    maxRecipients: Number.isSafeInteger(maxRecipients) ? Math.min(MAX_RECIPIENTS, Math.max(1, maxRecipients)) : MAX_RECIPIENTS,
    allowTypedSignature: row.allow_typed_signature !== false,
    allowOutsideSigners: row.allow_outside_signers !== false,
  };
}

/**
 * The unfilled consent and checkbox templates a recipient of this kind sees.
 * Outside signers and staff countersigners fall back to consent_text when their
 * own column is NULL (or blank). checkbox_text is shared by every kind.
 */
export function consentTemplatesFor(row: EsignDocumentTypeRow, kind: RecipientKind): { consent: string; checkbox: string } {
  const own = kind === "outside" ? row.consent_text_outside : kind === "staff" ? row.consent_text_staff : null;
  return {
    consent: typeof own === "string" && own.trim() !== "" ? own : row.consent_text,
    checkbox: row.checkbox_text,
  };
}

/**
 * How a sniffed file is signed under a type's sealing_mode.
 *  auto:        pdf → pdf, png|jpeg → image_pdf, docx|xlsx|pptx|text|csv → certificate
 *  page:        placed fields only; certificate kinds → null (refuse)
 *  certificate: everything, PDFs and images included, gets the certificate page
 */
export function resolveSourceMode(sealing: SealingMode, kind: SniffKind): SourceMode | null {
  if (sealing === "certificate") return "certificate";
  if (kind === "pdf") return "pdf";
  if (kind === "png" || kind === "jpeg") return "image_pdf";
  return sealing === "page" ? null : "certificate";
}

export const FILL_KEYS = [
  "provider_legal_name", "provider_name", "provider_contact_email", "client_legal_name", "document_title", "recipient_name",
] as const;
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
