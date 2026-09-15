import "server-only";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { sessionCan, type SessionContext } from "@/lib/auth";
import { toE164 } from "@/lib/crm/twilio";
import { CONTACT_NOTIFY_TO } from "@/lib/email";
import { site } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_FIELDS,
  MAX_RECIPIENTS,
  RECIPIENT_ACTIVE_STATUSES,
  TOKEN_RE,
  TYPED_FONT_ID,
  normalizeSignerText,
  sendEligibility,
  typedCharsetOk,
  type EnvelopeStatus,
  type EnvelopeSummary,
  type EsignErrorCode,
  type EsignField,
  type EsignResponseData,
  type EsignSnapshotV2,
  type EsignUploaderInfo,
  type FieldKind,
  type OtherField,
  type PreparedSource,
  type RecipientKind,
  type RoutingMode,
  type SendEnvelopeInput,
  type SignatureMethod,
  type SigningView,
  type SnapshotConversion,
  type SnapshotPage,
  type SnapshotRecipient,
  type SourceMode,
  type StaffSignerOption,
  type SubmitSignature,
  type UploaderRole,
  type ViewField,
} from "./types";
import { EsignError, EsignStaffError, fromDbError, staffErrorFromDb } from "./errors";
import { generateSigningToken, hashSigningToken, isWellFormedToken, signUrlFor } from "./token";
import {
  computeDocumentHashV2,
  computeEnvelopeHash,
  computeReceiptHash,
  computeRecipientHash,
  isoMs,
  sha256Hex,
  timingSafeEqualHex,
  type ReceiptInput,
} from "./hash";
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_SESSION_TTL_SECONDS,
  OTP_TTL_SECONDS,
  generateOtpCode,
  generateOtpSession,
  hashOtp,
  hashOtpSession,
  maskEmail,
  maskPhone,
} from "./otp";
import type { EsignRequestContext } from "./request-context";
import { parseSignatureDataUrl } from "./signature-image";
import {
  CLIENT_FILES_BUCKET,
  ESIGN_BUCKET,
  downloadObject,
  downloadObjectOrMissing,
  envelopeOriginalPath,
  envelopeRenderPath,
  envelopeSealedPath,
  isClientScopedPath,
  originalDownloadName,
  recipientSignaturePath,
  removeObjectsQuietly,
  sealedDownloadName,
  shortSignedUrl,
  uploadObject,
} from "./storage";
import {
  consentTemplatesFor,
  fillTemplate,
  loadDocumentType,
  notifyRecipients,
  resolveSourceMode,
  toTypeSummary,
  type EsignDocumentTypeRow,
} from "./config";
import {
  SOURCE_MAX_BYTES,
  buildSealedEnvelopePdf,
  inspectSourcePdf,
  probeSignaturePng,
  winAnsiLossless,
  type SealEvent,
  type SealRecipient,
} from "./seal";
import { ORIGINAL_MAX_BYTES_CERTIFICATE, SNIFF_TYPES, sniffFile, type SniffKind } from "./sniff";
import {
  IMAGE_INPUT_MAX_BYTES,
  JPEG_MAX_PIXELS,
  JPEG_MAX_SIDE,
  PNG_MAX_RAW_BYTES,
  PNG_MAX_SIDE,
  convertedStructureProbe,
  imageToPdf,
  readImageHeader,
  type ImageHeader,
} from "./conversion";
import { buildSignaturePage } from "./signature-page";
import { boxToMpt, imagePageLayout, pagesAgree, validateField } from "./geometry";
import {
  notifyRecipientsWithdrawn,
  notifyStaffClosed,
  notifyStaffCompleted,
  sendCompletedCopy,
  sendOtpSms,
  sendRecipientReceipt,
  sendSigningInvite,
  type NotifyResult,
} from "./notify";

// ───────────────────────────────────────────────────────────────────────────
// E-sign v2 orchestration (spec §D + addendum §3.12).
//
// Two entry surfaces call this file:
//   - Staff server actions (app/portal/documents/esign-actions.ts). The caller
//     ran assertStaff(); every function here re-checks sessionCan(documents)
//     on the named client AND on the REAL client_id of the row it loads, and
//     throws EsignStaffError.
//   - The signer routes (app/api/esign/route.ts, app/api/esign/seal/route.ts).
//     No session exists; the token is the capability. Every function checks
//     TOKEN_RE and resolves the token_hash before the service role reads
//     anything, and throws EsignError.
//
// Every state change is one SQL function (0032) that locks and re-checks; this
// file never writes signature_envelope, signature_recipient, tokens or
// documents directly. The only direct inserts are best-effort
// signature_envelope_event rows (notified / notify_failed / otp_send_failed).
//
// Sealing never runs inside a signer's submit (C11). It runs in the seal route
// (maxDuration 300) or staff Finish sealing, behind an exclusive SQL lease.
//
// Logging rule: envelope ids and error class names only. Never a token, an
// OTP code, a storage path, an email or row data.
// ───────────────────────────────────────────────────────────────────────────

export type CreateEnvelopeResult = {
  envelopeId: string;
  superseded: number;
  links: { recipientKey: string; recipientId: string; name: string; email: string; url: string | null; emailed: boolean }[];
};
export type CloseResult = "ok" | "not_found" | "expired" | "completing" | "completed" | "declined" | "voided";
export type ResendRecipientResult = { kind: "activated" | "rotated"; url: string; emailed: boolean; name: string };
export type FinishSealingResult =
  | "completed"
  | "already_completed"
  | "not_completing"
  | "sealing_now"
  | "backoff"
  | "retry_later"
  | "voided_drift";
export type AbandonSealResult = "ok" | "not_found" | "completed" | "not_completing" | "too_soon" | "sealing_now";

type Admin = ReturnType<typeof createAdminClient>;
type NotifyKind =
  | "invite"
  | "turn_invite"
  | "receipt"
  | "completed_copy"
  | "staff_completed"
  | "staff_closed"
  | "withdrawn";

const SEALED_DOWNLOAD_WINDOW_DAYS = 30;
const MIN_INK_LENGTH = 40;
const CREATES_PER_DOCUMENT_PER_DAY = 10;
const DAY_MS = 86_400_000;
const SEAL_LEASE_SECONDS = 240;
const CHAIN_RETRIES = 3;
const COMPLETION_NOTICE_WINDOW_MS = DAY_MS;
const DEFAULT_TIME_ZONE = "America/Phoenix";
const HEX64 = /^[0-9a-f]{64}$/;

const CLOSE_RESULTS: readonly CloseResult[] = ["ok", "not_found", "expired", "completing", "completed", "declined", "voided"];
const ABANDON_RESULTS: readonly AbandonSealResult[] = ["ok", "not_found", "completed", "not_completing", "too_soon", "sealing_now"];

// ── Signer-facing messages ─────────────────────────────────────────────────

const SIGNER_MESSAGES: Record<EsignErrorCode, string> = {
  bad_request: "Check your entry and try again.",
  unsupported_media_type: "This endpoint only accepts JSON.",
  forbidden_origin: "This request isn't allowed from another site.",
  payload_too_large: "That request is too large.",
  not_found: "This signing link isn't valid.",
  expired: "This signing link has expired.",
  closed: "This signing request is no longer open.",
  already_signed: "You've already signed this document.",
  document_changed:
    "This document changed after it was sent. GBTN has been notified and will send a new link.",
  signature_invalid: "We couldn't read your signature. Clear it, draw it again, and resubmit.",
  otp_required: "Verify your phone to continue.",
  otp_not_required: "This document doesn't need a phone code.",
  otp_incorrect: "That code isn't right. Check the text message and try again.",
  otp_code_expired: "That code has expired. Request a new one.",
  otp_locked: "Too many incorrect attempts. Request a new code.",
  otp_cooldown: "Please wait a moment before requesting another code.",
  otp_limit: "Too many codes have been requested for this link. Contact GBTN for a new link.",
  sms_failed: "We couldn't send the text message. Try again in a minute.",
  download_expired: "The download window has closed. Ask GBTN for a copy.",
  server_error: "Something went wrong. Please try again.",
  typed_unsupported: "Your name has characters the typed style can't show. Draw your signature instead.",
  name_unsupported: "Your printed name has characters we can't print on the document. Use Latin letters.",
  fields_incomplete: "Apply your signature to every required signature box, then submit.",
  out_of_order: "Earlier signers haven't signed yet. We'll email you when it's your turn.",
  staff_session_required: "Sign in to the GBTN portal as this countersigner in this browser, then try again.",
  not_available: "That isn't available for this document.",
  not_active: "Your link isn't active yet. We'll email you when it's your turn.",
};

function signerError(code: EsignErrorCode, opts?: { resendAvailableAt?: string; message?: string }): EsignError {
  return new EsignError(
    code,
    opts?.message ?? SIGNER_MESSAGES[code],
    opts?.resendAvailableAt ? { resendAvailableAt: opts.resendAvailableAt } : undefined
  );
}

/** Map a signer-path SQL result code that isn't success to its API error. */
function resultError(result: string): EsignError {
  switch (result) {
    case "not_found":
    case "pending":
      return signerError("not_found");
    case "expired":
      return signerError("expired");
    case "signed":
    case "already_signed":
      return signerError("already_signed");
    case "completing":
      return signerError("closed", { message: "Everyone has signed. Your copy is being prepared." });
    case "completed":
    case "declined":
    case "voided":
    case "canceled":
      return signerError("closed");
    case "not_available":
      return signerError("not_available");
    case "not_active":
      return signerError("not_active");
    case "otp_required":
      return signerError("otp_required");
    case "out_of_order":
      return signerError("out_of_order");
    case "fields_incomplete":
      return signerError("fields_incomplete");
    case "staff_session_required":
      return signerError("staff_session_required");
    default:
      return signerError("server_error");
  }
}

/** Unexpected PostgREST/RPC failure on a signer path: log the code, map the message. */
function signerDbError(where: string, error: { message?: string; code?: string }): EsignError {
  const mapped = fromDbError(error);
  if (mapped.code === "server_error") console.error("[esign] db error", where, error.code ?? "");
  return mapped;
}

function requireTokenHash(token: string): string {
  if (!isWellFormedToken(token)) throw signerError("not_found");
  return hashSigningToken(token);
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readSnapshot(value: unknown): EsignSnapshotV2 | null {
  if (!isRecord(value)) return null;
  const s = value as Partial<EsignSnapshotV2>;
  if (s.v !== 2) return null;
  if (!isRecord(s.document) || !isRecord(s.source) || !isRecord(s.client) || !isRecord(s.provider)) return null;
  if (!isRecord(s.render) || !Array.isArray(s.pages) || !Array.isArray(s.recipients) || !Array.isArray(s.fields)) {
    return null;
  }
  return s as EsignSnapshotV2;
}

function toUploaderRole(role: unknown): UploaderRole {
  return role === "admin" || role === "employee" || role === "client" ? role : null;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}

function hexMatches(actual: string | null | undefined, expected: string | null | undefined): boolean {
  return typeof actual === "string" && typeof expected === "string" && timingSafeEqualHex(actual, expected);
}

function isoOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    return isoMs(v);
  } catch {
    return null;
  }
}

function validTimeZone(tz: string): string {
  const trimmed = (tz ?? "").trim();
  if (!trimmed || trimmed.length > 64) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return trimmed;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Notification helpers never throw; a throw becomes { ok:false } with the class name only. */
async function attempt(fn: () => Promise<NotifyResult>): Promise<NotifyResult> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: errorName(e) };
  }
}

async function recordNotifyOutcome(
  admin: Admin,
  envelopeId: string,
  kind: NotifyKind,
  recipientId: string | null,
  result: NotifyResult
) {
  // System events never carry IP or user agent, and never an address.
  const meta: Record<string, string> = { kind };
  if (recipientId) meta.recipient_id = recipientId;
  if (!result.ok) meta.error = (result.error ?? "unknown").slice(0, 200);
  try {
    const { error } = await admin.from("signature_envelope_event").insert({
      envelope_id: envelopeId,
      recipient_id: null,
      event: result.ok ? "notified" : "notify_failed",
      actor: "system",
      actor_user_id: null,
      ip: null,
      user_agent: null,
      meta,
    });
    if (error) console.error("[esign] event insert failed", envelopeId, error.code ?? "");
  } catch (e) {
    console.error("[esign] event insert failed", envelopeId, errorName(e));
  }
}

async function staffRecipients(admin: Admin, documentType: string): Promise<string[]> {
  try {
    const row = await loadDocumentType(admin, documentType);
    if (row) {
      const list = notifyRecipients(row);
      if (list.length > 0) return list;
    }
  } catch {
    // fall through to the default inbox
  }
  return [CONTACT_NOTIFY_TO].filter((x): x is string => typeof x === "string" && x.length > 0);
}

function revalidateDocuments() {
  try {
    revalidatePath("/portal/documents");
    revalidatePath("/portal");
  } catch (e) {
    console.error("[esign] revalidate failed", errorName(e));
  }
}

/** Run best-effort work after the response. Never throws into the request. */
function later(label: string, envelopeId: string, fn: () => Promise<void>) {
  after(async () => {
    try {
      await fn();
    } catch (e) {
      console.error("[esign] after failed", label, envelopeId, errorName(e));
    }
  });
}

// ── Row shapes ─────────────────────────────────────────────────────────────

const ENVELOPE_COLUMNS =
  "id, client_id, document_id, engagement_id, document_type, status, routing_mode, source_mode, original_frozen_path, original_sha256, original_content_type, original_file_name, original_byte_size, render_frozen_path, render_sha256, page_count, document_snapshot, document_hash, envelope_hash, last_receipt_sha256, sealed_pdf_path, sealed_pdf_sha256, seal_attempts, sent_at, expires_at, completing_at, completed_at";

type EnvelopeRow = {
  id: string;
  client_id: string;
  document_id: string;
  engagement_id: string | null;
  document_type: string;
  status: string;
  routing_mode: string;
  source_mode: string;
  original_frozen_path: string;
  original_sha256: string;
  original_content_type: string;
  original_file_name: string;
  original_byte_size: number;
  render_frozen_path: string;
  render_sha256: string;
  page_count: number;
  document_snapshot: unknown;
  document_hash: string;
  envelope_hash: string | null;
  last_receipt_sha256: string | null;
  sealed_pdf_path: string | null;
  sealed_pdf_sha256: string | null;
  seal_attempts: number;
  sent_at: string;
  expires_at: string;
  completing_at: string | null;
  completed_at: string | null;
};

const RECIPIENT_COLUMNS =
  "id, envelope_id, client_id, kind, routing_order, status, contact_id, staff_user_id, name, email, phone, consent_text, checkbox_text, recipient_hash, require_sms_otp, otp_last_sent_at, otp_verified_at, otp_session_hash, otp_session_expires_at, activated_at, viewed_at, source_opened_at, original_downloaded_at, signed_at, printed_name, signature_method, signature_image_path, signature_image_sha256, typed_signature_text, typed_signature_font, date_text, time_zone, prev_receipt_sha256, receipt_sha256, applied_field_ids, chain_index, signed_ip, signed_user_agent";

type RecipientRow = {
  id: string;
  envelope_id: string;
  client_id: string;
  kind: string;
  routing_order: number;
  status: string;
  contact_id: string | null;
  staff_user_id: string | null;
  name: string;
  email: string;
  phone: string | null;
  consent_text: string;
  checkbox_text: string;
  recipient_hash: string;
  require_sms_otp: boolean;
  otp_last_sent_at: string | null;
  otp_verified_at: string | null;
  otp_session_hash: string | null;
  otp_session_expires_at: string | null;
  activated_at: string | null;
  viewed_at: string | null;
  source_opened_at: string | null;
  original_downloaded_at: string | null;
  signed_at: string | null;
  printed_name: string | null;
  signature_method: string | null;
  signature_image_path: string | null;
  signature_image_sha256: string | null;
  typed_signature_text: string | null;
  typed_signature_font: string | null;
  date_text: string | null;
  time_zone: string | null;
  prev_receipt_sha256: string | null;
  receipt_sha256: string | null;
  applied_field_ids: string[] | null;
  chain_index: number | null;
  signed_ip: string | null;
  signed_user_agent: string | null;
};

type TokenRow = {
  id: string;
  envelope_id: string;
  recipient_id: string;
  client_id: string;
  revoked_at: string | null;
  revoke_reason: string | null;
};

const TOKEN_COLUMNS = "id, envelope_id, recipient_id, client_id, revoked_at, revoke_reason";

const DOCUMENT_COLUMNS =
  "id, client_id, uploaded_by, storage_path, file_name, byte_size, content_type, category, engagement_id, title, doc_type, version, status, effective_date, signed_at, signature_request_id, esign_envelope_id";

type DocumentRow = {
  id: string;
  client_id: string;
  uploaded_by: string | null;
  storage_path: string;
  file_name: string;
  byte_size: number;
  content_type: string | null;
  category: string;
  engagement_id: string | null;
  title: string | null;
  doc_type: string | null;
  version: number;
  status: string;
  effective_date: string | null;
  signed_at: string | null;
  signature_request_id: string | null;
  esign_envelope_id: string | null;
};

function isSequential(e: { routing_mode: string }): boolean {
  return e.routing_mode === "sequential";
}

function sortRecipients<T extends { routing_order: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.routing_order - b.routing_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Sequential: pending recipients at the lowest order whose predecessors have all signed. */
function nextPendingRecipientIds(rows: RecipientRow[], routing: string): string[] {
  if (routing !== "sequential") return [];
  const unsigned = rows.filter((r) => r.status !== "signed");
  if (unsigned.length === 0) return [];
  const lowest = Math.min(...unsigned.map((r) => r.routing_order));
  return unsigned.filter((r) => r.routing_order === lowest && r.status === "pending").map((r) => r.id);
}

async function readLiveToken(admin: Admin, tokenHash: string): Promise<TokenRow | null> {
  const { data, error } = await admin
    .from("signature_access_token")
    .select(TOKEN_COLUMNS)
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle<TokenRow>();
  if (error) throw signerDbError("token_read", error);
  return data ?? null;
}

async function readEnvelopeScoped(admin: Admin, envelopeId: string, clientId: string): Promise<EnvelopeRow | null> {
  const { data, error } = await admin
    .from("signature_envelope")
    .select(ENVELOPE_COLUMNS)
    .eq("id", envelopeId)
    .eq("client_id", clientId)
    .maybeSingle<EnvelopeRow>();
  if (error) throw error;
  return data ?? null;
}

async function readRecipientsScoped(admin: Admin, envelopeId: string, clientId: string): Promise<RecipientRow[]> {
  const { data, error } = await admin
    .from("signature_recipient")
    .select(RECIPIENT_COLUMNS)
    .eq("envelope_id", envelopeId)
    .eq("client_id", clientId)
    .returns<RecipientRow[]>();
  if (error) throw error;
  return sortRecipients(data ?? []);
}

// ── Staff: gates and reads ─────────────────────────────────────────────────

function staffForbidden(): EsignStaffError {
  return new EsignStaffError("forbidden", "You don't have access to this client.");
}

function assertStaffCan(session: SessionContext, clientId: string) {
  if (!session.isStaff || !clientId || !sessionCan(session, clientId, "documents")) throw staffForbidden();
}

async function readUploader(admin: Admin, userId: string | null): Promise<EsignUploaderInfo | null> {
  if (!userId) return null;
  const { data, error } = await admin
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", userId)
    .maybeSingle<{ id: string; full_name: string | null; role: string | null }>();
  if (error) throw staffErrorFromDb(error);
  if (!data) return null;
  return { name: data.full_name, role: toUploaderRole(data.role) };
}

async function readLatestEnvelopeSummary(admin: Admin, documentId: string, clientId: string): Promise<EnvelopeSummary | null> {
  const { data, error } = await admin
    .from("signature_envelope")
    .select(
      "id, document_id, status, routing_mode, source_mode, sent_at, expires_at, completed_at, completing_at, seal_attempts, seal_next_attempt_at"
    )
    .eq("document_id", documentId)
    .eq("client_id", clientId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      document_id: string;
      status: string;
      routing_mode: string;
      source_mode: string;
      sent_at: string;
      expires_at: string;
      completed_at: string | null;
      completing_at: string | null;
      seal_attempts: number | null;
      seal_next_attempt_at: string | null;
    }>();
  if (error) throw staffErrorFromDb(error);
  if (!data) return null;
  return {
    id: data.id,
    documentId: data.document_id,
    status: data.status as EnvelopeStatus,
    routing: data.routing_mode as RoutingMode,
    sourceMode: data.source_mode as SourceMode,
    sentAt: data.sent_at,
    expiresAt: data.expires_at,
    completedAt: data.completed_at,
    completingAt: data.completing_at,
    sealAttempts: data.seal_attempts ?? 0,
    sealNextAttemptAt: data.seal_next_attempt_at,
    recipients: [],
  };
}

async function countRecentCreates(admin: Admin, documentId: string, clientId: string): Promise<number> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const { count, error } = await admin
    .from("signature_envelope")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("client_id", clientId)
    .gt("sent_at", since);
  if (error) throw staffErrorFromDb(error);
  return count ?? 0;
}

async function readClient(admin: Admin, clientId: string) {
  const { data, error } = await admin
    .from("clients")
    .select("id, name, legal_name")
    .eq("id", clientId)
    .maybeSingle<{ id: string; name: string; legal_name: string | null }>();
  if (error) throw staffErrorFromDb(error);
  return data;
}

async function readEngagement(admin: Admin, engagementId: string | null, clientId: string) {
  if (!engagementId) return null;
  const { data, error } = await admin
    .from("engagements")
    .select("id, name, offer_rung")
    .eq("id", engagementId)
    .eq("client_id", clientId)
    .maybeSingle<{ id: string; name: string; offer_rung: string | null }>();
  if (error) throw staffErrorFromDb(error);
  if (!data) {
    throw new EsignStaffError("engagement_mismatch", "That engagement doesn't belong to this client.");
  }
  return data;
}

async function readContact(admin: Admin, contactId: string, clientId: string) {
  const { data, error } = await admin
    .from("client_contacts")
    .select("id, full_name, email, phone")
    .eq("id", contactId)
    .eq("client_id", clientId)
    .maybeSingle<{ id: string; full_name: string; email: string | null; phone: string | null }>();
  if (error) throw staffErrorFromDb(error);
  if (!data) throw new EsignStaffError("contact_not_found", "That contact wasn't found for this client.");
  return data;
}

async function readStaffDocument(admin: Admin, documentId: string, clientId: string): Promise<DocumentRow> {
  const { data, error } = await admin
    .from("documents")
    .select(DOCUMENT_COLUMNS)
    .eq("id", documentId)
    .eq("client_id", clientId)
    .maybeSingle<DocumentRow>();
  if (error) throw staffErrorFromDb(error);
  if (!data) throw new EsignStaffError("document_not_found", "Document not found.");
  return data;
}

/** S14 / I19: the full Financials rule, not just the category. */
async function assertNotFinancialObject(admin: Admin, storagePath: string) {
  const { data, error } = await admin.rpc("is_financial_object", { object_name: storagePath });
  if (error) throw new EsignStaffError("unknown");
  if (data !== false) throw new EsignStaffError("document_not_eligible", "Financial files can't be sent for signature.");
}

async function downloadStaffSource(admin: Admin, path: string): Promise<Uint8Array> {
  try {
    return await downloadObject(admin, CLIENT_FILES_BUCKET, path);
  } catch {
    throw new EsignStaffError("storage_failed", "We couldn't read that file from storage. Nothing was sent.");
  }
}

/** Header + byte/pixel budget for an image that will be placed on a page. null = acceptable. */
function imageCapError(bytes: Uint8Array, header: ImageHeader | null): string | null {
  const exportHint = "Export it as a JPEG under 14 MB and upload it again.";
  if (bytes.byteLength > IMAGE_INPUT_MAX_BYTES) return `This image is too large to sign on the page. ${exportHint}`;
  if (!header) return "This image can't be converted. Export it as a JPEG or PNG and upload it again.";
  if (header.kind === "png") {
    const raw = header.pixelW * header.pixelH * Math.max(1, header.channels);
    if (header.pixelW > PNG_MAX_SIDE || header.pixelH > PNG_MAX_SIDE || raw > PNG_MAX_RAW_BYTES) {
      return `This PNG is too large to sign on the page. ${exportHint}`;
    }
    if (bytes.byteLength < raw / 1000) {
      return "This PNG can't be converted safely. Export it as a JPEG and upload it again.";
    }
    return null;
  }
  if (
    header.pixelW > JPEG_MAX_SIDE ||
    header.pixelH > JPEG_MAX_SIDE ||
    header.pixelW * header.pixelH > JPEG_MAX_PIXELS
  ) {
    return "This photo has too many pixels to sign on the page. Export it at 20 megapixels or less.";
  }
  return null;
}

function sizeRefusal(mode: SourceMode, kind: SniffKind, byteSize: number): EsignStaffError | null {
  if (mode === "pdf" && byteSize > SOURCE_MAX_BYTES) {
    return new EsignStaffError("pdf_rejected", "This PDF is larger than 15 MB. Compress it and upload it again.");
  }
  if (mode === "image_pdf" && byteSize > IMAGE_INPUT_MAX_BYTES) {
    return new EsignStaffError("image_rejected", "This image is too large to sign on the page. Export it as a JPEG under 14 MB.");
  }
  if (mode === "certificate" && byteSize > ORIGINAL_MAX_BYTES_CERTIFICATE) {
    return new EsignStaffError("file_rejected", "This file is larger than 10 MB, so it can't be attached to a signature page.");
  }
  void kind;
  return null;
}

/** 0032's signature_envelope_shape_check: char_length(original_file_name) between 1 and 400 (code points). */
const ORIGINAL_FILE_NAME_MAX_CHARS = 400;

function assertSendableFileName(fileName: string) {
  const chars = Array.from(fileName ?? "").length;
  if (chars < 1 || chars > ORIGINAL_FILE_NAME_MAX_CHARS) {
    throw new EsignStaffError(
      "file_name_invalid",
      chars < 1 ? "This file has no name. Upload it again with a name, then send it." : undefined
    );
  }
}

function sniffOrRefuse(bytes: Uint8Array, fileName: string) {
  const sniffed = sniffFile(bytes, fileName);
  if (!sniffed.ok) throw new EsignStaffError("file_rejected", sniffed.error || undefined);
  return sniffed;
}

function imageLayoutPage(header: ImageHeader) {
  const layout = imagePageLayout(header.displayW, header.displayH);
  const page: SnapshotPage = {
    index: 0,
    rotate: 0,
    box_mpt: boxToMpt({ x: 0, y: 0, w: layout.pageW, h: layout.pageH }),
  };
  return { layout, page };
}

/** The type whose sealing mode governs a preview. The send re-resolves authoritatively. */
async function previewTypeRow(admin: Admin, doc: DocumentRow): Promise<EsignDocumentTypeRow> {
  if (doc.doc_type) {
    const row = await loadDocumentType(admin, doc.doc_type);
    if (row?.esign_enabled) return row;
  }
  const { data, error } = await admin
    .from("esign_document_type")
    .select("document_type")
    .eq("esign_enabled", true)
    .order("document_type", { ascending: true })
    .returns<{ document_type: string }[]>();
  if (error) throw new EsignStaffError("unknown");
  const rows: EsignDocumentTypeRow[] = [];
  for (const r of data ?? []) {
    const row = await loadDocumentType(admin, r.document_type);
    if (row?.esign_enabled) rows.push(row);
  }
  if (rows.length === 0) throw new EsignStaffError("type_disabled");
  const modes = new Set(rows.map((r) => toTypeSummary(r).sealingMode));
  // One mode across every enabled type → use it; mixed → the first row with auto, else the first row.
  if (modes.size === 1) return rows[0];
  return rows.find((r) => toTypeSummary(r).sealingMode === "auto") ?? rows[0];
}

// ── Staff: countersigners ──────────────────────────────────────────────────

/** Platform admins only (S1). The caller is staff-gated; clientId is reserved for the employee follow-up. */
export async function listStaffSigners(clientId: string): Promise<StaffSignerOption[]> {
  void clientId;
  const admin = createAdminClient();
  const [{ data: profiles, error: profErr }, { data: userList, error: usersErr }] = await Promise.all([
    admin.from("profiles").select("id, full_name, role").eq("role", "admin").returns<{ id: string; full_name: string | null; role: string }[]>(),
    admin.auth.admin.listUsers({ perPage: 200 }),
  ]);
  if (profErr || usersErr) throw new EsignStaffError("unknown");
  const emailById = new Map<string, string>();
  for (const u of userList?.users ?? []) {
    if (u.email) emailById.set(u.id, u.email.trim().toLowerCase());
  }
  const out: StaffSignerOption[] = [];
  for (const p of profiles ?? []) {
    const email = emailById.get(p.id);
    if (!email) continue;
    const name = normalizeSignerText(p.full_name ?? "") || email;
    out.push({ userId: p.id, name, email, role: "admin" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

// ── Staff: preview source ──────────────────────────────────────────────────

export async function prepareEnvelopeSource(
  session: SessionContext,
  input: { clientId: string; documentId: string; documentType?: string }
): Promise<PreparedSource> {
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();
  const doc = await readStaffDocument(admin, input.documentId, input.clientId);
  assertStaffCan(session, doc.client_id);
  // The send would fail this at the RPC; say so before staff place any boxes.
  assertSendableFileName(doc.file_name);

  // I18 before anything the service role downloads; I19 in full (S14).
  if (!isClientScopedPath(doc.storage_path, doc.client_id)) throw new EsignStaffError("document_not_eligible");
  if (doc.category === "Financials") {
    throw new EsignStaffError("document_not_eligible", "Financial files can't be sent for signature.");
  }
  await assertNotFinancialObject(admin, doc.storage_path);

  // The preview follows the type staff picked, so its source mode (placed vs
  // certificate) matches what the send will resolve. previewTypeRow is only the
  // fallback for a caller that has not picked a type.
  let typeRow: EsignDocumentTypeRow;
  if (input.documentType) {
    if (doc.doc_type && doc.doc_type !== input.documentType) {
      throw new EsignStaffError("document_not_eligible", "This document is filed as a different agreement type.");
    }
    const row = await loadDocumentType(admin, input.documentType);
    if (!row?.esign_enabled) throw new EsignStaffError("type_disabled");
    typeRow = row;
  } else {
    typeRow = await previewTypeRow(admin, doc);
  }
  const type = toTypeSummary(typeRow);

  const bytes = await downloadStaffSource(admin, doc.storage_path);
  const sniffed = sniffOrRefuse(bytes, doc.file_name);
  const mode = resolveSourceMode(type.sealingMode, sniffed.kind);
  if (!mode) throw new EsignStaffError("bad_mode");
  const tooBig = sizeRefusal(mode, sniffed.kind, bytes.byteLength);
  if (tooBig) throw tooBig;
  const sha256 = sha256Hex(bytes);

  const previewUrl = async () => {
    try {
      // Inline (no download disposition), 60 seconds.
      return await shortSignedUrl(admin, CLIENT_FILES_BUCKET, doc.storage_path);
    } catch {
      throw new EsignStaffError("storage_failed", "Could not create a preview link. Try again.");
    }
  };

  if (mode === "pdf") {
    const inspected = await inspectSourcePdf(bytes);
    if (!inspected.ok) throw new EsignStaffError("pdf_rejected", inspected.error);
    return {
      mode: "pdf",
      previewUrl: await previewUrl(),
      sha256,
      fileName: doc.file_name,
      byteSize: bytes.byteLength,
      pages: [...inspected.pages].sort((a, b) => a.index - b.index),
    };
  }

  if (mode === "image_pdf") {
    const kind = sniffed.kind === "png" ? "png" : sniffed.kind === "jpeg" ? "jpeg" : null;
    if (!kind) throw new EsignStaffError("bad_mode");
    const header = readImageHeader(bytes, kind);
    const capError = imageCapError(bytes, header);
    if (capError || !header) throw new EsignStaffError("image_rejected", capError ?? undefined);
    const { layout, page } = imageLayoutPage(header);
    return {
      mode: "image_pdf",
      previewUrl: await previewUrl(),
      sha256,
      fileName: doc.file_name,
      byteSize: bytes.byteLength,
      imageContentType: kind === "png" ? "image/png" : "image/jpeg",
      page,
      imageRect: layout.imageRect,
    };
  }

  return {
    mode: "certificate",
    sha256,
    fileName: doc.file_name,
    byteSize: bytes.byteLength,
    contentTypeSniffed: sniffed.contentType,
    extension: sniffed.extension,
  };
}

// ── Staff: create ──────────────────────────────────────────────────────────

type ResolvedRecipient = {
  key: string;
  id: string;
  kind: RecipientKind;
  order: number;
  name: string;
  email: string;
  phone: string | null;
  contactId: string | null;
  staffUserId: string | null;
};

const emailSchema = z.string().email().max(254);

export async function createEnvelope(session: SessionContext, input: SendEnvelopeInput): Promise<CreateEnvelopeResult> {
  // ── 1. Gate on the named client, load, gate on the row's client (I3) ──
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();
  const doc = await readStaffDocument(admin, input.documentId, input.clientId);
  assertStaffCan(session, doc.client_id);
  // original_file_name is capped by a CHECK in 0032; refuse before any download, upload or RPC.
  assertSendableFileName(doc.file_name);

  // ── 2. Type and recipient roster shape ──
  const typeRow = await loadDocumentType(admin, input.documentType);
  if (!typeRow || !typeRow.esign_enabled) throw new EsignStaffError("type_disabled");
  const type = toTypeSummary(typeRow);

  const badRecipients = (message?: string) => new EsignStaffError("bad_recipients", message);
  const maxRecipients = Math.min(MAX_RECIPIENTS, type.maxRecipients);
  if (input.recipients.length < 1 || input.recipients.length > maxRecipients) {
    throw badRecipients(`Add between 1 and ${maxRecipients} signers.`);
  }
  if (new Set(input.recipients.map((r) => r.key)).size !== input.recipients.length) throw badRecipients();
  if (input.recipients.filter((r) => r.kind === "staff").length > 1) {
    throw badRecipients("Only one GBTN countersigner can sign an envelope.");
  }
  if (!type.allowOutsideSigners && input.recipients.some((r) => r.kind === "outside")) {
    throw badRecipients("This document type only allows client contacts and GBTN to sign.");
  }

  // ── 3. Routing orders ──
  if (input.routing === "parallel") {
    if (input.recipients.some((r) => r.order !== 1)) throw badRecipients();
  } else if (input.routing === "sequential") {
    if (input.recipients.some((r, i) => r.order !== i + 1)) throw badRecipients();
  } else {
    throw badRecipients();
  }

  // A document already linked to an engagement keeps it; the wizard may pass null.
  if (doc.engagement_id && input.engagementId && input.engagementId !== doc.engagement_id) {
    throw new EsignStaffError("engagement_mismatch", "This document is linked to a different engagement.");
  }
  const engagementId = doc.engagement_id ?? input.engagementId;

  // ── 4. Resolve every recipient against this client ──
  const needsStaffList = input.recipients.some((r) => r.kind === "staff");
  const staffSigners = needsStaffList ? await listStaffSigners(doc.client_id) : [];
  const resolved: ResolvedRecipient[] = [];
  for (const r of input.recipients) {
    let name: string;
    let email: string;
    let phone: string | null = null;
    let contactId: string | null = null;
    let staffUserId: string | null = null;
    if (r.kind === "client_contact") {
      const contact = await readContact(admin, r.contactId, doc.client_id);
      if (!contact.email || !contact.email.trim()) throw new EsignStaffError("contact_no_email");
      name = contact.full_name;
      email = contact.email;
      phone = toE164(contact.phone);
      contactId = contact.id;
    } else if (r.kind === "outside") {
      name = r.fullName;
      email = r.email;
      phone = toE164(r.phone ?? null);
    } else {
      const signer = staffSigners.find((s) => s.userId === r.staffUserId);
      if (!signer) throw new EsignStaffError("countersigner_not_staff");
      name = signer.name;
      email = signer.email;
      staffUserId = signer.userId;
    }
    name = normalizeSignerText(name);
    if (name.length < 1 || name.length > 200 || (r.kind === "outside" && (name.length < 2 || name.length > 120))) {
      throw badRecipients("Enter each signer's full name.");
    }
    email = email.trim().toLowerCase();
    if (!emailSchema.safeParse(email).success) throw new EsignStaffError("invalid_email");
    if (type.requireSmsOtp && !phone) throw new EsignStaffError("phone_required");
    resolved.push({ key: r.key, id: randomUUID(), kind: r.kind, order: r.order, name, email, phone, contactId, staffUserId });
  }
  if (new Set(resolved.map((r) => r.email)).size !== resolved.length) {
    throw badRecipients("Each signer needs a different email address.");
  }

  // ── 5. Parallel reads, friendly pre-check, I18/I19, rate limit ──
  const [uploader, latest, recent, client, engagement] = await Promise.all([
    readUploader(admin, doc.uploaded_by),
    readLatestEnvelopeSummary(admin, doc.id, doc.client_id),
    countRecentCreates(admin, doc.id, doc.client_id),
    readClient(admin, doc.client_id),
    readEngagement(admin, engagementId, doc.client_id),
  ]);
  if (!client) throw new EsignStaffError("document_not_found", "Client not found.");

  const now = new Date();
  const eligibility = sendEligibility(doc, type, latest, uploader, { replaceOpen: input.replaceOpen, now });
  if (!eligibility.ok) throw new EsignStaffError("document_not_eligible", eligibility.reason);
  if (!isClientScopedPath(doc.storage_path, doc.client_id)) throw new EsignStaffError("document_not_eligible");
  await assertNotFinancialObject(admin, doc.storage_path);
  // Every create sends real email; refuse before downloading anything.
  if (recent >= CREATES_PER_DOCUMENT_PER_DAY) throw new EsignStaffError("rate_limited");

  // ── 6. The bytes the placer saw ──
  const originalBytes = await downloadStaffSource(admin, doc.storage_path);
  const originalSha256 = sha256Hex(originalBytes);
  if (!hexMatches(originalSha256, input.sourceSha256)) {
    throw new EsignStaffError("source_changed", "The file changed after you opened it. Reopen the dialog.");
  }

  // ── 7. Mode, render bytes, verified pages ──
  const sniffed = sniffOrRefuse(originalBytes, doc.file_name);
  const mode = resolveSourceMode(type.sealingMode, sniffed.kind);
  if (!mode) throw new EsignStaffError("bad_mode");
  const tooBig = sizeRefusal(mode, sniffed.kind, originalBytes.byteLength);
  if (tooBig) throw tooBig;

  const envelopeId = randomUUID();
  const title = doc.title?.trim() || doc.file_name;
  const idByKey = new Map(resolved.map((r) => [r.key, r.id]));

  let renderBytes: Uint8Array;
  let pages: SnapshotPage[];
  let conversion: SnapshotConversion = null;
  let generatedFields: EsignField[] | null = null;

  if (mode === "pdf") {
    const inspected = await inspectSourcePdf(originalBytes);
    if (!inspected.ok) throw new EsignStaffError("pdf_rejected", inspected.error);
    if (!pagesAgree(input.pages, inspected.pages)) throw new EsignStaffError("pages_mismatch");
    renderBytes = originalBytes;
    pages = inspected.pages;
  } else if (mode === "image_pdf") {
    const kind = sniffed.kind === "png" ? "png" : sniffed.kind === "jpeg" ? "jpeg" : null;
    if (!kind) throw new EsignStaffError("bad_mode");
    const converted = await imageToPdf(originalBytes, kind);
    if (!converted.ok) throw new EsignStaffError("image_rejected", converted.error);
    if (converted.pdf.byteLength > SOURCE_MAX_BYTES) {
      throw new EsignStaffError("image_rejected", "This image is too large to sign on the page. Export it as a JPEG under 14 MB.");
    }
    // Structure only: the raw-byte marker scan over embedded image data false-positives.
    const probe = await convertedStructureProbe(converted.pdf);
    if (!probe) throw new EsignStaffError("image_rejected");
    const inspected = await inspectSourcePdf(probe);
    if (!inspected.ok) throw new EsignStaffError("image_rejected", inspected.error);
    const { page: layoutPage } = imageLayoutPage(converted.header);
    if (!pagesAgree(input.pages, [layoutPage]) || !pagesAgree(inspected.pages, [layoutPage])) {
      throw new EsignStaffError("pages_mismatch");
    }
    renderBytes = converted.pdf;
    pages = inspected.pages;
    conversion = {
      tool: "pdf-lib@1.17.1",
      profile: "img2pdf-v1",
      orientation: converted.header.orientation,
      pixel_w: converted.header.pixelW,
      pixel_h: converted.header.pixelH,
    };
  } else {
    let built: Awaited<ReturnType<typeof buildSignaturePage>>;
    try {
      built = await buildSignaturePage({
        envelopeId,
        title,
        clientName: client.legal_name?.trim() || client.name,
        providerName: site.name,
        original: {
          fileName: doc.file_name,
          contentTypeSniffed: sniffed.contentType,
          contentTypeDeclared: doc.content_type,
          byteSize: originalBytes.byteLength,
          sha256: originalSha256,
          extension: sniffed.extension,
        },
        recipients: resolved.map((r) => ({ id: r.id, name: r.name, kind: r.kind, routingOrder: r.order })),
        newFieldId: () => randomUUID(),
      });
    } catch (e) {
      console.error("[esign] signature page build failed", envelopeId, errorName(e));
      throw new EsignStaffError("unknown");
    }
    renderBytes = built.pdf;
    pages = built.pages;
    generatedFields = built.fields;
    conversion = { tool: "pdf-lib@1.17.1", profile: "sigpage-v1" };
  }
  pages = [...pages].sort((a, b) => a.index - b.index);
  const pageCount = pages.length;
  if (pageCount < 1 || pageCount > 200) throw new EsignStaffError("pdf_rejected");
  const renderSha256 = mode === "pdf" ? originalSha256 : sha256Hex(renderBytes);

  // ── 8/9. Fields ──
  let fields: EsignField[];
  if (generatedFields) {
    fields = generatedFields;
  } else {
    if (input.fields.length > MAX_FIELDS) throw new EsignStaffError("bad_fields");
    fields = input.fields.map((f) => {
      const recipientId = idByKey.get(f.recipientKey);
      if (!recipientId) throw new EsignStaffError("bad_fields");
      const page = pages.find((p) => p.index === f.page);
      if (!page) throw new EsignStaffError("fields_invalid", "A signature box is on a page that doesn't exist.");
      const reason = validateField(
        { page: f.page, x_ppm: f.x_ppm, y_ppm: f.y_ppm, w_ppm: f.w_ppm, h_ppm: f.h_ppm, kind: f.kind },
        page,
        pageCount
      );
      if (reason) throw new EsignStaffError("fields_invalid", reason);
      const label = f.detectedLabel === null ? null : normalizeSignerText(f.detectedLabel).slice(0, 200) || null;
      return {
        id: randomUUID(),
        recipient_id: recipientId,
        kind: f.kind,
        page: f.page,
        x_ppm: f.x_ppm,
        y_ppm: f.y_ppm,
        w_ppm: f.w_ppm,
        h_ppm: f.h_ppm,
        required: f.required,
        origin: f.origin,
        detected_label: label,
      };
    });
  }
  if (fields.length > MAX_FIELDS) throw new EsignStaffError("bad_fields");
  for (const r of resolved) {
    if (!fields.some((f) => f.recipient_id === r.id && f.kind === "signature" && f.required)) {
      throw new EsignStaffError("fields_invalid", `Place a required signature box for ${r.name}.`);
    }
  }

  // ── 10. Consent per recipient kind, filled (I40/I26) ──
  const clientLegalName = client.legal_name?.trim() || client.name;
  const consents = new Map<string, { consent: string; checkbox: string }>();
  for (const r of resolved) {
    const tpl = consentTemplatesFor(typeRow, r.kind);
    const vars = {
      provider_legal_name: site.legalName,
      provider_name: site.name,
      provider_contact_email: site.founder.email,
      client_legal_name: clientLegalName,
      document_title: title,
      recipient_name: r.name,
    };
    const consent = fillTemplate(tpl.consent, vars);
    const checkbox = fillTemplate(tpl.checkbox, vars);
    if (!consent.ok || !checkbox.ok) throw new EsignStaffError("template_incomplete");
    consents.set(r.id, { consent: consent.text, checkbox: checkbox.text });
  }

  // ── 11. Snapshot v2, document hash, recipient hashes ──
  const expiresAt = isoMs(new Date(now.getTime() + typeRow.expiry_days * DAY_MS));
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const snapshotRecipients: SnapshotRecipient[] = resolved
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      routing_order: r.order,
      name: r.name,
      email: r.email,
      phone_e164: r.phone,
      contact_id: r.contactId,
      staff_user_id: r.staffUserId,
      require_sms_otp: type.requireSmsOtp,
    }))
    .sort((a, b) => a.routing_order - b.routing_order || byId(a, b));
  const snapshotFields = [...fields].sort((a, b) => a.page - b.page || byId(a, b));

  const snapshot: EsignSnapshotV2 = {
    v: 2,
    provider: { legal_name: site.legalName, name: site.name },
    client: { id: client.id, name: client.name, legal_name: client.legal_name ?? null },
    document: {
      id: doc.id,
      title,
      doc_type: input.documentType,
      doc_type_label: type.label,
      version: doc.version,
      effective_date: doc.effective_date,
      category: doc.category,
      uploaded_by: doc.uploaded_by,
      uploader_role: uploader?.role ?? null,
    },
    engagement: engagement ? { id: engagement.id, name: engagement.name, offer_rung: engagement.offer_rung ?? null } : null,
    source: {
      bucket: "client-files",
      storage_path: doc.storage_path,
      file_name: doc.file_name,
      content_type_declared: doc.content_type,
      content_type_sniffed: sniffed.contentType,
      extension: sniffed.extension,
      byte_size: originalBytes.byteLength,
      sha256: originalSha256,
    },
    mode,
    routing: input.routing,
    render: { sha256: renderSha256, page_count: pageCount, conversion },
    pages,
    recipients: snapshotRecipients,
    fields: snapshotFields,
    expires_at: expiresAt,
  };

  let documentHash: string;
  try {
    documentHash = computeDocumentHashV2(snapshot);
  } catch (e) {
    console.error("[esign] snapshot hash failed", envelopeId, errorName(e));
    throw new EsignStaffError("unknown");
  }

  // ── 12. Tokens for the activated set ──
  const tokens = new Map<string, { token: string; tokenHash: string }>();
  for (const r of resolved) {
    if (input.routing === "parallel" || r.order === 1) tokens.set(r.id, generateSigningToken());
  }

  const recipientPayload = resolved.map((r) => {
    const c = consents.get(r.id)!;
    return {
      id: r.id,
      kind: r.kind,
      routing_order: r.order,
      contact_id: r.contactId,
      staff_user_id: r.staffUserId,
      name: r.name,
      email: r.email,
      phone: r.phone,
      consent_text: c.consent,
      checkbox_text: c.checkbox,
      recipient_hash: computeRecipientHash({
        documentHash,
        recipientId: r.id,
        consentText: c.consent,
        checkboxText: c.checkbox,
        requireSmsOtp: type.requireSmsOtp,
      }),
      require_sms_otp: type.requireSmsOtp,
      token_hash: tokens.get(r.id)?.tokenHash ?? null,
    };
  });

  // ── 13. Freeze before the RPC (I25) ──
  const originalPath = envelopeOriginalPath(envelopeId);
  const renderPath = envelopeRenderPath(envelopeId);
  const frozen = await Promise.allSettled([
    uploadObject(admin, ESIGN_BUCKET, originalPath, originalBytes, "application/octet-stream"),
    uploadObject(admin, ESIGN_BUCKET, renderPath, renderBytes, "application/pdf"),
  ]);
  if (frozen.some((u) => u.status === "rejected")) {
    // Nothing references these objects yet, so removing them is always safe.
    await removeObjectsQuietly(admin, ESIGN_BUCKET, [originalPath, renderPath]);
    throw new EsignStaffError("storage_failed", "We couldn't store a copy of the file. Nothing was sent.");
  }

  // ── 14. The one transactional write ──
  const { data: created, error: createErr } = await admin.rpc("esign_create_envelope", {
    p_envelope_id: envelopeId,
    p_client_id: doc.client_id,
    p_document_id: doc.id,
    p_engagement_id: engagementId,
    p_document_type: input.documentType,
    p_created_by: session.user.id,
    p_routing_mode: input.routing,
    p_source_mode: mode,
    p_original_frozen_path: originalPath,
    p_original_sha256: originalSha256,
    p_original_content_type: sniffed.contentType,
    p_original_file_name: doc.file_name,
    p_original_byte_size: originalBytes.byteLength,
    p_render_frozen_path: renderPath,
    p_render_sha256: renderSha256,
    p_page_count: pageCount,
    p_document_snapshot: snapshot,
    p_document_hash: documentHash,
    p_expires_at: expiresAt,
    p_replace_open: input.replaceOpen,
    p_supersede_siblings: input.supersedeSiblings,
    p_recipients: recipientPayload,
    p_fields: snapshotFields,
  });

  // ── 15. Ambiguous RPC: re-read before any cleanup (I25) ──
  let superseded = 0;
  if (createErr) {
    const { data: row, error: readErr } = await admin
      .from("signature_envelope")
      .select("id")
      .eq("id", envelopeId)
      .eq("client_id", doc.client_id)
      .maybeSingle<{ id: string }>();
    if (readErr) {
      console.error("[esign] create ambiguous", envelopeId);
      throw new EsignStaffError("unknown", "We couldn't confirm the envelope was created. Refresh before trying again.");
    }
    if (!row) {
      await removeObjectsQuietly(admin, ESIGN_BUCKET, [originalPath, renderPath]);
      throw staffErrorFromDb(createErr);
    }
    // The row exists: the create committed. Continue on the success path.
  } else {
    const n = Number((created as { superseded?: unknown } | null)?.superseded ?? 0);
    superseded = Number.isFinite(n) ? n : 0;
  }

  revalidateDocuments();

  // ── 16. Invites for the activated set, synchronously (the wizard shows outcomes) ──
  const total = resolved.length;
  const outcomes = await Promise.all(
    resolved.map(async (r) => {
      const t = tokens.get(r.id);
      if (!t) return { id: r.id, url: null as string | null, emailed: false };
      const url = signUrlFor(t.token);
      const res = await attempt(() =>
        sendSigningInvite({
          to: r.email,
          recipientName: r.name,
          title,
          clientName: client.name,
          signUrl: url,
          expiresAt,
          routing: input.routing,
          position: input.routing === "sequential" ? { order: r.order, total } : null,
          otherSignerCount: total - 1,
          isTurnNotice: false,
          requireStaffSession: r.kind === "staff",
        })
      );
      await recordNotifyOutcome(admin, envelopeId, "invite", r.id, res);
      return { id: r.id, url, emailed: res.ok };
    })
  );

  // ── 17. Links (shown once, staff-only, never logged) ──
  return {
    envelopeId,
    superseded,
    links: resolved.map((r) => {
      const o = outcomes.find((x) => x.id === r.id);
      return { recipientKey: r.key, recipientId: r.id, name: r.name, email: r.email, url: o?.url ?? null, emailed: o?.emailed ?? false };
    }),
  };
}

// ── Notices shared by close paths ──────────────────────────────────────────

type EnvelopeLabels = { title: string; clientName: string };

function labelsFor(envelope: { document_snapshot: unknown }): EnvelopeLabels {
  const snap = readSnapshot(envelope.document_snapshot);
  return { title: snap?.document.title ?? "Document", clientName: snap?.client.name ?? "" };
}

async function notifyStaffClosedBestEffort(
  admin: Admin,
  i: {
    envelopeId: string;
    documentType: string;
    labels: EnvelopeLabels;
    outcome: "declined" | "drift" | "expired" | "seal_failed" | "abandoned";
    reason: string | null;
    declinedBy: string | null;
    attempt: number | null;
  }
) {
  const to = await staffRecipients(admin, i.documentType);
  const res = await attempt(() =>
    notifyStaffClosed({
      to,
      title: i.labels.title,
      clientName: i.labels.clientName,
      envelopeId: i.envelopeId,
      outcome: i.outcome,
      reason: i.reason,
      declinedBy: i.declinedBy,
      attempt: i.attempt,
    })
  );
  await recordNotifyOutcome(admin, i.envelopeId, "staff_closed", null, res);
}

/** Recipients who were given a link and never signed (read AFTER the close). */
async function notifyWithdrawnBestEffort(
  admin: Admin,
  i: {
    envelopeId: string;
    clientId: string;
    labels: EnvelopeLabels;
    outcome: "voided" | "declined" | "expired" | "abandoned";
    exceptRecipientId: string | null;
    includeSigned: boolean;
  }
) {
  const rows = await readRecipientsScoped(admin, i.envelopeId, i.clientId);
  for (const r of rows) {
    if (r.id === i.exceptRecipientId) continue;
    if (!r.activated_at) continue;
    if (!i.includeSigned && (r.status === "signed" || r.signed_at)) continue;
    const res = await attempt(() =>
      notifyRecipientsWithdrawn({ to: r.email, recipientName: r.name, title: i.labels.title, outcome: i.outcome })
    );
    await recordNotifyOutcome(admin, i.envelopeId, "withdrawn", r.id, res);
  }
}

// ── Staff: void / resend / finish / abandon ────────────────────────────────

async function readStaffEnvelope(
  session: SessionContext,
  admin: Admin,
  input: { clientId: string; envelopeId: string }
): Promise<EnvelopeRow | null> {
  let envelope: EnvelopeRow | null;
  try {
    envelope = await readEnvelopeScoped(admin, input.envelopeId, input.clientId);
  } catch (e) {
    throw staffErrorFromDb(e as { message?: string; code?: string });
  }
  if (envelope) assertStaffCan(session, envelope.client_id);
  return envelope;
}

export async function voidEnvelope(
  session: SessionContext,
  input: { clientId: string; envelopeId: string; reason: string | null }
): Promise<CloseResult> {
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();
  const envelope = await readStaffEnvelope(session, admin, input);
  if (!envelope) return "not_found";

  const reason = input.reason ? input.reason.trim().slice(0, 1000) || null : null;
  const { data, error } = await admin.rpc("esign_close_envelope", {
    p_envelope_id: envelope.id,
    p_client_id: envelope.client_id,
    p_token_hash: null,
    p_new_status: "voided",
    p_actor: "staff",
    p_actor_user_id: session.user.id,
    p_session_user_id: null,
    p_reason: reason,
    p_extra_event: null,
    p_meta: null,
    p_otp_session_hash: null,
    p_ip: null,
    p_user_agent: null,
  });
  if (error) throw staffErrorFromDb(error);

  const raw = String(data);
  // Signer-only outcomes are impossible for a staff close; treat them as not found.
  const result: CloseResult = (CLOSE_RESULTS as readonly string[]).includes(raw) ? (raw as CloseResult) : "not_found";
  revalidateDocuments();

  if (result === "ok") {
    const labels = labelsFor(envelope);
    later("void_withdrawn", envelope.id, () =>
      notifyWithdrawnBestEffort(admin, {
        envelopeId: envelope.id,
        clientId: envelope.client_id,
        labels,
        outcome: "voided",
        exceptRecipientId: null,
        includeSigned: false,
      })
    );
  }
  return result;
}

async function sendResendInvite(
  admin: Admin,
  envelope: EnvelopeRow,
  recipient: RecipientRow,
  token: string,
  kind: "activated" | "rotated"
): Promise<{ url: string; emailed: boolean }> {
  const labels = labelsFor(envelope);
  const rows = await readRecipientsScoped(admin, envelope.id, envelope.client_id).catch(() => [] as RecipientRow[]);
  const total = Math.max(rows.length, 1);
  const url = signUrlFor(token);
  const sequential = isSequential(envelope);
  const res = await attempt(() =>
    sendSigningInvite({
      to: recipient.email,
      recipientName: recipient.name,
      title: labels.title,
      clientName: labels.clientName,
      signUrl: url,
      expiresAt: envelope.expires_at,
      routing: sequential ? "sequential" : "parallel",
      position: sequential ? { order: recipient.routing_order, total } : null,
      otherSignerCount: total - 1,
      isTurnNotice: kind === "activated" && sequential,
      requireStaffSession: recipient.kind === "staff",
    })
  );
  await recordNotifyOutcome(admin, envelope.id, kind === "activated" && sequential ? "turn_invite" : "invite", recipient.id, res);
  return { url, emailed: res.ok };
}

function resendResultError(result: string): EsignStaffError {
  switch (result) {
    case "out_of_order":
      return new EsignStaffError("out_of_order");
    case "rate_limited":
      return new EsignStaffError("rate_limited", "Too many links for this signer today. Try again tomorrow.");
    case "countersigner_not_staff":
      return new EsignStaffError("countersigner_not_staff");
    case "not_found":
      return new EsignStaffError("envelope_not_found");
    default:
      return new EsignStaffError("recipient_not_active");
  }
}

export async function resendToRecipient(
  session: SessionContext,
  input: { clientId: string; envelopeId: string; recipientId: string }
): Promise<ResendRecipientResult> {
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();
  const envelope = await readStaffEnvelope(session, admin, input);
  if (!envelope) throw new EsignStaffError("envelope_not_found");

  const { data: recipient, error } = await admin
    .from("signature_recipient")
    .select(RECIPIENT_COLUMNS)
    .eq("id", input.recipientId)
    .eq("envelope_id", envelope.id)
    .eq("client_id", envelope.client_id)
    .maybeSingle<RecipientRow>();
  if (error) throw staffErrorFromDb(error);
  if (!recipient) throw new EsignStaffError("envelope_not_found");

  const rotate = async (): Promise<ResendRecipientResult> => {
    const { token, tokenHash } = generateSigningToken();
    const { data, error: rpcErr } = await admin.rpc("esign_rotate_recipient_token", {
      p_envelope_id: envelope.id,
      p_client_id: envelope.client_id,
      p_recipient_id: recipient.id,
      p_token_hash: tokenHash,
      p_issued_by: session.user.id,
    });
    if (rpcErr) throw staffErrorFromDb(rpcErr);
    const result = String((data as { result?: unknown } | null)?.result ?? "");
    if (result !== "ok") throw resendResultError(result);
    revalidateDocuments();
    const sent = await sendResendInvite(admin, envelope, recipient, token, "rotated");
    return { kind: "rotated", url: sent.url, emailed: sent.emailed, name: recipient.name };
  };

  if (recipient.status === "pending") {
    const { token, tokenHash } = generateSigningToken();
    const { data, error: rpcErr } = await admin.rpc("esign_activate_recipient", {
      p_envelope_id: envelope.id,
      p_client_id: envelope.client_id,
      p_recipient_id: recipient.id,
      p_token_hash: tokenHash,
      p_issued_by: session.user.id,
      p_actor: "staff",
    });
    if (rpcErr) throw staffErrorFromDb(rpcErr);
    const result = String((data as { result?: unknown } | null)?.result ?? "");
    if (result === "already_active") return rotate();
    if (result !== "ok") throw resendResultError(result);
    revalidateDocuments();
    const sent = await sendResendInvite(admin, envelope, recipient, token, "activated");
    return { kind: "activated", url: sent.url, emailed: sent.emailed, name: recipient.name };
  }

  if ((RECIPIENT_ACTIVE_STATUSES as readonly string[]).includes(recipient.status)) return rotate();
  throw new EsignStaffError("recipient_not_active");
}

export async function finishSealing(
  session: SessionContext,
  input: { clientId: string; envelopeId: string }
): Promise<FinishSealingResult> {
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();
  const envelope = await readStaffEnvelope(session, admin, input);
  if (!envelope) throw new EsignStaffError("envelope_not_found");
  const result = await completeEnvelope(envelope.id, { force: true });
  revalidateDocuments();
  return result;
}

export async function abandonSealing(
  session: SessionContext,
  input: { clientId: string; envelopeId: string; reason: string | null }
): Promise<AbandonSealResult> {
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();
  const envelope = await readStaffEnvelope(session, admin, input);
  if (!envelope) return "not_found";

  const reason = input.reason ? input.reason.trim().slice(0, 1000) || null : null;
  const { data, error } = await admin.rpc("esign_abandon_seal", {
    p_envelope_id: envelope.id,
    p_client_id: envelope.client_id,
    p_actor_user_id: session.user.id,
    p_reason: reason,
  });
  if (error) throw staffErrorFromDb(error);
  const raw = String(data);
  const result: AbandonSealResult = (ABANDON_RESULTS as readonly string[]).includes(raw)
    ? (raw as AbandonSealResult)
    : "not_found";
  revalidateDocuments();

  if (result === "ok") {
    const labels = labelsFor(envelope);
    later("abandon_notices", envelope.id, async () => {
      await notifyStaffClosedBestEffort(admin, {
        envelopeId: envelope.id,
        documentType: envelope.document_type,
        labels,
        outcome: "abandoned",
        reason,
        declinedBy: null,
        attempt: null,
      });
      await notifyWithdrawnBestEffort(admin, {
        envelopeId: envelope.id,
        clientId: envelope.client_id,
        labels,
        outcome: "abandoned",
        exceptRecipientId: null,
        includeSigned: true,
      });
    });
  }
  return result;
}

// ── Member: the Signed copy download ───────────────────────────────────────

export async function getMemberSealedCopyUrl(session: SessionContext, documentId: string): Promise<{ url: string }> {
  // Cookie client: RLS proves membership, the Financials rule and
  // visible_to_client before the service role is used for anything.
  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, client_id, file_name, title, esign_envelope_id, signed_at")
    .eq("id", documentId)
    .maybeSingle<{
      id: string;
      client_id: string;
      file_name: string;
      title: string | null;
      esign_envelope_id: string | null;
      signed_at: string | null;
    }>();
  if (error || !doc) throw new EsignStaffError("document_not_found", "Not found.");
  if (!sessionCan(session, doc.client_id, "documents")) {
    throw new EsignStaffError("forbidden", "You don't have access to this.");
  }
  const noCopy = new EsignStaffError("envelope_not_found", "This document doesn't have a signed copy.");
  if (!doc.signed_at || !doc.esign_envelope_id) throw noCopy;

  const admin = createAdminClient();
  const { data: env, error: envErr } = await admin
    .from("signature_envelope")
    .select("sealed_pdf_path")
    .eq("id", doc.esign_envelope_id)
    .eq("document_id", doc.id)
    .eq("client_id", doc.client_id)
    .eq("status", "completed")
    .maybeSingle<{ sealed_pdf_path: string | null }>();
  if (envErr) throw staffErrorFromDb(envErr);
  if (!env?.sealed_pdf_path) throw noCopy;

  try {
    const url = await shortSignedUrl(admin, ESIGN_BUCKET, env.sealed_pdf_path, {
      download: sealedDownloadName(doc.title ?? doc.file_name),
    });
    return { url };
  } catch {
    throw new EsignStaffError("storage_failed", "Could not create a download link. Try again.");
  }
}

// ── Signer: read model ─────────────────────────────────────────────────────

function netContext(ctx: EsignRequestContext): { ip: string | null; userAgent: string | null } {
  // Identical to what SQL stores (left 64 / left 512), so receipts round-trip.
  return { ip: ctx.ip ? ctx.ip.slice(0, 64) : null, userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 512) : null };
}

function withinSealedWindow(completedAt: string | null, now: Date): boolean {
  const ms = completedAt ? Date.parse(completedAt) : NaN;
  return Number.isFinite(ms) && ms > now.getTime() - SEALED_DOWNLOAD_WINDOW_DAYS * DAY_MS;
}

async function allowTypedFor(admin: Admin, documentType: string): Promise<boolean> {
  try {
    const row = await loadDocumentType(admin, documentType);
    return row ? toTypeSummary(row).allowTypedSignature : false;
  } catch {
    return false;
  }
}

/**
 * Pure read for the SSR page and the `get` action. Never throws, never writes.
 * Resolves the token whatever its revoked state (C9): a rotated link is
 * invalid; any other revoked link shows its envelope's terminal state.
 */
export async function loadSigningView(token: string): Promise<SigningView> {
  if (!isWellFormedToken(token)) return { state: "invalid" };
  try {
    const admin = createAdminClient();
    const { data: tok, error } = await admin
      .from("signature_access_token")
      .select(TOKEN_COLUMNS)
      .eq("token_hash", hashSigningToken(token))
      .maybeSingle<TokenRow>();
    if (error) {
      console.error("[esign] view read failed", error.code ?? "");
      return { state: "invalid" };
    }
    if (!tok || tok.revoke_reason === "rotated") return { state: "invalid" };

    const envelope = await readEnvelopeScoped(admin, tok.envelope_id, tok.client_id);
    if (!envelope) return { state: "invalid" };
    const rows = await readRecipientsScoped(admin, envelope.id, envelope.client_id);
    const me = rows.find((r) => r.id === tok.recipient_id);
    const snap = readSnapshot(envelope.document_snapshot);
    if (!me || !snap) return { state: "invalid" };

    const now = new Date();
    const title = snap.document.title;
    switch (envelope.status) {
      case "declined":
      case "voided":
      case "expired":
        return { state: envelope.status, title };
      case "completed":
        if (me.status !== "signed") return { state: "invalid" };
        return {
          state: "completed",
          title,
          completedAt: envelope.completed_at ?? "",
          emailMasked: maskEmail(me.email),
          sealedDownloadAvailable: tok.revoked_at === null && withinSealedWindow(envelope.completed_at, now),
        };
      case "completing":
        return { state: "completing", title, signedAt: me.signed_at };
      case "in_progress":
        break;
      default:
        return { state: "invalid" };
    }

    // in_progress: past expiry reads as expired WITHOUT writing (I23).
    if (Date.parse(envelope.expires_at) <= now.getTime()) return { state: "expired", title };
    if (tok.revoked_at !== null) return { state: "invalid" };
    if (me.status === "signed") {
      return {
        state: "signed_waiting",
        title,
        signedAt: me.signed_at ?? "",
        emailMasked: maskEmail(me.email),
        remaining: rows.filter((r) => r.status !== "signed").length,
      };
    }
    if (!(RECIPIENT_ACTIVE_STATUSES as readonly string[]).includes(me.status)) return { state: "invalid" };

    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    const fields: ViewField[] = [];
    const otherFields: OtherField[] = [];
    for (const f of snap.fields) {
      if (f.recipient_id === me.id) {
        fields.push({ id: f.id, kind: f.kind, page: f.page, x_ppm: f.x_ppm, y_ppm: f.y_ppm, w_ppm: f.w_ppm, h_ppm: f.h_ppm, required: f.required });
      } else {
        otherFields.push({
          page: f.page,
          x_ppm: f.x_ppm,
          y_ppm: f.y_ppm,
          w_ppm: f.w_ppm,
          h_ppm: f.h_ppm,
          kind: f.kind,
          signed: statusById.get(f.recipient_id) === "signed",
        });
      }
    }
    const sequential = isSequential(envelope);
    const resendAt = me.otp_last_sent_at
      ? new Date(Date.parse(me.otp_last_sent_at) + OTP_RESEND_COOLDOWN_SECONDS * 1000)
      : null;
    const mode = envelope.source_mode as SourceMode;

    return {
      state: "open",
      title,
      docTypeLabel: snap.document.doc_type_label,
      version: snap.document.version,
      clientName: snap.client.legal_name ?? snap.client.name,
      providerName: snap.provider.name,
      recipientName: me.name,
      routing: sequential ? "sequential" : "parallel",
      position: sequential ? { order: me.routing_order, total: Math.max(...rows.map((r) => r.routing_order)) } : null,
      signerCount: rows.length,
      mode,
      pageCount: envelope.page_count,
      renderSha256: envelope.render_sha256,
      pages: snap.pages,
      fields,
      otherFields,
      original:
        mode === "certificate"
          ? {
              fileName: envelope.original_file_name,
              contentType: envelope.original_content_type,
              byteSize: Number(envelope.original_byte_size),
              sha256: envelope.original_sha256,
            }
          : null,
      consentText: me.consent_text,
      checkboxText: me.checkbox_text,
      expiresAt: envelope.expires_at,
      viewed: me.viewed_at !== null,
      requireOtp: me.require_sms_otp,
      phoneMask: me.require_sms_otp ? maskPhone(me.phone) : null,
      otpResendAvailableAt:
        me.require_sms_otp && resendAt && resendAt.getTime() > now.getTime() ? resendAt.toISOString() : null,
      allowTypedSignature: await allowTypedFor(admin, envelope.document_type),
      requireStaffSession: me.kind === "staff",
    };
  } catch (e) {
    console.error("[esign] view read failed", errorName(e));
    return { state: "invalid" };
  }
}

async function envelopeTouch(
  admin: Admin,
  tokenHash: string,
  step: "viewed" | "source_opened" | "original_downloaded",
  ctx: EsignRequestContext
): Promise<string> {
  const net = netContext(ctx);
  const { data, error } = await admin.rpc("esign_envelope_touch", {
    p_token_hash: tokenHash,
    p_step: step,
    p_ip: net.ip,
    p_user_agent: net.userAgent,
  });
  if (error) throw signerDbError("envelope_touch", error);
  return String((data as { result?: unknown } | null)?.result ?? "");
}

function touchPassed(result: string): boolean {
  return result === "ok" || (RECIPIENT_ACTIVE_STATUSES as readonly string[]).includes(result);
}

/** A live token plus its envelope, both tenant-scoped. */
async function readSignerEnvelope(admin: Admin, tokenHash: string): Promise<{ tok: TokenRow; envelope: EnvelopeRow }> {
  const tok = await readLiveToken(admin, tokenHash);
  if (!tok) throw signerError("not_found");
  let envelope: EnvelopeRow | null;
  try {
    envelope = await readEnvelopeScoped(admin, tok.envelope_id, tok.client_id);
  } catch (e) {
    throw signerDbError("envelope_read", e as { message?: string; code?: string });
  }
  if (!envelope) throw signerError("not_found");
  return { tok, envelope };
}

/** I24: `viewed` is recorded only by the explicit "Review the document" click. */
export async function markViewed(token: string, ctx: EsignRequestContext): Promise<SigningView> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  const result = await envelopeTouch(admin, tokenHash, "viewed", ctx);
  if (!touchPassed(result)) throw resultError(result);
  return loadSigningView(token);
}

export async function getSourceUrl(token: string, ctx: EsignRequestContext): Promise<EsignResponseData["source_url"]> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  // The touch refuses anything not open and unexpired, atomically.
  const result = await envelopeTouch(admin, tokenHash, "source_opened", ctx);
  if (!touchPassed(result)) throw resultError(result);

  const { envelope } = await readSignerEnvelope(admin, tokenHash);
  const snap = readSnapshot(envelope.document_snapshot);
  const title = snap?.document.title ?? "document";
  let url: string;
  try {
    // The FROZEN render, inline (no download disposition), 60 seconds.
    url = await shortSignedUrl(admin, ESIGN_BUCKET, envelope.render_frozen_path);
  } catch {
    throw signerError("server_error");
  }
  const fileName =
    envelope.source_mode === "pdf" && snap
      ? snap.source.file_name
      : originalDownloadName(title, SNIFF_TYPES.pdf.extension);
  return { url, fileName, sha256: envelope.render_sha256 };
}

export async function getOriginalUrl(token: string, ctx: EsignRequestContext): Promise<EsignResponseData["original_url"]> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  const before = await readSignerEnvelope(admin, tokenHash);
  if (before.envelope.source_mode !== "certificate") throw signerError("not_available");

  const result = await envelopeTouch(admin, tokenHash, "original_downloaded", ctx);
  if (!touchPassed(result)) throw resultError(result);

  const { envelope } = await readSignerEnvelope(admin, tokenHash);
  const snap = readSnapshot(envelope.document_snapshot);
  if (!snap) throw signerError("server_error");
  // I48: attachment disposition, extension from the sniffed kind (S6), never file_name.
  const fileName = originalDownloadName(snap.document.title, snap.source.extension);
  try {
    const url = await shortSignedUrl(admin, ESIGN_BUCKET, envelope.original_frozen_path, { download: fileName });
    return { url, fileName };
  } catch {
    throw signerError("server_error");
  }
}

// ── Signer: SMS verification ───────────────────────────────────────────────

export async function sendOtp(token: string, ctx: EsignRequestContext): Promise<EsignResponseData["send_otp"]> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  const tok = await readLiveToken(admin, tokenHash);
  if (!tok) throw signerError("not_found");
  const net = netContext(ctx);

  // Reserve-then-send (I17): the SQL counts the send before any SMS goes out.
  const code = generateOtpCode();
  const { data, error } = await admin.rpc("esign_envelope_otp_send", {
    p_token_hash: tokenHash,
    p_otp_hash: hashOtp(tok.recipient_id, code),
    p_ttl_seconds: OTP_TTL_SECONDS,
    p_cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS,
    p_max_sends: OTP_MAX_SENDS,
    p_ip: net.ip,
    p_user_agent: net.userAgent,
  });
  if (error) throw signerDbError("otp_send", error);

  const res = (data ?? {}) as { result?: string; recipient_id?: string; phone?: string | null; resend_available_at?: string };
  switch (res.result) {
    case "ok":
      break;
    case "cooldown":
      throw signerError("otp_cooldown", res.resend_available_at ? { resendAvailableAt: res.resend_available_at } : undefined);
    case "limit":
      throw signerError("otp_limit");
    case "not_required":
      throw signerError("otp_not_required");
    default:
      throw resultError(res.result ?? "");
  }
  // The HMAC is bound to the recipient the token named; SQL wrote it to that row.
  if (res.recipient_id && res.recipient_id !== tok.recipient_id) throw signerError("server_error");

  const phone = res.phone ?? null;
  const sms = phone ? await attempt(() => sendOtpSms({ to: phone, code })) : { ok: false };
  if (!sms.ok) {
    try {
      const { error: evErr } = await admin.from("signature_envelope_event").insert({
        envelope_id: tok.envelope_id,
        recipient_id: tok.recipient_id,
        event: "otp_send_failed",
        actor: "signer",
        actor_user_id: null,
        ip: net.ip,
        user_agent: net.userAgent,
        meta: {},
      });
      if (evErr) console.error("[esign] event insert failed", tok.envelope_id, evErr.code ?? "");
    } catch (e) {
      console.error("[esign] event insert failed", tok.envelope_id, errorName(e));
    }
    throw signerError("sms_failed");
  }

  return {
    resendAvailableAt:
      res.resend_available_at ?? new Date(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString(),
    phoneMask: maskPhone(phone),
  };
}

export async function verifyOtp(
  token: string,
  code: string,
  ctx: EsignRequestContext
): Promise<EsignResponseData["verify_otp"]> {
  const tokenHash = requireTokenHash(token);
  if (!/^\d{6}$/.test(code)) throw signerError("bad_request");
  const admin = createAdminClient();
  const tok = await readLiveToken(admin, tokenHash);
  if (!tok) throw signerError("not_found");
  const net = netContext(ctx);

  // A correct code binds a fresh browser session; only its hash is stored.
  const { otpSession, otpSessionHash } = generateOtpSession();
  const { data, error } = await admin.rpc("esign_envelope_otp_check", {
    p_token_hash: tokenHash,
    p_candidate_hash: hashOtp(tok.recipient_id, code),
    p_max_attempts: OTP_MAX_ATTEMPTS,
    p_session_hash: otpSessionHash,
    p_session_ttl_seconds: OTP_SESSION_TTL_SECONDS,
    p_ip: net.ip,
    p_user_agent: net.userAgent,
  });
  if (error) throw signerDbError("otp_check", error);

  const res = (data ?? {}) as { result?: string; session_expires_at?: string };
  switch (res.result) {
    case "verified":
      return {
        verified: true,
        otpSession,
        sessionExpiresAt:
          res.session_expires_at ?? new Date(Date.now() + OTP_SESSION_TTL_SECONDS * 1000).toISOString(),
      };
    case "incorrect":
      throw signerError("otp_incorrect");
    case "locked":
      throw signerError("otp_locked");
    case "code_expired":
      throw signerError("otp_code_expired");
    case "not_required":
      throw signerError("otp_not_required");
    case "expired":
      throw signerError("expired");
    case "not_found":
      throw signerError("not_found");
    default:
      throw signerError("closed");
  }
}

// ── Signer: sealed download and seal trigger ───────────────────────────────

export async function getSealedUrl(token: string, ctx: EsignRequestContext): Promise<EsignResponseData["sealed_url"]> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  const net = netContext(ctx);

  // The SQL throttles the audit row; the URL is minted on every ok. Never seals (C11).
  const { data, error } = await admin.rpc("esign_envelope_sealed_download", {
    p_token_hash: tokenHash,
    p_window_days: SEALED_DOWNLOAD_WINDOW_DAYS,
    p_ip: net.ip,
    p_user_agent: net.userAgent,
  });
  if (error) throw signerDbError("sealed_download", error);

  const res = (data ?? {}) as { result?: string; sealed_pdf_path?: string | null; title?: string | null };
  switch (res.result) {
    case "ok":
      break;
    case "completing":
      throw signerError("not_available", { message: "Your copy is still being prepared." });
    case "not_completed":
      throw signerError("closed");
    case "download_expired":
      throw signerError("download_expired");
    case "not_found":
      throw signerError("not_found");
    default:
      throw signerError("server_error");
  }
  if (!res.sealed_pdf_path) throw signerError("server_error");

  try {
    const url = await shortSignedUrl(admin, ESIGN_BUCKET, res.sealed_pdf_path, {
      download: sealedDownloadName(res.title || "document"),
    });
    return { url };
  } catch {
    throw signerError("server_error");
  }
}

/** Seal route: only a LIVE token of a SIGNED recipient of a completing envelope seals; else just the view. */
export async function sealFromSigner(token: string): Promise<SigningView> {
  if (!isWellFormedToken(token)) return { state: "invalid" };
  try {
    const admin = createAdminClient();
    const tok = await readLiveToken(admin, hashSigningToken(token));
    if (tok) {
      const envelope = await readEnvelopeScoped(admin, tok.envelope_id, tok.client_id);
      if (envelope?.status === "completing") {
        const { data: me, error } = await admin
          .from("signature_recipient")
          .select("id, status")
          .eq("id", tok.recipient_id)
          .eq("envelope_id", envelope.id)
          .eq("client_id", envelope.client_id)
          .maybeSingle<{ id: string; status: string }>();
        if (!error && me?.status === "signed") {
          await completeEnvelope(envelope.id, { force: false });
        }
      }
    }
  } catch (e) {
    console.error("[esign] seal from signer failed", errorName(e));
  }
  return loadSigningView(token);
}

// ── Signer: submit ─────────────────────────────────────────────────────────

type DriftCheck =
  | "document_hash"
  | "recipient_hash"
  | "document_row"
  | "source_path"
  | "frozen_render"
  | "frozen_original"
  | "client_source"
  | "recipient_artifact";

type DriftMeta = { check: DriftCheck; expected_sha256: string | null; actual_sha256: string | null };

/** System drift close (I27/C6). Returns the SQL result; notifies staff on ok. */
async function closeForDrift(admin: Admin, envelope: EnvelopeRow, drift: DriftMeta): Promise<string> {
  const { data, error } = await admin.rpc("esign_close_envelope", {
    p_envelope_id: envelope.id,
    p_client_id: envelope.client_id,
    p_token_hash: null,
    p_new_status: "voided",
    p_actor: "system",
    p_actor_user_id: null,
    p_session_user_id: null,
    p_reason: "document_changed",
    p_extra_event: "drift_detected",
    // No paths in meta.
    p_meta: drift,
    p_otp_session_hash: null,
    p_ip: null,
    p_user_agent: null,
  });
  if (error) {
    console.error("[esign] drift void failed", envelope.id, error.code ?? "");
    return "error";
  }
  const result = String(data);
  if (result === "ok") {
    revalidateDocuments();
    const labels = labelsFor(envelope);
    later("drift_notice", envelope.id, () =>
      notifyStaffClosedBestEffort(admin, {
        envelopeId: envelope.id,
        documentType: envelope.document_type,
        labels,
        outcome: "drift",
        reason: drift.check,
        declinedBy: null,
        attempt: null,
      })
    );
  }
  return result;
}

/** Integrity failed at submit: void, tell staff after the response, refuse. */
async function voidForDriftAtSubmit(admin: Admin, envelope: EnvelopeRow, drift: DriftMeta): Promise<never> {
  const result = await closeForDrift(admin, envelope, drift);
  if (result === "ok" || result === "error") throw signerError("document_changed");
  // Lost a race (declined, voided, expired, completing meanwhile): report that instead.
  throw resultError(result);
}

async function cookieUserId(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Sequential turn: mint a token, activate under the lock, email the link. */
async function activateNextRecipient(admin: Admin, envelope: EnvelopeRow, recipientId: string) {
  const { token, tokenHash } = generateSigningToken();
  const { data, error } = await admin.rpc("esign_activate_recipient", {
    p_envelope_id: envelope.id,
    p_client_id: envelope.client_id,
    p_recipient_id: recipientId,
    p_token_hash: tokenHash,
    p_issued_by: null,
    p_actor: "system",
  });
  if (error) {
    console.error("[esign] activation failed", envelope.id, error.code ?? "");
    return;
  }
  const result = String((data as { result?: unknown } | null)?.result ?? "");
  // Anything but ok leaves the recipient pending; staff see "Send link now" (C3).
  if (result !== "ok") return;

  const rows = await readRecipientsScoped(admin, envelope.id, envelope.client_id);
  const recipient = rows.find((r) => r.id === recipientId);
  if (!recipient) return;
  const labels = labelsFor(envelope);
  const total = Math.max(...rows.map((r) => r.routing_order));
  const res = await attempt(() =>
    sendSigningInvite({
      to: recipient.email,
      recipientName: recipient.name,
      title: labels.title,
      clientName: labels.clientName,
      signUrl: signUrlFor(token),
      expiresAt: envelope.expires_at,
      routing: "sequential",
      position: { order: recipient.routing_order, total },
      otherSignerCount: rows.length - 1,
      isTurnNotice: true,
      requireStaffSession: recipient.kind === "staff",
    })
  );
  await recordNotifyOutcome(admin, envelope.id, "turn_invite", recipient.id, res);
}

type RecordOutcome = { completionRequired: boolean; remaining: number; nextRecipientIds: string[] };

function uuidList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function submitRecipient(
  token: string,
  input: {
    printedName: string;
    timeZone: string;
    signature: SubmitSignature;
    appliedFieldIds: string[];
    otpSession: string | null;
  },
  ctx: EsignRequestContext
): Promise<SigningView> {
  // ── 1. Validate (cheap, before any DB call) ──
  const tokenHash = requireTokenHash(token);
  const printedName = normalizeSignerText(input.printedName ?? "");
  if (printedName.length < 2 || printedName.length > 120) throw signerError("bad_request");
  if (!winAnsiLossless(printedName)) throw signerError("name_unsupported");
  const timeZone = validTimeZone(input.timeZone);

  let method: SignatureMethod;
  let drawnBytes: Uint8Array | null = null;
  let drawnSha256: string | null = null;
  let typedText: string | null = null;
  if (input.signature.method === "drawn") {
    const parsed = parseSignatureDataUrl(input.signature.png);
    if (!parsed.ok) throw signerError("signature_invalid");
    // Client-reported pixels of ink: a UX guard, not a security control.
    if (!Number.isFinite(input.signature.inkLength) || input.signature.inkLength < MIN_INK_LENGTH) {
      throw signerError("signature_invalid");
    }
    method = "drawn";
    drawnBytes = parsed.bytes;
    drawnSha256 = parsed.sha256;
  } else if (input.signature.method === "typed") {
    const text = normalizeSignerText(input.signature.text ?? "");
    if (text.length < 2 || text.length > 120) throw signerError("bad_request");
    if (!typedCharsetOk(text)) throw signerError("typed_unsupported");
    method = "typed";
    typedText = text;
  } else {
    throw signerError("bad_request");
  }
  const appliedIds = [...new Set(input.appliedFieldIds ?? [])].sort();
  if (appliedIds.length === 0) throw signerError("fields_incomplete");

  // ── 2. Resolve the LIVE token → recipient → envelope ──
  const admin = createAdminClient();
  const { tok, envelope } = await readSignerEnvelope(admin, tokenHash);
  const { data: me, error: meErr } = await admin
    .from("signature_recipient")
    .select(RECIPIENT_COLUMNS)
    .eq("id", tok.recipient_id)
    .eq("envelope_id", envelope.id)
    .eq("client_id", envelope.client_id)
    .maybeSingle<RecipientRow>();
  if (meErr) throw signerDbError("submit_recipient_read", meErr);
  if (!me) throw signerError("not_found");

  if (envelope.status === "completing") return loadSigningView(token);
  if (envelope.status === "expired") throw signerError("expired");
  if (envelope.status !== "in_progress") throw signerError("closed");
  if (Date.parse(envelope.expires_at) <= Date.now()) {
    // Persist the expiry (or the all-signed promotion) through the lazy sweep.
    const swept = await envelopeTouch(admin, tokenHash, "viewed", ctx).catch(() => "expired");
    if (swept === "completing") return loadSigningView(token);
    throw signerError("expired");
  }
  if (me.status === "signed") throw signerError("already_signed");
  if (me.status === "pending") throw signerError("not_active");
  if (!(RECIPIENT_ACTIVE_STATUSES as readonly string[]).includes(me.status)) throw signerError("closed");

  // ── 3. Staff countersigner: this browser must be signed in as them (S1/S11) ──
  let sessionUserId: string | null = null;
  if (me.kind === "staff") {
    sessionUserId = await cookieUserId();
    if (!sessionUserId || sessionUserId !== me.staff_user_id) throw signerError("staff_session_required");
  }

  // ── 4. OTP: the verification must belong to THIS browser's live session ──
  const otpSessionHash = input.otpSession && TOKEN_RE.test(input.otpSession) ? hashOtpSession(input.otpSession) : null;
  if (me.require_sms_otp) {
    const sessionLive = !!me.otp_session_expires_at && Date.parse(me.otp_session_expires_at) > Date.now();
    if (!me.otp_verified_at || !otpSessionHash || !me.otp_session_hash || !sessionLive || !hexMatches(otpSessionHash, me.otp_session_hash)) {
      throw signerError("otp_required");
    }
  }

  // Typed signatures must be allowed by the type.
  if (method === "typed" && !(await allowTypedFor(admin, envelope.document_type))) {
    throw signerError("typed_unsupported", { message: "Typed signatures aren't allowed for this document. Draw your signature instead." });
  }

  // ── 5. Applied fields ⊆ my signature fields, ⊇ my required ones (S5) ──
  const { data: myFields, error: fieldsErr } = await admin
    .from("signature_field")
    .select("id, kind, required")
    .eq("envelope_id", envelope.id)
    .eq("recipient_id", me.id)
    .eq("client_id", envelope.client_id)
    .returns<{ id: string; kind: FieldKind; required: boolean }[]>();
  if (fieldsErr) throw signerDbError("submit_fields_read", fieldsErr);
  const signatureFieldIds = new Set((myFields ?? []).filter((f) => f.kind === "signature").map((f) => f.id));
  const requiredIds = (myFields ?? []).filter((f) => f.kind === "signature" && f.required).map((f) => f.id);
  if (!appliedIds.every((id) => signatureFieldIds.has(id)) || !requiredIds.every((id) => appliedIds.includes(id))) {
    throw signerError("fields_incomplete");
  }

  // ── 6. Integrity and drift (I27) ──
  const snap = readSnapshot(envelope.document_snapshot);
  let recomputedDoc: string | null = null;
  try {
    recomputedDoc = snap ? computeDocumentHashV2(snap) : null;
  } catch {
    recomputedDoc = null;
  }
  if (!snap || !hexMatches(recomputedDoc, envelope.document_hash)) {
    return voidForDriftAtSubmit(admin, envelope, {
      check: "document_hash",
      expected_sha256: envelope.document_hash,
      actual_sha256: recomputedDoc,
    });
  }
  let recomputedRecipient: string | null = null;
  try {
    recomputedRecipient = computeRecipientHash({
      documentHash: envelope.document_hash,
      recipientId: me.id,
      consentText: me.consent_text,
      checkboxText: me.checkbox_text,
      requireSmsOtp: me.require_sms_otp,
    });
  } catch {
    recomputedRecipient = null;
  }
  if (!hexMatches(recomputedRecipient, me.recipient_hash)) {
    return voidForDriftAtSubmit(admin, envelope, {
      check: "recipient_hash",
      expected_sha256: me.recipient_hash,
      actual_sha256: recomputedRecipient,
    });
  }

  // (d) the live document row is still the one that was sent.
  const { data: liveDoc, error: liveErr } = await admin
    .from("documents")
    .select("id, signed_at, status, storage_path, esign_envelope_id")
    .eq("id", envelope.document_id)
    .eq("client_id", envelope.client_id)
    .maybeSingle<{ id: string; signed_at: string | null; status: string; storage_path: string; esign_envelope_id: string | null }>();
  if (liveErr) throw signerDbError("submit_doc_read", liveErr);
  if (
    !liveDoc ||
    liveDoc.signed_at ||
    liveDoc.status === "superseded" ||
    liveDoc.esign_envelope_id !== envelope.id ||
    liveDoc.storage_path !== snap.source.storage_path
  ) {
    return voidForDriftAtSubmit(admin, envelope, {
      check: "document_row",
      expected_sha256: envelope.original_sha256,
      actual_sha256: null,
    });
  }

  // I18: never let the service role download a path outside this client.
  if (!isClientScopedPath(snap.source.storage_path, envelope.client_id)) {
    return voidForDriftAtSubmit(admin, envelope, {
      check: "source_path",
      expected_sha256: envelope.original_sha256,
      actual_sha256: null,
    });
  }

  // (b) frozen render, (e) frozen original (image/certificate), (c) client-files original.
  const checkOriginal = envelope.source_mode !== "pdf";
  const [renderRes, originalRes, liveRes] = await Promise.allSettled([
    downloadObject(admin, ESIGN_BUCKET, envelope.render_frozen_path),
    checkOriginal ? downloadObject(admin, ESIGN_BUCKET, envelope.original_frozen_path) : Promise.resolve(null),
    downloadObjectOrMissing(admin, CLIENT_FILES_BUCKET, snap.source.storage_path),
  ]);
  if (renderRes.status === "rejected" || originalRes.status === "rejected") {
    // The esign bucket is service-role only: a failed read is ours or transient, never drift.
    console.error("[esign] frozen artifact unreadable", envelope.id);
    throw signerError("server_error");
  }
  const renderSha = sha256Hex(renderRes.value);
  if (!hexMatches(renderSha, envelope.render_sha256)) {
    return voidForDriftAtSubmit(admin, envelope, {
      check: "frozen_render",
      expected_sha256: envelope.render_sha256,
      actual_sha256: renderSha,
    });
  }
  if (checkOriginal && originalRes.value) {
    const originalSha = sha256Hex(originalRes.value);
    if (!hexMatches(originalSha, envelope.original_sha256)) {
      return voidForDriftAtSubmit(admin, envelope, {
        check: "frozen_original",
        expected_sha256: envelope.original_sha256,
        actual_sha256: originalSha,
      });
    }
  }
  if (liveRes.status === "rejected") {
    // Not confirmed missing: a transient storage failure must never void. Nothing written yet.
    console.error("[esign] client source unreadable", envelope.id);
    throw signerError("server_error");
  }
  const liveSha = liveRes.value === null ? null : sha256Hex(liveRes.value);
  if (!hexMatches(liveSha, envelope.original_sha256)) {
    return voidForDriftAtSubmit(admin, envelope, {
      check: "client_source",
      expected_sha256: envelope.original_sha256,
      actual_sha256: liveSha,
    });
  }

  // ── 7. The drawn PNG must embed (errors land on the signer who can fix them) ──
  if (drawnBytes && !(await probeSignaturePng(drawnBytes).catch(() => false))) {
    throw signerError("signature_invalid");
  }

  // ── 8. Evidence values, exactly as SQL will store them ──
  const signedAt = isoMs(new Date());
  const dateText = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium" })
    .format(new Date(signedAt))
    .normalize("NFKC");
  const net = netContext(ctx);

  // ── 9. Drawn: attempt-scoped upload, upsert:false (I28) ──
  const attemptId = randomUUID();
  const signaturePath = drawnBytes ? recipientSignaturePath(envelope.id, me.id, attemptId) : null;
  const removeAttempt = async () => {
    if (signaturePath) await removeObjectsQuietly(admin, ESIGN_BUCKET, [signaturePath]);
  };
  if (drawnBytes && signaturePath) {
    try {
      await uploadObject(admin, ESIGN_BUCKET, signaturePath, drawnBytes, "image/png");
    } catch {
      // Nothing references the object before the RPC.
      await removeAttempt();
      console.error("[esign] signature upload failed", envelope.id);
      throw signerError("server_error");
    }
  }

  // ── 10. Receipt chain + the one transactional write, retrying a moved chain ──
  const readChainHead = async (): Promise<{ prev: string | null; chainIndex: number }> => {
    const [{ data: env, error: envErr }, { count, error: countErr }] = await Promise.all([
      admin
        .from("signature_envelope")
        .select("last_receipt_sha256")
        .eq("id", envelope.id)
        .eq("client_id", envelope.client_id)
        .maybeSingle<{ last_receipt_sha256: string | null }>(),
      admin
        .from("signature_recipient")
        .select("id", { count: "exact", head: true })
        .eq("envelope_id", envelope.id)
        .eq("client_id", envelope.client_id)
        .eq("status", "signed"),
    ]);
    if (envErr || countErr || !env) throw new Error("chain head read failed");
    return { prev: env.last_receipt_sha256, chainIndex: (count ?? 0) + 1 };
  };

  let outcome: RecordOutcome | null = null;
  let ourReceipt = "";
  for (let tries = 0; ; tries++) {
    let head: { prev: string | null; chainIndex: number };
    try {
      head = await readChainHead();
    } catch {
      await removeAttempt();
      throw signerError("server_error");
    }
    const receiptInput: ReceiptInput = {
      envelopeId: envelope.id,
      documentHash: envelope.document_hash,
      recipientId: me.id,
      recipientHash: me.recipient_hash,
      routingOrder: me.routing_order,
      chainIndex: head.chainIndex,
      prevReceiptSha256: head.prev,
      method,
      signatureImageSha256: drawnSha256,
      typedText,
      typedFont: typedText ? TYPED_FONT_ID : null,
      printedName,
      dateText,
      timeZone,
      signedAt,
      otpVerifiedAt: isoOrNull(me.otp_verified_at),
      ip: net.ip,
      userAgent: net.userAgent,
      appliedFieldIds: appliedIds,
    };
    ourReceipt = computeReceiptHash(receiptInput);

    const { data, error } = await admin.rpc("esign_record_signature", {
      p_token_hash: tokenHash,
      p_recipient_id: me.id,
      p_session_user_id: sessionUserId,
      p_signed_at: signedAt,
      p_printed_name: printedName,
      p_signature_method: method,
      p_signature_image_path: signaturePath,
      p_signature_image_sha256: drawnSha256,
      p_typed_signature_text: typedText,
      p_typed_signature_font: typedText ? TYPED_FONT_ID : null,
      p_date_text: dateText,
      p_time_zone: timeZone,
      p_applied_field_ids: appliedIds,
      p_chain_index: head.chainIndex,
      p_prev_receipt_sha256: head.prev,
      p_receipt_sha256: ourReceipt,
      p_otp_session_hash: otpSessionHash,
      p_ip: net.ip,
      p_user_agent: net.userAgent,
    });

    if (error) {
      // ── 11. Ambiguous: the commit may have gone through. Re-read before cleanup (I25). ──
      const { data: reread, error: rereadErr } = await admin
        .from("signature_recipient")
        .select("status, receipt_sha256")
        .eq("id", me.id)
        .eq("envelope_id", envelope.id)
        .eq("client_id", envelope.client_id)
        .maybeSingle<{ status: string; receipt_sha256: string | null }>();
      if (rereadErr) {
        console.error("[esign] record ambiguous", envelope.id);
        throw signerError("server_error");
      }
      if (reread?.status === "signed" && reread.receipt_sha256 === ourReceipt) {
        let rows: RecipientRow[] = [];
        let envStatus = "in_progress";
        try {
          rows = await readRecipientsScoped(admin, envelope.id, envelope.client_id);
          const fresh = await readEnvelopeScoped(admin, envelope.id, envelope.client_id);
          envStatus = fresh?.status ?? envStatus;
        } catch {
          // Committed; notices are best-effort.
        }
        outcome = {
          completionRequired: envStatus === "completing",
          remaining: rows.filter((r) => r.status !== "signed").length,
          nextRecipientIds: envStatus === "in_progress" ? nextPendingRecipientIds(rows, envelope.routing_mode) : [],
        };
        break;
      }
      await removeAttempt();
      if (reread?.status === "signed") throw signerError("already_signed");
      throw fromDbError(error);
    }

    const res = (data ?? {}) as {
      result?: string;
      completion_required?: unknown;
      remaining?: unknown;
      next_recipient_ids?: unknown;
    };
    const result = res.result ?? "";
    if (result === "ok") {
      outcome = {
        completionRequired: res.completion_required === true,
        remaining: Number.isFinite(Number(res.remaining)) ? Number(res.remaining) : 0,
        nextRecipientIds: uuidList(res.next_recipient_ids),
      };
      break;
    }
    if (result === "chain_moved" && tries < CHAIN_RETRIES) continue;

    // ── 12. Nothing was written: remove the attempt and map. ──
    await removeAttempt();
    switch (result) {
      case "chain_moved":
        throw signerError("server_error");
      case "completion_required":
        return loadSigningView(token);
      case "out_of_order":
      case "otp_required":
      case "fields_incomplete":
      case "staff_session_required":
      case "not_active":
      case "already_signed":
        throw signerError(result);
      case "expired":
        throw signerError("expired");
      case "not_found":
        throw signerError("not_found");
      default:
        throw signerError("closed");
    }
  }

  // ── 13. Revalidate ──
  revalidateDocuments();

  // ── 14. After the response: next turn and receipt. No sealing (C11). ──
  const committed = outcome;
  const labels = labelsFor(envelope);
  later("submit_notices", envelope.id, async () => {
    for (const nextId of committed.nextRecipientIds) {
      try {
        await activateNextRecipient(admin, envelope, nextId);
      } catch (e) {
        console.error("[esign] activation failed", envelope.id, errorName(e));
      }
    }
    if (!committed.completionRequired) {
      const res = await attempt(() =>
        sendRecipientReceipt({
          to: me.email,
          recipientName: me.name,
          title: labels.title,
          signedAt,
          receiptSha256: ourReceipt,
          renderSha256: envelope.render_sha256,
          remaining: committed.remaining,
        })
      );
      await recordNotifyOutcome(admin, envelope.id, "receipt", me.id, res);
    }
  });

  // ── 15. signed_waiting or completing ──
  return loadSigningView(token);
}

// ── Signer: decline ────────────────────────────────────────────────────────

export async function declineRecipient(
  token: string,
  input: { reason: string | null; otpSession: string | null },
  ctx: EsignRequestContext
): Promise<SigningView> {
  const tokenHash = requireTokenHash(token);
  const reason = input.reason ? input.reason.trim().slice(0, 1000) || null : null;
  const otpSessionHash = input.otpSession && TOKEN_RE.test(input.otpSession) ? hashOtpSession(input.otpSession) : null;
  const admin = createAdminClient();
  const net = netContext(ctx);

  // Unlocked read only to learn whether a staff session must be presented; SQL re-checks.
  const tok = await readLiveToken(admin, tokenHash);
  let recipient: { id: string; kind: string; name: string; envelope_id: string; client_id: string } | null = null;
  if (tok) {
    const { data, error } = await admin
      .from("signature_recipient")
      .select("id, kind, name, envelope_id, client_id")
      .eq("id", tok.recipient_id)
      .eq("envelope_id", tok.envelope_id)
      .eq("client_id", tok.client_id)
      .maybeSingle<{ id: string; kind: string; name: string; envelope_id: string; client_id: string }>();
    if (error) throw signerDbError("decline_recipient_read", error);
    recipient = data ?? null;
  }
  const sessionUserId = recipient?.kind === "staff" ? await cookieUserId() : null;

  const { data, error } = await admin.rpc("esign_close_envelope", {
    p_envelope_id: null,
    p_client_id: null,
    p_token_hash: tokenHash,
    p_new_status: "declined",
    p_actor: "signer",
    p_actor_user_id: null,
    p_session_user_id: sessionUserId,
    p_reason: reason,
    p_extra_event: null,
    p_meta: null,
    p_otp_session_hash: otpSessionHash,
    p_ip: net.ip,
    p_user_agent: net.userAgent,
  });
  if (error) throw signerDbError("close_envelope", error);

  const result = String(data);
  switch (result) {
    case "ok": {
      revalidateDocuments();
      if (tok && recipient) {
        const declinedBy = recipient.name;
        const declinerId = recipient.id;
        later("decline_notices", tok.envelope_id, async () => {
          const envelope = await readEnvelopeScoped(admin, tok.envelope_id, tok.client_id);
          if (!envelope) return;
          const labels = labelsFor(envelope);
          await notifyStaffClosedBestEffort(admin, {
            envelopeId: envelope.id,
            documentType: envelope.document_type,
            labels,
            outcome: "declined",
            reason,
            declinedBy,
            attempt: null,
          });
          await notifyWithdrawnBestEffort(admin, {
            envelopeId: envelope.id,
            clientId: envelope.client_id,
            labels,
            outcome: "declined",
            exceptRecipientId: declinerId,
            includeSigned: false,
          });
        });
      }
      return loadSigningView(token);
    }
    case "already_signed":
    case "completing":
    case "declined":
    case "voided":
      // S4/C8: a signed recipient can't decline; a repeat shows the closed state.
      return loadSigningView(token);
    case "not_active":
      throw signerError("not_active");
    case "otp_required":
      throw signerError("otp_required");
    case "staff_session_required":
      throw signerError("staff_session_required");
    default:
      throw resultError(result);
  }
}

// ── Completion: seal under an exclusive lease (S8/C6/C11/C12) ──────────────

type EventRow = {
  event: string;
  actor: string;
  recipient_id: string | null;
  at: string;
  ip: string | null;
  user_agent: string | null;
  meta: unknown;
};

async function releaseSeal(
  admin: Admin,
  envelopeId: string,
  leaseId: string,
  errorClass: string,
  check: string
): Promise<{ result: string; attempt: number | null }> {
  try {
    const { data, error } = await admin.rpc("esign_release_seal", {
      p_envelope_id: envelopeId,
      p_lease_id: leaseId,
      p_error_class: errorClass.slice(0, 80),
      p_check: check.slice(0, 40),
    });
    if (error) {
      console.error("[esign] seal release failed", envelopeId, error.code ?? "");
      return { result: "error", attempt: null };
    }
    const res = (data ?? {}) as { result?: unknown; attempt?: unknown };
    const n = Number(res.attempt);
    return { result: String(res.result ?? ""), attempt: Number.isFinite(n) ? n : null };
  } catch (e) {
    console.error("[esign] seal release failed", envelopeId, errorName(e));
    return { result: "error", attempt: null };
  }
}

/** Staff hear about a failing seal on the first and third attempt, not every retry. */
function sealFailedNotice(admin: Admin, envelope: EnvelopeRow, attemptNo: number | null, check: string) {
  if (attemptNo !== 1 && attemptNo !== 3) return;
  const labels = labelsFor(envelope);
  later("seal_failed_notice", envelope.id, () =>
    notifyStaffClosedBestEffort(admin, {
      envelopeId: envelope.id,
      documentType: envelope.document_type,
      labels,
      outcome: "seal_failed",
      reason: check,
      declinedBy: null,
      attempt: attemptNo,
    })
  );
}

async function sendCompletionNotices(
  admin: Admin,
  i: {
    envelope: EnvelopeRow;
    recipients: RecipientRow[];
    pdf: Uint8Array;
    sealedSha256: string;
    completedAt: string;
    engagementActivated: boolean | null;
    recipientIds: ReadonlySet<string> | "all";
    staff: boolean;
  }
) {
  const labels = labelsFor(i.envelope);
  const fileName = sealedDownloadName(labels.title);
  for (const r of i.recipients) {
    if (i.recipientIds !== "all" && !i.recipientIds.has(r.id)) continue;
    const res = await attempt(() =>
      sendCompletedCopy({
        to: r.email,
        recipientName: r.name,
        title: labels.title,
        completedAt: i.completedAt,
        sealedSha256: i.sealedSha256,
        pdf: i.pdf,
        fileName,
      })
    );
    await recordNotifyOutcome(admin, i.envelope.id, "completed_copy", r.id, res);
  }
  if (!i.staff) return;

  let activated = i.engagementActivated;
  if (activated === null) {
    const { data: ev } = await admin
      .from("signature_envelope_event")
      .select("id")
      .eq("envelope_id", i.envelope.id)
      .eq("event", "engagement_activated")
      .limit(1);
    activated = (ev?.length ?? 0) > 0;
  }
  const to = await staffRecipients(admin, i.envelope.document_type);
  const ordered = [...i.recipients].sort((a, b) => (a.chain_index ?? 99) - (b.chain_index ?? 99));
  const res = await attempt(() =>
    notifyStaffCompleted({
      to,
      title: labels.title,
      clientName: labels.clientName,
      envelopeId: i.envelope.id,
      completedAt: i.completedAt,
      sealedSha256: i.sealedSha256,
      engagementActivated: activated ?? false,
      pdf: i.pdf,
      fileName,
      recipients: ordered.map((r) => ({
        name: r.name,
        printedName: r.printed_name ?? "",
        email: r.email,
        method: (r.signature_method === "typed" ? "typed" : "drawn") as SignatureMethod,
      })),
    })
  );
  await recordNotifyOutcome(admin, i.envelope.id, "staff_completed", null, res);
}

/** An already-completed envelope within 24 h re-sends only notices with no recorded outcome (C11). */
async function ensureCompletionNotices(admin: Admin, envelopeId: string) {
  try {
    const { data: envelope, error } = await admin
      .from("signature_envelope")
      .select(ENVELOPE_COLUMNS)
      .eq("id", envelopeId)
      .maybeSingle<EnvelopeRow>();
    if (error || !envelope || envelope.status !== "completed" || !envelope.sealed_pdf_path || !envelope.sealed_pdf_sha256) return;
    const completedMs = envelope.completed_at ? Date.parse(envelope.completed_at) : NaN;
    if (!Number.isFinite(completedMs) || completedMs <= Date.now() - COMPLETION_NOTICE_WINDOW_MS) return;

    const { data: events, error: evErr } = await admin
      .from("signature_envelope_event")
      .select("event, meta")
      .eq("envelope_id", envelope.id)
      .in("event", ["notified", "notify_failed"])
      .returns<{ event: string; meta: unknown }[]>();
    if (evErr) return;
    const recorded = new Set<string>();
    for (const e of events ?? []) {
      const meta = isRecord(e.meta) ? e.meta : {};
      recorded.add(`${String(meta.kind ?? "")}:${typeof meta.recipient_id === "string" ? meta.recipient_id : ""}`);
    }
    const recipients = await readRecipientsScoped(admin, envelope.id, envelope.client_id);
    const missing = new Set(recipients.filter((r) => !recorded.has(`completed_copy:${r.id}`)).map((r) => r.id));
    const staffMissing = ![...recorded].some((k) => k.startsWith("staff_completed:"));
    if (missing.size === 0 && !staffMissing) return;

    const sealedPath = envelope.sealed_pdf_path;
    const sealedSha = envelope.sealed_pdf_sha256;
    later("completion_notices_retry", envelope.id, async () => {
      const pdf = await downloadObject(admin, ESIGN_BUCKET, sealedPath);
      if (!hexMatches(sha256Hex(pdf), sealedSha)) {
        console.error("[esign] sealed copy hash mismatch", envelope.id);
        return;
      }
      await sendCompletionNotices(admin, {
        envelope,
        recipients,
        pdf,
        sealedSha256: sealedSha,
        completedAt: envelope.completed_at ?? isoMs(new Date()),
        engagementActivated: null,
        recipientIds: missing,
        staff: staffMissing,
      });
    });
  } catch (e) {
    console.error("[esign] completion notice check failed", envelopeId, errorName(e));
  }
}

/** Idempotent. `force` (staff Finish sealing) skips the backoff, never the lease. */
export async function completeEnvelope(envelopeId: string, opts: { force: boolean }): Promise<FinishSealingResult> {
  const admin = createAdminClient();

  // ── 1. Claim the exclusive lease ──
  const { data: claim, error: claimErr } = await admin.rpc("esign_claim_seal", {
    p_envelope_id: envelopeId,
    p_lease_seconds: SEAL_LEASE_SECONDS,
    p_force: opts.force,
  });
  if (claimErr) {
    console.error("[esign] seal claim failed", envelopeId, claimErr.code ?? "");
    return "retry_later";
  }
  const claimed = (claim ?? {}) as { result?: unknown; lease_id?: unknown };
  switch (String(claimed.result ?? "")) {
    case "claimed":
      break;
    case "completed":
      await ensureCompletionNotices(admin, envelopeId);
      return "already_completed";
    case "not_completing":
    case "not_found":
      return "not_completing";
    case "held":
      return "sealing_now";
    case "backoff":
      return "backoff";
    default:
      return "retry_later";
  }
  const leaseId = typeof claimed.lease_id === "string" ? claimed.lease_id : null;
  if (!leaseId) return "retry_later";

  // ── 2. Evidence reads ──
  let envelope: EnvelopeRow | null = null;
  let recipients: RecipientRow[] = [];
  let events: EventRow[] = [];
  let tableFieldIds: string[] = [];
  try {
    const { data: env, error: envErr } = await admin
      .from("signature_envelope")
      .select(ENVELOPE_COLUMNS)
      .eq("id", envelopeId)
      .maybeSingle<EnvelopeRow>();
    if (envErr) throw envErr;
    envelope = env ?? null;
    if (envelope) {
      const [rows, fieldsRes, eventsRes] = await Promise.all([
        readRecipientsScoped(admin, envelope.id, envelope.client_id),
        admin
          .from("signature_field")
          .select("id")
          .eq("envelope_id", envelope.id)
          .eq("client_id", envelope.client_id)
          .returns<{ id: string }[]>(),
        admin
          .from("signature_envelope_event")
          .select("event, actor, recipient_id, at, ip, user_agent, meta")
          .eq("envelope_id", envelope.id)
          .order("seq", { ascending: true })
          .returns<EventRow[]>(),
      ]);
      if (fieldsRes.error) throw fieldsRes.error;
      if (eventsRes.error) throw eventsRes.error;
      recipients = rows;
      tableFieldIds = (fieldsRes.data ?? []).map((f) => f.id);
      events = eventsRes.data ?? [];
    }
  } catch (e) {
    await releaseSeal(admin, envelopeId, leaseId, errorName(e), "read");
    return "retry_later";
  }
  if (!envelope) {
    await releaseSeal(admin, envelopeId, leaseId, "missing", "read");
    return "not_completing";
  }
  const env = envelope;

  const fail = async (check: string, errorClass: string, notice: boolean): Promise<FinishSealingResult> => {
    const released = await releaseSeal(admin, env.id, leaseId, errorClass, check);
    if (notice) sealFailedNotice(admin, env, released.attempt, check);
    return "retry_later";
  };
  // Only byte drift of service-role-only objects may void a completing envelope (C6).
  const driftVoid = async (drift: DriftMeta): Promise<FinishSealingResult> => {
    await releaseSeal(admin, env.id, leaseId, "drift", drift.check);
    const result = await closeForDrift(admin, env, drift);
    if (result === "ok") return "voided_drift";
    if (result === "completed") return "already_completed";
    return "retry_later";
  };

  if (env.status !== "completing") {
    await releaseSeal(admin, env.id, leaseId, "status", "roster");
    return env.status === "completed" ? "already_completed" : "not_completing";
  }
  if (recipients.length === 0 || recipients.some((r) => r.status !== "signed")) {
    return fail("roster", "unsigned", true);
  }
  const snap = readSnapshot(env.document_snapshot);
  if (!snap) return fail("receipt_chain", "snapshot", true);
  const snapFieldIds = snap.fields.map((f) => f.id).sort();
  const sortedTableIds = [...tableFieldIds].sort();
  if (snapFieldIds.length !== sortedTableIds.length || snapFieldIds.some((id, k) => id !== sortedTableIds[k])) {
    return fail("fields", "mismatch", true);
  }

  // ── 3. Frozen render (+ original for image/certificate) ──
  const needOriginal = env.source_mode !== "pdf";
  let renderBytes: Uint8Array;
  let originalBytes: Uint8Array | null = null;
  try {
    const [render, original] = await Promise.all([
      downloadObject(admin, ESIGN_BUCKET, env.render_frozen_path),
      needOriginal ? downloadObject(admin, ESIGN_BUCKET, env.original_frozen_path) : Promise.resolve(null),
    ]);
    renderBytes = render;
    originalBytes = original;
  } catch (e) {
    return fail("storage", errorName(e), false);
  }
  const renderSha = sha256Hex(renderBytes);
  if (!hexMatches(renderSha, env.render_sha256)) {
    return driftVoid({ check: "frozen_render", expected_sha256: env.render_sha256, actual_sha256: renderSha });
  }
  if (needOriginal && originalBytes) {
    const originalSha = sha256Hex(originalBytes);
    if (!hexMatches(originalSha, env.original_sha256)) {
      return driftVoid({ check: "frozen_original", expected_sha256: env.original_sha256, actual_sha256: originalSha });
    }
  }

  // ── 4. Drawn signature images ──
  const pngs = new Map<string, Uint8Array>();
  for (const r of recipients) {
    if (r.signature_method !== "drawn") continue;
    const path = r.signature_image_path ?? "";
    const prefix = `envelopes/${env.id}/recipients/${r.id}/attempts/`;
    if (!path.startsWith(prefix) || !path.endsWith("/signature.png") || !r.signature_image_sha256) {
      return fail("receipt_chain", "artifact_path", true);
    }
    let bytes: Uint8Array;
    try {
      bytes = await downloadObject(admin, ESIGN_BUCKET, path);
    } catch (e) {
      return fail("storage", errorName(e), false);
    }
    const sha = sha256Hex(bytes);
    if (!hexMatches(sha, r.signature_image_sha256)) {
      return driftVoid({ check: "recipient_artifact", expected_sha256: r.signature_image_sha256, actual_sha256: sha });
    }
    pngs.set(r.id, bytes);
  }

  // ── 5. Recompute every hash from DB rows; mismatch → seal_failed, never a void ──
  const chain = [...recipients].sort((a, b) => (a.chain_index ?? 0) - (b.chain_index ?? 0));
  const receipts: string[] = [];
  let envelopeHash: string;
  try {
    const documentHash = computeDocumentHashV2(snap);
    if (!hexMatches(documentHash, env.document_hash)) throw new Error("document_hash");
    for (let k = 0; k < chain.length; k++) {
      const r = chain[k];
      if (r.chain_index !== k + 1) throw new Error("chain_index");
      const expectedPrev = k === 0 ? null : receipts[k - 1];
      if ((r.prev_receipt_sha256 ?? null) !== expectedPrev) throw new Error("prev");
      const recipientHash = computeRecipientHash({
        documentHash: env.document_hash,
        recipientId: r.id,
        consentText: r.consent_text,
        checkboxText: r.checkbox_text,
        requireSmsOtp: r.require_sms_otp,
      });
      if (!hexMatches(recipientHash, r.recipient_hash)) throw new Error("recipient_hash");
      if (!r.signed_at || !r.printed_name || !r.date_text || !r.time_zone || !r.receipt_sha256) throw new Error("evidence");
      const method: SignatureMethod = r.signature_method === "typed" ? "typed" : "drawn";
      const receipt = computeReceiptHash({
        envelopeId: env.id,
        documentHash: env.document_hash,
        recipientId: r.id,
        recipientHash: r.recipient_hash,
        routingOrder: r.routing_order,
        chainIndex: r.chain_index,
        prevReceiptSha256: r.prev_receipt_sha256 ?? null,
        method,
        signatureImageSha256: method === "drawn" ? r.signature_image_sha256 : null,
        typedText: method === "typed" ? r.typed_signature_text : null,
        typedFont: method === "typed" ? r.typed_signature_font : null,
        printedName: r.printed_name,
        dateText: r.date_text,
        timeZone: r.time_zone,
        signedAt: isoMs(r.signed_at),
        otpVerifiedAt: isoOrNull(r.otp_verified_at),
        ip: r.signed_ip,
        userAgent: r.signed_user_agent,
        appliedFieldIds: [...(r.applied_field_ids ?? [])].sort(),
      });
      if (!hexMatches(receipt, r.receipt_sha256)) throw new Error("receipt");
      receipts.push(r.receipt_sha256);
    }
    if (!hexMatches(receipts[receipts.length - 1], env.last_receipt_sha256)) throw new Error("head");
    envelopeHash = computeEnvelopeHash({ documentHash: env.document_hash, receipts });
    if (!HEX64.test(envelopeHash)) throw new Error("envelope_hash");
  } catch (e) {
    return fail("receipt_chain", e instanceof Error ? e.message.slice(0, 40) : "mismatch", true);
  }

  // ── 6. Build in memory; a throw persists nothing ──
  const sealRecipients: SealRecipient[] = chain.map((r) => {
    const method: SignatureMethod = r.signature_method === "typed" ? "typed" : "drawn";
    return {
      id: r.id,
      kind: r.kind as RecipientKind,
      routingOrder: r.routing_order,
      chainIndex: r.chain_index ?? 0,
      name: r.name,
      email: r.email,
      phoneE164: r.phone,
      requireSmsOtp: r.require_sms_otp,
      printedName: r.printed_name ?? "",
      method,
      signaturePng: method === "drawn" ? pngs.get(r.id) ?? null : null,
      typedText: method === "typed" ? r.typed_signature_text : null,
      typedFont: method === "typed" ? r.typed_signature_font : null,
      dateText: r.date_text ?? "",
      timeZone: r.time_zone ?? "",
      signedAt: isoOrNull(r.signed_at) ?? "",
      activatedAt: isoOrNull(r.activated_at),
      viewedAt: isoOrNull(r.viewed_at),
      sourceOpenedAt: isoOrNull(r.source_opened_at),
      originalDownloadedAt: isoOrNull(r.original_downloaded_at),
      otpVerifiedAt: isoOrNull(r.otp_verified_at),
      ip: r.signed_ip,
      userAgent: r.signed_user_agent,
      consentText: r.consent_text,
      checkboxText: r.checkbox_text,
      recipientHash: r.recipient_hash,
      receiptSha256: r.receipt_sha256 ?? "",
      appliedFieldIds: [...(r.applied_field_ids ?? [])].sort(),
    };
  });
  // I14: only signer rows carry network details onto the certificate.
  const sealEvents: SealEvent[] = events.map((e) => {
    const actor: SealEvent["actor"] = e.actor === "signer" || e.actor === "staff" ? e.actor : "system";
    return {
      event: e.event,
      actor,
      recipientId: e.recipient_id,
      at: isoOrNull(e.at) ?? e.at,
      ip: actor === "signer" ? e.ip : null,
      user_agent: actor === "signer" ? e.user_agent : null,
    };
  });

  let sealed: Uint8Array;
  try {
    sealed = await buildSealedEnvelopePdf({
      envelopeId: env.id,
      documentId: env.document_id,
      snapshot: snap,
      documentHash: env.document_hash,
      envelopeHash,
      renderPdf: renderBytes,
      // Image originals can carry GPS; only certificate originals are attached (spec C.2).
      originalBytes: env.source_mode === "certificate" ? originalBytes : null,
      sentAt: isoOrNull(env.sent_at) ?? env.sent_at,
      completedAt: isoOrNull(env.completing_at) ?? isoMs(new Date()),
      recipients: sealRecipients,
      events: sealEvents,
    });
  } catch (e) {
    const name = errorName(e);
    console.error("[esign] seal build failed", env.id, name);
    return fail(name === "SealGeometryError" ? "geometry" : "build", name, true);
  }
  const sealedSha256 = sha256Hex(sealed);

  // ── 7. Attempt-scoped upload (upsert:false) ──
  const sealedPath = envelopeSealedPath(env.id, randomUUID());
  try {
    await uploadObject(admin, ESIGN_BUCKET, sealedPath, sealed, "application/pdf");
  } catch (e) {
    await removeObjectsQuietly(admin, ESIGN_BUCKET, [sealedPath]);
    return fail("storage", errorName(e), false);
  }
  const removeSealed = () => removeObjectsQuietly(admin, ESIGN_BUCKET, [sealedPath]);

  // ── 8. The completion write ──
  const { data: done, error: doneErr } = await admin.rpc("esign_complete_envelope", {
    p_envelope_id: env.id,
    p_lease_id: leaseId,
    p_signed_recipient_ids: chain.map((r) => r.id),
    p_receipt_chain: receipts,
    p_envelope_hash: envelopeHash,
    p_sealed_pdf_path: sealedPath,
    p_sealed_pdf_sha256: sealedSha256,
  });

  let engagementActivated: boolean | null = null;
  if (doneErr) {
    // Ambiguous (I25). Releasing the lease is the proof: it waits on the
    // envelope lock, and only succeeds if the completion never committed.
    const released = await releaseSeal(admin, env.id, leaseId, "rpc", "complete");
    if (released.result === "released") {
      await removeSealed();
      return "retry_later";
    }
    const { data: reread, error: rereadErr } = await admin
      .from("signature_envelope")
      .select("status, sealed_pdf_path")
      .eq("id", env.id)
      .eq("client_id", env.client_id)
      .maybeSingle<{ status: string; sealed_pdf_path: string | null }>();
    if (rereadErr || !reread || reread.status !== "completed" || reread.sealed_pdf_path !== sealedPath) {
      // Unknown or someone else's object is referenced: never remove ours blindly.
      console.error("[esign] complete ambiguous", env.id);
      return reread?.status === "completed" ? "already_completed" : "retry_later";
    }
    // Committed with our path: continue on the success path.
  } else {
    const res = (done ?? {}) as { result?: unknown; engagement_activated?: unknown; sealed_pdf_path?: unknown; attempt?: unknown };
    const result = String(res.result ?? "");
    switch (result) {
      case "ok":
        engagementActivated = res.engagement_activated === true;
        break;
      case "already_completed":
        if (res.sealed_pdf_path !== sealedPath) await removeSealed();
        return "already_completed";
      case "not_holder":
        await removeSealed();
        return "sealing_now";
      case "roster_moved":
      case "chain_moved":
      case "document_changed": {
        // SQL already released the lease and wrote one seal_failed.
        await removeSealed();
        const n = Number(res.attempt);
        sealFailedNotice(admin, env, Number.isFinite(n) ? n : null, result);
        return "retry_later";
      }
      case "not_completing":
      case "not_found":
        await removeSealed();
        return "not_completing";
      default: {
        const released = await releaseSeal(admin, env.id, leaseId, "unknown_result", "complete");
        if (released.result === "released") await removeSealed();
        return "retry_later";
      }
    }
  }

  // ── 9. Revalidate; notices after the response ──
  revalidateDocuments();
  const completedAt = isoMs(new Date());
  later("completion_notices", env.id, () =>
    sendCompletionNotices(admin, {
      envelope: env,
      recipients: chain,
      pdf: sealed,
      sealedSha256,
      completedAt,
      engagementActivated,
      recipientIds: "all",
      staff: true,
    })
  );
  return "completed";
}
