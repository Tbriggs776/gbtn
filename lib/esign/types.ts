import type { StatusTone } from "@/lib/engagements/portal-model";

// Shared e-sign vocabulary. Deliberately NOT server-only: the signing page and
// the staff Documents UI import these types and pure helpers. Nothing here may
// touch a secret, the service role or a Node API.

export const ESIGN_STATUSES = ["sent", "viewed", "otp_sent", "otp_verified", "signed", "declined", "expired", "voided"] as const;
export type EsignStatus = (typeof ESIGN_STATUSES)[number];
export const ESIGN_OPEN_STATUSES: readonly EsignStatus[] = ["sent", "viewed", "otp_sent", "otp_verified"];
export const ESIGN_DOC_TYPES = ["msa", "sow", "onboarding", "report", "deliverable", "other"] as const;
export type EsignDocType = (typeof ESIGN_DOC_TYPES)[number];
/** 32 random bytes, base64url, no padding. Signing tokens AND otpSession values. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isOpenStatus(s: string): boolean {
  return (ESIGN_OPEN_STATUSES as readonly string[]).includes(s);
}

/**
 * The status a viewer should see. The DB only flips an open request to
 * `expired` lazily (on the next signer touch or create), so an open row whose
 * expiry has passed is shown as expired without waiting for that sweep.
 */
export function effectiveStatus(r: { status: string; expiresAt: string }, now: Date): EsignStatus {
  if (isOpenStatus(r.status) && new Date(r.expiresAt).getTime() <= now.getTime()) return "expired";
  return r.status as EsignStatus;
}

const STATUS_LABELS: Record<EsignStatus, string> = {
  sent: "Sent",
  viewed: "Viewed",
  otp_sent: "Code sent",
  otp_verified: "Verified",
  signed: "Signed",
  declined: "Declined",
  expired: "Expired",
  voided: "Voided",
};

export function esignStatusLabel(s: string): string {
  return STATUS_LABELS[s as EsignStatus] ?? "Unknown";
}

export function esignStatusTone(s: string): StatusTone {
  switch (s) {
    case "sent":
    case "viewed":
    case "otp_sent":
    case "otp_verified":
      return "upcoming";
    case "signed":
      return "live";
    case "declined":
      return "alert";
    case "expired":
      return "paused";
    default:
      return "neutral";
  }
}

export type DocumentStatusDoc = {
  status: string; doc_type: string | null; signature_request_id: string | null; signature_expires_at: string | null;
};

/**
 * Lifecycle pill for a documents row, identical for every viewer. Plain uploads
 * (doc_type null) get no pill. "Sent" without a request pointer is a seeded or
 * manually-sent agreement, never "Sent for signature".
 */
export function documentStatusLabel(doc: DocumentStatusDoc, now: Date): { label: string; tone: StatusTone } | null {
  if (doc.doc_type === null) return null;
  switch (doc.status) {
    case "draft":
      return { label: "Draft", tone: "neutral" };
    case "executed":
      return { label: "Executed", tone: "live" };
    case "superseded":
      return { label: "Superseded", tone: "neutral" };
    case "sent":
      if (doc.signature_request_id && doc.signature_expires_at) {
        return new Date(doc.signature_expires_at).getTime() > now.getTime()
          ? { label: "Sent for signature", tone: "upcoming" }
          : { label: "Signature link expired", tone: "paused" };
      }
      return { label: "Sent", tone: "upcoming" };
    default:
      return null;
  }
}

export type UploaderRole = "admin" | "employee" | "client" | null;
export type EsignUploaderInfo = { name: string | null; role: UploaderRole };

export function isStaffRole(role: UploaderRole): boolean {
  return role === "admin" || role === "employee";
}

export type EsignTypeSummary = {
  documentType: EsignDocType; label: string; requireSmsOtp: boolean; activatesEngagement: boolean;
  expiryDays: number; allowedContentTypes: string[];
};
export type StaffRequestSummary = {
  id: string; documentId: string; status: EsignStatus; signerName: string; signerEmail: string;
  sentAt: string; viewedAt: string | null; signedAt: string | null; expiresAt: string;
};
export type EsignContactOption = { id: string; full_name: string; title: string | null; email: string | null; phone: string | null; is_primary: boolean };
export type EsignEngagementOption = { id: string; name: string; status: string };
export type EsignStaffData = {
  clientId: string;
  types: EsignTypeSummary[];                             // enabled types only
  contacts: EsignContactOption[];                        // primary first
  engagements: EsignEngagementOption[];
  latestByDocument: Record<string, StaffRequestSummary>; // key = document id
  uploaders: Record<string, EsignUploaderInfo>;          // key = profiles.id (documents.uploaded_by)
};

export type EligibilityDoc = {
  client_id: string; storage_path: string; status: string; doc_type: string | null; signed_at: string | null;
  category: string; content_type: string | null;
};
export type SendEligibility = { ok: true; warning?: string } | { ok: false; reason: string };

/**
 * Friendly pre-check for the send dialog and the engine. It mirrors
 * esign_create_request, which stays authoritative. First failure wins.
 */
export function sendEligibility(
  doc: EligibilityDoc, type: EsignTypeSummary | null, latest: StaffRequestSummary | null,
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
  if (!opts.replaceOpen && latest && isOpenStatus(effectiveStatus(latest, opts.now))) {
    return { ok: false, reason: "A signature request is already open. Void or resend it." };
  }
  if (type.activatesEngagement && !isStaffRole(uploader?.role ?? null)) {
    return { ok: false, reason: `Only files uploaded by GBTN staff can be sent as a ${type.label}. Upload the agreement yourself.` };
  }

  const warnings: string[] = [];
  const contentType = (doc.content_type ?? "").trim().toLowerCase();
  if (contentType === "" || contentType === "application/octet-stream") {
    warnings.push("File type unknown; it's checked when you send.");
  } else if (contentType !== "application/pdf") {
    return { ok: false, reason: "Upload a PDF of this agreement to send it for signature." };
  }
  if (doc.doc_type === null && doc.status === "executed") {
    warnings.push("This file is labelled Executed by default; sending marks it Sent for signature.");
  }
  return warnings.length > 0 ? { ok: true, warning: warnings.join(" ") } : { ok: true };
}

export type SendForSignatureInput = {
  clientId: string; documentId: string; documentType: EsignDocType; engagementId: string | null;
  signer: { kind: "contact"; contactId: string } | { kind: "manual"; fullName: string; email: string; phone?: string };
  supersedeSiblings: boolean;
};

/** Hashed into document_hash via canonicalJson, so only strings, booleans, null and safe integers. */
export type EsignSnapshot = {
  v: 1;
  provider: { legal_name: string; name: string };               // site.legalName, site.name
  client: { id: string; name: string; legal_name: string | null };
  document: { id: string; title: string; doc_type: EsignDocType; doc_type_label: string; version: number;
              effective_date: string | null; category: string;
              uploaded_by: string | null; uploader_role: UploaderRole };
  engagement: { id: string; name: string; offer_rung: string | null } | null;
  source: { bucket: "client-files"; storage_path: string; file_name: string; content_type: "application/pdf";
            byte_size: number; sha256: string; page_count: number };
  signer: { name: string; email: string; phone_e164: string | null; contact_id: string | null };
  expires_at: string;
};

export type SigningView =
  | { state: "invalid" }
  | { state: "expired" | "voided" | "declined"; title: string }
  | { state: "signed"; title: string; signedAt: string; signerEmailMasked: string; sealedDownloadAvailable: boolean }
  | { state: "open"; title: string; docTypeLabel: string; version: number; fileName: string; byteSize: number;
      pageCount: number; sourceSha256: string; clientName: string; providerName: string; signerName: string;
      consentText: string; checkboxText: string; expiresAt: string;
      viewed: boolean;                         // viewed_at is set (skip the Review gate)
      requireOtp: boolean; phoneMask: string | null; otpResendAvailableAt: string | null };
export type SignedView = Extract<SigningView, { state: "signed" }>;

// ── API wire types (app/api/esign/route.ts ↔ components/esign/signing-flow.tsx) ──

export type EsignErrorCode =
  | "bad_request" | "unsupported_media_type" | "forbidden_origin" | "payload_too_large"
  | "not_found" | "expired" | "closed" | "already_signed" | "document_changed" | "signature_invalid"
  | "otp_required" | "otp_not_required" | "otp_incorrect" | "otp_code_expired" | "otp_locked"
  | "otp_cooldown" | "otp_limit" | "sms_failed" | "download_expired" | "server_error";
export const ESIGN_ERROR_STATUS: Record<EsignErrorCode, number> = {
  bad_request: 400, unsupported_media_type: 415, forbidden_origin: 403, payload_too_large: 413,
  not_found: 404, expired: 410, closed: 409, already_signed: 409, document_changed: 409, signature_invalid: 400,
  otp_required: 403, otp_not_required: 400, otp_incorrect: 400, otp_code_expired: 400, otp_locked: 429,
  otp_cooldown: 429, otp_limit: 429, sms_failed: 502, download_expired: 410, server_error: 500,
};
export type EsignApiError = { code: EsignErrorCode; message: string; resendAvailableAt?: string };
export type EsignApiResult<T> = { ok: true; data: T } | { ok: false; error: EsignApiError };

export type EsignRequestBody =
  | { action: "get"; token: string }
  | { action: "view"; token: string }
  | { action: "source_url"; token: string }
  | { action: "send_otp"; token: string }
  | { action: "verify_otp"; token: string; code: string }
  | { action: "submit"; token: string; consent: true; printedName: string; signaturePng: string; inkLength: number; otpSession?: string }
  | { action: "decline"; token: string; reason?: string; otpSession?: string }
  | { action: "sealed_url"; token: string };
export type EsignAction = EsignRequestBody["action"];
export type EsignResponseData = {
  get: SigningView;
  view: SigningView;
  source_url: { url: string; fileName: string };
  send_otp: { resendAvailableAt: string; phoneMask: string | null };
  verify_otp: { verified: true; otpSession: string; sessionExpiresAt: string };
  submit: SignedView;
  decline: SigningView;
  sealed_url: { url: string };
};
