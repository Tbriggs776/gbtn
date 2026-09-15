import "server-only";
import { NextResponse } from "next/server";
import { ESIGN_ERROR_STATUS, type EsignApiResult, type EsignErrorCode } from "./types";

// Two error families. EsignError is the signer (token) routes': it carries an
// HTTP status and a message safe to show a signer. EsignStaffError is the staff
// server actions': staffMessage() turns it into a sentence and never lets a raw
// DB message through. SQL functions raise their code as the message
// ("esign_open_envelope_exists", "esign_tenant_mismatch: supersede …"), which is
// what the mappers below key on.

export class EsignError extends Error {
  readonly code: EsignErrorCode;
  readonly status: number;
  readonly resendAvailableAt?: string;

  constructor(code: EsignErrorCode, message: string, opts?: { resendAvailableAt?: string }) {
    super(message);
    this.name = "EsignError";
    this.code = code;
    this.status = ESIGN_ERROR_STATUS[code];
    if (opts?.resendAvailableAt) this.resendAvailableAt = opts.resendAvailableAt;
  }
}

const GENERIC_SIGNER_MESSAGE = "Something went wrong. Please try again.";

/** Every token-route response: never cached, never indexed, never leaks a Referer. */
export function esignJson<T>(body: EsignApiResult<T>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function toResponse(e: unknown): NextResponse {
  if (e instanceof EsignError) {
    return esignJson<never>(
      {
        ok: false,
        error: {
          code: e.code,
          message: e.message,
          ...(e.resendAvailableAt ? { resendAvailableAt: e.resendAvailableAt } : {}),
        },
      },
      e.status
    );
  }
  return esignJson<never>({ ok: false, error: { code: "server_error", message: GENERIC_SIGNER_MESSAGE } }, 500);
}

const SIGNER_DB_ERRORS: Partial<Record<EsignErrorCode, string>> = {
  not_found: "This signing link isn't valid.",
  already_signed: "You've already signed this document.",
  closed: "This signing request is no longer open.",
  expired: "This signing link has expired.",
  otp_required: "Verify your phone to continue.",
  document_changed: "This document changed after it was sent. GBTN has been notified and will send a new link.",
};

function signerError(code: EsignErrorCode): EsignError {
  return new EsignError(code, SIGNER_DB_ERRORS[code] ?? GENERIC_SIGNER_MESSAGE);
}

/** Maps a raised SQL exception to the signer error. Unknown and internal codes become server_error. */
export function fromDbError(e: { message?: string; code?: string } | null | undefined): EsignError {
  const message = (e?.message ?? "").trim();
  if (message.startsWith("esign_closed:")) return signerError("closed");
  switch (message) {
    case "esign_not_found":
      return signerError("not_found");
    case "esign_already_signed":
      return signerError("already_signed");
    case "esign_expired":
      return signerError("expired");
    case "esign_otp_required":
      return signerError("otp_required");
    case "esign_document_changed":
    case "esign_source_changed":
      return signerError("document_changed");
    // Shape guards in esign_record_signature: an app bug, never the signer's fault.
    case "esign_bad_signature":
    case "esign_bad_artifact_path":
    case "esign_bad_timestamp":
      return new EsignError("server_error", GENERIC_SIGNER_MESSAGE);
    default:
      return new EsignError("server_error", GENERIC_SIGNER_MESSAGE);
  }
}

export type EsignStaffCode =
  | "forbidden" | "type_disabled" | "document_not_found" | "document_not_eligible" | "doc_type_mismatch"
  | "engagement_mismatch" | "source_changed" | "open_envelope_exists" | "uploader_not_staff" | "rate_limited"
  | "tenant_mismatch" | "bad_expiry" | "pdf_rejected" | "image_rejected" | "file_rejected" | "file_name_invalid"
  | "contact_not_found" | "contact_no_email" | "invalid_email" | "phone_required" | "template_incomplete"
  | "already_signed" | "storage_failed" | "bad_recipients" | "countersigner_not_staff" | "bad_fields"
  | "fields_invalid" | "bad_mode" | "pages_mismatch" | "envelope_not_found" | "recipient_not_active"
  | "out_of_order" | "not_completing" | "sealing_now" | "abandon_too_soon" | "unknown";

const STAFF_MESSAGES: Record<EsignStaffCode, string> = {
  forbidden: "You don't have access to this.",
  type_disabled: "E-signature isn't enabled for that document type.",
  document_not_found: "Document not found.",
  document_not_eligible: "This document can't be sent for signature.",
  doc_type_mismatch: "This document is filed as a different type. Send it as that type.",
  engagement_mismatch: "That engagement doesn't belong with this document.",
  source_changed: "The file changed after you opened it. Reopen the dialog.",
  open_envelope_exists: "A signature envelope is already open for this document.",
  uploader_not_staff: "Only files uploaded by GBTN staff can be sent for this type.",
  rate_limited: "Too many sends for this document today. Try again tomorrow.",
  tenant_mismatch: "That record belongs to a different client.",
  bad_expiry: "The link expiry is out of range. Check the e-sign settings for this type.",
  pdf_rejected: "This PDF can't be sent for signature. Export a clean copy and upload it again.",
  image_rejected: "This image can't be converted. Export it as a JPEG or PNG and upload it again.",
  file_rejected:
    "This file type can't be sent for signature. Upload a PDF, image, Word, Excel, PowerPoint, text or CSV file without macros or links.",
  file_name_invalid: "This file's name is longer than 400 characters. Upload it again with a shorter name, then send it.",
  contact_not_found: "That contact wasn't found for this client.",
  contact_no_email: "This contact has no email. Add one or enter the signer manually.",
  invalid_email: "Enter a valid email address for the signer.",
  phone_required: "A mobile number is required because this type needs an SMS code.",
  template_incomplete: "The consent text has unfilled fields. Ask Tyler to fix the e-sign settings.",
  already_signed: "This document has already been signed.",
  storage_failed: "The file couldn't be frozen for signing. Nothing was sent.",
  bad_recipients: "Check the signers: each needs a unique email, and the order must be 1, 2, 3…",
  countersigner_not_staff: "That countersigner isn't a GBTN admin. Only GBTN admins can countersign.",
  bad_fields: "Some signature boxes are off the page or too small.",
  fields_invalid: "Some signature boxes are off the page or too small.",
  bad_mode: "This document type can't be signed that way. Check its e-sign settings.",
  pages_mismatch: "This PDF's page boxes are ambiguous. Print it to PDF and upload it again.",
  envelope_not_found: "That signature envelope wasn't found.",
  recipient_not_active: "That signer isn't waiting on a link right now.",
  out_of_order: "Earlier signers haven't signed yet.",
  not_completing: "This envelope isn't waiting to be sealed.",
  sealing_now: "Sealing is running right now. Try again in a few minutes.",
  abandon_too_soon: "Give sealing 30 minutes before abandoning it.",
  unknown: "Something went wrong. Nothing was sent.",
};

export class EsignStaffError extends Error {
  readonly code: EsignStaffCode;

  constructor(code: EsignStaffCode, message?: string) {
    super(message ?? "");
    this.name = "EsignStaffError";
    this.code = code;
  }
}

function isStaffCode(s: string): s is EsignStaffCode {
  return Object.prototype.hasOwnProperty.call(STAFF_MESSAGES, s);
}

/** `esign_<code>[:detail]` → `<code>` when it is a staff code; a unique violation is a lost open-envelope race. */
export function staffErrorFromDb(e: { message?: string; code?: string } | null | undefined): EsignStaffError {
  const match = /^esign_([a-z_]+)/.exec((e?.message ?? "").trim());
  if (match && isStaffCode(match[1])) return new EsignStaffError(match[1]);
  if (e?.code === "23505") return new EsignStaffError("open_envelope_exists");
  return new EsignStaffError("unknown");
}

const ACCESS_MESSAGES = new Set(["GBTN staff access required.", "You don't have access to this."]);

/** The only text a staff action may return as `error`. */
export function staffMessage(e: unknown): string {
  if (e instanceof EsignStaffError) return e.message.trim() ? e.message : STAFF_MESSAGES[e.code];
  if (e instanceof Error && ACCESS_MESSAGES.has(e.message)) return "You don't have access to this.";
  return STAFF_MESSAGES.unknown;
}
