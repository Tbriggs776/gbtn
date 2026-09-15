import type { StatusTone } from "@/lib/engagements/portal-model";
import { inGreatVibes } from "./fonts/great-vibes-charset";

// Shared e-sign vocabulary (v2: multi-signer envelopes). Deliberately NOT
// server-only: the signing page, the staff send wizard and the Documents UI
// import these types and pure helpers. Nothing here may touch a secret, the
// service role or a Node API.

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const ESIGN_DOC_TYPES = ["msa", "sow", "onboarding", "report", "deliverable", "other"] as const;
export type EsignDocType = (typeof ESIGN_DOC_TYPES)[number];
/** 32 random bytes, base64url, no padding. Signing tokens AND otpSession values. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const ENVELOPE_STATUSES = ["in_progress", "completing", "completed", "declined", "voided", "expired"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];
export const ENVELOPE_OPEN_STATUSES: readonly EnvelopeStatus[] = ["in_progress", "completing"];

export const RECIPIENT_STATUSES = ["pending", "sent", "viewed", "otp_sent", "otp_verified", "signed", "declined", "canceled"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];
export const RECIPIENT_ACTIVE_STATUSES: readonly RecipientStatus[] = ["sent", "viewed", "otp_sent", "otp_verified"];

export type RoutingMode = "parallel" | "sequential";
export type SourceMode = "pdf" | "image_pdf" | "certificate";
export type SealingMode = "auto" | "page" | "certificate";
export type RecipientKind = "client_contact" | "outside" | "staff";
export type FieldKind = "signature" | "date_signed" | "printed_name";
export type FieldOrigin = "detected" | "staff" | "generated";
export type SignatureMethod = "drawn" | "typed";
export type Rotation = 0 | 90 | 180 | 270;
export type RevokeReason = "rotated" | "closed" | "expired" | "replaced";

export const PPM = 1_000_000;
export const MAX_RECIPIENTS = 10;
export const MAX_FIELDS = 100;
export const TYPED_FONT_ID = "great-vibes-1";
/** The Documents UI offers Finish sealing once an envelope has been completing this long. */
export const FINISH_SEALING_AFTER_MS = 120_000;
/** Mirrors esign_abandon_seal's 30 minutes. */
export const ABANDON_SEAL_AFTER_MS = 1_800_000;

export function isEnvelopeOpen(s: string): boolean {
  return (ENVELOPE_OPEN_STATUSES as readonly string[]).includes(s);
}

/**
 * The status a viewer should see. An in_progress envelope past its expiry reads
 * as expired without a write (the sweep and the next transition persist it). A
 * completing envelope never expires: everyone has already signed.
 */
export function effectiveEnvelopeStatus(e: { status: string; expiresAt: string }, now: Date): EnvelopeStatus {
  const status: EnvelopeStatus = (ENVELOPE_STATUSES as readonly string[]).includes(e.status)
    ? (e.status as EnvelopeStatus)
    : "voided";
  if (status === "in_progress" && new Date(e.expiresAt).getTime() <= now.getTime()) return "expired";
  return status;
}

const ENVELOPE_LABELS: Record<EnvelopeStatus, string> = {
  in_progress: "In progress",
  completing: "Sealing",
  completed: "Completed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
};

const ENVELOPE_TONES: Record<EnvelopeStatus, StatusTone> = {
  in_progress: "upcoming",
  completing: "upcoming",
  completed: "live",
  declined: "alert",
  voided: "neutral",
  expired: "paused",
};

export function envelopeStatusLabel(s: EnvelopeStatus): string {
  return ENVELOPE_LABELS[s] ?? "Unknown";
}

export function envelopeStatusTone(s: EnvelopeStatus): StatusTone {
  return ENVELOPE_TONES[s] ?? "neutral";
}

const RECIPIENT_LABELS: Record<RecipientStatus, string> = {
  pending: "Waiting",
  sent: "Sent",
  viewed: "Viewed",
  otp_sent: "Code sent",
  otp_verified: "Verified",
  signed: "Signed",
  declined: "Declined",
  canceled: "Canceled",
};

const RECIPIENT_TONES: Record<RecipientStatus, StatusTone> = {
  pending: "neutral",
  sent: "upcoming",
  viewed: "upcoming",
  otp_sent: "upcoming",
  otp_verified: "upcoming",
  signed: "live",
  declined: "alert",
  canceled: "neutral",
};

export function recipientStatusLabel(s: RecipientStatus): string {
  return RECIPIENT_LABELS[s] ?? "Unknown";
}

export function recipientStatusTone(s: RecipientStatus): StatusTone {
  return RECIPIENT_TONES[s] ?? "neutral";
}

// ── Signer text (C22/C23): used by the engine AND the signing UI ──────────

/** NFC, collapse every whitespace run to one space, trim. Printed names and typed signatures both go through this. */
export function normalizeSignerText(s: string): string {
  return String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * true when every code point of the normalized text can be drawn by the pinned
 * typed-signature face: at least U+0020, not U+FFFF, outside the private-use
 * block, and present in the Great Vibes cmap. Callers check length (2-120).
 */
export function typedCharsetOk(text: string): boolean {
  const normalized = normalizeSignerText(text);
  if (!normalized) return false;
  for (const ch of normalized) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0xffff || (cp >= 0xe000 && cp <= 0xf8ff) || !inGreatVibes(cp)) return false;
  }
  return true;
}

/** engine.ts DEFAULT_TIME_ZONE: what an invalid or missing signer time zone falls back to. */
const SIGNER_DEFAULT_TIME_ZONE = "America/Phoenix";

/**
 * The "Date signed" text, formatted exactly as engine.ts submitRecipient step 8
 * stores it and seal.ts stamps it: en-US, dateStyle medium, in the signer's
 * time zone (validated the way the engine's validTimeZone does), NFKC. The
 * signing page previews with this so the box shows what the seal will stamp.
 */
export function signedDateText(timeZone: string, at: Date): string {
  const trimmed = (timeZone ?? "").trim();
  let tz = SIGNER_DEFAULT_TIME_ZONE;
  if (trimmed && trimmed.length <= 64) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
      tz = trimmed;
    } catch {
      tz = SIGNER_DEFAULT_TIME_ZONE;
    }
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium" }).format(at).normalize("NFKC");
}

// ── Geometry (hashed) ───────────────────────────────────────────────────────

export type FieldRect = { page: number; x_ppm: number; y_ppm: number; w_ppm: number; h_ppm: number };
export type EsignField = FieldRect & {
  id: string; recipient_id: string; kind: FieldKind; required: boolean;
  origin: FieldOrigin; detected_label: string | null;
};
/** box_mpt = [x, y, w, h] of the effective view box in integer millipoints. */
export type SnapshotPage = { index: number; rotate: Rotation; box_mpt: [number, number, number, number] };

// ── Snapshot v2 (hashed into document_hash) ─────────────────────────────────

export type UploaderRole = "admin" | "employee" | "client" | null;
export type EsignUploaderInfo = { name: string | null; role: UploaderRole };

export function isStaffRole(role: UploaderRole): boolean {
  return role === "admin" || role === "employee";
}

export type SnapshotRecipient = {
  id: string; kind: RecipientKind; routing_order: number; name: string; email: string;
  phone_e164: string | null; contact_id: string | null; staff_user_id: string | null; require_sms_otp: boolean;
};
export type SnapshotConversion =
  | { tool: "pdf-lib@1.17.1"; profile: "img2pdf-v1"; orientation: number; pixel_w: number; pixel_h: number }
  | { tool: "pdf-lib@1.17.1"; profile: "sigpage-v1" }
  | null;
export type EsignSnapshotV2 = {
  v: 2;
  provider: { legal_name: string; name: string };
  client: { id: string; name: string; legal_name: string | null };
  document: {
    id: string; title: string; doc_type: EsignDocType; doc_type_label: string; version: number;
    effective_date: string | null; category: string; uploaded_by: string | null; uploader_role: UploaderRole;
  };
  engagement: { id: string; name: string; offer_rung: string | null } | null;
  source: {
    bucket: "client-files"; storage_path: string; file_name: string; content_type_declared: string | null;
    content_type_sniffed: string; extension: string; byte_size: number; sha256: string;
  };
  mode: SourceMode;
  routing: RoutingMode;
  render: { sha256: string; page_count: number; conversion: SnapshotConversion };
  pages: SnapshotPage[];            // index asc
  recipients: SnapshotRecipient[];  // routing_order asc, then id asc
  fields: EsignField[];             // page asc, then id asc
  expires_at: string;               // isoMs
};

// ── Staff view models ───────────────────────────────────────────────────────

export type EsignTypeSummary = {
  documentType: EsignDocType; label: string; requireSmsOtp: boolean; activatesEngagement: boolean;
  expiryDays: number; allowedContentTypes: string[]; sealingMode: SealingMode;
  maxRecipients: number; allowTypedSignature: boolean; allowOutsideSigners: boolean;
};
export type StaffSignerOption = { userId: string; name: string; email: string; role: "admin" };
export type EsignContactOption = { id: string; full_name: string; title: string | null; email: string | null; phone: string | null; is_primary: boolean };
export type EsignEngagementOption = { id: string; name: string; status: string };
export type RecipientSummary = {
  id: string; kind: RecipientKind; order: number; name: string; email: string;
  status: RecipientStatus; activatedAt: string | null; viewedAt: string | null; signedAt: string | null;
  method: SignatureMethod | null;
};
export type EnvelopeSummary = {
  id: string; documentId: string; status: EnvelopeStatus; routing: RoutingMode;
  sourceMode: SourceMode; sentAt: string; expiresAt: string; completedAt: string | null; completingAt: string | null;
  sealAttempts: number; sealNextAttemptAt: string | null;
  recipients: RecipientSummary[];   // order asc, then id asc
};
export type EsignStaffData = {
  clientId: string;
  types: EsignTypeSummary[];                              // enabled types only
  contacts: EsignContactOption[];                         // primary first
  engagements: EsignEngagementOption[];
  staffSigners: StaffSignerOption[];                      // platform admins (S1)
  envelopesByDocument: Record<string, EnvelopeSummary>;   // latest envelope per document
  uploaders: Record<string, EsignUploaderInfo>;           // key = profiles.id (documents.uploaded_by)
};

/** A pending recipient whose predecessors have all signed (C3 "Send link now"). */
export function canActivateRecipient(e: EnvelopeSummary, recipientId: string): boolean {
  if (e.status !== "in_progress") return false;
  const target = e.recipients.find((r) => r.id === recipientId);
  if (!target || target.status !== "pending") return false;
  return e.recipients.every((r) => r.id === target.id || r.order >= target.order || r.status === "signed");
}

export type EligibilityDoc = {
  client_id: string; storage_path: string; status: string; doc_type: string | null; signed_at: string | null;
  category: string; content_type: string | null;
};
export type SendEligibility = { ok: true; warning?: string } | { ok: false; reason: string };

/** Never sendable, whatever a type's allowedContentTypes says (S6). The real bytes are sniffed at send anyway. */
const REFUSED_CONTENT_TYPES = new Set(["text/html", "image/svg+xml", "application/msword", "application/vnd.ms-excel"]);
const FILE_TYPE_REFUSED = "This file type can't be sent for signature.";

/**
 * Friendly pre-check for the send wizard and the engine. It mirrors
 * esign_create_envelope, which stays authoritative. First failure wins. Open =
 * effective status in_progress (blocks unless replaceOpen), or completing
 * (always blocks).
 */
export function sendEligibility(
  doc: EligibilityDoc, type: EsignTypeSummary | null, latest: EnvelopeSummary | null,
  uploader: EsignUploaderInfo | null, opts: { replaceOpen: boolean; now: Date }
): SendEligibility {
  if (!type) return { ok: false, reason: "E-signature isn't enabled for this document type." };
  if (doc.signed_at) return { ok: false, reason: "Already signed." };
  if (doc.status === "superseded") return { ok: false, reason: "This document is superseded." };
  if (doc.category === "Financials") return { ok: false, reason: "Financial files can't be sent for signature." };
  if (doc.status === "executed" && doc.doc_type) return { ok: false, reason: "This agreement is already executed." };
  if (doc.doc_type && doc.doc_type !== type.documentType) {
    return { ok: false, reason: `This document is filed as ${doc.doc_type}; send it as that type.` };
  }
  if (doc.storage_path.split("/")[0] !== doc.client_id) {
    return { ok: false, reason: "This file isn't stored under this client." };
  }
  if (latest) {
    const effective = effectiveEnvelopeStatus(latest, opts.now);
    if (effective === "completing") {
      return { ok: false, reason: "Everyone has signed and the executed copy is being sealed." };
    }
    if (effective === "in_progress" && !opts.replaceOpen) {
      return { ok: false, reason: "A signature envelope is already open. Void it first." };
    }
  }
  if (type.activatesEngagement && !isStaffRole(uploader?.role ?? null)) {
    return { ok: false, reason: `Only files uploaded by GBTN staff can be sent as a ${type.label}. Upload the agreement yourself.` };
  }

  const warnings: string[] = [];
  const contentType = (doc.content_type ?? "").split(";")[0].trim().toLowerCase();
  if (contentType === "" || contentType === "application/octet-stream") {
    warnings.push("File type unknown; it's checked when you send.");
  } else if (
    REFUSED_CONTENT_TYPES.has(contentType) ||
    !type.allowedContentTypes.some((t) => t.trim().toLowerCase() === contentType)
  ) {
    return { ok: false, reason: FILE_TYPE_REFUSED };
  }
  if (doc.doc_type === null && doc.status === "executed") {
    warnings.push("This file is labelled Executed by default; sending marks it Sent for signature.");
  }
  return warnings.length > 0 ? { ok: true, warning: warnings.join(" ") } : { ok: true };
}

export type DocumentStatusDoc = {
  status: string; doc_type: string | null; esign_envelope_id: string | null; signature_expires_at: string | null;
};

/**
 * Lifecycle pill for a documents row. Plain uploads (doc_type null) get no pill.
 * "Sent" without an envelope pointer is a seeded or manually-sent agreement,
 * never "Sent for signature".
 *
 * `envelope` is the document's latest envelope: the staff view model for staff,
 * or a status-only {id, status, expiresAt} the documents page loads for clients.
 * Everyone has signed a completing envelope, so it reads "Signed, finishing" and
 * never expired. 0032 also clears signature_expires_at on the move to
 * completing, so even without envelope data the label never says expired.
 */
export function documentStatusLabel(
  doc: DocumentStatusDoc, now: Date, envelope: { id: string; status: string; expiresAt: string } | null = null
): { label: string; tone: StatusTone } | null {
  if (doc.doc_type === null) return null;
  switch (doc.status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "executed":
      return { label: "Executed", tone: "live" };
    case "superseded":
      return { label: "Superseded", tone: "neutral" };
    case "sent":
      if (
        doc.esign_envelope_id &&
        envelope &&
        envelope.id === doc.esign_envelope_id &&
        (effectiveEnvelopeStatus(envelope, now) === "completing" || envelope.status === "completed")
      ) {
        return { label: "Signed, finishing", tone: "upcoming" };
      }
      if (doc.esign_envelope_id && doc.signature_expires_at) {
        return new Date(doc.signature_expires_at).getTime() > now.getTime()
          ? { label: "Sent for signature", tone: "upcoming" }
          : { label: "Signature link expired", tone: "paused" };
      }
      return { label: "Sent", tone: "upcoming" };
    default:
      return null;
  }
}

// ── Staff send input (what the wizard posts) ────────────────────────────────

/** key = a client-side temp key ("r1", "r2"…). The SERVER assigns every uuid. */
export type SendRecipientInput =
  | { key: string; kind: "client_contact"; order: number; contactId: string }
  | { key: string; kind: "outside"; order: number; fullName: string; email: string; phone?: string }
  | { key: string; kind: "staff"; order: number; staffUserId: string };
export type SendFieldInput = {
  recipientKey: string; kind: FieldKind; page: number;
  x_ppm: number; y_ppm: number; w_ppm: number; h_ppm: number; required: boolean;
  origin: "detected" | "staff"; detectedLabel: string | null;
};
export type SendEnvelopeInput = {
  clientId: string; documentId: string; documentType: EsignDocType;
  engagementId: string | null; routing: RoutingMode; recipients: SendRecipientInput[]; fields: SendFieldInput[];
  /** sha256 of the original bytes the placer rendered. Refused on mismatch. */
  sourceSha256: string;
  /** pdf: the pages the placer verified (C16); image_pdf: [the Letter page]; certificate: []. */
  pages: SnapshotPage[];
  supersedeSiblings: boolean; replaceOpen: boolean;
};

export type PreparedSource =
  | { mode: "pdf"; previewUrl: string; sha256: string; fileName: string; byteSize: number; pages: SnapshotPage[] }
  | { mode: "image_pdf"; previewUrl: string; sha256: string; fileName: string; byteSize: number;
      imageContentType: "image/png" | "image/jpeg"; page: SnapshotPage; imageRect: FieldRect }
  | { mode: "certificate"; sha256: string; fileName: string; byteSize: number; contentTypeSniffed: string; extension: string };

// ── Signer view (never paths, other recipients' emails/names, or the envelope id) ─

export type ViewField = { id: string; kind: FieldKind; page: number; x_ppm: number; y_ppm: number;
  w_ppm: number; h_ppm: number; required: boolean };
export type OtherField = { page: number; x_ppm: number; y_ppm: number; w_ppm: number; h_ppm: number;
  kind: FieldKind; signed: boolean };
export type SigningView =
  | { state: "invalid" }
  | { state: "expired" | "voided" | "declined"; title: string }
  | { state: "signed_waiting"; title: string; signedAt: string; emailMasked: string; remaining: number }
  | { state: "completing"; title: string; signedAt: string | null }
  | { state: "completed"; title: string; completedAt: string; emailMasked: string; sealedDownloadAvailable: boolean }
  | { state: "open"; title: string; docTypeLabel: string; version: number; clientName: string; providerName: string;
      recipientName: string; routing: RoutingMode; position: { order: number; total: number } | null;
      signerCount: number; mode: SourceMode; pageCount: number; renderSha256: string; pages: SnapshotPage[];
      fields: ViewField[]; otherFields: OtherField[];
      original: { fileName: string; contentType: string; byteSize: number; sha256: string } | null;  // certificate only
      consentText: string; checkboxText: string; expiresAt: string; viewed: boolean;
      requireOtp: boolean; phoneMask: string | null; otpResendAvailableAt: string | null;
      allowTypedSignature: boolean; requireStaffSession: boolean };

// ── API wire types (app/api/esign/route.ts ↔ components/esign/signing-flow.tsx) ──

export type EsignErrorCode =
  | "bad_request" | "unsupported_media_type" | "forbidden_origin" | "payload_too_large"
  | "not_found" | "expired" | "closed" | "already_signed" | "document_changed" | "signature_invalid"
  | "otp_required" | "otp_not_required" | "otp_incorrect" | "otp_code_expired" | "otp_locked"
  | "otp_cooldown" | "otp_limit" | "sms_failed" | "download_expired" | "server_error"
  | "typed_unsupported" | "name_unsupported" | "fields_incomplete" | "out_of_order"
  | "staff_session_required" | "not_available" | "not_active";
export const ESIGN_ERROR_STATUS: Record<EsignErrorCode, number> = {
  bad_request: 400, unsupported_media_type: 415, forbidden_origin: 403, payload_too_large: 413,
  not_found: 404, expired: 410, closed: 409, already_signed: 409, document_changed: 409, signature_invalid: 400,
  otp_required: 403, otp_not_required: 400, otp_incorrect: 400, otp_code_expired: 400, otp_locked: 429,
  otp_cooldown: 429, otp_limit: 429, sms_failed: 502, download_expired: 410, server_error: 500,
  typed_unsupported: 400, name_unsupported: 400, fields_incomplete: 400, out_of_order: 409,
  staff_session_required: 403, not_available: 404, not_active: 409,
};
export type EsignApiError = { code: EsignErrorCode; message: string; resendAvailableAt?: string };
export type EsignApiResult<T> = { ok: true; data: T } | { ok: false; error: EsignApiError };

export type SubmitSignature = { method: "drawn"; png: string; inkLength: number } | { method: "typed"; text: string };
export type EsignRequestBody =
  | { action: "get"; token: string }
  | { action: "view"; token: string }
  | { action: "source_url"; token: string }
  | { action: "original_url"; token: string }
  | { action: "send_otp"; token: string }
  | { action: "verify_otp"; token: string; code: string }
  | { action: "submit"; token: string; consent: true; printedName: string; timeZone: string;
      signature: SubmitSignature; appliedFieldIds: string[]; otpSession?: string }
  | { action: "decline"; token: string; reason?: string; otpSession?: string }
  | { action: "sealed_url"; token: string };
export type EsignAction = EsignRequestBody["action"];
export type EsignResponseData = {
  get: SigningView;
  view: SigningView;
  source_url: { url: string; fileName: string; sha256: string };
  original_url: { url: string; fileName: string };
  send_otp: { resendAvailableAt: string; phoneMask: string | null };
  verify_otp: { verified: true; otpSession: string; sessionExpiresAt: string };
  submit: SigningView;
  decline: SigningView;
  sealed_url: { url: string };
};
/** app/api/esign/seal/route.ts */
export type EsignSealBody = { action: "seal"; token: string };
export type EsignSealResponse = EsignApiResult<SigningView>;
