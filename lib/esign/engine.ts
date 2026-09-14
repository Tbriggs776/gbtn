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
  ESIGN_DOC_TYPES,
  TOKEN_RE,
  effectiveStatus,
  isOpenStatus,
  sendEligibility,
  type EsignDocType,
  type EsignErrorCode,
  type EsignResponseData,
  type EsignSnapshot,
  type EsignStatus,
  type EsignUploaderInfo,
  type SendForSignatureInput,
  type SignedView,
  type SigningView,
  type StaffRequestSummary,
  type UploaderRole,
} from "./types";
import { EsignError, EsignStaffError, fromDbError, staffErrorFromDb } from "./errors";
import { generateSigningToken, hashSigningToken, isWellFormedToken, signUrlFor } from "./token";
import { computeDocumentHash, sha256Hex, timingSafeEqualHex } from "./hash";
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
  attemptPaths,
  downloadObject,
  downloadObjectOrMissing,
  frozenSourcePath,
  isClientScopedPath,
  removeObjectsQuietly,
  sealedClientPath,
  sealedDownloadName,
  shortSignedUrl,
  uploadObject,
} from "./storage";
import { fillTemplate, loadDocumentType, notifyRecipients, toTypeSummary } from "./config";
import { buildSealedPdf, inspectSourcePdf, type SealEvent } from "./seal";
import {
  notifyStaffClosed,
  notifyStaffSigned,
  sendOtpSms,
  sendSignedCopy,
  sendSigningInvite,
} from "./notify";

// ───────────────────────────────────────────────────────────────────────────
// E-sign orchestration (spec B.12 + addendum §3.14).
//
// Two entry surfaces call this file:
//   - Staff server actions (app/portal/documents/esign-actions.ts). The caller
//     ran assertStaff(); every function here re-checks sessionCan(documents)
//     on the REAL client_id of the row it loads, and throws EsignStaffError.
//   - The signer route (app/api/esign/route.ts). No session exists; the token
//     is the capability. Every function checks TOKEN_RE and resolves the
//     token_hash before the service role reads anything, and throws EsignError.
//
// Every state change is one SQL function (0031) that locks the request row;
// this file never writes signature_request or documents directly. The only
// direct inserts are best-effort signature_event rows (notified /
// notify_failed / otp_send_failed), which the event guard permits for the
// service role.
//
// Logging rule: request ids and error class names only. Never the token, an
// OTP code, a storage path, or row data.
// ───────────────────────────────────────────────────────────────────────────

export type CreateSignatureResult = {
  requestId: string;
  signUrl: string;
  emailed: boolean;
  emailError?: string;
  superseded: number;
};
export type VoidResult = "ok" | "not_found" | "expired" | "otp_required" | "signed" | "declined" | "voided";

type Admin = ReturnType<typeof createAdminClient>;
type NotifyResult = { ok: boolean; error?: string };

const SEALED_DOWNLOAD_WINDOW_DAYS = 30;
const MIN_INK_LENGTH = 40;
const CREATES_PER_DOCUMENT_PER_DAY = 10;
const DAY_MS = 86_400_000;

const VOID_RESULTS: readonly VoidResult[] = ["ok", "not_found", "expired", "otp_required", "signed", "declined", "voided"];

// ── Signer-facing messages ─────────────────────────────────────────────────

const SIGNER_MESSAGES: Record<EsignErrorCode, string> = {
  bad_request: "Check your entry and try again.",
  unsupported_media_type: "This endpoint only accepts JSON.",
  forbidden_origin: "This request isn't allowed from another site.",
  payload_too_large: "That request is too large.",
  not_found: "This signing link isn't valid.",
  expired: "This signing link has expired.",
  closed: "This signing request is no longer open.",
  already_signed: "This document has already been signed.",
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
};

function signerError(code: EsignErrorCode, opts?: { resendAvailableAt?: string }): EsignError {
  return new EsignError(code, SIGNER_MESSAGES[code], opts);
}

/** Map a signer-path SQL result code that isn't success to its API error. */
function resultError(result: string): EsignError {
  switch (result) {
    case "not_found":
      return signerError("not_found");
    case "expired":
      return signerError("expired");
    case "signed":
      return signerError("already_signed");
    case "declined":
    case "voided":
      return signerError("closed");
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

function readSnapshot(value: unknown): EsignSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<EsignSnapshot>;
  if (s.v !== 1 || !s.document || !s.source || !s.client || !s.provider || !s.signer) return null;
  return s as EsignSnapshot;
}

function toUploaderRole(role: unknown): UploaderRole {
  return role === "admin" || role === "employee" || role === "client" ? role : null;
}

function isDocType(t: string): t is EsignDocType {
  return (ESIGN_DOC_TYPES as readonly string[]).includes(t);
}

function collapseWhitespace(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Notification helpers never throw; a throw becomes { ok:false } with the class name only. */
async function attempt(fn: () => Promise<NotifyResult>): Promise<NotifyResult> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : "error" };
  }
}

async function recordNotifyOutcome(admin: Admin, requestId: string, kind: string, result: NotifyResult) {
  // S5: system events never carry IP or user agent.
  const { error } = await admin.from("signature_event").insert({
    request_id: requestId,
    event: result.ok ? "notified" : "notify_failed",
    actor: "system",
    actor_user_id: null,
    ip: null,
    user_agent: null,
    meta: result.ok ? { kind } : { kind, error: (result.error ?? "unknown").slice(0, 200) },
  });
  if (error) console.error("[esign] event insert failed", requestId, error.code ?? "");
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

async function notifyClosedBestEffort(
  admin: Admin,
  i: {
    requestId: string;
    documentType: string;
    title: string;
    clientName: string;
    outcome: "declined" | "drift";
    reason: string | null;
  }
) {
  try {
    const to = await staffRecipients(admin, i.documentType);
    const res = await attempt(() =>
      notifyStaffClosed({
        to,
        title: i.title,
        clientName: i.clientName,
        outcome: i.outcome,
        reason: i.reason,
        requestId: i.requestId,
      })
    );
    await recordNotifyOutcome(admin, i.requestId, `staff_${i.outcome}`, res);
  } catch (e) {
    console.error("[esign] close notify failed", i.requestId, e instanceof Error ? e.name : "error");
  }
}

function revalidateDocuments() {
  revalidatePath("/portal/documents");
  revalidatePath("/portal");
}

// ── Staff: row shapes ──────────────────────────────────────────────────────

const DOCUMENT_COLUMNS =
  "id, client_id, uploaded_by, storage_path, file_name, byte_size, content_type, category, engagement_id, title, doc_type, version, status, effective_date, signed_at, signature_request_id";

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
};

type RequestSummaryRow = {
  id: string;
  document_id: string;
  status: string;
  signer_name: string;
  signer_email: string;
  sent_at: string;
  viewed_at: string | null;
  signed_at: string | null;
  expires_at: string;
};

function staffForbidden(): EsignStaffError {
  return new EsignStaffError("forbidden", "You don't have access to this client.");
}

function assertStaffCan(session: SessionContext, clientId: string) {
  if (!session.isStaff || !sessionCan(session, clientId, "documents")) throw staffForbidden();
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

async function readLatestRequest(admin: Admin, documentId: string, clientId: string): Promise<StaffRequestSummary | null> {
  const { data, error } = await admin
    .from("signature_request")
    .select("id, document_id, status, signer_name, signer_email, sent_at, viewed_at, signed_at, expires_at")
    .eq("document_id", documentId)
    .eq("client_id", clientId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle<RequestSummaryRow>();
  if (error) throw staffErrorFromDb(error);
  if (!data) return null;
  return {
    id: data.id,
    documentId: data.document_id,
    status: data.status as EsignStatus,
    signerName: data.signer_name,
    signerEmail: data.signer_email,
    sentAt: data.sent_at,
    viewedAt: data.viewed_at,
    signedAt: data.signed_at,
    expiresAt: data.expires_at,
  };
}

async function countRecentCreates(admin: Admin, documentId: string, clientId: string): Promise<number> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const { count, error } = await admin
    .from("signature_request")
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

// ── Staff: create / void / resend ──────────────────────────────────────────

export async function createSignatureRequest(
  session: SessionContext,
  input: SendForSignatureInput,
  opts: { replaceOpen: boolean }
): Promise<CreateSignatureResult> {
  // Gate on the client the caller named before the service role is touched…
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();

  const { data: doc, error: docErr } = await admin
    .from("documents")
    .select(DOCUMENT_COLUMNS)
    .eq("id", input.documentId)
    .eq("client_id", input.clientId)
    .maybeSingle<DocumentRow>();
  if (docErr) throw staffErrorFromDb(docErr);
  if (!doc) throw new EsignStaffError("document_not_found", "Document not found.");
  // …then again on the row's real client_id. assertStaff alone is not tenant proof.
  assertStaffCan(session, doc.client_id);

  const typeRow = await loadDocumentType(admin, input.documentType);
  if (!typeRow || !typeRow.esign_enabled) throw new EsignStaffError("type_disabled");
  // v1 signs PDFs only; a type configured for anything else can't be sent yet.
  if (!typeRow.allowed_content_types.includes("application/pdf")) {
    throw new EsignStaffError("not_pdf", "This document type isn't set up for PDF signing.");
  }
  const type = toTypeSummary(typeRow);

  // A document already linked to an engagement keeps it; the dialog may pass null.
  if (doc.engagement_id && input.engagementId && input.engagementId !== doc.engagement_id) {
    throw new EsignStaffError("engagement_mismatch", "This document is linked to a different engagement.");
  }
  const engagementId = doc.engagement_id ?? input.engagementId;

  const [uploader, latest, recent, client, engagement, contact] = await Promise.all([
    readUploader(admin, doc.uploaded_by),
    readLatestRequest(admin, doc.id, doc.client_id),
    countRecentCreates(admin, doc.id, doc.client_id),
    readClient(admin, doc.client_id),
    readEngagement(admin, engagementId, doc.client_id),
    input.signer.kind === "contact"
      ? readContact(admin, input.signer.contactId, doc.client_id)
      : Promise.resolve(null),
  ]);
  if (!client) throw new EsignStaffError("document_not_found", "Client not found.");

  // Friendly early refusal; esign_create_request re-checks all of it under a lock.
  const now = new Date();
  const eligibility = sendEligibility(doc, type, latest, uploader, { replaceOpen: opts.replaceOpen, now });
  if (!eligibility.ok) throw new EsignStaffError("document_not_eligible", eligibility.reason);
  // S3: the service role downloads storage_path, so it must sit under this client.
  if (!isClientScopedPath(doc.storage_path, doc.client_id)) {
    throw new EsignStaffError("document_not_eligible");
  }
  // Each create sends a real email; refuse before downloading anything.
  if (recent >= CREATES_PER_DOCUMENT_PER_DAY) throw new EsignStaffError("rate_limited");

  // ── Signer ──
  let signerName: string;
  let rawEmail: string;
  let rawPhone: string | null;
  let contactId: string | null;
  if (input.signer.kind === "contact") {
    if (!contact) throw new EsignStaffError("contact_not_found", "That contact wasn't found for this client.");
    if (!contact.email || !contact.email.trim()) throw new EsignStaffError("contact_no_email");
    signerName = contact.full_name;
    rawEmail = contact.email;
    rawPhone = contact.phone;
    contactId = contact.id;
  } else {
    signerName = input.signer.fullName;
    rawEmail = input.signer.email;
    rawPhone = input.signer.phone ?? null;
    contactId = null;
  }
  signerName = collapseWhitespace(signerName);
  if (signerName.length < 1 || signerName.length > 200) {
    throw new EsignStaffError("unknown", "Enter the signer's full name.");
  }
  const signerEmail = rawEmail.trim().toLowerCase();
  if (!z.string().email().max(254).safeParse(signerEmail).success) {
    throw new EsignStaffError("invalid_email", "Enter a valid signer email.");
  }
  const phoneE164 = toE164(rawPhone);
  if (type.requireSmsOtp && !phoneE164) throw new EsignStaffError("phone_required");

  // ── Source bytes ──
  let bytes: Uint8Array;
  try {
    bytes = await downloadObject(admin, CLIENT_FILES_BUCKET, doc.storage_path);
  } catch {
    throw new EsignStaffError("storage_failed", "We couldn't read that file from storage. Nothing was sent.");
  }
  const inspected = await inspectSourcePdf(bytes);
  if (!inspected.ok) throw new EsignStaffError("pdf_rejected", inspected.error);
  const sourceSha256 = sha256Hex(bytes);

  // ── Frozen texts, snapshot, hash, token ──
  const title = doc.title?.trim() || doc.file_name;
  const vars = {
    provider_legal_name: site.legalName,
    provider_name: site.name,
    provider_contact_email: site.founder.email,
    client_legal_name: client.legal_name?.trim() || client.name,
    document_title: title,
  };
  const consent = fillTemplate(typeRow.consent_text, vars);
  const checkbox = fillTemplate(typeRow.checkbox_text, vars);
  if (!consent.ok || !checkbox.ok) throw new EsignStaffError("template_incomplete");

  const requestId = randomUUID();
  const expiresAt = new Date(now.getTime() + typeRow.expiry_days * DAY_MS).toISOString();

  const snapshot: EsignSnapshot = {
    v: 1,
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
    engagement: engagement
      ? { id: engagement.id, name: engagement.name, offer_rung: engagement.offer_rung ?? null }
      : null,
    source: {
      bucket: "client-files",
      storage_path: doc.storage_path,
      file_name: doc.file_name,
      content_type: "application/pdf",
      byte_size: bytes.byteLength,
      sha256: sourceSha256,
      page_count: inspected.pageCount,
    },
    signer: { name: signerName, email: signerEmail, phone_e164: phoneE164, contact_id: contactId },
    expires_at: expiresAt,
  };
  const documentHash = computeDocumentHash({
    snapshot,
    consentText: consent.text,
    checkboxText: checkbox.text,
    sourceSha256,
  });
  const { token, tokenHash } = generateSigningToken();

  // ── Freeze the source, then the one transactional write ──
  const frozen = frozenSourcePath(requestId);
  try {
    await uploadObject(admin, ESIGN_BUCKET, frozen, bytes, "application/pdf");
  } catch {
    // Nothing references the object yet, so removing it is always safe.
    await removeObjectsQuietly(admin, ESIGN_BUCKET, [frozen]);
    throw new EsignStaffError("storage_failed", "We couldn't store a copy of the file. Nothing was sent.");
  }

  const { data: created, error: createErr } = await admin.rpc("esign_create_request", {
    p_request_id: requestId,
    p_token_hash: tokenHash,
    p_client_id: doc.client_id,
    p_document_id: doc.id,
    p_engagement_id: engagementId,
    p_document_type: input.documentType,
    p_signer_contact_id: contactId,
    p_signer_name: signerName,
    p_signer_email: signerEmail,
    p_signer_phone: phoneE164,
    p_created_by: session.user.id,
    p_document_snapshot: snapshot,
    p_source_frozen_path: frozen,
    p_source_sha256: sourceSha256,
    p_consent_text: consent.text,
    p_checkbox_text: checkbox.text,
    p_document_hash: documentHash,
    p_expires_at: expiresAt,
    p_replace_open: opts.replaceOpen,
    p_supersede_siblings: input.supersedeSiblings,
  });

  let superseded = 0;
  if (createErr) {
    // S4: an error can arrive after the commit went through. Never remove the
    // frozen source until a re-read proves the request row does not exist.
    const { data: row, error: readErr } = await admin
      .from("signature_request")
      .select("id")
      .eq("id", requestId)
      .maybeSingle<{ id: string }>();
    if (readErr) {
      console.error("[esign] create ambiguous", requestId);
      throw new EsignStaffError(
        "unknown",
        "We couldn't confirm the request was created. Refresh before trying again."
      );
    }
    if (!row) {
      await removeObjectsQuietly(admin, ESIGN_BUCKET, [frozen]);
      throw staffErrorFromDb(createErr);
    }
    // The row exists: the create committed. Continue on the success path.
  } else {
    const n = Number((created as { superseded?: unknown } | null)?.superseded ?? 0);
    superseded = Number.isFinite(n) ? n : 0;
  }

  revalidateDocuments();

  // The invite is synchronous so the dialog can say whether it went out; the
  // link is the fallback when it didn't.
  const signUrl = signUrlFor(token);
  const invite = await attempt(() =>
    sendSigningInvite({
      to: signerEmail,
      signerName,
      title,
      clientName: client.name,
      signUrl,
      expiresAt,
    })
  );
  await recordNotifyOutcome(admin, requestId, "invite", invite);

  return {
    requestId,
    signUrl,
    emailed: invite.ok,
    ...(invite.ok ? {} : { emailError: invite.error ?? "unknown" }),
    superseded,
  };
}

export async function voidSignatureRequest(
  session: SessionContext,
  input: { clientId: string; requestId: string; reason: string | null }
): Promise<VoidResult> {
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();

  const { data: req, error } = await admin
    .from("signature_request")
    .select("id, document_id, client_id")
    .eq("id", input.requestId)
    .eq("client_id", input.clientId)
    .maybeSingle<{ id: string; document_id: string; client_id: string }>();
  if (error) throw staffErrorFromDb(error);
  if (!req) return "not_found";
  assertStaffCan(session, req.client_id);

  const reason = input.reason ? input.reason.trim().slice(0, 1000) || null : null;
  const { data, error: rpcErr } = await admin.rpc("esign_close_request", {
    p_request_id: req.id,
    p_client_id: req.client_id,
    p_token_hash: null,
    p_new_status: "voided",
    p_actor: "staff",
    p_actor_user_id: session.user.id,
    p_reason: reason,
    p_extra_event: null,
    p_meta: null,
    p_otp_session_hash: null,
    p_ip: null,
    p_user_agent: null,
  });
  if (rpcErr) throw staffErrorFromDb(rpcErr);

  const result = String(data) as VoidResult;
  if (!VOID_RESULTS.includes(result)) throw new EsignStaffError("unknown");
  return result;
}

export async function resendSignatureRequest(
  session: SessionContext,
  input: { clientId: string; requestId: string }
): Promise<CreateSignatureResult> {
  assertStaffCan(session, input.clientId);
  const admin = createAdminClient();

  const { data: old, error } = await admin
    .from("signature_request")
    .select(
      "id, client_id, document_id, document_type, engagement_id, status, signed_at, signer_contact_id, signer_name, signer_email, signer_phone"
    )
    .eq("id", input.requestId)
    .eq("client_id", input.clientId)
    .maybeSingle<{
      id: string;
      client_id: string;
      document_id: string;
      document_type: string;
      engagement_id: string | null;
      status: string;
      signed_at: string | null;
      signer_contact_id: string | null;
      signer_name: string;
      signer_email: string;
      signer_phone: string | null;
    }>();
  if (error) throw staffErrorFromDb(error);
  if (!old) throw new EsignStaffError("request_not_found", "That signature request wasn't found.");
  assertStaffCan(session, old.client_id);

  const alreadySigned = new EsignStaffError("already_signed", "Already signed. A signed request can't be resent.");
  if (old.status === "signed" || old.signed_at) throw alreadySigned;

  const { data: doc, error: docErr } = await admin
    .from("documents")
    .select("id, signed_at")
    .eq("id", old.document_id)
    .eq("client_id", old.client_id)
    .maybeSingle<{ id: string; signed_at: string | null }>();
  if (docErr) throw staffErrorFromDb(docErr);
  if (!doc) throw new EsignStaffError("document_not_found", "Document not found.");
  if (doc.signed_at) throw alreadySigned;

  if (!isDocType(old.document_type)) throw new EsignStaffError("type_disabled");

  // Resend = void + a new token: same document, type, engagement and signer.
  // A contact that still exists is re-read, so a corrected email is picked up.
  return createSignatureRequest(
    session,
    {
      clientId: old.client_id,
      documentId: old.document_id,
      documentType: old.document_type,
      engagementId: old.engagement_id,
      signer: old.signer_contact_id
        ? { kind: "contact", contactId: old.signer_contact_id }
        : {
            kind: "manual",
            fullName: old.signer_name,
            email: old.signer_email,
            ...(old.signer_phone ? { phone: old.signer_phone } : {}),
          },
      supersedeSiblings: false,
    },
    { replaceOpen: true }
  );
}

// ── Member: the Signed copy download (S1) ──────────────────────────────────

export async function getMemberSealedCopyUrl(
  session: SessionContext,
  documentId: string
): Promise<{ url: string }> {
  // Cookie client: RLS proves membership, the Financials rule and
  // visible_to_client before the service role is used for anything.
  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, client_id, file_name, title, signature_request_id, signed_at")
    .eq("id", documentId)
    .maybeSingle<{
      id: string;
      client_id: string;
      file_name: string;
      title: string | null;
      signature_request_id: string | null;
      signed_at: string | null;
    }>();
  if (error || !doc) throw new EsignStaffError("document_not_found", "Not found.");
  if (!sessionCan(session, doc.client_id, "documents")) {
    throw new EsignStaffError("forbidden", "You don't have access to this.");
  }
  if (!doc.signed_at || !doc.signature_request_id) {
    throw new EsignStaffError("request_not_found", "This document doesn't have a signed copy.");
  }

  const admin = createAdminClient();
  const { data: req, error: reqErr } = await admin
    .from("signature_request")
    .select("sealed_pdf_path")
    .eq("id", doc.signature_request_id)
    .eq("document_id", doc.id)
    .eq("client_id", doc.client_id)
    .eq("status", "signed")
    .maybeSingle<{ sealed_pdf_path: string | null }>();
  if (reqErr) throw staffErrorFromDb(reqErr);
  if (!req?.sealed_pdf_path) {
    throw new EsignStaffError("request_not_found", "This document doesn't have a signed copy.");
  }

  try {
    const url = await shortSignedUrl(admin, ESIGN_BUCKET, req.sealed_pdf_path, {
      download: sealedDownloadName(doc.title ?? doc.file_name),
    });
    return { url };
  } catch {
    throw new EsignStaffError("storage_failed", "Could not create a download link. Try again.");
  }
}

// ── Signer: read model ─────────────────────────────────────────────────────

type ViewRow = {
  status: string;
  document_snapshot: unknown;
  consent_text: string;
  checkbox_text: string;
  expires_at: string;
  signed_at: string | null;
  viewed_at: string | null;
  require_sms_otp: boolean;
  signer_name: string;
  signer_email: string;
  signer_phone: string | null;
  otp_last_sent_at: string | null;
  sealed_pdf_path: string | null;
};

const VIEW_COLUMNS =
  "status, document_snapshot, consent_text, checkbox_text, expires_at, signed_at, viewed_at, require_sms_otp, signer_name, signer_email, signer_phone, otp_last_sent_at, sealed_pdf_path";

// Never exposes paths, hashes other than the source hash, OTP state, the
// request id, or the signer's email unmasked.
function toSigningView(r: ViewRow, now: Date): SigningView {
  const snap = readSnapshot(r.document_snapshot);
  if (!snap) return { state: "invalid" };
  const title = snap.document.title;

  if (r.status === "signed") {
    const signedMs = r.signed_at ? Date.parse(r.signed_at) : NaN;
    return {
      state: "signed",
      title,
      signedAt: r.signed_at ?? "",
      signerEmailMasked: maskEmail(r.signer_email),
      sealedDownloadAvailable:
        !!r.sealed_pdf_path &&
        Number.isFinite(signedMs) &&
        signedMs > now.getTime() - SEALED_DOWNLOAD_WINDOW_DAYS * DAY_MS,
    };
  }
  if (r.status === "declined" || r.status === "voided" || r.status === "expired") {
    return { state: r.status, title };
  }
  if (!isOpenStatus(r.status)) return { state: "invalid" };
  // Open but past expiry reads as expired WITHOUT writing (link scanners can
  // fetch this; the lazy sweep happens on the next transition).
  if (effectiveStatus({ status: r.status, expiresAt: r.expires_at }, now) === "expired") {
    return { state: "expired", title };
  }

  const resendAt = r.otp_last_sent_at
    ? new Date(Date.parse(r.otp_last_sent_at) + OTP_RESEND_COOLDOWN_SECONDS * 1000)
    : null;
  return {
    state: "open",
    title,
    docTypeLabel: snap.document.doc_type_label,
    version: snap.document.version,
    fileName: snap.source.file_name,
    byteSize: snap.source.byte_size,
    pageCount: snap.source.page_count,
    sourceSha256: snap.source.sha256,
    clientName: snap.client.legal_name ?? snap.client.name,
    providerName: snap.provider.name,
    signerName: r.signer_name,
    consentText: r.consent_text,
    checkboxText: r.checkbox_text,
    expiresAt: r.expires_at,
    viewed: r.viewed_at !== null,
    requireOtp: r.require_sms_otp,
    phoneMask: r.require_sms_otp ? maskPhone(r.signer_phone) : null,
    otpResendAvailableAt:
      r.require_sms_otp && resendAt && resendAt.getTime() > now.getTime() ? resendAt.toISOString() : null,
  };
}

/** Pure read for the SSR page and the `get` action. Never throws, never writes. */
export async function loadSigningView(token: string): Promise<SigningView> {
  if (!isWellFormedToken(token)) return { state: "invalid" };
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("signature_request")
      .select(VIEW_COLUMNS)
      .eq("token_hash", hashSigningToken(token))
      .maybeSingle<ViewRow>();
    if (error) {
      console.error("[esign] view read failed", error.code ?? "");
      return { state: "invalid" };
    }
    if (!data) return { state: "invalid" };
    return toSigningView(data, new Date());
  } catch (e) {
    console.error("[esign] view read failed", e instanceof Error ? e.name : "error");
    return { state: "invalid" };
  }
}

async function signerTouch(
  admin: Admin,
  tokenHash: string,
  step: "viewed" | "source_opened",
  ctx: EsignRequestContext
): Promise<void> {
  const { data, error } = await admin.rpc("esign_signer_touch", {
    p_token_hash: tokenHash,
    p_step: step,
    p_ip: ctx.ip,
    p_user_agent: ctx.userAgent,
  });
  if (error) throw signerDbError("signer_touch", error);
  const result = String(data);
  if (result === "ok" || isOpenStatus(result)) return;
  throw resultError(result);
}

/** S9: `viewed` is recorded only by the explicit "Review the document" click. */
export async function markViewed(token: string, ctx: EsignRequestContext): Promise<SigningView> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  await signerTouch(admin, tokenHash, "viewed", ctx);
  return loadSigningView(token);
}

export async function getSourceUrl(
  token: string,
  ctx: EsignRequestContext
): Promise<EsignResponseData["source_url"]> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  // The touch refuses anything not open and unexpired, atomically.
  await signerTouch(admin, tokenHash, "source_opened", ctx);

  const { data, error } = await admin
    .from("signature_request")
    .select("source_frozen_path, document_snapshot")
    .eq("token_hash", tokenHash)
    .maybeSingle<{ source_frozen_path: string; document_snapshot: unknown }>();
  if (error) throw signerDbError("source_read", error);
  if (!data) throw signerError("not_found");

  // The FROZEN copy, inline (no download disposition), 60 seconds.
  const url = await shortSignedUrl(admin, ESIGN_BUCKET, data.source_frozen_path);
  const snap = readSnapshot(data.document_snapshot);
  return { url, fileName: snap?.source.file_name ?? "document.pdf" };
}

// ── Signer: SMS verification ───────────────────────────────────────────────

async function readRequestId(admin: Admin, tokenHash: string): Promise<string> {
  const { data, error } = await admin
    .from("signature_request")
    .select("id")
    .eq("token_hash", tokenHash)
    .maybeSingle<{ id: string }>();
  if (error) throw signerDbError("id_read", error);
  if (!data) throw signerError("not_found");
  return data.id;
}

export async function sendOtp(
  token: string,
  ctx: EsignRequestContext
): Promise<EsignResponseData["send_otp"]> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();
  const requestId = await readRequestId(admin, tokenHash);

  // Reserve-then-send: the SQL counts the send (cooldown, cap) before any SMS
  // goes out, so a failed send still counts and SMS pumping stays bounded.
  const code = generateOtpCode();
  const { data, error } = await admin.rpc("esign_record_otp_send", {
    p_token_hash: tokenHash,
    p_otp_hash: hashOtp(requestId, code),
    p_ttl_seconds: OTP_TTL_SECONDS,
    p_cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS,
    p_max_sends: OTP_MAX_SENDS,
    p_ip: ctx.ip,
    p_user_agent: ctx.userAgent,
  });
  if (error) throw signerDbError("record_otp_send", error);

  const res = (data ?? {}) as {
    result?: string;
    request_id?: string;
    phone?: string | null;
    resend_available_at?: string;
  };
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

  const phone = res.phone ?? null;
  const sms = phone ? await attempt(() => sendOtpSms({ to: phone, code })) : { ok: false };
  if (!sms.ok) {
    // Actor signer with the signer's own ip/ua; never the code in meta.
    const { error: evErr } = await admin.from("signature_event").insert({
      request_id: requestId,
      event: "otp_send_failed",
      actor: "signer",
      actor_user_id: null,
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      meta: {},
    });
    if (evErr) console.error("[esign] event insert failed", requestId, evErr.code ?? "");
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
  const requestId = await readRequestId(admin, tokenHash);

  // S2: a correct code binds a fresh browser session. Only its hash is stored;
  // the raw value goes back once, in this response.
  const { otpSession, otpSessionHash } = generateOtpSession();
  const { data, error } = await admin.rpc("esign_check_otp", {
    p_token_hash: tokenHash,
    p_candidate_hash: hashOtp(requestId, code),
    p_max_attempts: OTP_MAX_ATTEMPTS,
    p_session_hash: otpSessionHash,
    p_session_ttl_seconds: OTP_SESSION_TTL_SECONDS,
    p_ip: ctx.ip,
    p_user_agent: ctx.userAgent,
  });
  if (error) throw signerDbError("check_otp", error);

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

// ── Signer: submit ─────────────────────────────────────────────────────────

type SubmitRow = {
  id: string;
  client_id: string;
  document_id: string;
  document_type: string;
  status: string;
  signer_name: string;
  signer_email: string;
  document_snapshot: unknown;
  source_frozen_path: string;
  source_sha256: string;
  consent_text: string;
  checkbox_text: string;
  document_hash: string;
  require_sms_otp: boolean;
  otp_verified_at: string | null;
  otp_session_hash: string | null;
  otp_session_expires_at: string | null;
  sent_at: string;
  viewed_at: string | null;
  source_opened_at: string | null;
  expires_at: string;
};

const SUBMIT_COLUMNS =
  "id, client_id, document_id, document_type, status, signer_name, signer_email, document_snapshot, source_frozen_path, source_sha256, consent_text, checkbox_text, document_hash, require_sms_otp, otp_verified_at, otp_session_hash, otp_session_expires_at, sent_at, viewed_at, source_opened_at, expires_at";

type DriftCheck = "document_hash" | "document_row" | "source_path" | "frozen_source" | "client_source";

// Integrity failed: void through the one close function (drift_detected event,
// document restored), tell staff after the response, and refuse the submit.
async function voidForDrift(
  admin: Admin,
  r: SubmitRow,
  tokenHash: string,
  labels: { title: string; clientName: string },
  drift: { check: DriftCheck; expected_sha256: string | null; actual_sha256: string | null }
): Promise<never> {
  const { data, error } = await admin.rpc("esign_close_request", {
    p_request_id: r.id,
    p_client_id: r.client_id,
    p_token_hash: tokenHash,
    p_new_status: "voided",
    p_actor: "system",
    p_actor_user_id: null,
    p_reason: "document_changed",
    p_extra_event: "drift_detected",
    // No paths in meta.
    p_meta: { check: drift.check, expected_sha256: drift.expected_sha256, actual_sha256: drift.actual_sha256 },
    p_otp_session_hash: null,
    p_ip: null,
    p_user_agent: null,
  });
  if (error) {
    console.error("[esign] drift void failed", r.id, error.code ?? "");
    throw signerError("document_changed");
  }

  const result = String(data);
  if (result === "ok") {
    after(() =>
      notifyClosedBestEffort(admin, {
        requestId: r.id,
        documentType: r.document_type,
        title: labels.title,
        clientName: labels.clientName,
        outcome: "drift",
        reason: drift.check,
      })
    );
    throw signerError("document_changed");
  }
  // Lost a race (signed, declined, voided, expired meanwhile): report that instead.
  throw resultError(result);
}

function hexMatches(actual: string | null, expected: string): boolean {
  return actual !== null && timingSafeEqualHex(actual, expected);
}

export async function submitSignature(
  token: string,
  input: { printedName: string; signaturePng: string; inkLength: number; otpSession: string | null },
  ctx: EsignRequestContext
): Promise<SignedView> {
  // ── 1. Validate (cheap, before any DB call) ──
  const tokenHash = requireTokenHash(token);
  const signature = parseSignatureDataUrl(input.signaturePng);
  if (!signature.ok) throw signerError("signature_invalid");
  // Client-reported pixels of ink: a UX guard, not a security control.
  if (!Number.isFinite(input.inkLength) || input.inkLength < MIN_INK_LENGTH) {
    throw signerError("signature_invalid");
  }
  const printedName = collapseWhitespace(input.printedName);
  if (printedName.length < 2 || printedName.length > 120) throw signerError("bad_request");

  // ── 2. Load the request ──
  const admin = createAdminClient();
  const { data: r, error: loadErr } = await admin
    .from("signature_request")
    .select(SUBMIT_COLUMNS)
    .eq("token_hash", tokenHash)
    .maybeSingle<SubmitRow>();
  if (loadErr) throw signerDbError("submit_read", loadErr);
  if (!r) throw signerError("not_found");
  if (r.status === "signed") throw signerError("already_signed");
  if (!isOpenStatus(r.status)) throw signerError("closed");
  if (Date.parse(r.expires_at) <= Date.now()) {
    // Persist the expiry (and restore the document) through the lazy sweep.
    await admin.rpc("esign_signer_touch", {
      p_token_hash: tokenHash,
      p_step: "viewed",
      p_ip: ctx.ip,
      p_user_agent: ctx.userAgent,
    });
    throw signerError("expired");
  }
  // S2: the verification must belong to THIS browser's live session.
  if (r.require_sms_otp) {
    const session = input.otpSession;
    const sessionLive =
      !!r.otp_session_expires_at && Date.parse(r.otp_session_expires_at) > Date.now();
    if (
      !r.otp_verified_at ||
      !session ||
      !TOKEN_RE.test(session) ||
      !r.otp_session_hash ||
      !sessionLive ||
      !timingSafeEqualHex(hashOtpSession(session), r.otp_session_hash)
    ) {
      throw signerError("otp_required");
    }
  }

  // ── 3. Integrity and drift ──
  const snap = readSnapshot(r.document_snapshot);
  const labels = {
    title: snap?.document.title ?? "Document",
    clientName: snap?.client.name ?? "",
  };

  // (a) the stored hash still matches the stored evidence.
  let recomputed: string | null = null;
  try {
    recomputed = snap
      ? computeDocumentHash({
          snapshot: snap,
          consentText: r.consent_text,
          checkboxText: r.checkbox_text,
          sourceSha256: r.source_sha256,
        })
      : null;
  } catch {
    recomputed = null;
  }
  if (!snap || !hexMatches(recomputed, r.document_hash)) {
    return voidForDrift(admin, r, tokenHash, labels, {
      check: "document_hash",
      expected_sha256: r.document_hash,
      actual_sha256: recomputed,
    });
  }

  // (d) the live document row is still the one that was sent.
  const { data: liveDoc, error: liveErr } = await admin
    .from("documents")
    .select("id, signed_at, status, storage_path")
    .eq("id", r.document_id)
    .eq("client_id", r.client_id)
    .maybeSingle<{ id: string; signed_at: string | null; status: string; storage_path: string }>();
  if (liveErr) throw signerDbError("submit_doc_read", liveErr);
  if (
    !liveDoc ||
    liveDoc.signed_at ||
    liveDoc.status === "superseded" ||
    liveDoc.storage_path !== snap.source.storage_path
  ) {
    return voidForDrift(admin, r, tokenHash, labels, {
      check: "document_row",
      expected_sha256: r.source_sha256,
      actual_sha256: null,
    });
  }

  // S3: never let the service role download a path outside this client.
  if (!isClientScopedPath(snap.source.storage_path, r.client_id)) {
    return voidForDrift(admin, r, tokenHash, labels, {
      check: "source_path",
      expected_sha256: r.source_sha256,
      actual_sha256: null,
    });
  }

  // (b) the frozen copy and (c) the client-files original, both by sha256.
  const [frozenRes, liveRes] = await Promise.allSettled([
    downloadObject(admin, ESIGN_BUCKET, r.source_frozen_path),
    downloadObjectOrMissing(admin, CLIENT_FILES_BUCKET, snap.source.storage_path),
  ]);
  if (frozenRes.status === "rejected") {
    // The esign bucket is service-role only, so a failed read here is ours
    // (or transient), not client drift. Nothing has been written.
    console.error("[esign] frozen source unreadable", r.id);
    throw signerError("server_error");
  }
  const frozenBytes = frozenRes.value;
  const frozenSha = sha256Hex(frozenBytes);
  if (!hexMatches(frozenSha, r.source_sha256)) {
    return voidForDrift(admin, r, tokenHash, labels, {
      check: "frozen_source",
      expected_sha256: r.source_sha256,
      actual_sha256: frozenSha,
    });
  }
  if (liveRes.status === "rejected") {
    // Not confirmed missing: a transient storage failure must not permanently
    // void a valid request as drift. Nothing has been written; the signer retries.
    console.error("[esign] client source unreadable", r.id);
    throw signerError("server_error");
  }
  // A confirmed-missing original, or one whose bytes changed, counts as drift.
  const liveSha = liveRes.value === null ? null : sha256Hex(liveRes.value);
  if (!hexMatches(liveSha, r.source_sha256)) {
    return voidForDrift(admin, r, tokenHash, labels, {
      check: "client_source",
      expected_sha256: r.source_sha256,
      actual_sha256: liveSha,
    });
  }

  // ── 4. Evidence set ──
  const { data: eventRows, error: evErr } = await admin
    .from("signature_event")
    .select("event, actor, at, ip, user_agent")
    .eq("request_id", r.id)
    .order("seq", { ascending: true })
    .returns<{ event: string; actor: string; at: string; ip: string | null; user_agent: string | null }[]>();
  if (evErr) throw signerDbError("submit_events_read", evErr);

  const signedAt = new Date();
  const signedAtIso = signedAt.toISOString();
  const events: SealEvent[] = (eventRows ?? []).map((e) => {
    const actor: SealEvent["actor"] =
      e.actor === "signer" || e.actor === "staff" ? e.actor : "system";
    // S5: only signer rows carry network details onto the certificate.
    return actor === "signer"
      ? { event: e.event, actor, at: e.at, ip: e.ip, user_agent: e.user_agent }
      : { event: e.event, actor, at: e.at, ip: null, user_agent: null };
  });
  events.push(
    { event: "consented", actor: "signer", at: signedAtIso, ip: ctx.ip, user_agent: ctx.userAgent },
    { event: "signed", actor: "signer", at: signedAtIso, ip: ctx.ip, user_agent: ctx.userAgent }
  );

  // ── 5. Seal in memory; a throw here writes nothing ──
  let sealed: Uint8Array;
  try {
    sealed = await buildSealedPdf({
      sourcePdf: frozenBytes,
      signaturePng: signature.bytes,
      requestId: r.id,
      documentId: r.document_id,
      snapshot: snap,
      documentHash: r.document_hash,
      sourceSha256: r.source_sha256,
      consentText: r.consent_text,
      checkboxText: r.checkbox_text,
      signerPrintedName: printedName,
      signedAt,
      signedIp: ctx.ip,
      signedUserAgent: ctx.userAgent,
      sentAt: r.sent_at,
      viewedAt: r.viewed_at,
      sourceOpenedAt: r.source_opened_at,
      otpVerifiedAt: r.otp_verified_at,
      requireSmsOtp: r.require_sms_otp,
      events,
    });
  } catch (e) {
    console.error("[esign] seal failed", r.id, e instanceof Error ? e.name : "error");
    // seal.ts rethrows pdf-lib's embedPng failure (B.7) as EsignError
    // signature_invalid: that one is the signer's to fix. Anything else is ours.
    const invalidPng = e instanceof EsignError && e.code === "signature_invalid";
    throw signerError(invalidPng ? "signature_invalid" : "server_error");
  }
  const sealedSha256 = sha256Hex(sealed);
  const signatureSha256 = sha256Hex(signature.bytes);

  // ── 6. Upload three attempt-scoped objects (upsert:false) ──
  const attemptId = randomUUID();
  const paths = attemptPaths(r.id, attemptId);
  const clientCopy = sealedClientPath(r.client_id, r.id, attemptId);
  const removeAttempt = () =>
    Promise.all([
      removeObjectsQuietly(admin, ESIGN_BUCKET, [paths.signature, paths.sealed]),
      removeObjectsQuietly(admin, CLIENT_FILES_BUCKET, [clientCopy]),
    ]);

  // allSettled, so nothing is still in flight when the cleanup runs.
  const uploads = await Promise.allSettled([
    uploadObject(admin, ESIGN_BUCKET, paths.signature, signature.bytes, "image/png"),
    uploadObject(admin, ESIGN_BUCKET, paths.sealed, sealed, "application/pdf"),
    uploadObject(admin, CLIENT_FILES_BUCKET, clientCopy, sealed, "application/pdf"),
  ]);
  if (uploads.some((u) => u.status === "rejected")) {
    // Before the RPC nothing references these objects: remove freely.
    await removeAttempt();
    console.error("[esign] artifact upload failed", r.id);
    throw signerError("server_error");
  }

  // ── 7. Commit: the one transactional write ──
  const { data: finalized, error: finErr } = await admin.rpc("esign_finalize_signature", {
    p_request_id: r.id,
    p_token_hash: tokenHash,
    p_signed_at: signedAtIso,
    p_printed_name: printedName,
    p_signature_image_path: paths.signature,
    p_signature_image_sha256: signatureSha256,
    p_sealed_pdf_path: paths.sealed,
    p_sealed_pdf_sha256: sealedSha256,
    p_sealed_client_path: clientCopy,
    p_otp_session_hash: input.otpSession ? hashOtpSession(input.otpSession) : null,
    p_ip: ctx.ip,
    p_user_agent: ctx.userAgent,
  });

  let engagementActivated: boolean | null = null;
  if (finErr) {
    // S4: an error can arrive after the commit went through. Re-read before
    // removing anything, or we could delete the evidence of a real signing.
    const { data: reread, error: rereadErr } = await admin
      .from("signature_request")
      .select("status, sealed_pdf_path")
      .eq("id", r.id)
      .eq("token_hash", tokenHash)
      .maybeSingle<{ status: string; sealed_pdf_path: string | null }>();
    if (rereadErr) {
      console.error("[esign] finalize ambiguous", r.id);
      throw signerError("server_error");
    }
    if (reread?.status === "signed" && reread.sealed_pdf_path === paths.sealed) {
      // Committed: continue on the success path (activation unknown; looked up below).
    } else if (reread?.status === "signed") {
      await removeAttempt();
      throw signerError("already_signed");
    } else {
      await removeAttempt();
      throw fromDbError(finErr);
    }
  } else {
    engagementActivated = Boolean(
      (finalized as { engagement_activated?: unknown } | null)?.engagement_activated
    );
  }

  // ── 8. Revalidate ──
  revalidateDocuments();

  // ── 9. Notify after the response; DB state never depends on email ──
  const title = labels.title;
  const clientName = labels.clientName;
  const fileName = sealedDownloadName(title);
  after(async () => {
    try {
      const copy = await attempt(() =>
        sendSignedCopy({
          to: r.signer_email,
          signerName: r.signer_name,
          title,
          signedAt: signedAtIso,
          sealedSha256,
          pdf: sealed,
          fileName,
        })
      );
      await recordNotifyOutcome(admin, r.id, "signed_copy", copy);

      let activated = engagementActivated;
      if (activated === null) {
        const { data: ev } = await admin
          .from("signature_event")
          .select("id")
          .eq("request_id", r.id)
          .eq("event", "engagement_activated")
          .limit(1);
        activated = (ev?.length ?? 0) > 0;
      }
      const to = await staffRecipients(admin, r.document_type);
      const staff = await attempt(() =>
        notifyStaffSigned({
          to,
          title,
          clientName,
          signerName: r.signer_name,
          printedName,
          signerEmail: r.signer_email,
          signedAt: signedAtIso,
          requestId: r.id,
          sealedSha256,
          engagementActivated: activated ?? false,
          pdf: sealed,
          fileName,
        })
      );
      await recordNotifyOutcome(admin, r.id, "staff_signed", staff);
    } catch (e) {
      console.error("[esign] signed notify failed", r.id, e instanceof Error ? e.name : "error");
    }
  });

  // ── 10. Return ──
  return {
    state: "signed",
    title,
    signedAt: signedAtIso,
    signerEmailMasked: maskEmail(r.signer_email),
    sealedDownloadAvailable: true,
  };
}

// ── Signer: decline ────────────────────────────────────────────────────────

export async function declineSignature(
  token: string,
  input: { reason: string | null; otpSession: string | null },
  ctx: EsignRequestContext
): Promise<SigningView> {
  const tokenHash = requireTokenHash(token);
  const reason = input.reason ? input.reason.trim().slice(0, 1000) || null : null;
  const otpSessionHash =
    input.otpSession && TOKEN_RE.test(input.otpSession) ? hashOtpSession(input.otpSession) : null;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("esign_close_request", {
    p_request_id: null,
    p_client_id: null,
    p_token_hash: tokenHash,
    p_new_status: "declined",
    p_actor: "signer",
    p_actor_user_id: null,
    p_reason: reason,
    p_extra_event: null,
    p_meta: null,
    p_otp_session_hash: otpSessionHash,
    p_ip: ctx.ip,
    p_user_agent: ctx.userAgent,
  });
  if (error) throw signerDbError("close_request", error);

  const result = String(data);
  switch (result) {
    case "ok":
      after(async () => {
        const { data: row } = await admin
          .from("signature_request")
          .select("id, document_type, document_snapshot")
          .eq("token_hash", tokenHash)
          .maybeSingle<{ id: string; document_type: string; document_snapshot: unknown }>();
        if (!row) return;
        const snap = readSnapshot(row.document_snapshot);
        await notifyClosedBestEffort(admin, {
          requestId: row.id,
          documentType: row.document_type,
          title: snap?.document.title ?? "Document",
          clientName: snap?.client.name ?? "",
          outcome: "declined",
          reason,
        });
      });
      return loadSigningView(token);
    case "otp_required":
      throw signerError("otp_required");
    case "declined":
    case "voided":
      // Idempotent: a repeated decline just shows the closed state.
      return loadSigningView(token);
    default:
      throw resultError(result);
  }
}

// ── Signer: sealed download ────────────────────────────────────────────────

export async function getSealedUrl(
  token: string,
  ctx: EsignRequestContext
): Promise<EsignResponseData["sealed_url"]> {
  const tokenHash = requireTokenHash(token);
  const admin = createAdminClient();

  // S8: the SQL throttles the audit row; the URL is minted on every ok.
  const { data, error } = await admin.rpc("esign_record_sealed_download", {
    p_token_hash: tokenHash,
    p_window_days: SEALED_DOWNLOAD_WINDOW_DAYS,
    p_ip: ctx.ip,
    p_user_agent: ctx.userAgent,
  });
  if (error) throw signerDbError("record_sealed_download", error);

  const res = (data ?? {}) as { result?: string; sealed_pdf_path?: string | null; title?: string | null };
  switch (res.result) {
    case "ok":
      break;
    case "not_found":
      throw signerError("not_found");
    case "not_signed":
      throw signerError("closed");
    case "download_expired":
      throw signerError("download_expired");
    default:
      throw signerError("server_error");
  }
  if (!res.sealed_pdf_path) throw signerError("server_error");

  const url = await shortSignedUrl(admin, ESIGN_BUCKET, res.sealed_pdf_path, {
    download: sealedDownloadName(res.title || "document"),
  });
  return { url };
}
